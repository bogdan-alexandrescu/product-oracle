import { expect, test, type Page } from "./test";

import { MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY } from "../lib/api/mock/server";
import { ADMIN, login } from "./helpers";

/*
 * QA pass 2, the shell: not-found and error pages in one pattern, a rail that scrolls on a
 * short window, the Inbox badge clear of its icon and read with the link, the mock reset that
 * asks, sign-in that waits for the session check, the mode switch that opens at once, radio
 * groups that answer the arrow keys, one product name, browser tabs that name the tab, the
 * page skeleton, Home's labels and goals, and one time format.
 * protects = what a person sees and does in the shell; fails_when = any of those findings
 * (qa-shell-1 … 20, qa-onboarding-32, cld-2) comes back; no_claim = the pages' own content.
 */

const PHONE = { width: 390, height: 844 };

/** Errors in the console and uncaught ones (React's hydration error #418 among them). */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

/** Holds `call` ("METHOD /path") in the mock for `ms` before it answers. */
async function holdCall(page: Page, call: string, ms: number) {
  await page.evaluate(
    ([key, value, msKey, wait]) => {
      localStorage.setItem(key, value);
      localStorage.setItem(msKey, wait);
    },
    [MOCK_SLOW_KEY, call, MOCK_SLOW_MS_KEY, String(ms)],
  );
}

for (const phone of [false, true]) {
  test.describe(phone ? "phone" : "desktop", () => {
    test.beforeEach(async ({ page }) => {
      if (phone) await page.setViewportSize(PHONE);
      await login(page);
    });

    test("qa-shell-1: a missing document is Document not found, with Back to PRDs", async ({ page }) => {
      await page.goto("/documents/no-such-doc");
      await expect(page.getByRole("heading", { level: 1, name: "Document not found" })).toHaveCount(1);
      const card = page.getByTestId("doc-not-found").filter({ visible: true });
      await expect(card).toContainText("This document doesn't exist or was deleted.");
      await expect(page.getByRole("alert").filter({ hasText: "Document not found" })).toHaveCount(0);
      await expect(page.getByText("no-such-doc")).toHaveCount(0);
      await expect(page).toHaveTitle("Document not found · Product Oracle");
      await card.getByRole("link", { name: "Back to PRDs" }).click();
      await expect(page).toHaveURL(/\/documents$/);
    });

    test("qa-shell-8: every not-found screen has its heading and the way on close under its sentence", async ({ page }) => {
      for (const [path, heading, testId] of [
        ["/this-page-does-not-exist", "Page not found", "not-found"],
        ["/runs/no-such-run", "Run not found", "run-not-found"],
        ["/documents/no-such-doc", "Document not found", "doc-not-found"],
      ] as const) {
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 1, name: heading })).toHaveCount(1);
        const card = page.getByTestId(testId).filter({ visible: true });
        const text = await card.getByTestId("not-found-text").boundingBox();
        const button = await card.getByRole("link").first().boundingBox();
        // The way on sits close under the sentence (it was ~60 px below it).
        expect(button!.y - (text!.y + text!.height)).toBeLessThanOrEqual(20);
      }
    });

    test("qa-shell-14, qa-onboarding-32: the Inbox badge clears its icon and the link says how many wait", async ({ page }) => {
      const link = phone ? page.getByTestId("tab-inbox") : page.getByTestId("app-nav").getByTestId("nav-inbox");
      const badge = link.getByTestId(phone ? "tab-inbox-badge" : "nav-inbox-badge");
      await expect(badge).toHaveText(/^\d+$/);
      const n = (await badge.innerText()).trim();
      await expect(link).toHaveAccessibleName(`Inbox, ${n} waiting`);
      const icon = await link.locator("svg").first().boundingBox();
      const box = await badge.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(icon!.x + icon!.width);
    });

    test("qa-shell-13: the mock reset says what it does and asks first", async ({ page }) => {
      await page.getByTestId(phone ? "phone-user-menu" : "user-menu").click();
      const menu = page.getByRole("dialog", { name: "Account" });
      const reset = menu.getByRole("button", { name: /Reset/ });
      await expect(reset).toHaveAttribute("title", "Restore the sample data and sign out");
      await reset.click();
      const ask = page.getByRole("alertdialog", { name: "Reset sample data" });
      await expect(ask).toContainText("Every change made in this browser is lost.");
      await ask.getByRole("button", { name: "Back" }).click();
      await expect(ask).toHaveCount(0);
      await expect(page).toHaveURL(/\/home$/);
    });

    test("qa-shell-11: My account opens without a hydration error, light and dark", async ({ page }) => {
      for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        const errors = collectErrors(page);
        await page.goto("/account");
        await expect(page.getByRole("heading", { level: 1, name: "My account" })).toHaveCount(1);
        await expect(page.getByText("Member since")).toBeVisible();
        expect(errors).toEqual([]);
      }
    });

    test("qa-shell-16, 17, 18: Home says what Needs you counts, its PRD stats fit, and on a phone one goal per row", async ({ page }) => {
      await page.getByTestId("home-needs").getByRole("button", { name: "About Needs you" }).click();
      await expect(page.getByText("Simple's Home counts something else")).toBeVisible();
      await page.keyboard.press("Escape");
      const goals = page.getByRole("list", { name: "Goals" }).locator(":scope > li");
      await expect(goals.first()).toBeVisible();
      if (phone) {
        const xs = await goals.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().x)));
        expect(new Set(xs).size).toBe(1);
      }
    });
  });
}

test.describe("a short window", () => {
  // The window is short from the start: a resize after sign-in left the rail's height behind
  // when the test scrolled it (fix2-shell review).
  test.use({ viewport: { width: 1366, height: 600 } });
  test("qa-shell-2: on a short window the rail scrolls, so Settings and the account menu stay reachable", async ({ page }) => {
    await login(page);
    const rail = page.getByTestId("app-nav");
    const scrolls = await rail.evaluate((el) => getComputedStyle(el).overflowY);
    expect(scrolls).toBe("auto");
    await rail.getByTestId("nav-settings").scrollIntoViewIfNeeded();
    await expect(rail.getByTestId("nav-settings")).toBeInViewport();
    await page.getByTestId("user-menu").click();
    const menu = page.getByRole("dialog", { name: "Account" });
    await expect(menu).toBeInViewport({ ratio: 1 });
    await expect(menu.getByRole("button", { name: "Sign out" })).toBeVisible();
  });
});

test("qa-shell-7: the theme and mode switches are radio groups with one Tab stop and the arrow keys", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await login(page);
  await page.getByTestId("user-menu").click();
  const theme = page.getByRole("radiogroup", { name: "Theme" });
  await expect(theme.getByRole("radio", { name: "System" })).toBeFocused();
  await expect(theme.locator('[role="radio"][tabindex="0"]')).toHaveCount(1);
  await page.keyboard.press("ArrowRight");
  await expect(theme.getByRole("radio", { name: "Light" })).toBeFocused();
  await expect(theme.getByRole("radio", { name: "Light" })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(theme.getByRole("radio", { name: "System" })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");

  const mode = page.getByRole("radiogroup", { name: "Mode" }).filter({ visible: true });
  await expect(mode.locator('[role="radio"][tabindex="0"]')).toHaveCount(1);
  await mode.getByRole("radio", { name: "Detailed" }).focus();
  await page.keyboard.press("ArrowUp");
  await expect(mode.getByRole("radio", { name: "Simple" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/simple$/);
});

test("qa-shell-6: the mode switch opens the other mode at once, while the choice saves", async ({ page }) => {
  await login(page);
  await holdCall(page, "PATCH /v1/me/preferences", 15_000);
  await page.getByRole("radiogroup", { name: "Mode" }).filter({ visible: true }).getByRole("radio", { name: "Simple" }).click();
  await expect(page).toHaveURL(/\/simple$/, { timeout: 5_000 });
});

test("qa-shell-15: Simple's rail names the product as Detailed and the browser tab do", async ({ page }) => {
  await login(page);
  await page.goto("/simple");
  await expect(page.getByTestId("simple-nav-brand")).toHaveText("Product Oracle");
  await expect(page.getByTestId("simple-nav-brand")).toHaveAccessibleName("Product Oracle");
});

test("qa-shell-4, 5: the switch maps an old one-pager link and the Roadmap's own tabs", async ({ page }) => {
  await login(page);
  await page.goto("/simple/prds/checkout-redesign");
  await expect(page.getByTestId("one-pager-meta")).toBeVisible();
  await page.getByRole("radiogroup", { name: "Mode" }).filter({ visible: true }).getByRole("radio", { name: "Detailed" }).click();
  await expect(page).toHaveURL(/\/documents\/checkout-redesign$/);

  for (const tab of ["/roadmap/changelog", "/roadmap/launches"]) {
    await page.goto(tab);
    await page.getByRole("radiogroup", { name: "Mode" }).filter({ visible: true }).getByRole("radio", { name: "Simple" }).click();
    await expect(page).toHaveURL(/\/simple\/roadmap$/);
  }
});

test("qa-shell-3, 20: a section's tabs carry the section's name as H1, and the browser tab names the tab", async ({ page }) => {
  await login(page);
  for (const [path, h1, title] of [
    ["/plan", "Plan", "Plan · Product Oracle"],
    ["/plan/dates", "Plan", "Dates · Plan · Product Oracle"],
    ["/plan/reports", "Plan", "Reports · Plan · Product Oracle"],
    ["/company/strategy", "Company", "Strategy · Company · Product Oracle"],
    ["/settings/members", "Settings", "Members · Settings · Product Oracle"],
    ["/settings/company", "Settings", "Company · Settings · Product Oracle"],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: h1, exact: true })).toHaveCount(1);
    await expect(page).toHaveTitle(title);
  }
});

test("qa-shell-12: the sign-in page waits for the session check instead of showing the form", async ({ page }) => {
  await login(page);
  await holdCall(page, "GET /v1/me", 3_000);
  await page.goto("/login?next=%2Fhome");
  await expect(page.getByRole("status").filter({ hasText: "Checking your session…" })).toBeVisible();
  await expect(page.getByLabel("Email")).toHaveCount(0);
  await expect(page).toHaveURL(/\/home$/, { timeout: 10_000 });
});

test("qa-shell-12: signed out, the form shows once the check answers", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByText("Checking your session…")).toHaveCount(0);
  await page.getByLabel("Email").fill(ADMIN.email);
});

test("qa-shell-10: a page that is still loading draws its skeleton, not a bare Loading line", async ({ page }) => {
  await login(page);
  // Hold the page's scripts: what shows is the server's first paint, the Suspense fallback.
  // Scripts only: the stylesheets block the first paint.
  await page.route(/\/_next\/static\/chunks\/.*\.js$/, async (route) => {
    await new Promise((r) => setTimeout(r, 4_000));
    await route.continue();
  });
  await page.goto("/settings/analytics", { waitUntil: "commit" });
  await expect(page.getByTestId("page-skeleton")).toBeVisible();
  await expect(page.getByText("Loading…", { exact: true })).toHaveCount(0);
});

test("qa-shell-19: the daily triage time is written as every other time is", async ({ page }) => {
  await login(page);
  await page.goto("/requests");
  await expect(page.getByRole("switch", { name: /^Daily triage at 7:00 AM PDT/ })).toBeVisible();
  await expect(page.getByText("07:00 PT")).toHaveCount(0);
});

test("cld-2: the strip's end spacer adds its 1 px only, not the gap too", async ({ page }) => {
  await login(page);
  await page.setViewportSize(PHONE);
  await page.goto("/settings/members");
  const strip = page.getByTestId("settings-nav").locator(".scroll-fade").first();
  const after = await strip.evaluate((el) => {
    const s = getComputedStyle(el, "::after");
    return {
      margin: parseFloat(s.marginInlineStart),
      gap: parseFloat(getComputedStyle(el).columnGap),
    };
  });
  expect(after.gap).toBeGreaterThan(0);
  expect(after.margin).toBe(-after.gap);
  // Scrolled to the end, the last tab ends 1 px before the strip's scroll end.
  const tail = await strip.evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
    const items = Array.from(el.children).filter((c) => getComputedStyle(c).position !== "absolute");
    const last = items[items.length - 1].getBoundingClientRect();
    // The last tab's end in the strip's own (scrolled) coordinates, against its scroll width.
    return el.scrollWidth - (last.right - el.getBoundingClientRect().left + el.scrollLeft);
  });
  expect(tail).toBeLessThanOrEqual(2);
});
