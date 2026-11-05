import { expect, test, type Page } from "./test";

import { ROADMAP_CROSS_PRD_RUN_ID } from "../lib/api/mock/runs";
import { login, seedRoadmapCrossPrd, signOut } from "./helpers";

const COMMENTER = "commenter@example.com";

/**
 * The owner, Nov 4: a roadmap item may depend on another PRD's feature on the company roadmap.
 * Budget caps (Now) waits on Account health ledger, the Safety PRD's item in Next, and on its
 * own Anomaly detection (Later). The review shows each reason in its own words with its own
 * fixes, the other PRD's feature by name, and acting on one clears that one only.
 */

const CROSS = "Needs Account health ledger (Safety PRD), which is in Next. An item cannot ship before what it depends on.";
const LOCAL = "Needs Anomaly detection, which is in Later. An item cannot ship before what it depends on.";

const row = (page: Page, key: string) => page.locator(`[data-testid="roadmap-item-row"][data-key="${key}"]`);
const inspector = (page: Page) => page.getByTestId("roadmap-item-inspector");
const card = (page: Page, text: string) => inspector(page).getByTestId("reason-card").filter({ hasText: text });

async function openReview(page: Page, email?: string) {
  await login(page, email);
  await seedRoadmapCrossPrd(page);
  await goToReview(page);
}

async function goToReview(page: Page) {
  await page.goto("/runs");
  await page.locator('[data-testid="run-row"][data-document="usage-alerts-roadmap-6"]').getByRole("link").first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Roadmap from an approved PRD" })).toBeVisible();
  await page.getByTestId("items-review-line").getByRole("link", { name: "Review items" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Roadmap items" })).toBeVisible();
}

test("an item waiting on another PRD's feature and on its own item shows both reasons with their own fixes; acting on one clears it", async ({ page }) => {
  await openReview(page);
  await expect(page.getByTestId("review-summary")).toHaveText("3 blocking · 7 to confirm");
  await expect(row(page, "budget-caps").getByTestId("reason-chip")).toHaveText(["Depends on a later item", "Depends on a later item"]);
  await row(page, "budget-caps").locator('[data-phone="title"]').click();

  const cross = card(page, CROSS);
  const local = card(page, LOCAL);
  await expect(cross).toHaveCount(1);
  await expect(local).toHaveCount(1);
  await expect(cross.getByRole("button")).toHaveText(["Move to Next", "Remove dependency", "Waive…"]);
  await expect(local.getByRole("button")).toHaveText(["Move to Later", "Pull dependency to Now", "Remove dependency", "Waive…"]);
  // The other PRD's feature is named, never shown as its key.
  const depends = inspector(page).getByTestId("item-depends");
  await expect(depends).toContainText("Account health ledger (Safety PRD)");
  await expect(depends).toContainText("Anomaly detection");
  await expect(inspector(page)).not.toContainText("account-health-ledger");

  // Acting on the other PRD's reason clears it, and only it.
  await cross.getByRole("button", { name: "Remove dependency", exact: true }).click();
  await expect(cross).toContainText("✓ Dependency removed");
  await expect(cross.getByRole("button", { name: "Move to Next", exact: true })).toHaveCount(0);
  await expect(local.getByRole("button", { name: "Move to Later", exact: true })).toBeVisible();
  await expect(page.getByTestId("review-summary")).toHaveText("3 blocking · 7 to confirm");

  // Acting on its own item's reason clears that one, and the item leaves the blocking count.
  await local.getByRole("button", { name: "Move to Later", exact: true }).click();
  await expect(local).toContainText("✓ Moved to Later");
  await expect(cross).toContainText("✓ Dependency removed");
  await expect(page.getByTestId("review-summary")).toHaveText("2 blocking · 7 to confirm");
});

test("Move to Later on its own item's reason also clears the other PRD's reason in Next", async ({ page }) => {
  await openReview(page);
  await row(page, "budget-caps").locator('[data-phone="title"]').click();
  const cross = card(page, CROSS);
  const local = card(page, LOCAL);
  // In Later, Budget caps ships after both: the ledger (Next) and Anomaly detection (Later).
  await local.getByRole("button", { name: "Move to Later", exact: true }).click();
  await expect(local).toContainText("✓ Moved to Later");
  await expect(cross).toContainText("✓ Moved to Later");
  await expect(cross.getByRole("button", { name: "Move to Next", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("review-summary")).toHaveText("2 blocking · 7 to confirm");
});

test("Remove dependency pressed on both reasons removes both and clears both", async ({ page }) => {
  await openReview(page);
  await row(page, "budget-caps").locator('[data-phone="title"]').click();
  const cross = card(page, CROSS);
  const local = card(page, LOCAL);
  await cross.getByRole("button", { name: "Remove dependency", exact: true }).click();
  await expect(cross).toContainText("✓ Dependency removed");
  await local.getByRole("button", { name: "Remove dependency", exact: true }).click();
  await expect(local).toContainText("✓ Dependency removed");
  // The first removal stays: its dependency does not come back and its reason stays answered.
  await expect(cross).toContainText("✓ Dependency removed");
  await expect(page.getByTestId("review-summary")).toHaveText("2 blocking · 7 to confirm");
});

test("Undo on one of two joined removals brings back that dependency only; the other stays removed", async ({ page }) => {
  await openReview(page);
  await row(page, "budget-caps").locator('[data-phone="title"]').click();
  const cross = card(page, CROSS);
  const local = card(page, LOCAL);
  await cross.getByRole("button", { name: "Remove dependency", exact: true }).click();
  await expect(cross).toContainText("✓ Dependency removed");
  await local.getByRole("button", { name: "Remove dependency", exact: true }).click();
  await expect(local).toContainText("✓ Dependency removed");
  await expect(page.getByTestId("review-summary")).toHaveText("2 blocking · 7 to confirm");

  // Undo on the ledger's card: its reason and its dependency come back, Anomaly detection stays removed.
  await cross.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(cross.getByRole("button", { name: "Move to Next", exact: true })).toBeVisible();
  await expect(local).toContainText("✓ Dependency removed");
  await expect(local.getByRole("button", { name: "Move to Later", exact: true })).toHaveCount(0);
  const depends = inspector(page).getByTestId("item-depends");
  await expect(depends.getByRole("button", { name: "Remove dependency Account health ledger (Safety PRD)" })).toBeVisible();
  await expect(depends.getByRole("button", { name: "Remove dependency Anomaly detection" })).toHaveCount(0);
  // One reason open on Budget caps: it stays blocking, and nothing else changes.
  await expect(page.getByTestId("review-summary")).toHaveText("3 blocking · 7 to confirm");

  // A reload reads the same: one removal staged.
  await page.reload();
  await row(page, "budget-caps").locator('[data-phone="title"]').click();
  await expect(card(page, LOCAL)).toContainText("✓ Dependency removed");
  await expect(card(page, CROSS).getByRole("button", { name: "Move to Next", exact: true })).toBeVisible();
});

test("a commenter's two Remove dependency suggestions both stay, each card with its own Undo", async ({ page }) => {
  await login(page, COMMENTER);
  await seedRoadmapCrossPrd(page);
  await page.goto("/runs");
  await page.locator('[data-testid="run-row"][data-document="usage-alerts-roadmap-6"]').getByRole("link").first().click();
  await page.getByTestId("items-review-line").getByRole("link", { name: "Review items" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Roadmap items" })).toBeVisible();
  await row(page, "budget-caps").locator('[data-phone="title"]').click();
  const cross = card(page, CROSS);
  const local = card(page, LOCAL);
  const depends = inspector(page).getByTestId("item-depends");

  await cross.getByRole("button", { name: "Remove dependency", exact: true }).click();
  await expect(cross).toContainText("Suggested: Dependency removed");
  await local.getByRole("button", { name: "Remove dependency", exact: true }).click();
  await expect(local).toContainText("Suggested: Dependency removed");
  // The first suggestion stays: both dependencies read as removed.
  await expect(cross).toContainText("Suggested: Dependency removed");
  await expect(depends.getByRole("button", { name: /^Remove dependency / })).toHaveCount(0);
  // A suggestion answers nothing until an approver stages it.
  await expect(page.getByTestId("review-summary")).toHaveText("3 blocking · 7 to confirm");

  // Undo on Anomaly detection's card takes back that suggestion only.
  await local.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(local.getByRole("button", { name: "Remove dependency", exact: true })).toBeVisible();
  await expect(cross).toContainText("Suggested: Dependency removed");
  await expect(depends.getByRole("button", { name: "Remove dependency Anomaly detection" })).toBeVisible();
  await expect(depends.getByRole("button", { name: "Remove dependency Account health ledger (Safety PRD)" })).toHaveCount(0);
});

/** Another commenter (an invented person) and one action on Budget caps in the run's shared draft. */
const OTHER = { id: "7a11c0de-0000-4000-8000-0000000005a1", email: "sam.okafor@example.com" };

async function seedAction(page: Page, action: Record<string, unknown>) {
  await page.evaluate(
    ({ runId, other, action }) => {
      type Db = {
        user_id: string;
        members: { id: string; email: string; role: string }[];
        runs: { runs: { id: string; checkpoints: { id: string; status: string }[] }[]; drafts?: Record<string, unknown> };
      };
      const write = (globalThis as { __poMockWrite?: (change: (db: Db) => void) => Promise<void> }).__poMockWrite!;
      return write((db) => {
        const commenter = db.members.find((m) => m.role === "commenter")!;
        db.members = [...db.members.filter((m) => m.id !== other.id), { ...commenter, id: other.id, email: other.email }];
        const cp = db.runs.runs.find((r) => r.id === runId)!.checkpoints.find((c) => c.status === "pending")!;
        const by = action.created_by === "other" ? other.id : db.user_id;
        const now = new Date().toISOString();
        db.runs.drafts ??= {};
        db.runs.drafts[cp.id] = {
          revision: 1,
          note: null,
          log: [],
          actions: [{ id: "7a11c0de-0000-4000-8000-0000000005b1", item_key: "budget-caps", kind: "edit", field: "depends_on", answers: [], note: null, ...action, created_by: by, updated_by: by, updated_at: now }],
        };
      });
    },
    { runId: ROADMAP_CROSS_PRD_RUN_ID, other: OTHER, action },
  );
}

// Review follow-up (PR 1264, minor 1): protects = a commenter's Remove dependency never meets
// another person's dependency change in silence: it says whose it is and offers theirs as a
// separate suggestion (Ask a teammate, filled in); fails_when = the button stays and its post is
// refused with nothing said; no_claim = what an approver does with either suggestion.
test("a commenter's Remove dependency where another person's suggestion holds the item says whose and offers theirs separately", async ({ page }) => {
  await login(page, COMMENTER);
  await seedRoadmapCrossPrd(page);
  await seedAction(page, { value: { add: [], remove: ["anomaly-detection"] }, answers: ["horizon_breaks_dependency"], state: "suggested", created_by: "other" });
  await goToReview(page);
  await row(page, "budget-caps").locator('[data-phone="title"]').click();
  const cross = card(page, CROSS);
  await expect(cross.getByTestId("their-removal")).toContainText("Sam Okafor suggested this item's dependency change");
  await expect(cross.getByRole("button", { name: "Remove dependency", exact: true })).toHaveCount(0);
  await expect(cross.getByRole("button", { name: "Move to Next", exact: true })).toBeVisible();

  await cross.getByRole("button", { name: "Suggest yours separately…" }).click();
  const form = inspector(page).getByTestId("form-ask");
  await expect(form.getByRole("textbox", { name: "Question" })).toHaveValue("Please also remove the dependency on Account health ledger (Safety PRD).");
  await form.getByRole("combobox", { name: "Ask" }).selectOption({ label: "Priya Raman" });
  await form.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(row(page, "budget-caps").getByTestId("asked-chip")).toHaveText("Asked Priya Raman");
  // The other person's suggestion is still theirs, unchanged.
  await expect(row(page, "budget-caps").getByTestId("suggested-by").filter({ hasText: "Suggested by Sam Okafor" })).toContainText("Dependency removed");
});

// Review follow-up (PR 1264, minor 2): protects = an approver's Remove dependency joins a
// commenter's suggested removal on the item (both removed, both reasons answered); fails_when =
// it replaces the suggestion, so the commenter's dependency comes back; no_claim = Stage.
test("an approver's Remove dependency joins a commenter's suggested removal on the item", async ({ page }) => {
  await openReview(page, COMMENTER);
  await row(page, "budget-caps").locator('[data-phone="title"]').click();
  await card(page, CROSS).getByRole("button", { name: "Remove dependency", exact: true }).click();
  await expect(card(page, CROSS)).toContainText("Suggested: Dependency removed");
  await signOut(page);

  await login(page);
  await goToReview(page);
  await row(page, "budget-caps").locator('[data-phone="title"]').click();
  const cross = card(page, CROSS);
  const local = card(page, LOCAL);
  await local.getByRole("button", { name: "Remove dependency", exact: true }).click();
  await expect(local).toContainText("✓ Dependency removed");
  await expect(cross).toContainText("✓ Dependency removed");
  await expect(cross.getByRole("button", { name: "Move to Next", exact: true })).toHaveCount(0);
  await expect(inspector(page).getByTestId("item-depends").getByRole("button", { name: /^Remove dependency / })).toHaveCount(0);
  await expect(page.getByTestId("review-summary")).toHaveText("2 blocking · 7 to confirm");
});

// Review follow-up (PR 1264, minor 3): protects = the row's own Undo on a joined removal says
// it takes back both (each reason card's Undo takes back one); fails_when = it reads as a plain
// Undo yet removes both; no_claim = the reason cards' Undo (tested above).
test("the row's Undo on two joined removals says it undoes both, and does", async ({ page }) => {
  await openReview(page);
  await row(page, "budget-caps").locator('[data-phone="title"]').click();
  await card(page, CROSS).getByRole("button", { name: "Remove dependency", exact: true }).click();
  await expect(card(page, CROSS)).toContainText("✓ Dependency removed");
  await card(page, LOCAL).getByRole("button", { name: "Remove dependency", exact: true }).click();
  await expect(card(page, LOCAL)).toContainText("✓ Dependency removed");

  const done = row(page, "budget-caps").getByTestId("row-done");
  await expect(done).toContainText("✓ 2 dependencies removed");
  await expect(done.getByRole("button", { name: "Undo", exact: true })).toHaveCount(0);
  await done.getByRole("button", { name: "Undo both" }).click();
  await expect(card(page, CROSS).getByRole("button", { name: "Move to Next", exact: true })).toBeVisible();
  await expect(card(page, LOCAL).getByRole("button", { name: "Move to Later", exact: true })).toBeVisible();
  await expect(page.getByTestId("review-summary")).toHaveText("3 blocking · 7 to confirm");
});

// Review follow-up (PR 1264, minor 4): protects = Undo on one dependency of a joined removal
// staged from a discussion keeps it the discussion's (its chip keeps the discussion mark);
// fails_when = the narrowed edit reads as a row action; no_claim = the discussion's own status
// (tests/test_discussion_changes.py).
test("Undo on one dependency of a removal staged from a discussion keeps it the discussion's", async ({ page }) => {
  await login(page);
  await seedRoadmapCrossPrd(page);
  await seedAction(page, {
    value: { add: [], remove: ["account-health-ledger", "anomaly-detection"] },
    state: "staged",
    origin: "discussion",
    discussion_id: "7a11c0de-0000-4000-8000-0000000005d1",
    discussion_change_id: "7a11c0de-0000-4000-8000-0000000005c1",
    from_private: false,
  });
  await goToReview(page);
  await row(page, "budget-caps").locator('[data-phone="title"]').click();
  const cross = card(page, CROSS);
  await expect(cross).toContainText("✓ Dependency removed");
  await cross.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(cross.getByRole("button", { name: "Move to Next", exact: true })).toBeVisible();
  await expect(card(page, LOCAL)).toContainText("✓ Dependency removed");

  await page.goto("/runs");
  await page.locator('[data-testid="run-row"][data-document="usage-alerts-roadmap-6"]').getByRole("link").first().click();
  const chip = page.getByTestId("staging-bar").filter({ visible: true }).getByTestId("staged-chip");
  await expect(chip).toHaveCount(1);
  await expect(chip.getByTestId("chip-discussion")).toHaveCount(1);
});

// Review follow-up (PR 1264, minor 2): protects = the panel's × of an approver joins a
// commenter's suggested removal too; fails_when = it replaces the suggestion; no_claim = Stage.
test("an approver's × on a dependency joins a commenter's suggested removal on the item", async ({ page }) => {
  await openReview(page, COMMENTER);
  await row(page, "budget-caps").locator('[data-phone="title"]').click();
  await card(page, CROSS).getByRole("button", { name: "Remove dependency", exact: true }).click();
  await expect(card(page, CROSS)).toContainText("Suggested: Dependency removed");
  await signOut(page);

  await login(page);
  await goToReview(page);
  await row(page, "budget-caps").locator('[data-phone="title"]').click();
  await inspector(page).getByTestId("item-depends").getByRole("button", { name: "Remove dependency Anomaly detection" }).click();
  await expect(card(page, LOCAL)).toContainText("✓ Dependency removed");
  await expect(card(page, CROSS)).toContainText("✓ Dependency removed");
  await expect(page.getByTestId("review-summary")).toHaveText("2 blocking · 7 to confirm");
});
