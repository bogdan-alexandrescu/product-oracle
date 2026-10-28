import { expect, test, type Page } from "./test";

import { MOCK_INTERVIEW_TOKEN } from "../lib/api/mock/interviews";
import { login } from "./helpers";

/*
 * Make a new link (qa-work-43, decided 2026-10-28): an interview's link is shown once, so a
 * member who lost it makes a new one on the interview's page. The dialog asks first; the new
 * link is shown once with Copy; the page says when the link was made; the old link then says
 * plainly that it was replaced. Driven through the UI on the mock API
 * (./lib/api/mock/interviews.ts), whose fixture invites Ana Lima on `/i/i-mock-token`.
 *
 * Each test states its card: protects (the observable), fails_when (the wrong result it
 * rejects), no_claim (what green does not prove).
 */

const OLD_LINK = `/i/${MOCK_INTERVIEW_TOKEN}`;
const ASK = "Make a new link? The old link stops working.";
const REPLACED = "This link was replaced by a newer one. Ask the team that sent it for the new link.";

async function openInterview(page: Page) {
  await page.goto("/requests/interviews");
  await page.getByTestId("interview-row").filter({ hasText: "Ana Lima" }).click();
  await expect(page.getByTestId("interview-status")).toHaveText("Invited");
}

/** No element in `testId` is wider than its box (no text cut mid-word or scrolled away), and the page does not scroll sideways. */
async function expectNothingCut(page: Page, testId: string) {
  const cut = await page.getByTestId(testId).evaluate((root) =>
    [root, ...root.querySelectorAll<HTMLElement>("h2, p, span, button, dd, dt")]
      .filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== "auto")
      .map((el) => el.textContent),
  );
  expect(cut).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

async function makeNewLink(page: Page): Promise<string> {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await login(page);
  await openInterview(page);

  // Asked first; Cancel changes nothing.
  await page.getByRole("button", { name: "Make a new link" }).click();
  const dialog = page.getByTestId("new-link-dialog");
  await expect(dialog).toContainText(ASK);
  await expectNothingCut(page, "new-link-dialog");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await page.goto(OLD_LINK);
  await expect(page.getByRole("heading", { name: "Hi Ana Lima" })).toBeVisible();

  // Ana opened it, so the interview is in progress; the new link carries it on.
  await page.goBack();
  await expect(page.getByTestId("interview-status")).toHaveText("In progress");
  await page.getByRole("button", { name: "Make a new link" }).click();
  await dialog.getByRole("button", { name: "Make a new link" }).click();

  // Shown once, with Copy, as when the interview was first made.
  const field = dialog.getByTestId("interview-link");
  await expect(field).toHaveValue(/\/i\/i-/);
  const url = await field.inputValue();
  expect(url.endsWith(OLD_LINK)).toBe(false);
  await expect(dialog).toContainText("Copy it now: it shows only once.");
  await dialog.getByRole("button", { name: "Copy" }).click();
  await expect(dialog.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
  await expectNothingCut(page, "new-link-dialog");
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toHaveCount(0);

  // The page says when the link was made, and no longer offers to show the old one.
  await expect(page.getByTestId("interview-link-made")).toHaveText(/^Made [A-Z][a-z]{2} \d{1,2}/);
  await expect(page.getByTestId("interview-link-note")).toContainText("Make a new link");
  await expectNothingCut(page, "interview-about");
  return url;
}

async function oldAndNewLinks(page: Page, url: string) {
  await page.goto(OLD_LINK);
  await expect(page.getByTestId("interview-refused")).toHaveText(REPLACED);
  await page.goto(new URL(url).pathname);
  await expect(page.getByRole("heading", { name: "Hi Ana Lima" })).toBeVisible();
}

test("a member makes a new link; the old link says it was replaced", async ({ page }) => {
  // protects=qa-work-43 Make a new link (dialog, the link once with Copy, the made date, the old
  // link refused in plain words, the new link opens the interview); fails_when=there is no
  // button, it does not ask first, Cancel makes a link, the old link still opens or reads as
  // expired or used, or the new link does not open; no_claim=the API's hashing and audit
  // (api/tests/test_interviews.py).
  const url = await makeNewLink(page);
  await oldAndNewLinks(page, url);
});

test("a viewer is not offered a new link", async ({ page }) => {
  // protects=the creator-or-approver rule through the interview's can_manage; fails_when=a
  // viewer sees Make a new link; no_claim=the API's 403 (api/tests/test_interviews.py).
  await login(page, "viewer@example.com");
  await openInterview(page);
  await expect(page.getByTestId("interview-link-note")).toBeVisible();
  await expect(page.getByRole("button", { name: "Make a new link" })).toHaveCount(0);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  for (const scheme of ["light", "dark"] as const) {
    test(`make a new link at 390 px (${scheme})`, async ({ page }) => {
      // protects=the same flow on a phone, light and dark, with nothing cut or scrolled
      // sideways; fails_when=the dialog or the page overflows or a step is missing;
      // no_claim=a real phone's clipboard prompt.
      await page.emulateMedia({ colorScheme: scheme });
      const url = await makeNewLink(page);
      await oldAndNewLinks(page, url);
    });
  }
});

test.describe("desktop, dark", () => {
  test("make a new link (dark)", async ({ page }) => {
    // protects=the flow in dark mode on desktop; fails_when=a step is missing or text is cut;
    // no_claim=colour contrast (the ds tokens).
    await page.emulateMedia({ colorScheme: "dark" });
    const url = await makeNewLink(page);
    await oldAndNewLinks(page, url);
  });
});
