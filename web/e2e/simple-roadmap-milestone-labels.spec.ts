import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * The Timeline's re-review (Nov 5): every milestone name stays readable. The "crowded-milestones"
 * scenario's Example trails has five invented milestones in two weeks: Trail beta and Route preview
 * for group hikes on Jan 15, Photo pins on the map (Jan 25), Trip reports open (Jan 27) and Trail
 * launch (Jan 29). Labels that would collide fold into a "+N" chip after the label they meet; the
 * chip lists each one by name and date and opens it. A label, its line and a chip take the pointer
 * over the "+ Milestone" axis, show the milestone's full name and date on hover and focus, and are
 * reached by Tab. A phone keeps its list by quarter, every name in it. Mock clock: Oct 22, 2026.
 */

const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

const NAMES: [name: string, day: string][] = [
  ["Trail beta", "Jan 15"],
  ["Route preview for group hikes", "Jan 15"],
  ["Photo pins on the map", "Jan 25"],
  ["Trip reports open", "Jan 27"],
  ["Trail launch", "Jan 29"],
];

async function open(page: Page, scheme: "light" | "dark" = "light") {
  await page.context().addInitScript(
    ([key, themeKey, theme]) => {
      localStorage.setItem(key, "crowded-milestones");
      localStorage.setItem(themeKey, theme);
    },
    [MOCK_SCENARIO_KEY, THEME_KEY, scheme] as const,
  );
  await page.emulateMedia({ colorScheme: scheme });
  await login(page);
  await page.goto("/simple/roadmap?roadmap=example-trails");
  await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
}

async function zoom(page: Page, z: string) {
  await page.getByTestId(`zoom-${z}`).click();
  await expect(page.getByTestId(`zoom-${z}`)).toHaveAttribute("aria-pressed", "true");
}

/** Slides the chart till Jan 15's line sits a third of the way in. */
async function toJanuary(page: Page) {
  const line = page.locator('[data-testid="timeline-milestone-line"][data-day="2027-01-15"]').first();
  const view = page.getByTestId("timeline-scroll");
  await view.evaluate((el) => (el.scrollLeft = 0));
  const v = (await view.boundingBox())!;
  for (let n = 0; n < 40; n++) {
    const b = await line.boundingBox();
    if (b && b.x < v.x + v.width / 2) break;
    await view.evaluate((el) => (el.scrollLeft += 200));
  }
  await expect(line).toBeInViewport();
}

/** Each name the label row gives: a label's own, from its tip (whole), and each a chip lists. */
async function namesReached(page: Page, where: string) {
  const seen = new Set<string>();
  const tip = page.getByTestId("timeline-milestone-tip");
  for (const label of await page.getByTestId("timeline-milestone").filter({ visible: true }).all()) {
    // Playwright's hover fails when another element (the "+ Milestone" axis) takes the pointer.
    await label.hover();
    await expect(page.getByTestId("ms-ghost-words"), `${where}: a label's hover shows the + Milestone hint`).toHaveCount(0);
    await expect(tip).toBeVisible();
    const words = (await tip.innerText()).trim();
    // roadmap-milestone-codes: each reads its roadmap code first ("M3 Trail beta, Jan 15, 2027").
    for (const [name, day] of NAMES) if (new RegExp(`^M\\d+ ${name}, ${day}, 2027`).test(words)) seen.add(name);
  }
  for (const chip of await page.getByTestId("timeline-milestone-more").filter({ visible: true }).all()) {
    await chip.hover();
    await expect(page.getByTestId("ms-ghost-words")).toHaveCount(0);
    const list = page.getByTestId("timeline-milestone-list").filter({ visible: true });
    await expect(list).toHaveCount(1);
    const n = Number((await chip.innerText()).replace(/\D/g, ""));
    await expect(list.getByTestId("timeline-milestone-entry")).toHaveCount(n);
    for (const e of await list.getByTestId("timeline-milestone-entry").all()) {
      const words = (await e.innerText()).trim();
      for (const [name, day] of NAMES) if (new RegExp(`^◆ M\\d+ ${name} · ${day}$`).test(words)) seen.add(name);
    }
    await page.mouse.move(5, 5);
  }
  expect([...seen].sort(), `${where}: a milestone's name cannot be reached`).toEqual(NAMES.map(([n]) => n).sort());
}

/** No two of the label row's labels and chips overlap. */
async function apart(page: Page, where: string) {
  const els = [...(await page.getByTestId("timeline-milestone").filter({ visible: true }).all()), ...(await page.getByTestId("timeline-milestone-more").filter({ visible: true }).all())];
  const boxes = (await Promise.all(els.map((e) => e.boundingBox()))).filter((b) => b !== null);
  for (const [n, a] of boxes.entries())
    for (const b of boxes.slice(n + 1)) expect(a.x + a.width <= b.x || b.x + b.width <= a.x, `${where}: two labels overlap`).toBe(true);
}

for (const scheme of ["light", "dark"] as const)
  test.describe(`desktop, ${scheme}`, () => {
    test.use(DESKTOP);

    test(`${scheme}: five milestones in two weeks: every name reachable at 3 months, 6 months, 1 year and All`, async ({ page }) => {
      // protects: with five milestones in two weeks on Example trails, at 3 months, 6 months, 1 year and All no two labels or +N chips overlap, and every milestone's name and date can be read from a label's hover or a chip's list
      // fails_when: two labels or chips overlap, a hover shows the + Milestone hint, a chip's list length differs from its number, or a name cannot be reached
      // no_claim: how it looks (screenshots are saved, not compared); the phone; the colour scheme only sets the theme
      await open(page, scheme);
      for (const z of ["3m", "6m", "1y", "all"]) {
        await zoom(page, z);
        if (z !== "all") await toJanuary(page);
        await apart(page, z);
        await namesReached(page, z);
        await page.screenshot({ path: test.info().outputPath(`crowded-${z}-${scheme}.png`) });
      }
    });

    test(`${scheme}: a same-day pair reads "First name +1" and the chip opens the other`, async ({ page }) => {
      // protects: at 3 months the Jan 15 pair shows "Trail beta" with a "+1" chip right after it; the chip's list opens the Route preview for group hikes card (Jan 15, 2027, "20 groups plan a hike with it"); Escape closes it and returns focus to the chip; the label opens its own card
      // fails_when: the chip is not "+1" or sits more than 8 px from the label, the card lacks its name, date or note, Escape leaves focus elsewhere, or the label opens the wrong card or the + Milestone card
      // no_claim: other zoom levels or pairs; how it looks
      await open(page, scheme);
      await zoom(page, "3m");
      await toJanuary(page);
      // At 3 months the Jan 15 pair has room for one name before Jan 25's: the other folds.
      const first = page.getByTestId("timeline-milestone").filter({ hasText: "Trail beta" });
      await expect(first).toBeVisible();
      const chip = first.locator("xpath=..").getByTestId("timeline-milestone-more");
      await expect(chip).toHaveText("+1");
      const fb = (await first.boundingBox())!;
      const cb = (await chip.boundingBox())!;
      expect(cb.x - (fb.x + fb.width), "the chip sits right after the label").toBeLessThan(8);
      expect(cb.x).toBeGreaterThanOrEqual(fb.x + fb.width);
      await chip.click();
      const list = page.getByTestId("timeline-milestone-list").filter({ visible: true });
      await list.getByTestId("timeline-milestone-entry").filter({ hasText: "Route preview for group hikes · Jan 15" }).click();
      const card = page.getByTestId("timeline-milestone-card");
      await expect(card).toBeVisible();
      await expect(card).toContainText("Route preview for group hikes");
      await expect(card).toContainText("Jan 15, 2027");
      await expect(card).toContainText("20 groups plan a hike with it");
      await page.keyboard.press("Escape");
      await expect(card).toHaveCount(0);
      await expect(chip, "Escape gives the focus back to the chip the entry came from").toBeFocused();
      // The label opens its own milestone.
      await first.click();
      await expect(card).toContainText("Trail beta");
      await expect(page.getByTestId("ms-card")).toHaveCount(0);
    });

    test(`${scheme}: a label cut short gives its full name on hover and on focus`, async ({ page }) => {
      // protects: at 3 months a label cut with dots shows its full name on hover (no + Milestone hint) and Tab reaches it with a ring and the same tip; Tab then reaches a +N chip whose entry opens a focused card, Escape and Close return focus, and no line takes a Tab stop
      // fails_when: no label is cut, hover or focus shows no full name, Tab never reaches a label or chip, focus lands in the wrong place after a card closes, or a line takes the focus
      // no_claim: how it looks (screenshots are saved, not compared); mouse paths at other zoom levels
      await open(page, scheme);
      await zoom(page, "3m");
      await toJanuary(page);
      const labels = page.getByTestId("timeline-milestone").filter({ visible: true });
      let cut = null;
      for (const l of await labels.all()) if (await l.evaluate((el) => el.scrollWidth > el.clientWidth + 1)) cut = l;
      expect(cut, "no label is cut at 3 months").not.toBeNull();
      await expect(cut!).toHaveCSS("text-overflow", "ellipsis");
      const tip = page.getByTestId("timeline-milestone-tip");
      await cut!.hover();
      await expect(page.getByTestId("ms-ghost-words")).toHaveCount(0);
      await expect(tip).toBeVisible();
      await expect(tip).toContainText(/^M\d+ (Trail beta|Route preview for group hikes|Photo pins on the map|Trip reports open), Jan \d+, 2027/);
      await page.screenshot({ path: test.info().outputPath(`cut-hover-${scheme}.png`) });
      await page.mouse.move(5, 5);
      await expect(tip).toHaveCount(0);
      // Tab from the Show control reaches the labels, with a ring in sight.
      await page.getByTestId("zoom-all").focus();
      await page.getByTestId("zoom-3m").click();
      await toJanuary(page);
      let found = false;
      for (let n = 0; n < 20 && !found; n++) {
        await page.keyboard.press("Tab");
        found = await page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "timeline-milestone");
      }
      expect(found, "Tab never reaches a milestone label").toBe(true);
      const focused = page.locator('[data-testid="timeline-milestone"]:focus');
      // The first label in the row is Jan 15's, cut short: its tip gives the whole name.
      expect(await focused.evaluate((el) => el.scrollWidth > el.clientWidth + 1), "the focused label is not the cut one").toBe(true);
      await expect(tip).toBeVisible();
      await expect(tip).toContainText(/^M\d+ Trail beta, Jan 15, 2027/);
      expect(await focused.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe("none");
      // On along the row: the chip lists what it folds; Enter on an entry opens it.
      let chip = false;
      for (let n = 0; n < 6 && !chip; n++) {
        await page.keyboard.press("Tab");
        chip = await page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "timeline-milestone-more");
      }
      expect(chip, "Tab never reaches a +N chip").toBe(true);
      await expect(page.getByTestId("timeline-milestone-list").filter({ visible: true })).toHaveCount(1);
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe("timeline-milestone-entry");
      await page.keyboard.press("Enter");
      const card = page.getByTestId("timeline-milestone-card");
      await expect(card).toBeVisible();
      await expect(card).toBeFocused();
      await page.screenshot({ path: test.info().outputPath(`keyboard-${scheme}.png`) });
      // Escape closes it and gives the focus back to the chip; Tab goes on from there.
      const chipEl = page.getByTestId("timeline-milestone-more").filter({ visible: true }).first();
      await page.keyboard.press("Escape");
      await expect(card).toHaveCount(0);
      await expect(chipEl).toBeFocused();
      // A label: Enter opens its card, × closes it and the label has the focus again.
      await page.keyboard.press("Shift+Tab");
      const label = page.locator('[data-testid="timeline-milestone"]:focus');
      await expect(label).toHaveCount(1);
      await page.keyboard.press("Enter");
      await expect(card).toBeFocused();
      await card.getByRole("button", { name: "Close" }).focus();
      await page.keyboard.press("Enter");
      await expect(card).toHaveCount(0);
      await expect(label).toHaveCount(1);
      // Each milestone is one Tab stop: no line takes the focus along the row.
      for (let n = 0; n < 8; n++) {
        await page.keyboard.press("Tab");
        expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).not.toBe("timeline-milestone-line");
      }
    });

    test(`${scheme}: a card taller than the chart keeps the month header and label row in sight`, async ({ page }) => {
      // protects: at 3 months a click on Trail launch's line opens its card with focus, the card runs past the foot of the chart, and the chart stays scrolled to the top
      // fails_when: the card does not open or take focus, focus scrolls the chart down off its top, or the card is not taller than the chart
      // no_claim: that the month header and label row are seen on screen (only the chart's scroll position is read); other milestones
      await open(page, scheme);
      await zoom(page, "3m");
      await toJanuary(page);
      // Trail launch waits on two items: its card runs past the chart's foot.
      const view = page.getByTestId("timeline-scroll");
      await expect.poll(() => view.evaluate((el) => el.scrollTop)).toBe(0);
      const line = page.locator('[data-testid="timeline-milestone-line"][data-day="2027-01-29"]');
      const b = (await line.boundingBox())!;
      await page.mouse.click(b.x + 2, b.y + 40);
      const card = page.getByTestId("timeline-milestone-card");
      await expect(card).toBeFocused();
      await expect(card).toContainText("Trail launch");
      expect(await view.evaluate((el) => el.scrollTop), "the card's focus scrolled the chart").toBe(0);
      const vb = (await view.boundingBox())!;
      const cb = (await card.boundingBox())!;
      expect(cb.y + cb.height, "the card is not taller than the chart").toBeGreaterThan(vb.y + vb.height);
      await page.screenshot({ path: test.info().outputPath(`tall-card-${scheme}.png`) });
    });

    test(`${scheme}: a milestone's line shows its name and opens it, never the + Milestone hint`, async ({ page }) => {
      // protects: at 6 months, hovering Trail launch's line near its top and 120 px down shows "Trail launch, Jan 29, 2027" and no + Milestone hint, a click opens its card, and an empty stretch of the axis then shows the hint
      // fails_when: the hint shows over the line, the name tip is missing, the click opens no card, or the empty axis offers no new milestone
      // no_claim: other milestones or zoom levels; the new milestone is not made
      await open(page, scheme);
      await zoom(page, "6m");
      await toJanuary(page);
      const line = page.locator('[data-testid="timeline-milestone-line"][data-day="2027-01-29"]');
      const b = (await line.boundingBox())!;
      await page.mouse.move(b.x + 2, b.y + 4);
      await expect(page.getByTestId("ms-ghost-words")).toHaveCount(0);
      await expect(page.getByTestId("timeline-milestone-tip")).toContainText("Trail launch, Jan 29, 2027");
      await page.mouse.move(b.x + 2, b.y + 120);
      await expect(page.getByTestId("timeline-milestone-tip")).toContainText("Trail launch, Jan 29, 2027");
      await page.mouse.click(b.x + 2, b.y + 120);
      await expect(page.getByTestId("timeline-milestone-card")).toContainText("Trail launch");
      // An empty stretch of the axis still offers a new milestone.
      await page.keyboard.press("Escape");
      const axis = (await page.getByTestId("ms-axis").boundingBox())!;
      const v = (await page.getByTestId("timeline-scroll").boundingBox())!;
      await page.mouse.move(v.x + v.width - 40, axis.y + axis.height / 2);
      await expect(page.getByTestId("ms-ghost-words")).toBeVisible();
    });
  });

test.describe("phone", () => {
  test.use(PHONE);

  test("390 px keeps the list by quarter, every milestone named", async ({ page }) => {
    // protects: at 390 px wide in the light theme the Q1 2027 quarter lists all five milestones, each as "M<number> name · day"
    // fails_when: a milestone is missing from the quarter or its name or day is wrong
    // no_claim: the dark theme; tapping a milestone; other quarters
    await open(page);
    const q = page.getByTestId("timeline-quarter").filter({ hasText: "Q1 2027" }).filter({ visible: true }).first();
    await expect(q).toBeVisible();
    for (const [name, day] of NAMES) await expect(q.getByTestId("timeline-milestone").filter({ hasText: new RegExp(`◆ M\\d+ ${name} · ${day}`) })).toBeVisible();
  });
});
