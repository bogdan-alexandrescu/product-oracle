import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * Simple's Definition of Done, item 4 (docs/simple-dod-actions-plan.md): the Priorities actions
 * no spec drove yet, on a desktop (1440x900) and a phone (390x844). Driven against the mock's
 * default scenario: Oracle's order setup-checklist, alert-rules, alert-digest, alert-mobile,
 * setup-import, alert-export, alert-sso, price-tiers, setup-video; the draft Team invite nudges
 * (setup-ideas) waits below the ranking; Grow retention's bucket holds Oracle's suggestion
 * "Alert templates for new teams".
 */

const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const ORACLE = ["setup-checklist", "alert-rules", "alert-digest", "alert-mobile", "setup-import", "alert-export", "alert-sso", "price-tiers", "setup-video"];

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1440) <= 640;
const codes = (page: Page) => page.getByTestId("prio-row").evaluateAll((els) => els.map((e) => e.getAttribute("data-code")));
const row = (page: Page, code: string): Locator => page.locator(`[data-testid="prio-row"][data-code="${code}"]`);
const point = (page: Page, code: string): Locator => page.locator(`[data-testid="vxe-point"][data-code="${code}"]`);

async function open(page: Page, email?: string, tab = "") {
  await page.context().addInitScript((key) => localStorage.setItem(key, "default"), MOCK_SCENARIO_KEY);
  await login(page, email);
  await page.goto(`/simple/priorities${tab ? `?tab=${tab}` : ""}`);
  if (tab === "value-effort") await expect(point(page, "setup-checklist")).toBeVisible();
  else if (!tab) await expect(row(page, "setup-checklist")).toBeVisible();
}

/** Drags a row's handle onto the row now at `to` (0-based): a mouse, or a finger's pointer on a phone. */
async function dragRow(page: Page, code: string, to: number) {
  const handle = row(page, code).getByRole("button", { name: /^Drag .* to reorder$/ });
  await handle.evaluate((e) => e.scrollIntoView({ block: "center" }));
  const from = (await handle.boundingBox())!;
  const target = (await page.getByTestId("prio-row").nth(to).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, target.y + target.height / 2 + 2, { steps: 10 });
  await page.mouse.up();
}

async function giveReason(page: Page, reason: string, button: "Move" | "Propose") {
  const dialog = page.getByRole("dialog", { name: /^Why move / });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Reason").fill(reason);
  await dialog.getByRole("button", { name: button, exact: true }).click();
  await expect(dialog).toBeHidden();
}

/** Drags a value/effort mark sideways by `weeks` toward less effort: the mouse, or a real finger on a phone. */
async function dragMarkLeft(page: Page, code: string, weeks: number) {
  const mark = point(page, code);
  await mark.evaluate((e) => e.scrollIntoView({ block: "center" }));
  const plot = (await page.getByTestId("vxe-plot").boundingBox())!;
  const at = (await mark.boundingBox())!;
  const x = at.x + at.width / 2;
  const y = at.y + at.height / 2;
  const dx = (plot.width * 0.92 * weeks) / 5;
  if (!isPhone(page)) {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - dx, y + 3, { steps: 10 });
    await page.mouse.up();
    return;
  }
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let i = 1; i <= 10; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x - (dx * i) / 10, y: y + (3 * i) / 10 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

/** Grow retention's bucket, its suggestions drawer opened on Oracle's tab. */
async function oracleSuggestions(page: Page): Promise<Locator> {
  const bucket = page.locator('[data-testid="goal-bucket"][data-key="grow-retention"]');
  await bucket.getByRole("button", { name: "Suggestions for Grow retention" }).click();
  const drawer = page.getByTestId("goal-panel");
  await drawer.getByRole("tab", { name: /Oracle · 1/ }).click();
  return drawer;
}

for (const [where, use] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
] as const) {
  test.describe(where, () => {
    test.use(use);

    /*
     * Card dod-prio-approver-reorder: protects = an approver's move on the ranked list asks its
     * one-line reason and is a proposal: the order stays Oracle's and the row shows the proposal
     * waiting; fails_when = an approver's move applies, skips the reason, or leaves no proposal;
     * no_claim = who decides it (the API's routing).
     */
    test(`an approver's reorder is a proposal with its reason (${where})`, async ({ page }) => {
      await open(page, "approver@example.com");
      await dragRow(page, "alert-export", 0);
      await giveReason(page, "Two teams asked for it this month", "Propose");
      await expect(page.getByText(/^Proposed: .* decides$/)).toBeVisible();
      expect(await codes(page)).toEqual(ORACLE);
      await expect(row(page, "alert-export").getByTestId("prio-proposal")).toBeVisible();
    });

    /*
     * Card dod-prio-viewer: protects = a viewer reads the ranked list with no handle to drag and
     * the value/effort marks do not move; fails_when = a viewer is offered a reorder or a drag
     * re-estimates; no_claim = the API's refusal (pytest).
     */
    test(`a viewer reads the ranking and the 2x2 and moves nothing (${where})`, async ({ page }) => {
      await open(page, "viewer@example.com");
      await expect(page.getByRole("button", { name: /^Drag .* to reorder$/ })).toHaveCount(0);
      await page.getByRole("tab", { name: "Value / effort" }).click();
      await expect(point(page, "setup-import")).toBeVisible();
      const label = await point(page, "setup-import").getAttribute("aria-label");
      await dragMarkLeft(page, "setup-import", 2);
      await expect(page.getByText(/^Re-estimated|^Proposed/)).toHaveCount(0);
      await expect(point(page, "setup-import")).toHaveAttribute("aria-label", label!);
    });

    /*
     * Card dod-prio-commenter-2x2: protects = a commenter's drag of a value/effort mark (a mouse,
     * or a finger on a phone) is a proposal: the mark keeps its effort; fails_when = a commenter's
     * drag re-estimates or does nothing; no_claim = the keyboard (simple-priorities-codes.spec).
     */
    test(`a commenter's drag on the 2x2 proposes the re-estimate (${where})`, async ({ page }) => {
      await open(page, "commenter@example.com", "value-effort");
      const label = await point(page, "setup-import").getAttribute("aria-label");
      await dragMarkLeft(page, "setup-import", 2);
      await expect(page.getByText(/^Proposed: .* decides$/)).toBeVisible();
      await expect(point(page, "setup-import")).toHaveAttribute("aria-label", label!);
    });

    /*
     * Card dod-prio-bucket-reject: protects = the decider rejects Oracle's feature suggestion in
     * a goal bucket with an optional reason: it leaves the drawer and the toast says Oracle will
     * not suggest it again; fails_when = Reject does nothing or keeps the suggestion; no_claim =
     * Oracle's next suggestions.
     */
    test(`an owner rejects a goal's feature suggestion on Priorities (${where})`, async ({ page }) => {
      await open(page, undefined, "buckets");
      const drawer = await oracleSuggestions(page);
      const s = drawer.locator('[data-testid="goal-suggestion"][data-title="Alert templates for new teams"]');
      await s.getByRole("button", { name: "Reject" }).click();
      const dialog = page.getByRole("dialog", { name: "Reject Alert templates for new teams" });
      await dialog.getByLabel(/Why/).fill("Templates wait for the new editor");
      await dialog.getByRole("button", { name: "Reject" }).click();
      await expect(page.getByText("Rejected Alert templates for new teams: Oracle will not suggest it again").first()).toBeVisible();
      await expect(s).toHaveCount(0);
    });
  });
}

test.describe("phone", () => {
  test.use(PHONE);

  /*
   * Card dod-prio-phone-override: protects = on a phone an owner's move asks a one-line reason,
   * applies, and the row shows Oracle's rank as a ghost and the override with its reason; Undo
   * puts Oracle's order back; fails_when = the ghost or the override line is missing on a phone;
   * no_claim = the compare view (simple-priorities.spec).
   */
  test("an owner's move on a phone is an override with its reason and Oracle's ghost, undone", async ({ page }) => {
    await open(page);
    await dragRow(page, "alert-export", 0);
    await giveReason(page, "Two large customers asked for it", "Move");
    await expect(page.getByText("Moved Alert history export (AE) to rank 1")).toBeVisible();
    expect((await codes(page))[0]).toBe("alert-export");
    await expect(row(page, "alert-export").getByTestId("prio-ghost")).toHaveText("Oracle #6");
    await expect(row(page, "alert-export").getByTestId("prio-override")).toContainText("Moved by Admin: “Two large customers asked for it”");
    await page.getByRole("button", { name: "Undo" }).click();
    await expect.poll(() => codes(page)).toEqual(ORACLE);
  });

  /*
   * Card dod-prio-phone-accept: protects = on a phone the owner accepts Oracle's suggestion in a
   * goal bucket: it becomes a draft (the toast says so), then waits below the ranking until the
   * owner adds it; fails_when = Accept does nothing on a phone or the draft is not listed;
   * no_claim = the desktop (simple-additions.spec).
   */
  test("an owner accepts a goal's suggestion on a phone; the draft waits until it is added to the ranking", async ({ page }) => {
    await open(page, undefined, "buckets");
    const drawer = await oracleSuggestions(page);
    await drawer.locator('[data-testid="goal-suggestion"][data-title="Alert templates for new teams"]').getByRole("button", { name: "Accept" }).click();
    await expect(page.getByText("Added Alert templates for new teams as a draft").first()).toBeVisible();
    await drawer.getByRole("button", { name: "Close" }).click();

    await page.goto("/simple/priorities");
    const draft = page.locator('[data-testid="prio-draft"][data-code="setup-ideas"]');
    await draft.scrollIntoViewIfNeeded();
    await draft.getByRole("button", { name: "Add to the ranking" }).click();
    await expect(page.getByText("Added Team invite nudges to the ranking")).toBeVisible();
    await expect(row(page, "setup-ideas")).toContainText("Team invite nudges");
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.locator('[data-testid="prio-draft"][data-code="setup-ideas"]')).toBeVisible();
  });
});
