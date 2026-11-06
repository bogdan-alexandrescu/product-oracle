import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * Visual QA pass F, Members, invites and access: fix round 1 (on the mock layer).
 * protects: F-1 the People list (approvers, commenters, viewers), the Sign-in panel and
 *   Access requests say "Could not load …" with Try again when their read fails, the
 *   server's words behind an (i), and Try again loads them; F-52 the People list shows
 *   whole emails that break only after their @; F-30 Google sign-in off is one short line
 *   with the reason behind an (i).
 * no_claim: the API's sign-in rules (api/tests/test_invites.py).
 */

const scenario = (page: Page, name: string) => page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, name]);

async function failGets(page: Page, path: string) {
  await page.evaluate((p) => localStorage.setItem("po-mock-fail", p), path);
}

async function openMembers(page: Page) {
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
  await page.getByRole("navigation", { name: "Settings" }).getByTestId("nav-members").click();
  await expect(page).toHaveURL(/\/settings\/members$/);
}

/** The failed read's notice: what failed in plain words, the server's words behind the (i), Try again; Try again loads it. */
async function expectLoadErrorThenRetry(page: Page, scope: Locator, what: string) {
  const notice = scope.getByTestId("load-error");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(`Could not load ${what}.`);
  await expect(notice.getByText("Mock failure")).toBeHidden();
  await notice.getByRole("button", { name: "About the error" }).click();
  await expect(notice.getByRole("tooltip")).toContainText("Mock failure");
  await page.keyboard.press("Escape");
  await page.evaluate(() => localStorage.removeItem("po-mock-fail"));
  await notice.getByRole("button", { name: "Try again" }).click();
  await expect(scope.getByTestId("load-error")).toHaveCount(0);
}

test.describe("pass-f members, round 1", () => {
  test("F-1: the People list a commenter sees says it could not load and Try again loads it", async ({ page }) => {
    await login(page, "commenter@example.com");
    await failGets(page, "/v1/people");
    await openMembers(page);
    const list = page.getByTestId("people-readonly");
    await expectLoadErrorThenRetry(page, list, "the people");
    await expect(list.getByTestId("person-row").first()).toBeVisible();
  });

  test("F-1: the Sign-in panel says it could not load and Try again loads it", async ({ page }) => {
    await login(page);
    await failGets(page, "/v1/sign-in-rules");
    await openMembers(page);
    const panel = page.getByTestId("sign-in-rules");
    await expectLoadErrorThenRetry(page, panel, "the sign-in rules");
    await expect(panel.getByTestId("sign-in-domain").first()).toBeVisible();
  });

  test("F-1: Access requests says it could not load and Try again loads it", async ({ page }) => {
    await login(page);
    await failGets(page, "/v1/access-requests");
    await openMembers(page);
    const panel = page.getByTestId("access-requests");
    await expectLoadErrorThenRetry(page, panel, "the access requests");
    await expect(panel.getByTestId("access-row").filter({ hasText: "new.person@example.com" })).toBeVisible();
  });

  test("F-30: Google sign-in off is one short line, the reason behind an (i)", async ({ page }) => {
    await scenario(page, "no-google-sign-in");
    await login(page);
    await openMembers(page);
    const off = page.getByTestId("sign-in-rules").getByTestId("google-sign-in-off");
    await expect(off).toContainText("These rules don't apply here.");
    await expect(off.getByText(/people sign in with a password/)).toBeHidden();
    await off.getByRole("button", { name: "About Google sign-in" }).click();
    await expect(off.getByRole("tooltip")).toHaveText("Google sign-in is off for this Oracle, so people sign in with a password.");
  });

  test("F-52: on a phone the People list shows whole emails, breaking only after their @", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await login(page, "commenter@example.com");
    // On a phone the app's nav is behind its menu: Members by its address.
    await page.goto("/settings/members");
    const emails = page.getByTestId("people-readonly").getByTestId("person-email");
    await expect(emails.first()).toBeVisible();
    for (const el of await emails.all()) {
      const text = await el.innerText();
      await expect(el).toHaveAttribute("title", text.replace(/\s/g, ""));
      const whole = await el.evaluate((e) => {
        if (e.scrollWidth > e.clientWidth + 1) return false;
        // Each part between breaks (before and after the @) stays on one line.
        const walker = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const range = document.createRange();
          range.selectNodeContents(n);
          const tops = [...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top));
          if (!tops.every((t) => Math.abs(t - tops[0]) <= 1)) return false;
        }
        return e.querySelectorAll("wbr").length === 1;
      });
      expect(whole, text).toBe(true);
    }
  });
});
