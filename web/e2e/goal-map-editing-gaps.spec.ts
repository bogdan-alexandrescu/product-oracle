import { LADDER_SCENARIO } from "../lib/api/mock/goal-ladder";
import { MOCK_FAIL_ONCE_KEY, MOCK_ROLE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * Goal map editing gaps (owner picks: Free canvas, Edit ladder toggle; Nov 6 "no delete or
 * drag-drop" for commenters as direct edits), against the mock ("goal-ladder" scenario: invented
 * goals, milestones and features; F-66 serves Goal 1 but no milestone). A commenter's drop or
 * Move to Trash is a suggestion that waits for the decider, never a silent snap back; a card on
 * no milestone is placed by hand outside Edit mode; the "serve no gate" badge opens the list of
 * those features, each with its code and its fix; a drop that fails half way leaves nothing half
 * done; a milestone in Settings › Trash comes back on Restore.
 *
 * Test cards (protects / fails_when / no_claim) are each test's comment.
 */

test.use({ viewport: { width: 1440, height: 900 } });

async function open(page: Page, role?: "commenter" | "approver") {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, LADDER_SCENARIO] as const);
  if (role) await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_ROLE_KEY, role] as const);
  await login(page);
  await page.goto("/simple/goals");
  await expect(page.getByTestId("gm-page")).toBeVisible();
  await expect(page.getByTestId("ld-goal").first()).toBeVisible();
}

const card = (page: Page, code: string) => page.getByTestId("ld-feature").filter({ has: page.locator(".simple-code", { hasText: new RegExp(`^${code}$`) }) });
const krCard = (page: Page, name: string) => page.getByTestId("ld-milestone").filter({ hasText: name });
const toast = (page: Page, text: string | RegExp) => page.getByRole("status").filter({ hasText: text });

async function dragBy(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10);
  await page.mouse.up();
}
async function area(page: Page) {
  await page.getByTestId("ld-canvas").evaluate((el) => el.scrollIntoView({ block: "nearest" }));
  const c = (await page.getByTestId("ld-canvas").boundingBox())!;
  const top = Math.max(c.y, 0);
  return { x: c.x, y: top, width: c.width, height: Math.min(c.y + c.height, page.viewportSize()!.height - 100) - top };
}
/** Zooms out until both fit in the canvas, then pans them into view (the wheel over the canvas). */
async function showBoth(page: Page, a: Locator, b: Locator) {
  const canvas = await area(page);
  for (let i = 0; i < 14; i++) {
    const [A, B] = [(await a.boundingBox())!, (await b.boundingBox())!];
    const top = Math.min(A.y, B.y);
    const bottom = Math.max(A.y + A.height, B.y + B.height);
    if (top >= canvas.y && bottom <= canvas.y + canvas.height) return;
    if (bottom - top > canvas.height - 40) {
      await page.getByRole("button", { name: "Zoom out" }).click();
      continue;
    }
    await page.mouse.move(canvas.x + canvas.width - 30, canvas.y + canvas.height / 2);
    await page.mouse.wheel(0, -(canvas.y + canvas.height / 2 - (top + bottom) / 2));
    await page.waitForTimeout(50);
  }
}
async function mid(loc: Locator) {
  const b = (await loc.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
async function drag(page: Page, from: Locator, to: Locator) {
  await showBoth(page, from, to);
  await dragBy(page, await mid(from), await mid(to));
}
test("a commenter's drop on a milestone of its own goal is a suggestion that waits for the decider", async ({ page }) => {
  // protects=a commenter's link of F-66 onto M3 of its own goal is proposed (link_goal_map) with a
  // toast naming who it waits for, and the card stays until it is accepted; fails_when=it is refused
  // ("Only owners and approvers…") or snaps back with no word; no_claim=the decider's accept (pytest).
  await open(page, "commenter");
  await page.getByTestId("ld-edit").click();
  const m3 = page.locator("[data-ld-group]").filter({ hasText: "Mobile check-ins weekly for half of teams" }).first();
  await drag(page, card(page, "F-66"), m3.locator("span").first());
  await expect(toast(page, "Suggested: move")).toContainText(/^Suggested: move F-66 .+ to .*Mobile check-ins weekly for half of teams; it waits for (?!the roadmap's owner)\S/);
  await expect(page.getByTestId("ld-free").filter({ has: card(page, "F-66") })).toHaveCount(1);
  await expect(m3.getByTestId("ld-feature").filter({ hasText: "F-66" })).toHaveCount(0);
});

test("a commenter's Move to Trash on a milestone is a suggestion, and the milestone stays", async ({ page }) => {
  // protects=the ⋯ menu offers a commenter Move to Trash on a key result, and it proposes the
  // removal to the decider with a toast; fails_when=no Move to Trash, the API's 403 shows, or the
  // milestone leaves the ladder; no_claim=the decider's accept (pytest).
  await open(page, "commenter");
  await page.getByTestId("ld-edit").click();
  const kr = krCard(page, "Renewal rate at 85% for spring renewals");
  await kr.getByTestId("ld-more").first().click();
  await page.getByRole("menuitem", { name: "Move to Trash", exact: true }).click();
  await expect(toast(page, "Suggested: move")).toContainText(/Renewal rate at 85% for spring renewals to Trash; it waits for (?!the roadmap's owner)\S/);
  await expect(kr).toHaveCount(1);
});

test("Free canvas: a card on no milestone is placed by hand outside Edit mode and stays there", async ({ page }) => {
  // protects=the owner's Free canvas pick: F-66 (no milestone) dragged on the canvas without Edit
  // ladder keeps its place, after a reload too; fails_when=it snaps back; no_claim=Edit mode drops.
  await open(page);
  const f = card(page, "F-66");
  await f.scrollIntoViewIfNeeded();
  const from = await mid(f);
  await dragBy(page, from, { x: from.x + 140, y: from.y + 30 });
  await expect(toast(page, "by hand")).toContainText("Moved F-66");
  await expect(f).toHaveAttribute("data-placed", "1");
  await page.reload();
  await expect(card(page, "F-66")).toHaveAttribute("data-placed", "1");
});

test("the badges open their lists: each feature with its code and name, each gate area with its fix", async ({ page }) => {
  // protects=“6 features serve no gate” opens “Features serving no gate” listing each one's code
  // chip then name with Place it, and Place it opens Attach for it; the gate areas badge opens its
  // list with Place a feature; fails_when=the badge jumps onto the ladder instead, or a row has no
  // code; no_claim=the attach itself.
  await open(page);
  await page.getByTestId("gm-flag-unplaced").click();
  const list = page.getByTestId("gm-flag-list");
  await expect(list.getByRole("heading")).toHaveText("Features serving no gate");
  const row = list.getByTestId("gm-unplaced").filter({ has: page.locator(".simple-code", { hasText: /^F-66$/ }) });
  await expect(row).toHaveCount(1);
  await row.getByTestId("gm-place").click();
  await expect(page.getByTestId("gm-editor")).toBeVisible();
  await page.getByTestId("gm-editor").getByRole("button", { name: "Close" }).click();
  const gaps = page.getByTestId("gm-flag-gaps");
  if (await gaps.count()) {
    await gaps.click();
    await expect(list.getByRole("heading")).toHaveText("Gate areas with no feature");
    await expect(list.getByTestId("gm-gap").first().getByTestId("gm-place")).toBeVisible();
  }
});

test("a drop that fails half way leaves the feature on its milestone", async ({ page }) => {
  // protects=dropFeature never leaves partial state: the owner drops a feature on
  // a milestone onto another goal; its links are let go, then the goal change fails (500); the
  // links come back, so the card is still on its milestone; fails_when=the card ends on no
  // milestone of either goal; no_claim=the API's own rollback.
  await open(page);
  await page.getByTestId("ld-edit").click();
  const column = page.getByTestId("ld-column").first();
  const group = column.locator("[data-ld-group]").filter({ has: page.getByTestId("ld-feature") }).first();
  const f = group.getByTestId("ld-feature").first();
  const code = (await f.locator(".simple-code").first().textContent())!.trim();
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [MOCK_FAIL_ONCE_KEY, "POST /v1/simple/changes"] as const);
  await drag(page, card(page, code), page.getByTestId("ld-goal").nth(1));
  await expect(page.getByRole("status").first()).toBeVisible();
  await expect(group.getByTestId("ld-feature").filter({ has: page.locator(".simple-code", { hasText: new RegExp(`^${code}$`) }) })).toHaveCount(1);
  await page.reload();
  await expect(page.getByTestId("ld-column").first().locator("[data-ld-group]").filter({ has: card(page, code) })).toHaveCount(1);
});

test("a milestone moved to Trash comes back on the ladder from Settings › Trash", async ({ page }) => {
  // protects=a key result's Move to Trash lists it in Settings › Trash as a Milestone, and Restore
  // there puts it back on the ladder; fails_when=Trash does not list it or Restore leaves it gone;
  // no_claim=the goal-in-Trash refusal (pytest).
  await open(page);
  await page.getByTestId("ld-edit").click();
  const kr = krCard(page, "Renewal rate at 85% for spring renewals");
  await kr.getByTestId("ld-more").first().click();
  await page.getByRole("menuitem", { name: "Move to Trash", exact: true }).click();
  await expect(kr).toHaveCount(0);
  await page.goto("/settings/trash");
  const row = page.getByRole("listitem").filter({ hasText: "Renewal rate at 85% for spring renewals" }).first();
  await expect(row.getByTestId("trash-kind")).toHaveText("Milestone");
  await row.getByRole("button", { name: /Restore/ }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "Renewal rate at 85% for spring renewals" })).toHaveCount(0);
  await page.goto("/simple/goals");
  await expect(krCard(page, "Renewal rate at 85% for spring renewals")).toHaveCount(1);
});
