import { MOCK_SCENARIO_KEY } from "@/lib/api/mock/ids";
import { PRIORITIES_BUCKET_ONLY_SCENARIO } from "@/lib/api/mock/simple-priorities";
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

async function open(page: Page, email: string, theme: "light" | "dark", tab = "", scenario = ""): Promise<void> {
  await page.context().addInitScript(
    ([t, key, sc]) => {
      localStorage.setItem("oracle-theme", t);
      if (sc) localStorage.setItem(key, sc);
    },
    [theme, MOCK_SCENARIO_KEY, scenario] as const,
  );
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
          // Demo 9: Goal buckets' intro is behind the (i), as Value / effort's is.
          await expect(page.getByTestId("buckets-intro")).toBeHidden();
          await page.getByTestId("prio-about").click();
          await expect(page.getByTestId("buckets-intro")).toBeVisible();
          await page.keyboard.press("Escape");
          const n = await rows.count();
          expect(n).toBeGreaterThan(0);
          await expect(page.getByTestId("plan-feature-open")).toHaveCount(n);
          const last = page.getByTestId("plan-feature-open").last();
          const name = (await last.innerText()).trim();
          await last.click();
          await expect(page.getByTestId("item-panel")).toContainText(name);
        });

        test(`S-3: ${email}'s Goal bucket feature with no ranked row opens the feature panel`, async ({ page }) => {
          await open(page, email, theme, "buckets", PRIORITIES_BUCKET_ONLY_SCENARIO);
          await expect(page.getByTestId("plan-feature").first()).toBeVisible();
          // The first goal's first feature is not among the ranked rows: its row still opens it.
          const first = page.getByTestId("bucket-features").first().getByTestId("plan-feature").first();
          const opener = first.getByTestId("plan-feature-open");
          await expect(opener).toBeVisible();
          await opener.click();
          // The panel finds the feature by its key: its details, what it depends on and its goal.
          const panel = page.getByTestId("item-panel");
          await expect(panel).toContainText("Depends on");
          await expect(panel).toContainText("Goal");
          await expect(panel).not.toContainText("not on a roadmap you can see");
          if (email === VIEWER) await expect(panel).toContainText("You can read this feature");
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
              // GAP: 4 px (less a layout rounding hair).
              const gap = 4 - 0.05;
              const apart = a[2] + gap <= b[0] || b[2] + gap <= a[0] || a[3] + gap <= b[1] || b[3] + gap <= a[1];
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

      if (size === "390")
        test("P-3: a selected mark's name stays on the phone's screen; the page never scrolls sideways", async ({ page }) => {
          await open(page, OWNER, theme, "value-effort");
          const marks = page.getByTestId("vxe-point");
          await expect(marks.first()).toBeVisible();
          const n = await marks.count();
          expect(n).toBeGreaterThan(1);
          for (let k = 0; k < n; k++) {
            const mark = marks.nth(k);
            await mark.scrollIntoViewIfNeeded();
            await mark.click();
            const tag = mark.getByTestId("vxe-name");
            await expect(tag).toBeVisible();
            const b = (await tag.boundingBox())!;
            const code = await mark.getAttribute("data-code");
            expect(b.x, `${code}'s name runs off the left`).toBeGreaterThanOrEqual(0);
            expect(b.x + b.width, `${code}'s name runs off the right`).toBeLessThanOrEqual(PHONE.width);
            expect(await page.evaluate(() => document.documentElement.scrollWidth), `${code}'s name widens the page`).toBe(PHONE.width);
          }
        });

      if (size === "1440")
        test("P-3: every mark's name tag stays inside the plot and the page is no wider than the window", async ({ page }) => {
          await open(page, OWNER, theme, "value-effort");
          const marks = page.getByTestId("vxe-point");
          await expect(marks.first()).toBeVisible();
          const n = await marks.count();
          expect(n).toBeGreaterThan(1);
          for (let k = 0; k < n; k++) {
            const mark = marks.nth(k);
            const code = await mark.getAttribute("data-code");
            await mark.hover();
            const tag = mark.getByTestId("vxe-name");
            await expect(tag, `${code}'s name shows on hover`).toBeVisible();
            const plot = (await page.getByTestId("vxe-plot").boundingBox())!;
            const b = (await tag.boundingBox())!;
            expect(b.x, `${code}'s name runs off the plot's left`).toBeGreaterThanOrEqual(plot.x - 0.5);
            expect(b.x + b.width, `${code}'s name runs off the plot's right`).toBeLessThanOrEqual(plot.x + plot.width + 0.5);
            expect(await page.evaluate(() => document.documentElement.scrollWidth), `${code}'s name widens the page`).toBeLessThanOrEqual(DESKTOP.width);
          }
        });

      if (size === "1440")
        test("P-3: every mark's name tag stays inside the plot's top and foot", async ({ page }) => {
          // Alert history export's mark sits on the zero line: its name flips above the mark instead of hanging below the plot.
          await open(page, OWNER, theme, "value-effort");
          const marks = page.getByTestId("vxe-point");
          await expect(marks.first()).toBeVisible();
          for (let k = 0; k < (await marks.count()); k++) {
            const mark = marks.nth(k);
            const code = await mark.getAttribute("data-code");
            await mark.hover();
            const tag = mark.getByTestId("vxe-name");
            await expect(tag).toBeVisible();
            const plot = (await page.getByTestId("vxe-plot").boundingBox())!;
            const b = (await tag.boundingBox())!;
            expect(b.y, `${code}'s name runs off the plot's top`).toBeGreaterThanOrEqual(plot.y - 0.5);
            expect(b.y + b.height, `${code}'s name runs off the plot's foot`).toBeLessThanOrEqual(plot.y + plot.height + 0.5);
          }
        });

      if (size === "390")
        test("P-3: a mark with a very long title shows its name cut with an ellipsis, still inside the plot", async ({ page }) => {
          const long = "Alert history export for every workspace, every team and every project, in every file format, with a copy sent to each admin by email every week";
          await open(page, OWNER, theme);
          // Rename the feature through its panel (More actions, Rename, Save), then read the chart.
          await page.getByTestId("prio-title").filter({ hasText: "Alert history export" }).first().click();
          const panel = page.getByTestId("item-panel");
          await expect(panel).toBeVisible();
          await panel.getByRole("button", { name: "More actions" }).click();
          await panel.getByRole("menuitem", { name: "Rename" }).click();
          await panel.getByLabel("Name").fill(long);
          await panel.getByRole("button", { name: "Save" }).click();
          await expect(panel.getByRole("button", { name: "Save" })).toHaveCount(0);
          await page.keyboard.press("Escape");
          await page.getByRole("tab", { name: "Value / effort" }).click();
          const mark = page.locator('[data-testid="vxe-point"][data-code="alert-export"]');
          await mark.scrollIntoViewIfNeeded();
          await expect(mark).toHaveAccessibleName(new RegExp(long.slice(0, 40)));
          await mark.click();
          const tag = mark.getByTestId("vxe-name");
          await expect(tag).toBeVisible();
          await expect(tag).toContainText(long);
          const cut = await tag.evaluate((el) => {
            const s = getComputedStyle(el);
            return { ellipsis: s.textOverflow === "ellipsis" && s.overflow !== "visible" && s.whiteSpace === "nowrap", wider: el.scrollWidth > el.clientWidth };
          });
          expect(cut, "the tag is cut with an ellipsis").toEqual({ ellipsis: true, wider: true });
          const plot = (await page.getByTestId("vxe-plot").boundingBox())!;
          const b = (await tag.boundingBox())!;
          expect(b.x, "the name runs off the plot's left").toBeGreaterThanOrEqual(plot.x - 0.5);
          expect(b.x + b.width, "the name runs off the plot's right").toBeLessThanOrEqual(plot.x + plot.width + 0.5);
          expect(await page.evaluate(() => document.documentElement.scrollWidth), "the name widens the page").toBe(PHONE.width);
        });

      test("V-3: the Compare switch's off knob stands out from its track", async ({ page }) => {
        await open(page, OWNER, theme);
        const sw = page.getByRole("switch", { name: "Compare with Oracle" });
        await expect(sw).toHaveAttribute("aria-checked", "false");
        // The knob slides and recolours: read it once it settles.
        await expect.poll(async () => contrast(await bg(sw), await bg(page.getByTestId("compare-knob")))).toBeGreaterThanOrEqual(3);
        await sw.click();
        await expect(sw).toHaveAttribute("aria-checked", "true");
        // The knob slides and recolours: read it once it settles.
        await expect.poll(async () => contrast(await bg(sw), await bg(page.getByTestId("compare-knob")))).toBeGreaterThanOrEqual(3);
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
