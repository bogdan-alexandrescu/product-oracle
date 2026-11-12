import { login, openRoadmapItem } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * Pre-demo QA of Simple's one feature panel (the panel every page opens for a feature).
 * S-4: 'Needed by' is edited as 'Depends on' is: remove a feature that needs this one, add one,
 * with the same loop words and Undo. P-6 / L-2: a feature the Goal map draws under a goal (its
 * chip on the goals by tracks grid) reads that goal and its measure in the panel. P-8: on a 390
 * phone every tap target in the sheet is at least 44 px. P-10: in dark the selected Details / Talk
 * to Oracle tab stands out. Mock default scenario (invented data); owner and viewer; light and
 * dark; 1440 and 390.
 */

const SIZES = [
  { name: "1440", phone: false, use: { viewport: { width: 1440, height: 900 } } },
  { name: "390", phone: true, use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } },
];
const SCHEMES = ["light", "dark"] as const;

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

const panel = (page: Page) => page.getByTestId("floating-card");

async function openItem(page: Page, key: string, email?: string) {
  await login(page, email);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await openRoadmapItem(page, key);
  await expect(panel(page)).toBeVisible();
}

/** The relative luminance of a CSS rgb() colour. */
function luminance(css: string): number {
  const [r, g, b] = (css.match(/[\d.]+/g) ?? ["0", "0", "0"]).slice(0, 3).map((v) => {
    const c = Number(v) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

for (const size of SIZES) {
  for (const scheme of SCHEMES) {
    test.describe(`${size.name} ${scheme}`, () => {
      test.use({ ...size.use, colorScheme: scheme });

      test("S-4: a feature that needs this one is removed and added here, with Undo and the loop words", async ({ page }) => {
        await openItem(page, "alert-rules");
        const needed = panel(page).getByTestId("card-needed");
        await expect(needed).toContainText("Mobile alert push");
        await tap(panel(page).getByRole("button", { name: "Remove Mobile alert push from what needs it" }));
        await expect(page.getByText("Dependency removed in your working draft")).toBeVisible();
        await expect(needed.getByTestId("card-needed-row").filter({ hasText: "Mobile alert push" })).toHaveCount(0);
        await expect(needed).toContainText("Weekly alert digest");
        await tap(page.getByTestId("toasts").getByRole("button", { name: "Undo" }));
        await expect(needed.getByTestId("card-needed-row").filter({ hasText: "Mobile alert push" })).toBeVisible();

        // Add one: it now depends on this one.
        await tap(panel(page).getByRole("button", { name: "Add a feature that needs it" }));
        await panel(page).getByLabel("Feature that needs it").selectOption({ label: "Alert history export" });
        await tap(panel(page).getByRole("button", { name: "Save" }));
        await expect(needed.getByTestId("card-needed-row").filter({ hasText: "Alert history export" })).toBeVisible();
        await tap(needed.getByRole("button", { name: "Alert history export", exact: true }));
        await expect(panel(page).getByTestId("card-depends")).toContainText("Alert rules engine");
      });

      test("S-4: a feature this one already waits on would make a loop", async ({ page }) => {
        await openItem(page, "alert-digest");
        await tap(panel(page).getByRole("button", { name: "Add a feature that needs it" }));
        const loop = panel(page).getByLabel("Feature that needs it").locator("option", { hasText: "Alert rules engine" });
        await expect(loop).toHaveText(/Alert rules engine · This one needs it: it would make a loop/);
        await expect(loop).toBeDisabled();
      });

      test("S-4: a feature that would close a loop through others is refused with the loop named", async ({ page }) => {
        // Alert history export now waits on Alert rules engine; Alert routing by team waits on Alert history export.
        await openItem(page, "alert-export");
        await tap(panel(page).getByRole("button", { name: "Add a dependency" }));
        await panel(page).getByLabel("Feature it depends on").selectOption({ label: "Alert rules engine" });
        await tap(panel(page).getByRole("button", { name: "Save" }));
        const needed = panel(page).getByTestId("card-needed");
        await expect(needed).toContainText("Alert routing by team");
        await expect(panel(page).getByTestId("card-depends")).toContainText("Alert rules engine");
        await tap(needed.getByRole("button", { name: "Alert routing by team", exact: true }));
        await expect(panel(page).getByTestId("card-depends")).toContainText("Alert history export");

        // From Alert routing by team, a feature it waits on (directly or through others) would make a loop.
        await tap(panel(page).getByRole("button", { name: "Add a feature that needs it" }));
        const pick = panel(page).getByLabel("Feature that needs it");
        for (const name of ["Alert history export", "Alert rules engine"]) {
          const loop = pick.locator("option", { hasText: name });
          await expect(loop).toHaveText(`${name} · This one needs it: it would make a loop`);
          await expect(loop).toBeDisabled();
        }
        const free = pick.locator("option", { hasText: "Weekly alert digest" });
        await expect(free).toBeEnabled();
        await expect(free).not.toContainText("loop");
        // Nothing is picked, so nothing can be saved, and nothing was added.
        await expect(panel(page).getByRole("button", { name: "Save" })).toBeDisabled();
        await expect(panel(page).getByTestId("card-needed")).not.toContainText("Alert rules engine");
      });

      test("S-4: the server's refusal of a loop reads the same words (a typed key on the Depends on side)", async ({ page }) => {
        // The Needed by picker never lets a loop through, so the server's refusal is reached from the other side.
        await openItem(page, "alert-rules");
        await tap(panel(page).getByRole("button", { name: "Add a dependency" }));
        await panel(page).getByLabel("Or another PRD's feature key").fill("F-06");
        await tap(panel(page).getByRole("button", { name: "Save" }));
        const refusal = page.getByTestId("toasts").getByText(/^Not added, it would make a loop/);
        await expect(refusal).toBeVisible();
        await expect(refusal).toContainText("Weekly alert digest");
        await expect(refusal).toContainText("Alert rules engine");
        await expect(panel(page).getByTestId("card-depends")).not.toContainText("Weekly alert digest");
      });

      test("S-4: a viewer reads 'Needed by' with no edit controls", async ({ page }) => {
        await openItem(page, "alert-rules", "viewer@example.com");
        await expect(panel(page).getByTestId("card-needed")).toContainText("Mobile alert push");
        await expect(panel(page).getByRole("button", { name: /from what needs it$/ })).toHaveCount(0);
        await expect(panel(page).getByRole("button", { name: "Add a feature that needs it" })).toHaveCount(0);
      });

      for (const email of [undefined, "viewer@example.com"]) {
        test(`P-6: a feature on the Goal map reads its goal and measure (${email ?? "owner"})`, async ({ page }) => {
          await login(page, email);
          await page.goto("/simple/goals");
          await expect(page.getByTestId("gm-grid")).toBeVisible();
          // The feature's chip on the goals by tracks grid: a tap opens the one feature panel.
          const chip = page.getByTestId("gm-chip").filter({ hasText: "One-tap sign-up link" }).first();
          await tap(chip.getByRole("button").first());
          await expect(page.getByTestId("gm-feature-panel")).toBeVisible();
          await expect(panel(page).getByTestId("card-goal")).toHaveText("Sign-ups per rep per day");
          await expect(panel(page).getByTestId("card-goal-measure")).toHaveText("sign-ups per rep per day");
        });
      }

      if (size.phone) {
        test("P-8: the sheet's tap targets are at least 44 px", async ({ page }) => {
          await openItem(page, "alert-digest");
          const targets = [
            panel(page).getByRole("button", { name: "Change the dates" }),
            panel(page).getByRole("button", { name: "Why these dates" }),
            panel(page).getByRole("button", { name: "Add a dependency" }),
            panel(page).getByRole("button", { name: "Remove Alert rules engine from what it depends on" }),
            panel(page).getByRole("button", { name: "Add a feature that needs it" }),
          ];
          for (const t of targets) {
            await t.evaluate((el) => el.scrollIntoView({ block: "center" }));
            const box = await t.boundingBox();
            expect(box, await t.getAttribute("aria-label") ?? "").not.toBeNull();
            expect(box!.width).toBeGreaterThanOrEqual(44);
            expect(box!.height).toBeGreaterThanOrEqual(44);
          }
        });

        test("P-10: the selected tab stands out from the one not selected", async ({ page }) => {
          await openItem(page, "alert-digest");
          const on = panel(page).getByRole("tab", { name: "Details" });
          const off = panel(page).getByRole("tab", { name: "Talk to Oracle" });
          await expect(on).toHaveAttribute("aria-selected", "true");
          const bg = async (l: Locator) => l.evaluate((el) => getComputedStyle(el).backgroundColor);
          const list = await panel(page).getByRole("tablist").evaluate((el) => getComputedStyle(el).backgroundColor);
          const offBg = (await bg(off)) === "rgba(0, 0, 0, 0)" ? list : await bg(off);
          expect(contrast(await bg(on), offBg)).toBeGreaterThanOrEqual(scheme === "dark" ? 1.6 : 1.05);
        });

        test("P-10: the selected tab is marked in dark (white words on the accent); in light it keeps the panel's own colours", async ({ page }) => {
          await openItem(page, "alert-digest");
          const on = panel(page).getByRole("tab", { name: "Details" });
          const off = panel(page).getByRole("tab", { name: "Talk to Oracle" });
          await expect(on).toHaveAttribute("aria-selected", "true");
          const css = (l: Locator) => l.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, ink: getComputedStyle(el).color }));
          const sheet = await css(panel(page));
          const picked = await css(on);
          if (scheme === "dark") {
            expect(picked).toEqual({ bg: "rgb(31, 74, 122)", ink: "rgb(255, 255, 255)" });
            expect(contrast(picked.bg, sheet.bg), "the selected tab stands out from the sheet").toBeGreaterThanOrEqual(1.6);
          } else {
            // Light: the rule's tokens are the surface and text the tab had before it.
            expect(picked).toEqual({ bg: sheet.bg, ink: sheet.ink });
          }
          // The tab not selected is not marked the same way, and moving the pick moves the mark.
          expect(await css(off)).not.toEqual(picked);
          await tap(off);
          await expect(off).toHaveAttribute("aria-selected", "true");
          expect(await css(off)).toEqual(picked);
          expect(await css(on)).not.toEqual(picked);
        });
      } else {
        test("P-8: the desktop look is unchanged (small links stay small)", async ({ page }) => {
          await openItem(page, "alert-digest");
          const box = await panel(page).getByRole("button", { name: "Change the dates" }).boundingBox();
          expect(box!.height).toBeLessThan(30);
        });

        test("P-10: the desktop panel has no tabs; Talk to Oracle opens beside the details and Hide the talk closes it", async ({ page }) => {
          await openItem(page, "alert-digest");
          await expect(panel(page).getByRole("tablist")).toHaveCount(0);
          await tap(panel(page).getByRole("button", { name: "Talk to Oracle" }));
          await expect(panel(page).getByTestId("item-talk")).toBeVisible();
          await expect(panel(page).getByRole("tablist")).toHaveCount(0);
          await expect(panel(page).getByTestId("card-depends")).toBeVisible();
          await tap(panel(page).getByRole("button", { name: "Hide the talk" }));
          await expect(panel(page).getByTestId("item-talk")).toHaveCount(0);
        });
      }
    });
  }
}
