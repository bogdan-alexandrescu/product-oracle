import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY } from "../lib/api/mock/server";
import { ADMIN, login } from "./helpers";

/*
 * The review of the shell's QA pass 2: Home's inspector shows its stat and blocker words whole,
 * an old one-pager link lands on the one-pager's own path, the account menu stays by its avatar
 * while the window changes, sign-in never waits forever, the mode switch's arrow keys move
 * focus without leaving the page, and the rail never scrolls sideways.
 * protects = what a person sees and does in the shell; fails_when = any of those comes back;
 * no_claim = the pages' own content.
 */

const OWNER_WINDOW = { width: 1512, height: 900 };
const PHONE = { width: 390, height: 844 };

/** True when the element's text is cut (it is wider than its box). */
const cut = (l: Locator) => l.evaluate((el) => el.scrollWidth > el.clientWidth + 1);

async function holdCall(page: Page, call: string, ms: number) {
  await page.evaluate(
    ([key, value, msKey, wait]) => {
      localStorage.setItem(key, value);
      localStorage.setItem(msKey, wait);
    },
    [MOCK_SLOW_KEY, call, MOCK_SLOW_MS_KEY, String(ms)],
  );
}

for (const [name, size] of [
  ["desktop", OWNER_WINDOW],
  ["phone", PHONE],
] as const) {
  test(`qa-shell-17 (${name}): Home's inspector says Sections approved and its blockers whole`, async ({ page }) => {
    await page.setViewportSize(size);
    await login(page);
    const inspector = page.getByTestId("home-inspector");
    await expect(inspector.getByRole("heading", { name: "Checkout redesign PRD" })).toBeVisible();
    const label = inspector.getByTestId("stat-sections").locator("dt");
    await expect(label).toHaveText("Sections approved");
    expect(await cut(label.locator("span").first())).toBe(false);
    const blockers = inspector.getByTestId("inspector-blocker");
    await expect(blockers.first()).toBeVisible();
    await expect(
      blockers.filter({
        hasText: "The address lookup service allows 100 requests",
      }),
    ).toHaveCount(1);
    for (const row of await blockers.all()) {
      // Neither the row nor anything holding it cuts the words.
      expect(await row.evaluate((el) => [el, el.parentElement!].some((e) => e.scrollWidth > e.clientWidth + 1))).toBe(false);
      expect(await cut(row.locator("span").last())).toBe(false);
    }
  });
}

test("qa-shell-4: an old /simple/prds link opens the one-pager at its own path", async ({ page }) => {
  await login(page);
  await page.goto("/simple/prds/checkout-redesign");
  await expect(page).toHaveURL(/\/simple\/one-pagers\/checkout-redesign$/);
  await expect(page.getByTestId("one-pager-meta")).toBeVisible();
});

test.describe("on a short window", () => {
  test.use({ viewport: { width: 1366, height: 600 } });
  test("UserMenu: the account menu follows its avatar when the rail scrolls while it is open", async ({ page }) => {
    await login(page);
    const rail = page.getByTestId("app-nav");
    const avatar = page.getByTestId("user-menu");
    await avatar.scrollIntoViewIfNeeded();
    await avatar.click();
    const menu = page.getByRole("dialog", { name: "Account" });
    await expect(menu).toBeInViewport({ ratio: 1 });
    const railBox = await rail.boundingBox();
    await page.mouse.move(railBox!.x + 44, railBox!.y + 300);
    await page.mouse.wheel(0, -40);
    await expect.poll(() => rail.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeGreaterThan(5);
    await expect(menu).toBeVisible();
    // Its foot level with the avatar's (kept on screen), not where the avatar was.
    await expect
      .poll(async () => {
        const a = (await avatar.boundingBox())!;
        const m = (await menu.boundingBox())!;
        return Math.abs(m.y + m.height - Math.min(a.y + a.height, 600 - 8));
      })
      .toBeLessThanOrEqual(2);
  });
});

test("LoginForm: a session check that never answers still gives the form", async ({ page }) => {
  await page.goto("/login");
  await holdCall(page, "GET /v1/auth/access", 600_000);
  await page.reload();
  await expect(page.getByTestId("login-checking")).toBeVisible();
  await page.clock.fastForward(11_000);
  await expect(page.getByLabel("Email")).toBeVisible();
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
});

test.describe("LoginForm without JavaScript", () => {
  test.use({ javaScriptEnabled: false });
  test("says sign-in needs JavaScript instead of a blank card", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByText("Signing in needs JavaScript")).toBeVisible();
  });
});

test("ModeSwitch: an arrow key moves focus within the switch; Enter opens the other mode", async ({ page }) => {
  await login(page);
  const mode = page.getByRole("radiogroup", { name: "Mode" }).filter({ visible: true });
  await mode.getByRole("radio", { name: "Detailed" }).focus();
  await page.keyboard.press("ArrowUp");
  await expect(mode.getByRole("radio", { name: "Simple" })).toBeFocused();
  await expect(page).toHaveURL(/\/home$/);
  await page.keyboard.press("ArrowDown");
  await expect(mode.getByRole("radio", { name: "Detailed" })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/simple$/);
});

test("Inbox badge: the rail never scrolls sideways and the badge stays inside it", async ({ page }) => {
  await login(page);
  const rail = page.getByTestId("app-nav");
  expect(await rail.evaluate((el) => getComputedStyle(el).overflowX)).toBe("hidden");
  const badge = rail.getByTestId("nav-inbox-badge");
  await expect(badge).toBeVisible();
  const r = await rail.boundingBox();
  const b = await badge.boundingBox();
  expect(b!.x + b!.width).toBeLessThanOrEqual(r!.x + r!.width);
});
