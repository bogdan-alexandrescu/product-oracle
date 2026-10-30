import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN, login, signOut } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * QA pass 3, simple-plan (/simple/priorities): the Ranked list, Value / effort, Goal buckets and
 * the suggestions drawer, driven through the UI as a person would, on the mock's default company
 * and its "simple-plan" scenario (a dated plan). Desktop 1440x900 and phone 390x844.
 */

const PHONE = { width: 390, height: 844 };
const COMMENTER = "commenter@example.com";
const VIEWER = "viewer@example.com";

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
  await expect(page.getByText("Loading priorities…")).toHaveCount(0);
}

const rowByTitle = (page: Page, title: string): Locator => page.getByTestId("prio-row").filter({ has: page.getByTestId("prio-title").getByText(title, { exact: true }) });
const toast = (page: Page, text: string | RegExp): Locator => page.getByRole("status").filter({ hasText: text });
type Box = { x: number; y: number; width: number; height: number };
const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

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

test.describe("QA pass 3: simple-plan, the line", () => {
  /* qa-simple-plan-1, -26: a date typed key by key is applied only when whole, with Apply; a visible Cancel. */
  test("a typed date applies only when whole, never as year 1", async ({ page }) => {
    await setUp(page);
    await open(page);
    await page.getByLabel("Line", { exact: true }).selectOption({ label: "Pick a date…" });
    const field = page.getByLabel("The line's date");
    // Start on the month part, as a person clicking the field's left edge does.
    await field.click({ position: { x: 12, y: 16 } });
    await page.keyboard.type("12012026");
    // Nothing applied while typing: the field is still open, the caption still reads this quarter.
    await expect(field).toBeVisible();
    await expect(page.getByTestId("line-caption")).toContainText("this quarter");
    await expect(page.getByTestId("line-caption")).not.toContainText(", 1");
    await expect(page.getByTestId("line-day-preview")).toHaveText("Dec 1, 2026");
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByTestId("line-caption")).toContainText("miss Dec 1, 2026");
    await expect(page.locator("#prio-line")).toContainText("Date: Dec 1, 2026");
    // Cancel is a visible, named button.
    await page.getByLabel("Line", { exact: true }).selectOption({ label: "Pick another date…" });
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByLabel("The line's date")).toHaveCount(0);
    await expect(page.getByTestId("line-caption")).toContainText("miss Dec 1, 2026");
  });

  /* qa-simple-plan-25, -2, -27: the options in date order, one style; any line splits the list at the line. */
  test("the line's options run in date order and every line splits the list", async ({ page }) => {
    await setUp(page);
    await open(page);
    const options = await page.locator("#prio-line option").allTextContents();
    const dated = options.filter((o) => / · /.test(o));
    expect(dated.length).toBeGreaterThan(1);
    for (const o of dated) expect(o).toMatch(/^(Key date|Milestone): .+ · [A-Z][a-z]{2} \d{1,2}, \d{4}$/);
    const days = dated.map((o) => Date.parse(o.split(" · ").at(-1)!));
    expect([...days].sort((a, b) => a - b)).toEqual(days);
    for (const label of dated) {
      await page.getByLabel("Line", { exact: true }).selectOption({ label });
      await expect(page.locator("#prio-line")).toHaveValue(/key_date|milestone/);
      await expect(page.getByText("Loading priorities…")).toHaveCount(0);
      const above = await page.getByTestId("prio-row").evaluateAll((els) => els.map((e) => e.getAttribute("data-above")));
      const first = above.indexOf("false");
      if (first >= 0) {
        expect(above.slice(first).every((a) => a === "false")).toBe(true);
        await expect(page.getByTestId("line-divider")).toHaveCount(1);
      }
      if (label.startsWith("Milestone: Beta")) {
        // Weekly alert digest is tagged Milestone Beta and misses it: said in so many words.
        const own = page.locator('[data-testid="prio-misses"][data-own="true"]');
        if ((await own.count()) > 0) await expect(own.first()).toContainText("Misses its own milestone");
      }
    }
  });
});

test.describe("QA pass 3: simple-plan, the Ranked list", () => {
  /* qa-simple-plan-3, -22, -23: the score is explained; titles start at one x; phone rows align with the title. */
  test("the score says how it is worked out and titles line up", async ({ page }) => {
    await setUp(page);
    await open(page);
    await expect(page.getByTestId("prio-score-help")).toHaveText(/^Score = goal value × Oracle's confidence in it \(0 to 1\) ÷ effort in engineer-weeks\.$/);
    const xs = await page.getByTestId("prio-row").evaluateAll((els) =>
      els.map((e) => Math.round(e.querySelector('[data-testid="prio-title"]')!.getBoundingClientRect().x)),
    );
    expect(new Set(xs).size).toBe(1);
  });

  test("on a phone the after-line sits under the title's left edge", async ({ page }) => {
    await setUp(page, { phone: true, scheme: "dark" });
    await open(page);
    const after = page.getByTestId("prio-after").first();
    await expect(after).toBeVisible();
    const card = after.locator("xpath=ancestor::li[1]");
    const pad = await after.evaluate((e) => getComputedStyle(e).paddingLeft);
    expect(pad).toBe("0px");
    expect(Math.abs((await after.boundingBox())!.x - (await card.boundingBox())!.x)).toBeLessThan(20);
    // qa-simple-plan-24: a handle is a 44 px touch target.
    const handle = page.getByRole("button", { name: /^Drag .* to reorder$/ }).first();
    const box = (await handle.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  });

  /*
   * qa-simple-plan-5, -44, -4, -22: Escape closes the move dialog and focus goes back to the
   * handle; the reason is marked required; a moved row offers "Back to Oracle's rank".
   */
  test("the move dialog closes on Escape, keeps focus, and a move can go back to Oracle's rank", async ({ page }) => {
    await setUp(page);
    await open(page);
    const handle = page.getByRole("button", { name: "Drag Setup checklist (SC) to reorder" });
    await handle.focus();
    await page.keyboard.press("ArrowDown");
    const dialog = page.getByRole("dialog", { name: /Why move Setup checklist/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("(required)")).toBeVisible();
    await expect(dialog.getByLabel(/Reason/)).toHaveAttribute("aria-required", "true");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(handle).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(handle).toBeFocused();
    // Move it, then put it back once the toast is gone.
    await page.keyboard.press("ArrowDown");
    await dialog.getByLabel(/Reason/).fill("Setup first this month");
    await dialog.getByRole("button", { name: "Move" }).click();
    await expect(handle).toBeFocused();
    const moved = rowByTitle(page, "Setup checklist");
    await expect(moved.getByTestId("prio-override")).toContainText("Setup first this month");
    // The Oracle # chip sits after the title, so the title starts where the others' do.
    const xs = await page.getByTestId("prio-row").evaluateAll((els) =>
      els.map((e) => Math.round(e.querySelector('[data-testid="prio-title"]')!.getBoundingClientRect().x)),
    );
    expect(new Set(xs).size).toBe(1);
    await moved.getByRole("button", { name: "Back to Oracle's rank" }).click();
    await expect(toast(page, "Moved Setup checklist (SC) back to Oracle's rank")).toBeVisible();
    await expect(moved.getByTestId("prio-override")).toHaveCount(0);
    await expect(moved.getByTestId("prio-ghost")).toHaveCount(0);
  });

  /* qa-simple-plan-20, -21: Compare says when the orders match, marks the rows that differ; chips stay on one line. */
  test("compare with Oracle says 'Same as Oracle's order' and marks differences", async ({ page }) => {
    await setUp(page);
    await open(page, "?compare=1");
    await expect(page.getByTestId("compare-same")).toContainText("Same as Oracle's order");
    await expect(page.locator('[data-testid="oracle-row"][data-differs="true"]')).toHaveCount(0);
    await expect(page.getByTestId("oracle-goal").first()).toBeVisible();
    for (const r of await page.getByTestId("prio-row").all()) {
      const misses = r.getByTestId("prio-misses");
      if ((await misses.count()) === 0) continue;
      const a = (await misses.boundingBox())!;
      const b = (await r.getByTestId("prio-goal").boundingBox())!;
      expect(Math.abs(a.y - b.y)).toBeLessThan(6);
    }
    await dragRow(page, "Setup checklist (SC)", 3);
    const dialog = page.getByRole("dialog", { name: /Why move Setup checklist/ });
    await dialog.getByLabel(/Reason/).fill("Setup first");
    await dialog.getByRole("button", { name: "Move" }).click();
    await expect(page.getByTestId("compare-same")).toHaveCount(0);
    await expect(page.locator('[data-testid="oracle-row"][data-differs="true"]').first()).toBeVisible();
  });

  /* qa-simple-plan-28, -29: plain merge words, a reason for the short list; Confirm says what it does. */
  test("a draft says what Confirm does and why the merge list is short", async ({ page }) => {
    await setUp(page);
    await open(page);
    const draft = page.getByTestId("prio-draft").first();
    await expect(draft.getByRole("button", { name: "Add to the ranking" })).toBeVisible();
    await draft.getByRole("button", { name: "Merge into…" }).click();
    await expect(draft.getByLabel("Merge into", { exact: true }).locator("option").first()).toHaveText("Choose a feature…");
    await expect(draft.getByTestId("merge-hint")).toContainText("Only features on");
  });

  /*
   * qa-simple-plan-29, -30, -31, -32: a commenter's move dialog says "If accepted"; a row they
   * cannot move keeps the column and says why; Confirm reads "Propose adding" and is off while
   * pending; a rank proposal has no "No flow yet" chip; the owner reads "waiting for you".
   */
  test("a commenter proposes in plain words and the owner reads 'waiting for you'", async ({ page }) => {
    await setUp(page, { email: COMMENTER });
    await open(page);
    const locked = page.getByTestId("prio-locked");
    if ((await locked.count()) > 0) {
      await expect(locked.first()).toContainText("You can't move this one");
      const lockedRow = locked.first().locator("xpath=ancestor::li[1]");
      await expect(lockedRow.getByTestId("prio-no-handle")).toHaveCount(1);
      const rankX = await page.getByTestId("prio-rank").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().x)));
      expect(new Set(rankX).size).toBe(1);
    }
    const handle = page.getByRole("button", { name: "Drag Setup checklist (SC) to reorder" });
    await handle.focus();
    await page.keyboard.press("ArrowDown");
    const dialog = page.getByRole("dialog", { name: /Why move Setup checklist/ });
    await expect(dialog).toContainText("If accepted, your order replaces Oracle's");
    await dialog.getByLabel(/Reason/).fill("Setup first");
    await dialog.getByRole("button", { name: "Propose" }).click();
    const proposal = rowByTitle(page, "Setup checklist").getByTestId("prio-proposal");
    await expect(proposal).toBeVisible();
    await expect(proposal.getByTestId("flow-none")).toHaveCount(0);
    await expect(proposal).not.toContainText("waiting for you");
    const draft = page.getByTestId("prio-draft").first();
    await draft.getByRole("button", { name: "Propose adding" }).click();
    await expect(draft.getByRole("button", { name: "Propose adding" })).toBeDisabled();

    // The owner, in the same browser (the mock's data is the browser's).
    await signOut(page);
    await login(page, ADMIN.email);
    await open(page);
    await expect(rowByTitle(page, "Setup checklist").getByTestId("prio-proposal-words")).toContainText("waiting for you");
  });
});

test.describe("QA pass 3: simple-plan, a dated plan", () => {
  /* qa-simple-plan-7, -8, -38: one code, goal and effort per feature on every tab; PM-owned work has no score. */
  test("each feature reads one code, goal and effort on every tab", async ({ page }) => {
    await setUp(page, { scenario: "simple-plan" });
    await open(page);
    const codes = await page.getByTestId("prio-row").getByTestId("prio-code").allTextContents();
    expect(codes.some((c) => /^PF\d*$/.test(c))).toBe(false);
    expect(new Set(codes).size).toBe(codes.length);
    const setupError = rowByTitle(page, "Setup error report");
    await expect(setupError.getByTestId("prio-code")).toHaveText("F-06");
    await expect(setupError.getByTestId("prio-goal")).toHaveText("Reliability");
    const referral = rowByTitle(page, "Referral link");
    await expect(referral.getByTestId("prio-code")).toHaveText("F-12");
    await expect(referral.getByTestId("prio-goal")).toHaveText("Growth");
    await expect(rowByTitle(page, "Setup checklist").getByTestId("prio-numbers")).toContainText("3 wk");
    // PM-owned work: no engineer-weeks, no score.
    const pricing = rowByTitle(page, "Pricing page words");
    await expect(pricing.getByTestId("prio-pm-owned")).toContainText("PM-owned");
    await expect(pricing.getByTestId("prio-score")).toHaveCount(0);

    await page.getByRole("tab", { name: "Goal buckets" }).click();
    const reliability = page.locator('[data-testid="plan-goal"]').filter({ hasText: "Reliability" }).first();
    await expect(reliability.locator('[data-testid="plan-feature"][data-code="F-06"]')).toContainText("Setup error report");
    await expect(page.locator('[data-testid="plan-feature"][data-code="F-01"]').getByTestId("plan-feature-total")).toHaveText("3 wk");
    // Codes drawn as chips (never grey monospace).
    const chip = page.locator('[data-testid="plan-feature"]').first().getByTestId("prio-code");
    expect(await chip.evaluate((e) => getComputedStyle(e).fontFamily)).not.toMatch(/mono/i);
    // The outside list names no code that the plan uses for another feature.
    const outside = page.getByTestId("plan-outside");
    if ((await outside.count()) > 0) await expect(outside).not.toContainText("F-06 Weekly alert digest");
  });

  /* qa-simple-plan-37, -39: 'M1 · 4 wk'; one heading; on a phone the weeks keep their unit. */
  test("plan buckets read weeks with their unit and say the heading once", async ({ page }) => {
    await setUp(page, { scenario: "simple-plan", phone: true, scheme: "dark" });
    await open(page, "?tab=buckets");
    await expect(page.getByTestId("prio-subtitle")).not.toContainText("Where the engineer-weeks go");
    for (const l of await page.getByTestId("goal-bar-segment").locator(".sr-only, [data-testid=goal-bar-label]").allTextContents()) expect(l).toMatch(/^M\d · [\d.]+ wk$/);
    const outside = page.getByTestId("plan-outside-goal").first();
    if ((await outside.count()) > 0) await expect(outside).toContainText(/\d wk/);
  });
});

test.describe("QA pass 3: simple-plan, Value / effort", () => {
  /* qa-simple-plan-13, -17, -18, -15, -16, -6: marks at their real effort; plain words; numbers of the selected mark. */
  test("marks sit at their real effort and say it plainly", async ({ page }) => {
    await setUp(page);
    await open(page, "?tab=value-effort");
    const tick2 = page.getByTestId("vxe-tick").filter({ hasText: /^2$/ });
    const tx = (await tick2.boundingBox())!;
    const tickX = tx.x + tx.width / 2;
    for (const code of ["setup-checklist", "alert-sso"]) {
      const b = (await page.locator(`[data-testid="vxe-point"][data-code="${code}"]`).boundingBox())!;
      // Within a fan-out step of the tick, never pushed off to a side of the middle line.
      expect(Math.abs(b.x + b.width / 2 - tickX)).toBeLessThan(40);
    }
    await expect(page.locator('[data-testid="vxe-point"][aria-label*="effort 1 weeks"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="vxe-point"][aria-label*="effort 1 week,"], [data-testid="vxe-point"][aria-label$="effort 1 week"]').first()).toBeAttached();
    const legend = page.getByRole("list", { name: "Legend" });
    await expect(legend).toContainText("Each mark shows the feature's code");
    await expect(legend).not.toContainText("Codes stay with the item");
    await page.locator('[data-testid="vxe-point"][data-code="setup-checklist"]').click();
    await expect(page.locator('[data-testid="side-row"][data-code="setup-checklist"]').getByTestId("side-numbers")).toHaveText(/^goal value [\d.]+ · confidence [\d.]+ · [\d.]+ wk · score [\d.]+$/);
    // A goal value of 0 (No goal): ArrowDown and ArrowUp change nothing.
    const noGoal = page.locator('[data-testid="vxe-point"][aria-label*="no goal"]').first();
    const before = await noGoal.getAttribute("aria-label");
    await noGoal.focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowUp");
    await page.waitForTimeout(400);
    await expect(noGoal).toHaveAttribute("aria-label", before!);
    // A re-estimate that keeps the rank says so.
    const sso = page.locator('[data-testid="vxe-point"][data-code="alert-sso"]');
    await sso.focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator('[data-testid="side-row"][data-code="alert-sso"]').getByTestId("moved")).toHaveText(/^(rank stays #\d+|now #\d+) \(effort [\d.]+ wk\)$/);
  });

  /* qa-simple-plan-14: a drag shows the value the mark will take. */
  test("dragging a mark shows the effort it will take", async ({ page }) => {
    await setUp(page);
    await open(page, "?tab=value-effort");
    const am = page.locator('[data-testid="vxe-point"][data-code="alert-mobile"]');
    const box = (await am.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, { steps: 8 });
    await expect(page.getByTestId("vxe-drag-readout")).toHaveText(/^effort [\d.]+ wk$/);
    await page.mouse.up();
    await expect(page.getByTestId("vxe-drag-readout")).toHaveCount(0);
  });

  /* qa-simple-plan-11, -12, -19: on a phone no marks overlap nor cover the median words; the chart scrolls the page; '… more' opens. */
  for (const scenario of [null, "simple-plan"]) {
    test(`on a phone marks never overlap (${scenario ?? "default"})`, async ({ page }) => {
      await setUp(page, { phone: true, scenario: scenario ?? undefined });
      await open(page, "?tab=value-effort");
      await page.waitForTimeout(300);
      const marks = await Promise.all((await page.getByTestId("vxe-point").all()).map(async (m) => (await m.boundingBox())!));
      const shrink = (b: Box) => ({ x: b.x + 2, y: b.y + 2, width: b.width - 4, height: b.height - 4 });
      for (let i = 0; i < marks.length; i++) for (let j = i + 1; j < marks.length; j++) expect(overlap(shrink(marks[i]), shrink(marks[j]))).toBe(0);
      const middle = (await page.getByTestId("vxe-middle-value").boundingBox())!;
      for (const m of marks) expect(overlap(middle, shrink(m))).toBe(0);
      expect(await page.getByTestId("vxe-plot").evaluate((e) => getComputedStyle(e).touchAction)).not.toBe("none");
      const more = page.getByTestId("line-caption-more");
      if ((await more.count()) > 0) {
        await more.click();
        await expect(more).toHaveCount(0);
      }
    });
  }
});

test.describe("QA pass 3: simple-plan, tabs and the rail", () => {
  /* qa-simple-plan-41, -42, -43: arrow keys move between tabs; a click as soon as the page shows switches; the email breaks at '@'. */
  test("the tabs follow the arrow keys and an early click", async ({ page }) => {
    await setUp(page, { email: VIEWER });
    await page.goto("/simple/priorities");
    await page.getByRole("tab", { name: "Value / effort" }).click();
    await expect(page.getByRole("tab", { name: "Value / effort" })).toHaveAttribute("aria-selected", "true");
    await page.waitForTimeout(1500);
    await expect(page.getByRole("tab", { name: "Value / effort" })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "Value / effort" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "Goal buckets" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tab", { name: "Goal buckets" })).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByRole("tab", { name: "Value / effort" })).toHaveAttribute("aria-selected", "true");
    const name = page.getByTestId("simple-person-name");
    if (await name.isVisible()) {
      const lines = await name.evaluate((e) => {
        const r = document.createRange();
        r.selectNodeContents(e);
        return [...r.getClientRects()].length;
      });
      if (lines > 1) await expect(name).not.toHaveText(/viewer@example\.co$/);
    }
  });
});

test.describe("QA pass 3: simple-plan, the suggestions drawer", () => {
  /* qa-simple-plan-10, -40, -9: the drawer opens on the tab holding the suggestions; Escape closes it and focus goes back. */
  test("the drawer opens where the suggestions are and closes on Escape", async ({ page }) => {
    await setUp(page);
    await open(page, "?tab=buckets");
    // One display of the share: the bar names the goals, the cards carry the numbers.
    await expect(page.getByTestId("bucket-segment").first()).not.toContainText("%");
    const opener = page.getByTestId("goal-suggestions-open").filter({ hasText: /· \d+/ }).first();
    await expect(opener).toContainText("See or make suggestions");
    await opener.click();
    const drawer = page.getByTestId("goal-panel");
    await expect(drawer).toBeVisible();
    const people = drawer.getByTestId("suggestions-tab-people");
    const oracle = drawer.getByTestId("suggestions-tab-oracle");
    const [p, o] = [await people.textContent(), await oracle.textContent()];
    if (/· 0$/.test(p ?? "") && !/· 0$/.test(o ?? "")) await expect(oracle).toHaveAttribute("aria-selected", "true");
    // qa-simple-plan-35: one suggest control, a chat button that says where it goes.
    await expect(drawer.getByTestId("suggest-first-feature")).toHaveCount(0);
    await expect(drawer.getByTestId("suggest-from-chat")).toHaveText("Ask Oracle in the chat");
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(opener).toBeFocused();
    // The × puts focus back too.
    await opener.click();
    await drawer.getByRole("button", { name: "Close" }).click();
    await expect(opener).toBeFocused();
  });

  /* qa-simple-plan-33, -34: the owner is not told someone else reviews; a look-alike links and offers a merge. */
  test("the owner reads they decide; look-alikes link and offer a merge", async ({ page }) => {
    await setUp(page, { scenario: "simple-plan" });
    await open(page, "?tab=buckets");
    await page.getByTestId("goal-suggest-feature").first().click();
    const drawer = page.getByTestId("goal-panel");
    await expect(drawer.getByTestId("suggest-decider")).not.toContainText("will review your suggestion");
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await page.getByTestId("goal-ask-oracle").first().click();
    const looks = drawer.getByTestId("suggestion-looks-like");
    await expect(drawer.getByTestId("goal-suggestion").first()).toBeVisible({ timeout: 15_000 });
    if ((await looks.count()) > 0) {
      await expect(looks.first().getByTestId("looks-like-link")).toBeVisible();
      await expect(looks.first().getByTestId("looks-like-merge")).toHaveText("Same as this: decline the suggestion");
    }
    // qa-simple-plan-36: one scrollbar (the page behind does not scroll); an opened flow comes into view.
    expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).toBe("hidden");
    const flow = drawer.getByTestId("flow-open").first();
    if ((await flow.count()) > 0) {
      await flow.click();
      await expect(drawer.getByTestId("flow-detail").first()).toBeInViewport();
    }
  });
});
