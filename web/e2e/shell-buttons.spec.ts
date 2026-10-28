import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * Buttons (qa-settings-6, qa-plan-64, qa-company-30, qa-shell-30), on the mock API in light
 * and dark: a disabled button reads as disabled (a muted neutral fill, never the accent, its
 * text still 4.5:1), an enabled solid button is a full-contrast accent fill, every button
 * takes the page's one focus ring, and a ritual's Save says "No changes" until something changed.
 *
 * Card: protects=the disabled and solid looks and the ritual's Save; fails_when=a disabled
 * primary keeps an accent tint or drops under 4.5:1, an enabled solid is a pale tint, the
 * focus ring differs by variant, or Save is enabled with nothing to save; no_claim=hover.
 */

/** lib/theme.ts THEME_KEY: the user's theme choice, as the user menu's Theme radio saves it. */
const THEME_KEY = "oracle-theme";

/** The colour a CSS colour token computes to, as rgb(). */
async function tokenColour(page: Page, token: string): Promise<string> {
  return page.evaluate((t) => {
    const el = document.createElement("span");
    el.style.color = `var(${t})`;
    document.body.append(el);
    const c = getComputedStyle(el).color;
    el.remove();
    return c;
  }, token);
}

async function colours(button: Locator): Promise<{ bg: string; ratio: number }> {
  return button.evaluate((el) => {
    const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    // Read the settled colours, not a frame of the colour transition.
    el.getAnimations().forEach((a) => a.finish());
    const s = getComputedStyle(el);
    const [a, b] = [lum(rgb(s.color)), lum(rgb(s.backgroundColor))].sort((x, y) => y - x);
    return { bg: s.backgroundColor, ratio: (a + 0.05) / (b + 0.05) };
  });
}

for (const theme of ["light", "dark"] as const) {
  test.describe(theme, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript(([key, t]) => localStorage.setItem(key, t), [THEME_KEY, theme]);
    });

    test(`a disabled primary is a muted neutral fill at 4.5:1, and one focus ring serves every variant (${theme})`, async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "launches"));
      await login(page);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await page.goto("/roadmap/changelog");
      await page.getByTestId("new-entry").click();
      const dialog = page.getByRole("dialog", { name: "New entry" });
      const add = dialog.getByRole("button", { name: "Add entry" });
      await expect(add).toBeDisabled();
      const accent = await tokenColour(page, "--accent");
      const off = await colours(add);
      expect(off.bg, "a disabled primary is not the accent").not.toBe(accent);
      expect(off.bg).toBe(await tokenColour(page, "--surface2"));
      expect(off.ratio, "its text reads at 4.5:1").toBeGreaterThanOrEqual(4.5);
      expect(await add.evaluate((el) => getComputedStyle(el).cursor)).toBe("not-allowed");

      // Enabled: the accent fill.
      await dialog.getByLabel("Title").fill("Ring check");
      await expect(add).toBeEnabled();
      const on = await colours(add);
      expect(on.bg).toBe(accent);
      expect(on.ratio).toBeGreaterThanOrEqual(4.5);

      // One ring: Tab from the body to Cancel (outline) and on to Add entry (filled).
      const ring = (b: Locator) =>
        b.evaluate((el) => {
          const s = getComputedStyle(el);
          return `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor} ${s.outlineOffset}`;
        });
      await dialog.getByLabel("What changed").focus();
      await page.keyboard.press("Tab");
      const cancel = dialog.getByRole("button", { name: "Cancel" });
      await expect(cancel).toBeFocused();
      const cancelRing = await ring(cancel);
      await page.keyboard.press("Tab");
      await expect(add).toBeFocused();
      const addRing = await ring(add);
      expect(cancelRing).toBe(`solid 2px ${accent} 2px`);
      expect(addRing).toBe(cancelRing);
    });

    test(`a ritual's Save says No changes until something changed, then is an accent solid (${theme})`, async ({ page }) => {
      await page.clock.install({ time: new Date("2026-10-23T12:00:00Z") });
      await page.addInitScript((key) => localStorage.setItem(key, "rituals"), MOCK_SCENARIO_KEY);
      await login(page);
      await page.goto("/company/rituals");
      await page.getByTestId("ritual-row").filter({ hasText: "Monthly roadmap refresh" }).click();
      const panel = page.getByTestId("ritual-inspector").filter({ visible: true });
      const save = panel.getByRole("button", { name: "Save" });
      await expect(save).toBeDisabled();
      await expect(panel.getByTestId("ritual-no-changes")).toHaveText("No changes");
      const accent = await tokenColour(page, "--accent");
      const off = await colours(save);
      expect(off.bg).not.toBe(accent);
      expect(off.ratio).toBeGreaterThanOrEqual(4.5);

      await panel.getByLabel("Length (minutes)").fill("47");
      await expect(save).toBeEnabled();
      await expect(panel.getByTestId("ritual-no-changes")).toHaveCount(0);
      await expect(save).toHaveAttribute("data-variant", "solid");
      const on = await colours(save);
      expect(on.bg, "an enabled solid is the accent fill").toBe(accent);
      expect(on.ratio).toBeGreaterThanOrEqual(4.5);
    });
  });
}
