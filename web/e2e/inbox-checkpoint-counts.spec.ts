import { expect, test, type Page } from "@playwright/test";

import { ROADMAP_REVIEW_RUN } from "../lib/api/mock/runs";
import { login, seedRoadmapReview } from "./helpers";

/**
 * D9 Inbox checkpoint counts: the Roadmap items checkpoint row says how many items need me and
 * how many block, with the wait's time left, and up to three items under it, each with its safe
 * one-click fix (staged, undone in one click) and Open, then "+k more · h handled". Home shows
 * the parent row only. The seeded review: ten items need a person, three of them blocking
 * (Slack alerts' date, Budget caps' dependency, Usage export's section).
 */

const RUN = ROADMAP_REVIEW_RUN.run.id;
const CP = ROADMAP_REVIEW_RUN.run.checkpoints[0].id;

/** The seeded checkpoint's row and the rows under it. */
const parent = (page: Page) => page.locator(`tr[data-key="${CP}"]`).filter({ visible: true });
const child = (page: Page, item: string) => page.locator(`tr[data-key="${CP}-${item}"]`).filter({ visible: true });

/** Test setup only: edits the seeded mock data before the page loads it. */
async function seed(page: Page, edit: (db: { runs: { runs: { id: string; checkpoints: Record<string, unknown>[] }[]; drafts?: Record<string, unknown> } }, ids: { run: string; cp: string }) => void) {
  await page.evaluate(
    ({ source, ids }) => {
      const key = "po-mock-db-v2";
      const db = JSON.parse(localStorage.getItem(key)!);
      new Function("db", "ids", `(${source})(db, ids)`)(db, ids);
      localStorage.setItem(key, JSON.stringify(db));
    },
    { source: edit.toString(), ids: { run: RUN, cp: CP } },
  );
}

async function openInbox(page: Page) {
  await login(page);
  await seedRoadmapReview(page);
}

// Card counts: protects = the row says what needs a decision and how much, with the time left,
// and Review items opens the decision; fails_when = no counts, no blocking chip, no time left or
// the wrong target; no_claim = the review screen itself (D1).
test("the checkpoint row counts what needs me, with the time left and Review items", async ({ page }) => {
  await openInbox(page);
  await page.goto("/inbox");
  const row = parent(page);
  await expect(row.getByTestId("checkpoint-label")).toHaveText("Roadmap items · 10 need you");
  await expect(row.getByTestId("checkpoint-blocking")).toHaveText("3 blocking");
  await expect(row.getByTestId("need-left")).toHaveText("19 h left");
  await expect(row).toContainText("from Usage alerts PRD v1");
  // Three items under it, blocking first, in position order.
  await expect(page.locator(`tr[data-child-of="${CP}"]`).filter({ visible: true }).getByTestId("child-title")).toHaveText([
    "Slack alerts",
    "Budget caps",
    "Usage export",
  ]);
  await row.getByRole("link", { name: "Review items" }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${RUN}#decide$`));
  await expect(page.getByRole("heading", { level: 1, name: "Roadmap from an approved PRD" })).toBeVisible();
});

// Card safe-fix: protects = a one-click fix stages (decides nothing), reads done with Undo, the
// counts update in place, Undo restores both and the badge never counts child rows;
// fails_when = the checkpoint leaves the Inbox, the counts stay, Undo leaves the action or the
// badge moves; no_claim = applying the fix (D7).
test("Move to Later stages the fix, the counts update, Undo restores both", async ({ page }) => {
  await openInbox(page);
  await page.goto("/inbox");
  const badge = page.getByTestId("nav-inbox-badge");
  await expect(parent(page).getByTestId("checkpoint-label")).toHaveText("Roadmap items · 10 need you");
  const before = await badge.textContent();
  const caps = child(page, "budget-caps");
  await expect(caps).toContainText("Depends on a later item");
  await caps.getByRole("button", { name: "Move to Later for Budget caps" }).click();
  await expect(caps.getByTestId("child-done")).toHaveText("✓ Moved to Later");
  await expect(caps.getByRole("button", { name: /^Undo/ })).toBeVisible();
  await expect(parent(page).getByTestId("checkpoint-label")).toHaveText("Roadmap items · 9 need you");
  await expect(parent(page).getByTestId("checkpoint-blocking")).toHaveText("2 blocking");
  // Staged, not decided: the checkpoint still waits, and the badge counts it once.
  await expect(parent(page).getByRole("link", { name: "Review items" })).toBeVisible();
  await expect(badge).toHaveText(before!);

  await caps.getByRole("button", { name: /^Undo/ }).click();
  await expect(caps.getByRole("button", { name: "Move to Later for Budget caps" })).toBeVisible();
  await expect(parent(page).getByTestId("checkpoint-label")).toHaveText("Roadmap items · 10 need you");
  await expect(parent(page).getByTestId("checkpoint-blocking")).toHaveText("3 blocking");
  await expect(badge).toHaveText(before!);
});

// Card open-only: protects = a reason that needs typing offers only Open, and Open lands on the
// item; "+k more" links to the review; fails_when = Link section is offered in the Inbox, or a
// link goes elsewhere; no_claim = selecting the item on the review screen (D1).
test("a child with no safe fix shows only Open; +7 more links to the review", async ({ page }) => {
  await openInbox(page);
  await page.goto("/inbox");
  const usage = child(page, "usage-export");
  await expect(usage).toContainText("No PRD section");
  await expect(usage.getByRole("button")).toHaveCount(0);
  const more = child(page, "more").getByTestId("child-more");
  await expect(more).toHaveText("+7 more · 0 handled");
  await expect(more).toHaveAttribute("href", `/runs/${RUN}#decide`);
  await usage.getByRole("link", { name: "Open Usage export" }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${RUN}\\?item=usage-export#decide$`));
  await expect(page.getByRole("heading", { level: 1, name: "Roadmap from an approved PRD" })).toBeVisible();
});

// Card suggestion: protects = a commenter's suggestion on a shown item reads "Suggested: …" with
// Stage for the approver, and Stage stages it; fails_when = it is not shown, or Stage does not
// stage; no_claim = who may suggest (the API's role checks).
test("a commenter's suggestion shows as Suggested with Stage", async ({ page }) => {
  await openInbox(page);
  await seed(page, (db, ids) => {
    db.runs.drafts = {
      ...(db.runs.drafts ?? {}),
      [ids.cp]: {
        revision: 1,
        note: null,
        log: [{ revision: 1, by: "cora" }],
        actions: [
          {
            id: "7a11c0de-0000-4000-8000-00000000d9a1",
            item_key: "slack-alerts",
            kind: "edit",
            field: "milestone_date",
            value: null,
            answers: ["unverified_date"],
            note: null,
            state: "suggested",
            created_by: "someone-else",
            updated_by: "someone-else",
            updated_at: "2026-10-20T10:00:00Z",
          },
        ],
      },
    };
  });
  await page.goto("/inbox");
  const slack = child(page, "slack-alerts");
  await expect(slack.getByTestId("child-suggested")).toHaveText("Suggested: Remove date");
  await slack.getByRole("button", { name: "Stage Remove date on Slack alerts" }).click();
  await expect(slack.getByTestId("child-done")).toHaveText("✓ Date removed");
  await expect(parent(page).getByTestId("checkpoint-blocking")).toHaveText("2 blocking");
});

// Card home-and-held: protects = Home shows the parent row with its counts and no child rows; a
// console approval held while blocking reasons are open says so on the row; fails_when = Home
// draws child rows or no counts, or the suffix is missing; no_claim = D3's Confirm action.
test("Home shows the counts only; a held console approval says so", async ({ page }) => {
  await openInbox(page);
  await seed(page, (db, ids) => {
    const run = db.runs.runs.find((r) => r.id === ids.run)!;
    run.checkpoints[0].console = { needs: "confirm", answered_by: "Sam Lee", verdict: "MERGE", counted: false, findings: [], revise: false, can_redo: false };
  });
  await page.goto("/home");
  const row = parent(page);
  await expect(row.getByTestId("checkpoint-label")).toHaveText("Roadmap items · 10 need you · console approval held");
  await expect(row.getByTestId("checkpoint-blocking")).toHaveText("3 blocking");
  await expect(page.locator(`tr[data-child-of="${CP}"]`)).toHaveCount(0);
  await page.goto("/inbox");
  await expect(parent(page).getByTestId("checkpoint-label")).toHaveText("Roadmap items · 10 need you · console approval held");
});

// Card phone: protects = at 390 px the counts show, the child rows are cards under the parent
// with the fix full width, and nothing scrolls sideways; fails_when = horizontal scroll or a
// narrow fix button; no_claim = other widths.
test("on a phone the child rows are cards with the fix full width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openInbox(page);
  await page.goto("/inbox");
  await expect(parent(page).getByTestId("checkpoint-label")).toHaveText("Roadmap items · 10 need you");
  const fix = child(page, "budget-caps").getByRole("button", { name: "Move to Later for Budget caps" });
  await expect(fix).toBeVisible();
  const row = await child(page, "budget-caps").boundingBox();
  const button = await fix.boundingBox();
  expect(button!.width).toBeGreaterThan(row!.width * 0.8);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
