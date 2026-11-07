import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * fix3, qa-simple-roadmap-4, moved onto mk-qa4-roadmap QR3 A: a broken link no longer draws a
 * callout over the chart; it sits in the "conflicts" panel above the Timeline, in the existing
 * callout's words and with its fixes, and every bar takes its own clicks. Driven against the
 * mock's default scenario (Weekly alert digest starts before Alert rules engine, which it
 * depends on, ends).
 */

const DESKTOP = { viewport: { width: 1366, height: 820 } };
/** A narrow desktop: the panel's words and fixes still fit inside it. */
const NARROW = { viewport: { width: 1024, height: 820 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

async function open(page: Page, scheme: "light" | "dark") {
  await page.context().addInitScript(([themeKey, theme]) => localStorage.setItem(themeKey, theme), [THEME_KEY, scheme] as const);
  await page.emulateMedia({ colorScheme: scheme });
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-view", "zoom");
}

/**
 * An item's link to what it depends on in the panel. Since pre-demo QA S-5 and S-14 (7821685f4,
 * efd457e59) the digest's end past its milestone is listed under it too, by name with its
 * sentence behind an (i): this is its dependency break.
 */
const conflict = (page: Page, key: string) => page.locator(`[data-testid="conflict"][data-item="${key}"]`).filter({ hasText: "starts" });

for (const scheme of ["light", "dark"] as const) {
  test.describe(`desktop, ${scheme}`, () => {
    test.use({ ...DESKTOP, colorScheme: scheme });

    test(`a broken link sits in the panel above the Timeline and covers no bar (${scheme})`, async ({ page }) => {
      await open(page, scheme);
      const c = conflict(page, "alert-digest");
      await expect(c).toBeVisible();
      // The panel names both items, in the existing callout's words.
      await expect(c).toContainText("Weekly alert digest");
      await expect(c).toContainText("Alert rules engine");
      await expect(c).toContainText("which it depends on, ends");
      // No callout is drawn on the chart any more.
      await expect(page.getByTestId("broken-callout")).toHaveCount(0);
      // The broken item's row is marked.
      await expect(page.locator('[data-testid="timeline-row"][data-item="alert-digest"]').getByLabel("Broken link")).toBeVisible();
      // Every bar in sight takes its own clicks (nothing drawn over its middle).
      const hit = await page.getByTestId("timeline-bar").evaluateAll((els) =>
        els
          .map((b) => {
            // A bar that starts before the chart's scroll runs under the names fixed on the left
            // (mk-qa4-roadmap QR1 A): its part in sight starts at the names' right edge.
            const names = b.closest('[data-testid="timeline-row"]')?.querySelector("button")?.getBoundingClientRect().right ?? 0;
            const r = b.getBoundingClientRect();
            const x0 = Math.max(r.x, names);
            return { b, r, x0, w: r.x + r.width - x0 };
          })
          .filter(({ r, w }) => w > 24 && r.x + r.width <= innerWidth && r.y >= 0 && r.y + r.height <= innerHeight)
          .map(({ b, r, x0, w }) => {
            const at = document.elementFromPoint(x0 + Math.min(w / 2, 12), r.y + r.height / 2);
            return { key: b.closest("[data-item]")?.getAttribute("data-item"), ok: !!at && b.contains(at) };
          }),
      );
      expect(hit.filter((h) => !h.ok)).toEqual([]);
      // Another item still opens in the side panel.
      await page.locator('[data-testid="timeline-row"][data-item="alert-mobile"]').getByRole("button").first().click();
      await expect(page.locator('[data-testid="timeline-row"][data-item="alert-mobile"]')).toHaveAttribute("data-open", "true");
      await expect(page.getByTestId("item-panel")).toBeVisible();
      // The panel still opens its fixes.
      await c.getByRole("button", { name: "Accept as risk" }).click();
      await expect(page.getByLabel("Why it is an accepted risk")).toBeVisible();
    });
  });
}

// cld-9: the narrow desktop runs in light and dark.
for (const scheme of ["light", "dark"] as const) {
  test.describe(`narrow desktop, ${scheme}`, () => {
    test.use({ ...NARROW, colorScheme: scheme });

    test(`on a narrow desktop the broken link's fixes stay whole inside its panel (${scheme})`, async ({ page }) => {
      await open(page, scheme);
      const panel = page.getByTestId("conflicts");
      const c = conflict(page, "alert-digest");
      await expect(c).toBeVisible();
      const pb = (await panel.boundingBox())!;
      const accept = c.getByRole("button", { name: "Accept as risk" });
      const ab = (await accept.boundingBox())!;
      expect(ab.x, "the fix starts inside the panel").toBeGreaterThanOrEqual(pb.x);
      expect(ab.x + ab.width, "the fix ends inside the panel").toBeLessThanOrEqual(pb.x + pb.width);
      await accept.click();
      await expect(page.getByLabel("Why it is an accepted risk")).toBeVisible();
    });
  });
}

test.describe("phone", () => {
  test.use(PHONE);

  // A phone's Timeline is a list: no callout; the broken item is marked in its row, its link in the panel.
  test("the phone's Timeline draws no callout; the broken item is marked in the list", async ({ page }) => {
    await login(page);
    await page.goto("/simple/roadmap");
    await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-view", "zoom");
    await expect(page.getByTestId("timeline-list")).toBeVisible();
    const row = page.locator('[data-testid="timeline-row"][data-item="alert-digest"]');
    await expect(row).toBeVisible();
    await expect(row).toContainText("⚠ Broken link");
    await expect(conflict(page, "alert-digest")).toContainText("which it depends on, ends");
    await expect(page.getByTestId("broken-callout")).toHaveCount(0);
  });
});
