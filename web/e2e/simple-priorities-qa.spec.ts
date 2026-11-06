import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * Pre-demo QA on Simple's Priorities, driven through the UI on the mock as a person would, as
 * the owner (admin) and a viewer, light and dark, at 1440 and 390 wide.
 * S-2: a viewer's Ranked list title opens the feature panel, read-only. S-3: every feature in a
 * Goal bucket opens it. P-3: a Value / effort mark names its feature on hover, focus or
 * selection. V-3: the Compare switch's off knob stands out from its track. V-4: Fill-ins and
 * Later sit off the zero line; marks never touch. V-5: the share bar's neighbouring goals differ.
 * Demo 9: the view's explanation is behind an (i).
 */

const OWNER = "admin@example.com";
const VIEWER = "viewer@example.com";
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

async function open(page: Page, email: string, theme: "light" | "dark", tab = ""): Promise<void> {
  await page.context().addInitScript((t) => localStorage.setItem("oracle-theme", t), theme);
  await login(page, email);
  await page.goto(`/simple/priorities${tab ? `?tab=${tab}` : ""}`);
}

/** WCAG contrast of two computed colours ("rgb(r, g, b)"). */
function contrast(a: string, b: string): number {
  const lum = (c: string) => {
    const [r, g, bl] = (c.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number).map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const bg = (l: Locator) => l.evaluate((e) => getComputedStyle(e).backgroundColor);

for (const [size, viewport] of [["1440", DESKTOP], ["390", PHONE]] as const) {
  for (const theme of ["light", "dark"] as const) {
    test.describe(`${size} ${theme}`, () => {
      test.use({ viewport });

      for (const email of [OWNER, VIEWER]) {
        test(`S-2, Demo 9: ${email}'s ranked title opens the feature panel; the explanation is behind an (i)`, async ({ page }) => {
          await open(page, email, theme);
          const title = page.getByTestId("prio-title").first();
          await expect(title).toBeVisible();
          // Demo 9: no explanation sentence under the heading; the (i) says it.
          await expect(page.getByText("Features that serve a goal first, then by score")).toBeHidden();
          await page.getByTestId("prio-about").click();
          await expect(page.getByText("Features that serve a goal first, then by score")).toBeVisible();
          await page.keyboard.press("Escape");
          const name = (await title.innerText()).trim();
          await title.click();
          const panel = page.getByTestId("item-panel");
          await expect(panel).toBeVisible();
          await expect(panel).toContainText(name);
          if (email === VIEWER) await expect(panel).toContainText("You can read this feature");
        });

        test(`S-3: ${email}'s Goal bucket features each open the feature panel`, async ({ page }) => {
          await open(page, email, theme, "buckets");
          const rows = page.getByTestId("plan-feature");
          await expect(rows.first()).toBeVisible();
          const n = await rows.count();
          expect(n).toBeGreaterThan(0);
          await expect(page.getByTestId("plan-feature-open")).toHaveCount(n);
          const last = page.getByTestId("plan-feature-open").last();
          const name = (await last.innerText()).trim();
          await last.click();
          await expect(page.getByTestId("item-panel")).toContainText(name);
        });

        test(`P-3, V-4: ${email}'s Value / effort marks name their feature and keep apart; bottom names sit off the zero line`, async ({ page }) => {
          await open(page, email, theme, "value-effort");
          const mark = page.locator('[data-testid="vxe-point"][data-code="alert-export"]');
          await expect(mark).toBeVisible();
          await expect(mark).toHaveAccessibleName(/Alert history export/);
          if (size === "1440") await mark.hover();
          else await mark.click();
          await expect(mark.getByTestId("vxe-name")).toBeVisible();
          await expect(mark.getByTestId("vxe-name")).toHaveText("#6 AHE · Alert history export");
          await page.mouse.move(0, 0);
          // V-4: every two marks keep a gap (no touching rings).
          const boxes = await page.getByTestId("vxe-point").evaluateAll((es) => es.map((e) => e.querySelector("svg")!.getBoundingClientRect()).map((b) => [b.left, b.top, b.right, b.bottom]));
          for (let i = 0; i < boxes.length; i++)
            for (let j = i + 1; j < boxes.length; j++) {
              const [a, b] = [boxes[i], boxes[j]];
              const apart = a[2] + 3 <= b[0] || b[2] + 3 <= a[0] || a[3] + 3 <= b[1] || b[3] + 3 <= a[1];
              expect(apart, `marks ${i} and ${j} touch`).toBe(true);
            }
          // The zero line: the value tick "0".
          const zero = await page.getByTestId("vxe-value-tick").filter({ hasText: /^0$/ }).evaluate((e) => {
            const b = e.getBoundingClientRect();
            return b.top + b.height / 2;
          });
          for (const q of ["Fill-ins", "Later"]) {
            const box = (await page.getByTestId("vxe-quadrant").filter({ hasText: q }).boundingBox())!;
            expect(box.y + box.height, `${q} sits on the zero line`).toBeLessThanOrEqual(zero - 1);
          }
          // Demo 9: how to read the chart is behind the (i).
          await expect(page.getByText("Each mark shows the feature's code")).toBeHidden();
        });
      }

      test("V-3: the Compare switch's off knob stands out from its track", async ({ page }) => {
        await open(page, OWNER, theme);
        const sw = page.getByRole("switch", { name: "Compare with Oracle" });
        await expect(sw).toHaveAttribute("aria-checked", "false");
        expect(contrast(await bg(sw), await bg(page.getByTestId("compare-knob")))).toBeGreaterThanOrEqual(3);
        await sw.click();
        await expect(sw).toHaveAttribute("aria-checked", "true");
        expect(contrast(await bg(sw), await bg(page.getByTestId("compare-knob")))).toBeGreaterThanOrEqual(3);
      });

      if (size === "1440")
        test("V-5: the share bar's neighbouring goals have different fills", async ({ page }) => {
          await open(page, OWNER, theme, "buckets");
          const segs = page.getByTestId("bucket-segment");
          await expect(segs.nth(1)).toBeVisible();
          const n = await segs.count();
          for (let k = 1; k < n; k++) expect(await bg(segs.nth(k)), `segment ${k} reads as its neighbour`).not.toBe(await bg(segs.nth(k - 1)));
        });
    });
  }
}
