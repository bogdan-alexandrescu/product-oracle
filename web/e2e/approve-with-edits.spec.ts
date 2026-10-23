import { expect, test, type Page } from "@playwright/test";

import { ROADMAP_REVIEW_RUN_ID } from "../lib/api/mock/runs";
import { login, seedRoadmapReview } from "./helpers";

/**
 * D7 Approve with edits: at the Roadmap items checkpoint, the approver's staged edits (D8
 * Shared draft decision) are applied by Oracle when they approve, with no agent round: the
 * button says how many, the run goes on to the roadmap draft, the decided checkpoint says what
 * was applied and the agents' own file is kept. A split needs the agents, so Approve waits.
 * Driven through the UI over the mock API.
 */

/** Opens the seeded roadmap review run from the runs list, as a person would. */
async function openRun(page: Page) {
  await page.goto("/runs");
  await page.getByTestId("run-row").filter({ hasText: /usage-alerts-roadmap(?!-)/ }).getByRole("link").first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Roadmap from an approved PRD" })).toBeVisible();
}

const decision = (page: Page) => page.getByRole("group", { name: "Decide: Roadmap items" });
const item = (page: Page, title: string) => page.getByTestId("item-reasons").filter({ hasText: title });

/** Stages one reason's fix from its item, as an approver does, and waits for it to show as staged. */
async function stage(page: Page, title: string, fix: string) {
  const row = item(page, title);
  const before = await row.getByTestId("draft-action").count();
  await row.getByRole("button", { name: fix, exact: true }).click();
  await expect(row.getByTestId("draft-action")).toHaveCount(before + 1);
  await expect(row.getByTestId("draft-action").last()).toHaveText(/Staged by/);
}

/** Remove date, Drop and Move to Later staged, the section reason waived: the gate opens on the edits. */
async function stageEdits(page: Page) {
  await stage(page, "Slack alerts", "Remove date");
  await stage(page, "Mobile push", "Drop");
  await stage(page, "Budget caps", "Move to Later");
  const gate = decision(page).getByTestId("approve-gate");
  const row = gate.getByTestId("gate-reason").filter({ hasText: "Usage export" });
  await row.getByRole("button", { name: "Waive…" }).click();
  await row.getByRole("textbox").fill("Section lands in the next PRD version");
  await row.getByRole("button", { name: "Waive", exact: true }).click();
  await expect(gate).toHaveCount(0);
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
  await seedRoadmapReview(page);
  await openRun(page);
  await expect(decision(page).getByRole("button", { name: "Approve and continue" })).toBeDisabled();

  await stageEdits(page);
  const approve = decision(page).getByRole("button", { name: "Approve with 3 edits" });
  await expect(approve).toBeEnabled();
  await approve.click();

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
  await seedRoadmapReview(page);
  await seedStagedSplit(page);
  await openRun(page);
  await stageEdits(page);

  const sentence = "Split on budget-caps needs the agents: send back, or remove it to approve.";
  await expect(decision(page).getByTestId("needs-agents")).toHaveText(sentence);
  const approve = decision(page).getByRole("button", { name: "Approve with 3 edits" });
  await expect(approve).toBeDisabled();
  await expect(approve).toHaveAttribute("title", sentence);

  // Removing the split is the other way on: Approve is enabled again.
  const split = item(page, "Budget caps").getByTestId("draft-action").filter({ hasText: "Split" });
  await split.getByRole("button", { name: "Undo" }).click();
  await expect(decision(page).getByTestId("needs-agents")).toHaveCount(0);
  await expect(approve).toBeEnabled();
});
