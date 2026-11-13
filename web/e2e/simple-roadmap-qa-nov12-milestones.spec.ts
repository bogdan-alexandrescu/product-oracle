import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * Visual QA, Nov 12, 2026 (docs/qa/2026-11-12/simple-roadmap.md #3, #7, #8, #13, #16, #17), driven
 * through the UI against the mock's default invented data (the mock clock pinned to Oct 22, 2026):
 * the milestone card's Measure / Start / Target row and its Status, the Gantt's late chips and
 * "+ Milestone" hint, the phone Waterfall's milestone band, the Key dates popover and the new-track form.
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

type Box = { left: number; right: number; top: number; bottom: number };

async function open(page: Page) {
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
}

const card = (page: Page) => page.getByTestId("ms-card");
const boxOf = (l: Locator): Promise<Box> => l.evaluate((e) => e.getBoundingClientRect().toJSON() as DOMRect);

/** The chart's part in view (its sideways scroller's box, inside its border). */
const viewOf = (page: Page, format: string): Promise<Box> =>
  page.locator(`[data-testid="simple-chart"][data-format="${format}"] [data-testid="chart-scroll"]`).evaluate((el) => {
    const b = el.getBoundingClientRect();
    return { left: b.left + el.clientLeft, right: b.left + el.clientLeft + el.clientWidth, top: b.top, bottom: b.bottom };
  });

test.describe("Milestone card fields", () => {
  for (const [where, size] of [
    ["1440 wide", DESKTOP],
    ["390 wide", PHONE],
  ] as const) {
    test(`#3: a new Goal milestone's Target box sits whole inside the card (${where})`, async ({ page }) => {
      // protects: on Now / Next / Later, "+ Milestone" then the Goal kind opens a card whose Measure, Start and Target boxes all sit inside the card and the window, and what is typed in Target shows
      // fails_when: the Measure / Start / Target row runs past the card's right edge or the screen's
      // no_claim: other kinds' fields, the save itself
      await page.setViewportSize(size);
      await open(page);
      await page.getByTestId("format-board").click();
      await page.getByTestId("ms-board-add").first().click();
      await page.getByTestId("ms-kind-picker").locator('[data-testid="ms-kind-option"][data-kind="goal"]').click();
      const c = card(page);
      await expect(c).toBeVisible();
      const row = c.getByTestId("ms-measure");
      await expect(row).toBeVisible();
      await row.getByLabel("Target").fill("80");
      await expect(row.getByLabel("Target")).toHaveValue("80");
      const cb = await boxOf(c);
      for (const name of ["Measure", "Start", "Target"]) {
        const b = await boxOf(row.getByLabel(name, { exact: true }));
        expect(b.left, `${name} starts inside the card`).toBeGreaterThanOrEqual(cb.left - 0.5);
        expect(b.right, `${name} ends inside the card`).toBeLessThanOrEqual(cb.right + 0.5);
        expect(b.right, `${name} ends inside the window`).toBeLessThanOrEqual(size.width + 0.5);
      }
      // Its bordered box too (the input sits in it).
      const target = await boxOf(row.getByLabel("Target", { exact: true }).locator("xpath=.."));
      expect(target.right).toBeLessThanOrEqual(cb.right + 0.5);
    });
  }

  test("#17: Status reads \"Oracle decides\" whole, its (i) beside the field's name outside the box", async ({ page }) => {
    // protects: a milestone made from Now / Next / Later ("+ Milestone", Delivery, a name, Save) and opened again from its chip shows Status "Oracle decides" with room for all its words, and the (i) with Oracle's reason sits above the Status box, not inside it
    // fails_when: the (i) sits inside the box beside the select, or the select is narrower than its words
    // no_claim: the reason's wording
    await page.setViewportSize(DESKTOP);
    await open(page);
    await page.getByTestId("format-board").click();
    // A person makes a milestone from the board (invented name).
    await page.getByTestId("ms-board-add").first().click();
    await page.getByTestId("ms-kind-picker").locator('[data-testid="ms-kind-option"][data-kind="delivery"]').click();
    await expect(card(page)).toBeVisible();
    await card(page).getByLabel("Name", { exact: true }).fill("Example sign-up check");
    await card(page).getByLabel("Builds toward", { exact: true }).selectOption({ index: 1 });
    await card(page).getByTestId("ms-save").click();
    await expect(card(page)).toBeHidden();
    // Then opens it again from its chip.
    const chip = page.getByTestId("ms-board-chip").filter({ hasText: "Example sign-up check" });
    await expect(chip).toHaveCount(1);
    await chip.click();
    await expect(card(page)).toBeVisible();
    await expect(card(page).getByTestId("ms-status-why")).toBeVisible();
    const c = card(page);
    const select = c.getByLabel("Status", { exact: true });
    await expect(select).toHaveValue("");
    await expect(select.locator("option:checked")).toHaveText("Oracle decides");
    // The (i) is above the bordered box that holds the select, never in it.
    const why = await boxOf(c.getByTestId("ms-status-why"));
    const field = await boxOf(select.locator("xpath=.."));
    expect(why.bottom, "the (i) sits above the Status box").toBeLessThanOrEqual(field.top + 1);
    // The select is wide enough for its words, in its own font.
    const fits = await select.evaluate((el: HTMLSelectElement) => {
      const ctx = document.createElement("canvas").getContext("2d")!;
      const cs = getComputedStyle(el);
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const words = ctx.measureText(el.options[el.selectedIndex].text).width;
      const room = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      return { words, room };
    });
    expect(fits.words, `"Oracle decides" (${fits.words}px) fits its select (${fits.room}px)`).toBeLessThanOrEqual(fits.room);
    // The (i) still gives Oracle's reason.
    await c.getByTestId("ms-status-why").hover();
    await expect(c.getByTestId("ms-status-why").locator("xpath=..").getByRole("tooltip")).toBeVisible();
  });
});

test("#7: the Gantt's late chips and its \"+ Milestone\" hint sit whole inside the chart in view", async ({ page }) => {
  // protects: on the Gantt at 1440 at rest, every "Ends after M…" chip that shows is whole inside the chart's visible part, and the axis's "+ Milestone" hint is too
  // fails_when: a late chip or the hint is cut by the chart's right edge
  // no_claim: which items are late, the chips' order
  await page.setViewportSize(DESKTOP);
  await open(page);
  await page.getByTestId("format-gantt").click();
  const hint = page.getByTestId("ms-add-hint");
  await expect(hint).toBeVisible();
  await expect(hint).toHaveText("+ Milestone");
  const view = await viewOf(page, "gantt");
  const hb = await boxOf(hint);
  expect(hb.left, "the hint starts in view").toBeGreaterThanOrEqual(view.left - 0.5);
  expect(hb.right, "the hint ends in view").toBeLessThanOrEqual(view.right + 0.5);
  const late = await page.getByTestId("ms-late").evaluateAll((els) => els.map((e) => ({ words: e.textContent ?? "", ...(e.getBoundingClientRect().toJSON() as DOMRect) })));
  const seen = late.filter((b) => b.right > view.left + 0.5 && b.left < view.right - 0.5);
  expect(seen.length, "late chips show in view").toBeGreaterThan(0);
  for (const b of seen) {
    expect(b.words).toMatch(/^Ends after M\d+ /);
    expect(b.left, `"${b.words}" starts in view`).toBeGreaterThanOrEqual(view.left - 0.5);
    expect(b.right, `"${b.words}" ends in view`).toBeLessThanOrEqual(view.right + 0.5);
  }
});

test("#8: on a phone's Waterfall no two milestone band labels or \"+N\" bubbles overlap, and none runs off the band", async ({ page }) => {
  // protects: at 390 wide, the Waterfall's milestone band draws each label and "+N" bubble apart from the others and inside the band
  // fails_when: two labels or bubbles overlap, or one runs past the band's edge
  // no_claim: which milestones fold into a bubble; the axis's key date names
  await page.setViewportSize(PHONE);
  await open(page);
  await page.getByTestId("format-waterfall").click();
  const band = page.locator('[data-testid="simple-chart"][data-format="waterfall"] [data-testid="ms-band"]');
  await expect(band).toBeVisible();
  const bb = await boxOf(band);
  const boxes = await page
    .locator('[data-testid="simple-chart"][data-format="waterfall"]')
    .locator('[data-testid="ms-label"], [data-testid="ms-prd-label"], [data-testid="ms-band-more"]')
    .evaluateAll((els) => els.map((e) => ({ words: e.textContent ?? "", ...(e.getBoundingClientRect().toJSON() as DOMRect) })));
  expect(boxes.length, "the band has labels").toBeGreaterThan(0);
  for (const b of boxes) {
    expect(b.left, `"${b.words}" starts in the band`).toBeGreaterThanOrEqual(bb.left - 0.5);
    expect(b.right, `"${b.words}" ends in the band`).toBeLessThanOrEqual(bb.right + 0.5);
  }
  for (let a = 0; a < boxes.length; a++)
    for (let b = a + 1; b < boxes.length; b++) {
      const [p, q] = [boxes[a], boxes[b]];
      const touch = p.left < q.right - 0.5 && q.left < p.right - 0.5 && p.top < q.bottom - 0.5 && q.top < p.bottom - 0.5;
      expect(touch, `"${p.words}" and "${q.words}" overlap`).toBe(false);
    }
});

test("#13: Key dates says where a change goes behind an (i) beside its title, not as a line of prose", async ({ page }) => {
  // protects: the Key dates popover shows no "working draft" sentence; an (i) beside the "Key dates" title gives it on hover
  // fails_when: the sentence shows as prose, or no (i) holds it
  // no_claim: the key dates listed
  await page.setViewportSize(DESKTOP);
  await open(page);
  await page.getByTestId("key-dates-open").click();
  const pop = page.getByRole("dialog", { name: "Key dates" });
  await expect(pop).toBeVisible();
  await expect(pop.getByText(/working draft/)).toBeHidden();
  const tip = pop.getByRole("button", { name: "About Key dates" });
  await expect(tip).toBeVisible();
  // Beside the title: on its line.
  const [t, h] = await Promise.all([boxOf(tip), boxOf(pop.getByRole("heading", { name: /^Key dates/ }))]);
  const mid = (t.top + t.bottom) / 2;
  expect(mid).toBeGreaterThanOrEqual(h.top);
  expect(mid).toBeLessThanOrEqual(h.bottom);
  await tip.hover();
  await expect(tip.locator("xpath=..").getByRole("tooltip")).toHaveText("Your changes go into the roadmap's working draft (Undo in the message).");
});

test("#16: + Add track names each of its choices: PRD, Goal and Owner", async ({ page }) => {
  // protects: the Tracks sheet's new-track form shows a visible name over each select (PRD, Goal, Owner), each name tied to its select
  // fails_when: a select shows a bare value ("No goal", "No owner") with no name
  // no_claim: adding the track
  await page.setViewportSize(DESKTOP);
  await open(page);
  await page.getByTestId("tracks-open").click();
  const sheet = page.getByTestId("tracks-sheet");
  await sheet.getByTestId("track-add").click();
  const form = sheet.getByTestId("track-new");
  await expect(form).toBeVisible();
  for (const [name, select] of [
    ["PRD", "New track PRD"],
    ["Goal", "New track goal"],
    ["Owner", "New track owner"],
  ] as const) {
    const label = form.locator("label").filter({ hasText: new RegExp(`^${name}`) });
    await expect(label, `a visible "${name}" name`).toHaveCount(1);
    await expect(label).toBeVisible();
    // The name is the select's own label (a click on it reaches the select) and sits above it.
    await expect(label.getByLabel(select, { exact: true })).toBeVisible();
    const [lb, sb] = await Promise.all([boxOf(label), boxOf(form.getByLabel(select, { exact: true }))]);
    expect(lb.top, `"${name}" sits above its select`).toBeLessThan(sb.top - 4);
  }
});
