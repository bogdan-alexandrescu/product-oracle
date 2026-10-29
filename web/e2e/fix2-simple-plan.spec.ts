import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN, login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * QA pass 2, simple-plan (/simple/priorities): the Ranked list, Value / effort, Goal buckets and
 * the suggestions drawer, driven through the UI as a person would, on the mock's default company
 * (nine features; Sample data import F-12 needs Setup checklist, Alert routing by team needs
 * Alert history export; the draft Team invite nudges) and its "simple-plan" scenario (a dated
 * plan, Nov 2 – Feb 12). Desktop 1440x900 and phone 390x844, light and dark.
 */

const PHONE = { width: 390, height: 844 };

async function setUp(page: Page, opts: { scheme?: "light" | "dark"; scenario?: string; email?: string; phone?: boolean } = {}) {
  const { scheme = "light", scenario = null, email = ADMIN.email, phone = false } = opts;
  await page.setViewportSize(phone ? PHONE : { width: 1440, height: 900 });
  await page.context().addInitScript(
    ([key, value, themeKey, theme]) => {
      if (value) localStorage.setItem(key, value);
      localStorage.setItem(themeKey, theme);
    },
    [MOCK_SCENARIO_KEY, scenario, THEME_KEY, scheme] as const,
  );
  await page.emulateMedia({ colorScheme: scheme });
  await login(page, email);
}

async function open(page: Page, query = ""): Promise<void> {
  await page.goto(`/simple/priorities${query}`);
  await expect(page.getByTestId("simple-priorities")).toBeVisible();
}

const row = (page: Page, code: string): Locator => page.locator(`[data-testid="prio-row"][data-code="${code}"]`);
const toast = (page: Page, text: string | RegExp): Locator => page.getByRole("status").filter({ hasText: text });

async function dragRow(page: Page, name: string, to: number): Promise<void> {
  const handle = page.getByRole("button", { name: `Drag ${name} to reorder` });
  await handle.evaluate((e) => e.scrollIntoView({ block: "center" }));
  const from = (await handle.boundingBox())!;
  const target = (await page.getByTestId("prio-row").nth(to).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, target.y + target.height / 2 + 2, { steps: 10 });
  await page.mouse.up();
}

const overlap = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

test.describe("QA pass 2: simple-plan, the Ranked list", () => {
  /*
   * qa-simple-plan-1, -2, -3, -28: a move names the feature by its title and code, never its
   * slug; a move a dependency keeps from landing says where it lands and why, or is refused when
   * it would change nothing; Move stays enabled and an empty reason asks for one.
   */
  test("a move says where the item lands, by name; a move that changes nothing is refused", async ({ page }) => {
    await setUp(page);
    await open(page);
    await dragRow(page, "Sample data import (F-12)", 0);
    const dialog = page.getByRole("dialog", { name: "Why move Sample data import (F-12)" });
    await expect(dialog.getByRole("heading")).toHaveText("Move Sample data import (F-12) to rank 2");
    await expect(dialog).toContainText("It needs Setup checklist (#1), so it can go no higher than #2.");
    await expect(dialog).not.toContainText("setup-import");
    await expect(dialog).not.toContainText("override");
    const move = dialog.getByRole("button", { name: "Move", exact: true });
    await expect(move).toBeEnabled();
    await move.click();
    await expect(dialog.getByRole("alert")).toHaveText("Say why in one line.");
    await dialog.getByLabel("Reason").fill("Sales demos need it");
    await move.click();
    await expect(toast(page, "Moved Sample data import (F-12) to rank 2")).toBeVisible();
    await expect(row(page, "setup-import").getByTestId("prio-rank")).toHaveText("2");

    await dragRow(page, "Alert routing by team (AS)", 5);
    const refused = page.getByRole("dialog", { name: "Why move Alert routing by team (AS)" });
    await expect(refused).toContainText("Can't go above Alert history export, which it needs.");
    await expect(refused.getByRole("button", { name: "Move", exact: true })).toHaveCount(0);
    await refused.getByRole("button", { name: "Close" }).click();
    await expect(row(page, "alert-sso").getByTestId("prio-override")).toHaveCount(0);
    await expect(row(page, "alert-sso").getByTestId("moved")).toHaveCount(0);
  });

  /*
   * qa-simple-plan-9, -11, -21, -22, -23, -25: the row's numbers say what they are and wrap as one
   * group; every code sits in one chip style above and below the line; the ranking sentence is the
   * Ranked list's only; the miss words read in sentence case; picking a date is one control.
   */
  for (const v of [
    { name: "desktop, light", phone: false, scheme: "light" as const },
    { name: "phone, dark", phone: true, scheme: "dark" as const },
  ])
    test(`the rows' numbers are labelled and the line reads plainly (${v.name})`, async ({ page }) => {
      await setUp(page, { scheme: v.scheme, phone: v.phone, email: "viewer@example.com" });
      await open(page);
      const digest = row(page, "alert-digest");
      const numbers = digest.getByTestId("prio-numbers");
      await expect(numbers).toHaveText("value 5 · 2 wk · score 1.25");
      expect(await numbers.evaluate((e) => getComputedStyle(e).whiteSpace)).toBe("nowrap");
      const box = (await numbers.boundingBox())!;
      expect(box.height).toBeLessThan(30);
      // One chip style: a below-the-line row's chip keeps its edge.
      const below = page.locator('[data-testid="prio-row"][data-above="false"]').first();
      const chip = below.getByTestId("prio-code");
      expect(await chip.evaluate((e) => parseFloat(getComputedStyle(e).borderTopWidth))).toBeGreaterThan(0);
      expect(await chip.evaluate((e) => getComputedStyle(e).fontFamily)).not.toMatch(/mono/i);
      await expect(page.getByTestId("prio-misses").first()).toHaveText("Misses this quarter");
      await expect(page.getByTestId("prio-subtitle")).toContainText("dependency order");
      await page.getByRole("tab", { name: "Goal buckets" }).click();
      await expect(page.getByTestId("prio-subtitle")).not.toContainText("dependency order");
      await page.getByRole("tab", { name: "Value / effort" }).click();
      await expect(page.getByTestId("prio-subtitle")).not.toContainText("dependency order");
    });

  test("picking a date is one control, and the caption reads the day", async ({ page }) => {
    await setUp(page);
    await open(page);
    await page.getByLabel("Line", { exact: true }).selectOption({ label: "Pick a date…" });
    await expect(page.locator("#prio-line")).toBeHidden();
    await page.getByLabel("The line's date").fill("2026-11-20");
    await expect(page.locator("#prio-line")).toBeVisible();
    await expect(page.getByLabel("The line's date")).toHaveCount(0);
    await expect(page.locator("#prio-line")).toContainText("By Nov 20, 2026");
    await expect(page.getByTestId("line-caption")).toContainText(/miss Nov 20, 2026/);
    await expect(page.getByTestId("line-caption")).not.toContainText("miss By");
    await expect(page.getByTestId("prio-misses").first()).toHaveText("Misses Nov 20, 2026");
  });

  /* qa-simple-plan-10, -24: the draft shows no slug; one Merge toggles, one Merge confirms. */
  test("a draft shows no slug and merges with one Merge", async ({ page }) => {
    await setUp(page);
    await open(page);
    const draft = page.getByTestId("prio-draft").first();
    await expect(draft).toContainText("Team invite nudges");
    await expect(draft).not.toContainText("setup-ideas");
    const toggle = draft.getByRole("button", { name: "Merge into…" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(draft.getByRole("button", { name: "Merge", exact: true })).toHaveCount(1);
    await expect(draft.getByLabel("Merge into", { exact: true })).not.toContainText("setup-checklist");
  });
});

test.describe("QA pass 2: simple-plan, Value / effort", () => {
  /* qa-simple-plan-2, -12, -14, -18: names not slugs, marks off the median lines, a re-estimate badge. */
  test("a re-estimate says 'now #n (effort …)' and marks sit in a quadrant", async ({ page }) => {
    await setUp(page);
    await open(page, "?tab=value-effort");
    const am = page.locator('[data-testid="vxe-point"][data-code="alert-mobile"]');
    await expect(am).toHaveAttribute("aria-label", /^#\d+ Mobile alert push \(AM(P)?\): goal value/);
    await expect(page.getByRole("list", { name: "Legend" })).not.toContainText("PRD");
    // No mark's centre is on a median line.
    const effortLine = (await page.getByTestId("vxe-median-effort").boundingBox())!.x;
    const valueLine = (await page.getByTestId("vxe-median-value").boundingBox())!.y;
    for (const b of await page.getByTestId("vxe-point").all()) {
      const box = (await b.boundingBox())!;
      expect(Math.abs(box.x + box.width / 2 - effortLine)).toBeGreaterThan(3);
      expect(Math.abs(box.y + box.height / 2 - valueLine)).toBeGreaterThan(3);
    }
    const box = (await am.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect(toast(page, /^Re-estimated Mobile alert push \(AMP?\): effort/)).toBeVisible();
    const side = page.locator('[data-testid="side-row"][data-code="alert-mobile"]');
    await expect(side.getByTestId("moved")).toHaveText(/^now #\d+ \(effort [\d.]+ wk\)$/);
    await expect(side.getByTestId("prio-title")).toHaveText("Mobile alert push");
    const title = side.getByTestId("prio-title");
    expect(await title.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  });

  /* qa-simple-plan-13: on a phone, no two marks overlap and the median words keep off the quadrant names. */
  test("on a phone the marks and labels do not collide", async ({ page }) => {
    await setUp(page, { phone: true, scheme: "dark" });
    await open(page, "?tab=value-effort");
    await page.waitForTimeout(300);
    const marks = await Promise.all((await page.getByTestId("vxe-point").all()).map(async (m) => (await m.boundingBox())!));
    // The 36 px boxes may touch at their corners; the shapes inside them may not overlap.
    const shrink = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x + 4, y: b.y + 4, width: b.width - 8, height: b.height - 8 });
    for (let i = 0; i < marks.length; i++) for (let j = i + 1; j < marks.length; j++) expect(overlap(shrink(marks[i]), shrink(marks[j]))).toBe(0);
    const labels = await Promise.all((await page.getByTestId("vxe-quadrant").all()).map(async (m) => (await m.boundingBox())!));
    for (const l of labels) for (const m of marks) expect(overlap(l, shrink(m))).toBe(0);
    const middle = (await page.getByTestId("vxe-middle-effort").boundingBox())!;
    for (const l of labels) expect(overlap(l, middle)).toBe(0);
  });
});

test.describe("QA pass 2: simple-plan, Goal buckets", () => {
  /* qa-simple-plan-6, -7, -15, -16: a labelled share bar, names in the cards, shares total 100%, no empty No goal card. */
  for (const scheme of ["light", "dark"] as const)
    test(`the buckets without a plan read plainly (${scheme})`, async ({ page }) => {
      await setUp(page, { scheme });
      await open(page, "?tab=buckets");
      const bar = page.getByTestId("bucket-bar");
      await expect(bar).not.toHaveAttribute("aria-hidden", "true");
      await expect(bar).toContainText("Share of engineer-weeks by goal");
      await expect(bar.getByTestId("bucket-segment").first()).toContainText(/\d+(\.\d)? wk · \d+%/);
      const shares = await page.getByTestId("bucket-share").allTextContents();
      expect(shares.reduce((n, s) => n + Number(s.replace("%", "")), 0)).toBe(100);
      const activation = page.locator('[data-testid="goal-bucket"][data-key="faster-activation"]');
      await expect(activation).toContainText("F-12 Sample data import");
      await expect(activation).toContainText("SC Setup checklist");
      for (const card of await page.getByTestId("goal-bucket").all()) await expect(card).not.toContainText("Nothing this quarter");
    });

  /* qa-simple-plan-8, -20, -27, -29: the drawer dims the page, its card body takes the width, pills on one line, no glyph, one control style. */
  test("the suggestions drawer: a backdrop, full-width text, one-line pills", async ({ page }) => {
    await setUp(page);
    await open(page, "?tab=buckets");
    await page.getByRole("button", { name: "Suggestions for Grow retention" }).click();
    const drawer = page.getByTestId("goal-panel");
    await expect(page.getByTestId("goal-panel-backdrop")).toBeVisible();
    await expect(drawer.getByTestId("suggest-from-chat")).toHaveClass(/font-semibold/);
    await expect(drawer.getByTestId("suggest-from-chat")).not.toHaveClass(/(^| )underline/);
    await drawer.getByRole("tab", { name: /Oracle/ }).click();
    const card = drawer.getByTestId("goal-suggestion").first();
    await expect(card.getByTestId("flow-thumb")).toHaveCount(0);
    await expect(card.getByTestId("flow-none")).toHaveCount(0);
    const outcome = (await card.getByTestId("suggestion-outcome").boundingBox())!;
    const accept = (await card.getByRole("button", { name: "Accept" }).boundingBox())!;
    expect(accept.y).toBeGreaterThan(outcome.y + outcome.height - 1);
    expect(outcome.width).toBeGreaterThan(300);
    for (const pill of await card.getByTestId("confidence").all()) expect(await pill.evaluate((e) => getComputedStyle(e).whiteSpace)).toBe("nowrap");
    await page.getByTestId("goal-panel-backdrop").click({ position: { x: 20, y: 400 } });
    await expect(drawer).toHaveCount(0);
  });

  /* qa-simple-plan-26: on a phone, a toast keeps clear of the open sheet's controls. */
  test("on a phone a toast sits above the sheet, not over its buttons", async ({ page }) => {
    await setUp(page, { phone: true, scheme: "dark", email: "commenter@example.com" });
    await open(page, "?tab=buckets");
    await page.getByRole("button", { name: "Suggestions for Grow retention" }).click();
    const sheet = page.getByRole("dialog", { name: "Suggestions · Grow retention" });
    await sheet.getByLabel("Feature name").fill("Quiet hours");
    await sheet.getByLabel("What it does, and for whom").fill("Admins mute alerts at night");
    await sheet.getByRole("button", { name: "Send suggestion" }).click();
    const t = page.getByRole("status").filter({ hasText: "Sent" });
    await expect(t).toBeVisible();
    const tb = (await t.boundingBox())!;
    for (const b of await sheet.getByRole("button").all()) {
      const bb = await b.boundingBox();
      if (bb) expect(overlap(tb, bb)).toBe(0);
    }
  });

  /* qa-simple-plan-5, -17, -18, -19, -20: with a dated plan the tabs agree, the span is the plan's, numbers drop ".0", plain words, one entry point. */
  test("with a dated plan: the plan's span, plain numbers and words, the tabs agree", async ({ page }) => {
    await setUp(page, { scheme: "dark", scenario: "simple-plan" });
    await open(page, "?tab=buckets");
    const head = page.getByTestId("buckets-head");
    await expect(page.getByTestId("buckets-summary")).toContainText(/^This plan, Nov 2 – Feb 12: \d+ engineer-weeks over three milestones/);
    await expect(head).not.toContainText(/\d\.0\b/);
    await expect(page.getByTestId("buckets-footnote")).not.toContainText("PRD");
    await expect(page.getByTestId("prio-subtitle")).toContainText("Nov 2 – Feb 12");
    await expect(page.getByTestId("plan-goal-count").first()).toContainText("in the plan");
    for (const card of await page.locator('[data-testid="plan-goal"][data-goal]:not([data-goal=""])').all()) {
      await expect(card.getByTestId("goal-suggest-feature")).toHaveCount(0);
      await expect(card.getByTestId("goal-ask-oracle")).toHaveCount(0);
    }
    await expect(page.getByTestId("goal-suggestions-open").first()).toBeVisible();
    const revenue = page.locator('[data-testid="plan-goal"]').filter({ has: page.getByRole("heading", { name: "Revenue" }) });
    const code = (await revenue.getByTestId("plan-feature").first().getAttribute("data-code"))!;
    await page.getByRole("tab", { name: "Ranked list" }).click();
    await expect(page.getByTestId("prio-subtitle")).toContainText("Nov 2 – Feb 12");
    const r = page.getByTestId("prio-row").filter({ has: page.getByTestId("prio-code").getByText(code, { exact: true }) });
    await expect(r.getByTestId("prio-goal")).toHaveText("Revenue");
    await expect(page.getByTestId("prio-misses").first()).not.toContainText("(Now)");
  });
});
