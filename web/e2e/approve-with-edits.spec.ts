import { expect, test, type Page } from "./test";

import { ROADMAP_REVIEW_RUN_ID } from "../lib/api/mock/runs";
import { login, seedRoadmapReview } from "./helpers";

/**
 * D7 Approve with edits: at the Roadmap items checkpoint, the approver's staged edits (D8
 * Shared draft decision) are applied by Oracle when they approve, with no agent round: the
 * button says how many, the run goes on to the roadmap draft, the decided checkpoint says what
 * was applied and the agents' own file is kept. A split needs the agents, so Approve waits.
 * Driven through the UI over the mock API.
 */

/** Whether the seeded run (and, with `split`, its staged split) is in the mock's store. */
function seedHeld(page: Page, split: boolean): Promise<boolean> {
  return page.evaluate(
    ({ runId, split }) => {
      const db = JSON.parse(localStorage.getItem("po-mock-db-v2")!);
      const run = db.runs.runs.find((r: { id: string }) => r.id === runId);
      const cp = run?.checkpoints.find((c: { status: string }) => c.status === "pending");
      const actions: { kind: string }[] = (cp && db.runs.drafts?.[cp.id]?.actions) ?? [];
      return !!cp && (!split || actions.some((a) => a.kind === "split"));
    },
    { runId: ROADMAP_REVIEW_RUN_ID, split },
  );
}

/**
 * Seeds the review run (and a staged split), then opens it from the runs list, as a person
 * would. A mock request the app had in flight when the seed was written can save its older
 * copy over it (as openSeeded in helpers handles); once the page has navigated nothing old can
 * land any more, so a lost seed is written again (at most 3 times).
 */
async function seedAndOpenRun(page: Page, split = false) {
  for (let i = 0; i < 3; i++) {
    await seedRoadmapReview(page);
    if (split) await seedStagedSplit(page);
    await page.goto("/runs");
    if (await seedHeld(page, split)) break;
  }
  await openRun(page);
}

/** Opens the seeded roadmap review run from the runs list, as a person would. */
async function openRun(page: Page) {
  await page.goto("/runs");
  await page.getByTestId("run-row").filter({ hasText: /usage-alerts-roadmap(?!-)/ }).getByRole("link").first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Roadmap from an approved PRD" })).toBeVisible();
}

const bar = (page: Page) => page.getByTestId("decision-bar");

/** D1: Roadmap items are decided on their review screen, opened from the run page's Review items. */
async function openReview(page: Page) {
  await page.getByTestId("items-review-line").getByRole("link", { name: "Review items" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Roadmap items" })).toBeVisible();
}
const item = (page: Page, title: string) => page.getByTestId("item-reasons").filter({ hasText: title });

/** Stages one reason's fix from its item, as an approver does, and waits for it to show as staged. */
async function stage(page: Page, title: string, fix: string) {
  const row = item(page, title);
  const before = await row.getByTestId("draft-action").count();
  await row.getByRole("button", { name: fix, exact: true }).click();
  await expect(row.getByTestId("draft-action")).toHaveCount(before + 1);
  await expect(row.getByTestId("draft-action").last()).toHaveText(/Staged by/);
}

/** Remove date, Drop and Move to Later staged on the run page; the review screen opened. */
async function stageEdits(page: Page) {
  await stage(page, "Slack alerts", "Remove date");
  await stage(page, "Mobile push", "Drop");
  await stage(page, "Budget caps", "Move to Later");
  await openReview(page);
}

/** On the review screen, the section reason waived: the gate opens on the edits. */
async function waiveSection(page: Page) {
  const row = page.locator('[data-testid="roadmap-item-row"][data-key="usage-export"]');
  await row.getByRole("button", { name: "More actions for Usage export" }).click();
  await page.getByRole("menuitem", { name: "Waive…" }).click();
  await page.getByTestId("roadmap-items-table").getByLabel("Why waive it").fill("Section lands in the next PRD version");
  await page.getByTestId("roadmap-items-table").getByRole("button", { name: "Waive", exact: true }).click();
  await expect(row.getByTestId("row-done")).toHaveText(/✓ Waived/);
}

/**
 * The fixture for the split: Split is not offered by any reason's fixes on this page yet (D1
 * Roadmap items review adds it), so the shared draft holds one staged Split on budget-caps, as
 * the approver's D1 action will leave it.
 */
async function seedStagedSplit(page: Page) {
  await page.evaluate((runId) => {
    const key = "po-mock-db-v2";
    const db = JSON.parse(localStorage.getItem(key)!);
    const run = db.runs.runs.find((r: { id: string }) => r.id === runId);
    const cp = run.checkpoints.find((c: { status: string }) => c.status === "pending");
    const now = new Date().toISOString();
    db.runs.drafts ??= {};
    db.runs.drafts[cp.id] = {
      revision: 1,
      note: null,
      log: [{ revision: 1, by: "Admin" }],
      actions: [
        {
          id: "7a11c0de-0000-4000-8000-0000000007a1",
          item_key: "budget-caps",
          kind: "split",
          field: null,
          value: { into: ["budget-caps-soft", "budget-caps-hard"] },
          answers: [],
          note: "Soft caps first, hard caps later.",
          state: "staged",
          created_by: db.user_id,
          updated_by: db.user_id,
          updated_at: now,
        },
      ],
    };
    localStorage.setItem(key, JSON.stringify(db));
  }, ROADMAP_REVIEW_RUN_ID);
}

// Card approve-with-edits: protects = staged edits are applied on Approve with no agent round:
// the button counts them, the run moves to the roadmap draft, the decided checkpoint says
// "Approved with 3 edits" and lists them, and the agents' file is kept as they wrote it;
// fails_when = the label is wrong, Approve stays disabled with the edits answering the gate,
// the run does not move on, or the agents' file is the edited one; no_claim = the API's YAML
// transform and re-check (pytest has them).
test("approve with 3 edits applies them, moves to the roadmap draft and keeps the agents' file", async ({ page }) => {
  await login(page);
  await seedAndOpenRun(page);
  await stageEdits(page);
  const approve = bar(page).getByRole("button", { name: "Approve with 3 edits" });
  await expect(approve).toBeDisabled();
  await waiveSection(page);
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect(page.getByTestId("review-status")).toHaveText("Approved with 3 edits");
  await page.getByRole("link", { name: /^Roadmap from an approved PRD from / }).click();

  // The run moves on to the roadmap draft: no agent re-ran the roadmap items.
  await expect(page.getByTestId("segment-roadmap_draft").getByTestId("segment-state")).toHaveText("Running");
  const items = page.getByTestId("segment-roadmap_items");
  await expect(items.getByTestId("checkpoint-roadmap_items")).toContainText("Approved");
  await expect(items).not.toContainText("attempt 2");
  const edits = items.getByTestId("approved-edits");
  await expect(edits).toContainText("Approved with 3 edits · View");
  await edits.getByRole("button", { name: "View" }).click();
  await expect(edits.getByTestId("applied-edits").getByRole("listitem")).toHaveText([
    "slack-alerts milestone date removed",
    "budget-caps horizon now → later",
    "mobile-push dropped",
  ]);

  // The file the next segment reads is the edited one; the agents' original is kept.
  const content = items.getByTestId("artifact-content");
  await items.getByRole("button", { name: "roadmap_items.yaml" }).click();
  await expect(content).toContainText("3 edits applied by Oracle; no agent ran. The agents' attempt 1 is kept.");
  await expect(content).toContainText("id: budget-caps, title: Budget caps, outcome: No team overspends its budget, horizon: later");
  await expect(content).not.toContainText("mobile-push");
  await expect(content).not.toContainText("2026-11-30");
  await items.getByRole("button", { name: "Agents' file" }).click();
  await expect(content).toContainText("milestone: {name: Beta, date: 2026-11-30, date_source: a guess}");
  await expect(content).toContainText("id: mobile-push");
  await expect(content).toContainText("id: budget-caps, title: Budget caps, outcome: No team overspends its budget, horizon: now");
  await expect(content).not.toContainText("edits applied by Oracle");
});

// Card needs-agents: protects = a staged split keeps Approve disabled and the page says the
// split needs the agents; removing it lets the edits be approved; fails_when = Approve is
// enabled with the split staged, or the sentence is missing or names the wrong item;
// no_claim = staging a split (no control on this page yet: the fixture stages it).
test("a staged split disables approve and says it needs the agents", async ({ page }) => {
  await login(page);
  await seedAndOpenRun(page, true);
  await stageEdits(page);
  await waiveSection(page);

  // D1's review screen: the split blocks Approve with the reason it needs the agents.
  await expect(bar(page).getByTestId("approve-blocked")).toContainText("Split needs the agents");
  const approve = bar(page).getByRole("button", { name: "Approve with 3 edits" });
  await expect(approve).toBeDisabled();

  // Removing the split is the other way on: Approve is enabled again.
  await bar(page).getByRole("button", { name: /^Undo .*split/i }).click();
  await expect(bar(page).getByTestId("approve-blocked")).toHaveCount(0);
  await expect(approve).toBeEnabled();
});
