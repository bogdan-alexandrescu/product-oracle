import { expect, test, type Page } from "@playwright/test";

import { ROADMAP_REVIEW_RUN_ID } from "../lib/api/mock/runs";
import { login, seedRoadmapReview, signOut } from "./helpers";

/**
 * G4 One staging list: what people stage from discussions joins the checkpoint's shared
 * draft or the document's next draft, next to row actions and accepted suggestions.
 *
 * Fixture: the roadmap-items-waiting run (seedRoadmapReview) whose shared draft holds one row
 * action (drop Budget caps) and one action staged from the open discussion "Push timing" (move
 * mobile-push to Next); and the Clinic outreach PRD (draft 5, two accepted suggestions staged)
 * with one section change staged from the open discussion "Invite wording". G3's Suggest and
 * Stage buttons are not built yet, so the discussion rows are seeded as G3 will leave them.
 */

const DISCUSSIONS = { push: "7a11c0de-0000-4000-8000-0000000004d1", invite: "7a11c0de-0000-4000-8000-0000000004d2" };

async function seedStaging(page: Page) {
  await seedRoadmapReview(page);
  await page.evaluate(
    ({ runId, ids }) => {
      const key = "po-mock-db-v2";
      const db = JSON.parse(localStorage.getItem(key)!);
      const now = new Date().toISOString();
      const run = db.runs.runs.find((r: { id: string }) => r.id === runId);
      const cp = run.checkpoints.find((c: { status: string }) => c.status === "pending");
      const doc = db.documents.find((d: { slug: string }) => d.slug === "clinic-outreach");
      const discussion = (id: string, title: string, documentId: string | null, run_id: string | null) => ({
        id,
        subject_kind: run_id ? "checkpoint_item" : "section",
        subject: {},
        subject_key: `seed:${id}`,
        subject_label: title,
        subject_url: "/",
        document_id: documentId,
        run_id,
        title,
        visibility: "open",
        author_only: false,
        status: "open",
        origin: "discuss",
        started_by: db.user_id,
        summary: null,
        summary_status: "none",
        summary_shared: true,
        last_message_at: null,
        lock_version: 1,
        created_at: now,
        updated_at: now,
      });
      db.discussions ??= { discussions: [], participants: [], messages: [] };
      db.discussions.discussions.push(discussion(ids.push, "Push timing", null, runId), discussion(ids.invite, "Invite wording", doc.id, null));
      const action = (id: string, item_key: string, kind: string, field: string | null, value: unknown, extra = {}) => ({
        id,
        item_key,
        kind,
        field,
        value,
        answers: [],
        note: null,
        state: "staged",
        created_by: db.user_id,
        updated_by: db.user_id,
        updated_at: now,
        ...extra,
      });
      db.runs.drafts ??= {};
      db.runs.drafts[cp.id] = {
        revision: 2,
        note: null,
        log: [],
        actions: [
          action("7a11c0de-0000-4000-8000-0000000004a1", "budget-caps", "drop", null, null),
          action("7a11c0de-0000-4000-8000-0000000004a2", "mobile-push", "edit", "horizon", "next", {
            origin: "discussion",
            discussion_id: ids.push,
            from_private: false,
            note: "It depends on an item in Later.",
          }),
        ],
      };
      db.llm.next_draft_changes = [
        {
          id: "7a11c0de-0000-4000-8000-0000000004c1",
          document_id: doc.id,
          section_key: "problem",
          raised_on_version: 5,
          instruction: "Say how many clinics this affects.",
          text: null,
          reason: "Readers asked how big the problem is.",
          status: "staged",
          applied_in_version: null,
          from_private: false,
          lock_version: 1,
          discussion_id: ids.invite,
          staged_by: db.user_id,
          suggested_by: null,
          created_at: now,
        },
      ];
      localStorage.setItem(key, JSON.stringify(db));
    },
    { runId: ROADMAP_REVIEW_RUN_ID, ids: DISCUSSIONS },
  );
}

/** Opens the seeded roadmap review run from the runs list, as a person would. */
async function openRun(page: Page) {
  await page.goto("/runs");
  await page.getByTestId("run-row").filter({ hasText: "usage-alerts-roadmap" }).getByRole("link").first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Roadmap from an approved PRD" })).toBeVisible();
}

const bar = (page: Page) => page.getByTestId("staging-bar").filter({ visible: true });
const chips = (page: Page) => bar(page).getByTestId("staged-chip");

// Card two-origins: protects = one row shows what rows and discussions staged at the checkpoint,
// the discussion's chip marked with a chat icon; fails_when = a chip is missing or doubled, or
// the discussion chip has no icon; no_claim = the list's API merge (tests/test_staging.py).
test("the pending checkpoint shows a row action and a discussion action as two chips", async ({ page }) => {
  await login(page);
  await seedStaging(page);
  await openRun(page);
  await expect(bar(page)).toContainText("Staged:");
  await expect(chips(page)).toHaveCount(2);
  await expect(chips(page).filter({ hasText: "Drop budget-caps" }).getByTestId("chip-discussion")).toHaveCount(0);
  const fromDiscussion = chips(page).filter({ hasText: "Move mobile-push to Next" });
  await expect(fromDiscussion.getByRole("img", { name: "From discussion Push timing" })).toBeVisible();
});

// Card remove-undo: protects = an approver removes a staged chip and can bring it back within
// 5 s; fails_when = "×" does nothing, or Undo does not restore the chip; no_claim = D8's delete
// itself (tests/test_checkpoint_review.py).
test("an approver's × removes a chip and Undo restores it", async ({ page }) => {
  await login(page);
  await seedStaging(page);
  await openRun(page);
  await expect(chips(page)).toHaveCount(2);
  await bar(page).getByRole("button", { name: "Remove Move mobile-push to Next" }).click();
  await expect(chips(page)).toHaveCount(1);
  await expect(bar(page).getByRole("status")).toContainText("Removed Move mobile-push to Next.");
  await bar(page).getByRole("button", { name: "Undo" }).click();
  await expect(chips(page)).toHaveCount(2);
  await expect(chips(page).filter({ hasText: "Move mobile-push to Next" })).toBeVisible();
});

// Card next-draft-row: protects = a discussion's section change sits next to the accepted
// suggestions in Build draft, ticked, with where it came from, and unticking it leaves it out
// of the build; fails_when = it is missing, unticked by default, has no origin line, or is built
// unticked; no_claim = how the model rewrites sections (the mock stands in).
test("Build draft lists a discussion row next to the accepted suggestions and builds without it when unticked", async ({ page }) => {
  await login(page);
  await seedStaging(page);
  await page.goto("/documents/clinic-outreach/v/5");
  const build = page.getByTestId("build-draft").filter({ visible: true });
  await expect(build).toContainText("Build draft 6");
  await expect(build.getByTestId("build-draft-count")).toHaveText("· 3 staged");
  await build.click();
  const sheet = page.getByTestId("next-draft-sheet");
  await expect(sheet.getByTestId("staged-item")).toHaveCount(2);
  const row = sheet.getByTestId("discussion-item");
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("discussion-origin")).toHaveText("From discussion Invite wording");
  const tick = row.getByRole("checkbox");
  await expect(tick).toBeChecked();
  await expect(sheet.getByTestId("pick-count")).toHaveText("3");
  await tick.uncheck();
  await expect(sheet.getByTestId("pick-count")).toHaveText("2");
  await sheet.getByRole("button", { name: "Build draft 6" }).click();
  const sections = sheet.getByTestId("next-draft-preview").getByTestId("next-draft-section");
  await expect(sections).toHaveCount(2);
  await expect(sections.filter({ hasText: "1. Problem" })).toHaveCount(0);
});

// Card commenter-reads: protects = commenters see what is staged but cannot remove it (approvers
// stage, c6); fails_when = a commenter sees "×" or no chips; no_claim = the server's 403s
// (tests/test_staging.py).
test("a commenter sees the chips without ×", async ({ page }) => {
  await login(page);
  await seedStaging(page);
  await signOut(page);
  await login(page, "commenter@example.com");
  await openRun(page);
  await expect(chips(page)).toHaveCount(2);
  await expect(bar(page).getByRole("button", { name: /^Remove / })).toHaveCount(0);
});
