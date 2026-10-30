import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/**
 * D12 + G4: a section change staged from a discussion goes with the agents when Build next
 * draft picks them, and is applied in the draft their run writes; a run that writes no
 * draft (cancelled) leaves it staged for the next one.
 *
 * Fixture ("next-draft" scenario): the fleet PRD on draft 2 with two accepted section-text
 * changes (F-33, F-34) and a whole-draft remark staged for the agents. Each test adds one
 * section change staged from the open discussion "Summary wording" on the Summary section.
 * G3's Stage button is not built yet, so the row is seeded as G3 will leave it (as
 * staging.spec.ts does).
 */
const DOC = "/documents/fleet-next/v/2";
const DISCUSSION = "7a11c0de-0000-4000-8000-0000000005d1";
const ROW = "7a11c0de-0000-4000-8000-0000000005c1";
const INSTRUCTION = "Say which fleet sizes the app is for.";

async function seedRow(page: Page) {
  await page.evaluate(
    ({ discussionId, rowId, instruction }) => {
      const key = "po-mock-db-v2";
      const db = JSON.parse(localStorage.getItem(key)!);
      const now = new Date().toISOString();
      const doc = db.documents.find((d: { slug: string }) => d.slug === "fleet-next");
      db.discussions ??= { discussions: [], participants: [], messages: [] };
      db.discussions.discussions = db.discussions.discussions.filter((d: { id: string }) => d.id !== discussionId);
      db.discussions.discussions.push({
        id: discussionId,
        subject_kind: "section",
        subject: {},
        subject_key: `seed:${discussionId}`,
        subject_label: "Summary wording",
        subject_url: "/",
        document_id: doc.id,
        run_id: null,
        title: "Summary wording",
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
      db.llm.next_draft_changes = [
        {
          id: rowId,
          document_id: doc.id,
          section_key: "summary",
          raised_on_version: 2,
          instruction,
          text: null,
          reason: "Readers asked who the app is for.",
          status: "staged",
          applied_in_version: null,
          from_private: false,
          lock_version: 1,
          discussion_id: discussionId,
          staged_by: db.user_id,
          suggested_by: null,
          created_at: now,
        },
      ];
      localStorage.setItem(key, JSON.stringify(db));
    },
    { discussionId: DISCUSSION, rowId: ROW, instruction: INSTRUCTION },
  );
}

const buildButton = (page: Page) => page.getByTestId("build-draft").filter({ visible: true });
const sheet = (page: Page) => page.getByTestId("next-draft-sheet");
const count = (page: Page) => buildButton(page).getByTestId("build-draft-count");

/**
 * Opens draft 2 with the row seeded and shown. A mock request the app had in flight when the
 * seed was written can save its older copy over it: seed again (at most 3 times).
 */
async function openSeeded(page: Page) {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "next-draft"));
  await login(page);
  await page.goto(DOC);
  for (let i = 0; ; i++) {
    await expect(count(page)).toBeVisible();
    await seedRow(page);
    await page.reload();
    try {
      await expect(count(page)).toHaveText("· 4 staged");
      return;
    } catch (e) {
      if (i >= 2) throw e;
    }
  }
}

/** Build draft 3 with the agents, leaving F-34's text change unticked; lands on the run page. */
async function buildWithAgents(page: Page) {
  await buildButton(page).click();
  const s = sheet(page);
  const row = s.getByTestId("discussion-item");
  await expect(row).toContainText(INSTRUCTION);
  await expect(row.getByRole("checkbox")).toBeChecked();
  await s.getByTestId("staged-list").getByRole("checkbox", { name: /^Include F-34/ }).uncheck();
  await expect(s.getByTestId("engine-line")).toHaveText("Agents write draft 3 because 1 remark is about the whole draft.");
  await s.getByRole("button", { name: "Build draft 3" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await expect(page.getByTestId("run-status").filter({ visible: true })).toHaveText("Running");
}

// Card applied-on-import: protects = a discussion's staged section change goes to the agents
// with the other ticked items, and once their draft is in, it has left the next draft's list
// (applied in draft 3) while the unticked text change stays; fails_when = the row is still
// staged after the run's draft (the next build would make it again) or the unticked change is
// gone; no_claim = what the agents wrote (the mock's runtime stands in), the API's bookkeeping
// (api/tests/test_next_draft_engine.py).
test("a staged section change goes with the agents and leaves the list once their draft is in", async ({ page }) => {
  await openSeeded(page);
  await buildWithAgents(page);

  await page.getByRole("button", { name: "Refresh progress" }).click();
  // The draft is in: the run waits at its PRD review.
  await expect(page.getByTestId("run-status").filter({ visible: true })).not.toHaveText("Running");

  await page.goto("/documents/fleet-next/v/3");
  await expect(buildButton(page)).toContainText("Build draft 4");
  await expect(count(page)).toHaveText("· 1 staged");
  await buildButton(page).click();
  await expect(sheet(page).getByTestId("staged-item")).toHaveCount(1);
  await expect(sheet(page).getByTestId("staged-list")).toContainText("F-34");
  await expect(sheet(page).getByTestId("discussion-item")).toHaveCount(0);
});

// Card kept-on-cancel: protects = a run that writes no draft gives its section change back
// to the next draft; fails_when = cancelling the run drops the row or marks it applied;
// no_claim = a failed run (the API test covers it).
test("cancelling the agents' run leaves the section change staged for the next draft", async ({ page }) => {
  await openSeeded(page);
  await buildWithAgents(page);

  await page.getByTestId("run-cancel").filter({ visible: true }).click();
  await page.getByRole("alertdialog", { name: "Cancel run" }).getByRole("button", { name: "Cancel run" }).click();
  await expect(page.getByTestId("run-status").filter({ visible: true })).toHaveText("Cancelled");

  await page.goto(DOC);
  await expect(count(page)).toHaveText("· 4 staged");
  await buildButton(page).click();
  const row = sheet(page).getByTestId("discussion-item");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(INSTRUCTION);
});
