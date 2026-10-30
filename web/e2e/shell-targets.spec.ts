import { expect, test, type Locator, type Page } from "./test";

import { login } from "./helpers";

/*
 * Hit targets, the Plan crumb and the Not reviewed mark (qa-company-49, qa-plan-65, qa-plan-22,
 * qa-shell-28, qa-shell-29, qa-settings-9), on the mock API.
 *
 * Card: protects=the (i) tips and goal chips are at least 24 x 24 px on desktop and on a
 * 390 px phone; Changelog and Launches lead back with a "‹ Plan" link to
 * /plan, 24 px tall; the Not reviewed mark reads at 4.5:1 in light and dark; /design says it
 * is a developer page; fails_when=a target is under 24 px, the crumb says Roadmap, is plain
 * text or goes elsewhere, or the mark is a faint line colour; no_claim=every small control.
 */

const THEME_KEY = "oracle-theme";

async function expectTargets(targets: Locator, what: string) {
  await expect(targets.filter({ visible: true }).first()).toBeVisible();
  const boxes = await targets.evaluateAll((els) =>
    els.filter((el) => el.checkVisibility()).map((el) => {
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height, name: el.getAttribute("aria-label") ?? el.textContent ?? "" };
    }),
  );
  expect(boxes.length, `${what}: some are shown`).toBeGreaterThan(0);
  for (const b of boxes) {
    expect(b.w, `${what} "${b.name}" width`).toBeGreaterThanOrEqual(24);
    expect(b.h, `${what} "${b.name}" height`).toBeGreaterThanOrEqual(24);
  }
}

async function targetsOnHomeAndPlan(page: Page) {
  await login(page);
  await page.goto("/home");
  // qa-company-10: Home's goal names are links to the goal; the inspector's goals keep chips.
  await expectTargets(page.getByTestId("goal-open"), "/home goal link");
  await expectTargets(page.getByTestId("code-chip"), "/home goal chip");
  await expectTargets(page.getByTestId("info-tip"), "/home (i)");
  await page.goto("/plan");
  await expectTargets(page.getByTestId("info-tip"), "/plan (i)");
  await expectTargets(page.getByTestId("code-chip"), "/plan goal chip");
}

test("the (i) tips and goal chips are at least 24 x 24 px on desktop", async ({ page }) => {
  await targetsOnHomeAndPlan(page);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the (i) tips and goal chips are at least 24 x 24 px at 390 px", async ({ page }) => {
    await targetsOnHomeAndPlan(page);
  });

  test("the Plan crumb is a 24 px link on a phone too", async ({ page }) => {
    await login(page);
    await page.goto("/roadmap/launches");
    const crumb = page.getByRole("link", { name: "Back to Plan" }).filter({ visible: true });
    expect((await crumb.boundingBox())!.height).toBeGreaterThanOrEqual(24);
    await crumb.click();
    await expect(page).toHaveURL(/\/plan$/);
  });
});

test("Changelog and Launches lead back with a ‹ Plan link to /plan", async ({ page }) => {
  await login(page);
  for (const path of ["/roadmap/changelog", "/roadmap/launches"]) {
    await page.goto(path);
    const header = page.locator("header[data-page-header]").filter({ visible: true });
    const crumb = header.getByRole("link", { name: "Back to Plan" });
    await expect(crumb, path).toHaveText("‹ Plan");
    await expect(crumb, path).toHaveAttribute("href", "/plan");
    expect((await crumb.boundingBox())!.height, `${path}: crumb height`).toBeGreaterThanOrEqual(24);
  }
  await page.getByRole("link", { name: "Back to Plan" }).filter({ visible: true }).click();
  await expect(page).toHaveURL(/\/plan$/);
});

for (const theme of ["light", "dark"] as const) {
  test(`the Not reviewed mark reads at 4.5:1, and /design says it is a developer page (${theme})`, async ({ page }) => {
    await page.addInitScript(([key, t]) => localStorage.setItem(key, t), [THEME_KEY, theme]);
    await login(page);
    await page.goto("/design");
    await expect(page.getByRole("heading", { level: 1, name: "Design system (developers)" })).toBeVisible();
    await expect(page.getByTestId("design-developer-note")).toContainText("Developer page: the components the app is built from. Not part of the product.");
    const mark = page.getByTestId("design-gallery").locator('[data-testid="status-mark"][data-state="none"]').first();
    await expect(mark).toBeVisible();
    const ratio = await mark.evaluate((el) => {
      const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
      const lum = ([r, g, b]: number[]) => {
        const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      let bg: number[] = [255, 255, 255];
      for (let n: Element | null = el; n; n = n.parentElement) {
        const c = rgb(getComputedStyle(n).backgroundColor);
        if (c.length === 3 || (c.length === 4 && c[3] > 0.9)) {
          bg = c;
          break;
        }
      }
      const [a, b] = [lum(rgb(getComputedStyle(el).color)), lum(bg)].sort((x, y) => y - x);
      return (a + 0.05) / (b + 0.05);
    });
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
}
