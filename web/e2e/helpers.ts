import { expect, type Locator, type Page } from "@playwright/test";

import { MOCK_LOGIN } from "../lib/api/mock/fixtures";
import { CONSOLE_HELD_RUN, ROADMAP_FILE_PROBLEM_RUN, ROADMAP_REVIEW_RUN, ROADMAP_REVIEW_RUN_ATTEMPT2 } from "../lib/api/mock/runs";

export const ADMIN = MOCK_LOGIN;

/** Signs in as the mock owner, or as the mock member with `email` (one per role). */
export async function login(page: Page, email: string = ADMIN.email) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/home$/);
}

/** A section of the visible version (Next keeps recently visited routes mounted but hidden). */
export function section(page: Page, key: string): Locator {
  return page.locator(`section[data-section-key="${key}"]`).filter({ visible: true });
}

/** Selects `text` inside a section body, the way a reader would by dragging. */
export async function selectText(page: Page, key: string, text: string) {
  await page.evaluate(
    ({ key, text }) => {
      const body = [...document.querySelectorAll<HTMLElement>(`[data-section-body="${key}"]`)].find(
        (el) => el.checkVisibility(),
      )!;
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        const at = node.data.indexOf(text);
        if (at >= 0) {
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + text.length);
          const sel = window.getSelection()!;
          sel.removeAllRanges();
          sel.addRange(range);
          return;
        }
      }
      throw new Error(`"${text}" not found in section ${key}`);
    },
    { key, text },
  );
}

/** Signs out from the user menu. */
export async function signOut(page: Page) {
  await page.getByTestId("user-menu").click();
  await page.getByRole("dialog", { name: "Account" }).getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
}

/** The version view's outline rail (>= 1280 px; one section is open at a time). */
export function sectionStrip(page: Page): Locator {
  return page.getByTestId("outline-rail").filter({ visible: true });
}

/** A section's row in the visible outline (rail, switcher popover or Sections sheet). */
export function outlineRow(page: Page, key: string): Locator {
  return page.locator(`a[data-outline-key="${key}"]`).filter({ visible: true });
}

/**
 * Opens a section of the current Brief / Full mode from the outline, and waits for its
 * panel. A row inside a folded chapter (or no rail, below 1280 px) is opened by its #key.
 */
export async function openSection(page: Page, key: string): Promise<Locator> {
  const row = outlineRow(page, key);
  if (await row.count()) await row.first().click();
  else await page.evaluate((k) => (window.location.hash = k), key);
  const s = section(page, key);
  await expect(s).toBeVisible();
  return s;
}

/** Opens a review panel tab (Feedback, Sources, History) in the visible panel. */
export async function openTab(page: Page, name: "Feedback" | "Sources" | "History") {
  await page.getByRole("tab", { name: new RegExp(`^${name}`) }).filter({ visible: true }).click();
}

/** Picks a Feedback state chip (Open, Staged, Declined, Done). */
export async function feedbackState(page: Page, state: "Open" | "Staged" | "Declined" | "Done") {
  await page.getByTestId("feedback-state").filter({ visible: true }).getByRole("button", { name: new RegExp(`^${state}`) }).click();
}

/** The review panel's feedback for every section, not only the open one. */
export async function showAll(page: Page) {
  await page.getByTestId("inspector-scope").filter({ visible: true }).getByRole("button", { name: /^All sections/ }).click();
}

/** Picks an item from the open section's ⋯ menu. */
export async function sectionAction(scope: Locator, heading: string, item: string | RegExp) {
  await scope.getByRole("button", { name: `Actions for ${heading}` }).click();
  await scope.getByRole("menuitem", { name: item }).click();
}

/**
 * Seeds the mock with what the adapter puts in the Inbox: a run whose lost submission is past
 * the lookup cap (Retry, Cancel run) and still looked for, a run whose output Oracle stopped
 * importing (Retry), and an ended run whose spend went over its ceiling while a workflow an
 * approver stopped cancelling still runs (Cancel again). Returns the overrun run's id.
 */
export async function seedStuckRuns(page: Page): Promise<string> {
  return page.evaluate(() => {
    const key = "po-mock-db-v2";
    const db = JSON.parse(localStorage.getItem(key)!);
    type R = Record<string, unknown> & { id: string; document_slug: string; segments: Record<string, unknown>[] };
    const runs: R[] = db.runs.runs;
    const base = runs.find((r) => r.document_slug === "team-onboarding")!;
    const clone = (id: string, at: string): R => ({
      ...JSON.parse(JSON.stringify(base)),
      id,
      status: "running",
      checkpoints: [],
      waiting_on: null,
      created_at: at,
      started_at: at,
    });
    const lost = clone("7a11c0de-0000-4000-8000-000000000001", "2026-10-17T06:00:00Z");
    Object.assign(lost, {
      stuck: "Submission seg-1-a2 was lost and is still not found. Retry looks again; Cancel ends the run.",
      can_retry: true,
      searching: "Oracle still looks for submission seg-1-a1, given up on: if it landed, it is cancelled and its cost counted.",
    });
    const failed = clone("7a11c0de-0000-4000-8000-000000000002", "2026-10-17T07:00:00Z");
    failed.segments[0] = { ...failed.segments[0], status: "failed", error: "Couldn't import its output: DataError on 5 tries in a row." };
    Object.assign(failed, {
      import_failed:
        "Couldn't import team-onboarding's output: DataError on 5 tries in a row, and Oracle stopped trying. Retry tries again.",
      can_retry_import: true,
    });
    const done = runs.find((r) => r.document_slug === "checkout-redesign" && r.status === "succeeded")!;
    done.segments[0] = { ...done.segments[0], cost_usd: 16.4 };
    Object.assign(done, {
      spent_usd: 16.4,
      stuck:
        "After the run ended its spend reached $16.40, over its $13.50 ceiling: workflow mock-wf-done still runs in SwarmCloud, and Oracle counts its spend on the run until it ends. An approver stopped cancelling mock-wf-done: Cancel again turns Oracle's cancel calls back on (nothing restarts), or cancel it in SwarmCloud's console.",
      cancel_again: ["mock-wf-done"],
      can_dismiss_overrun: false,
    });
    runs.push(lost, failed);
    localStorage.setItem(key, JSON.stringify(db));
    return done.id;
  });
}

/** The run seedSentBack adds, and the summary of the draft Oracle refused and sent back. */
export const SENT_BACK_RUN = "7a11c0de-0000-4000-8000-0000000000e1";
export const SENT_BACK_SUMMARY =
  "Oracle refused prd.md: 2 citations use source 'jira', which isn't accepted; 3 references fail because of them.";

/**
 * Seeds the mock with a run whose PRD draft Oracle refused at import and sent back to the
 * writer itself: no checkpoint stands for that review, the revision runs as attempt 2 with
 * Oracle's findings, and the refused import stays on the segment until the revision lands.
 */
export async function seedSentBack(page: Page): Promise<string> {
  return page.evaluate(
    ({ id, summary }) => {
      const key = "po-mock-db-v2";
      const db = JSON.parse(localStorage.getItem(key)!);
      type S = Record<string, unknown> & { seq: number; checkpoint: string };
      const base = db.runs.runs.find((r: { document_slug: string }) => r.document_slug === "team-onboarding");
      const at = "2026-10-17T09:00:00Z";
      const wf = "mock-wf-sent-back";
      // As the API stores the refusal: two citations of source 'jira', cited three times.
      const problems: Record<string, unknown>[] = [
        { code: "invalid_citation", message: "citation #1 (j1) is invalid: source 'jira' isn't accepted", section_key: null, cite_key: "j1", line: null },
        { code: "invalid_citation", message: "citation #2 (j2) is invalid: source 'jira' isn't accepted", section_key: null, cite_key: "j2", line: null },
        { code: "unknown_citation", message: "[c:j1] in section 'problem' is not defined in front matter 'citations'", section_key: "problem", cite_key: "j1", line: 14 },
        { code: "unknown_citation", message: "[c:j2] in section 'problem' is not defined in front matter 'citations'", section_key: "problem", cite_key: "j2", line: 14 },
        { code: "unknown_citation", message: "[c:j1] in section 'goals' is not defined in front matter 'citations'", section_key: "goals", cite_key: "j1", line: 20 },
      ];
      const error = `prd.md was rejected: ${problems.map((p) => `[${p.code}] ${p.message}`).join("; ")}`;
      const run = { ...JSON.parse(JSON.stringify(base)), id, document_slug: "guest-checkout", document_id: null, created_at: at, started_at: at };
      const segments: S[] = run.segments;
      for (const s of segments) {
        Object.assign(s, {
          id: crypto.randomUUID(),
          status: "succeeded",
          cost_usd: 1,
          attempts: [{ attempt: 1, workflow_id: wf, submitted_at: at, cost_usd: 1, note: null, note_by: null, state: "succeeded" }],
        });
      }
      const findings = [
        "Oracle could not import prd.md as the document's next version, so it sent the draft back before a person reviews it.",
        "Citations: citation #1 (j1) is invalid: source 'jira' isn't accepted; citation #2 (j2) is invalid: source 'jira' isn't accepted.",
      ].join("\n");
      Object.assign(segments[3], {
        status: "running",
        artifacts: ["prd.md"],
        draft_import: { document_id: null, slug: null, kind: null, version: null, created: null, warnings: [], error, problems, summary, source: null, prd_links: null },
      });
      (segments[3].attempts as unknown[]).push({ attempt: 2, workflow_id: wf, submitted_at: at, cost_usd: 0, note: findings, note_by: "Oracle", state: "running" });
      // Oracle answered the PRD review itself: no checkpoint stands for it.
      run.checkpoints = segments.slice(0, 3).map((s) => ({
        id: crypto.randomUUID(),
        run_id: id,
        kind: s.checkpoint,
        status: "approved",
        approver_role: "approver",
        segment_seq: s.seq,
        decided_by: null,
        decided_at: at,
        note: null,
        payload: {},
        created_at: at,
        can_decide: false,
        cannot_approve: null,
      }));
      Object.assign(run, { status: "running", waiting_on: null });
      db.runs.runs.push(run);
      db.runs.artifacts[`${id}|4|prd.md`] = "---\ntitle: Guest checkout PRD\n---\n\n# Guest checkout PRD {#title}\n";
      localStorage.setItem(key, JSON.stringify(db));
      return id;
    },
    { id: SENT_BACK_RUN, summary: SENT_BACK_SUMMARY },
  );
}

/**
 * Seeds the mock with the roadmap-items-waiting run (ROADMAP_REVIEW_RUN): a "Roadmap from an
 * approved PRD" run on usage-alerts-roadmap waiting at its Roadmap items checkpoint, its
 * nine-item file checked with 3 blocking reasons and a reason of every to-confirm code (one
 * of them a dropped item). Returns the run's id.
 */
export async function seedRoadmapReview(page: Page): Promise<string> {
  return seedRun(page, ROADMAP_REVIEW_RUN);
}

/**
 * Seeds the mock and opens `url`. The seed takes its turn with the app's own calls (sign-in's
 * writes included), so it is never written over and is seeded once.
 */
export async function openSeeded(page: Page, seed: (page: Page) => Promise<string>, url: string) {
  await seed(page);
  await page.goto(url);
}

type RunSeed = { run: { id: string }; artifacts: Record<string, string> };

/**
 * Adds a seeded run (and its files) to the mock's data in the mock's own turn
 * (`__poMockWrite`, lib/api/mock/server.ts): a call of the app's in flight cannot save over it.
 */
async function seedRun(page: Page, seed: RunSeed): Promise<string> {
  return page.evaluate((seed) => {
    type Db = { runs: { runs: { id: string }[]; artifacts: Record<string, string> } };
    const write = (globalThis as { __poMockWrite?: (change: (db: Db) => string) => Promise<string> }).__poMockWrite;
    if (!write) throw new Error("The mock API is not loaded: sign in before seeding");
    return write((db) => {
      db.runs.runs = db.runs.runs.filter((r) => r.id !== seed.run.id);
      db.runs.runs.push(seed.run);
      Object.assign(db.runs.artifacts, seed.artifacts);
      return seed.run.id;
    });
  }, seed);
}

/** Seeds the mock with the roadmap review run whose file cannot be read as items (ROADMAP_FILE_PROBLEM_RUN, D1). */
export async function seedRoadmapFileProblem(page: Page): Promise<string> {
  return seedRun(page, ROADMAP_FILE_PROBLEM_RUN);
}

/**
 * Seeds the mock with the roadmap review run's attempt 2 (ROADMAP_REVIEW_RUN_ATTEMPT2, D6):
 * sent back with a five-entry review, attempt 2 answered it with one decline, one change it
 * claimed and did not make, and one change nobody asked for.
 */
export async function seedRoadmapAttempt2(page: Page): Promise<string> {
  return seedRun(page, ROADMAP_REVIEW_RUN_ATTEMPT2);
}

/**
 * Seeds the mock with the roadmap-items-console-held run (CONSOLE_HELD_RUN, D3): approved in
 * SwarmCloud's console while one waivable blocking reason is open, so the approval is held.
 */
export async function seedConsoleHeld(page: Page): Promise<string> {
  return seedRun(page, CONSOLE_HELD_RUN);
}

/** The finished run seedDecidedRun adds. */
export const DECIDED_RUN = "7a11c0de-0000-4000-8000-0000000000d1";

/**
 * Seeds the mock with a finished Baseline to PRD run for checkout-redesign whose stops were
 * decided in the Inbox: the baseline approved with a note, the feature set sent back once and
 * approved on its second attempt, the priority order and the PRD review approved. The decision
 * log records each decided stop (H1 checkpoint records). Returns the run's id.
 */
export async function seedDecidedRun(page: Page): Promise<string> {
  return page.evaluate((id) => {
    // In the mock's own turn (seedRun): a call of the app's in flight cannot save over the run (#520).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const write = (globalThis as { __poMockWrite?: (change: (db: any) => string) => Promise<string> }).__poMockWrite;
    if (!write) throw new Error("The mock API is not loaded: sign in before seeding");
    return write((db) => {
      type S = Record<string, unknown> & { seq: number; checkpoint: string };
      const base = db.runs.runs.find((r: { document_slug: string }) => r.document_slug === "team-onboarding");
      const at = (minute: number) => `2026-10-15T09:${String(minute).padStart(2, "0")}:00Z`;
      const run = { ...JSON.parse(JSON.stringify(base)), id, document_slug: "checkout-redesign", created_at: at(0), started_at: at(0), finished_at: at(50) };
      const segments: S[] = run.segments;
      for (const s of segments) {
        Object.assign(s, {
          id: crypto.randomUUID(),
          status: "succeeded",
          cost_usd: 1,
          attempts: [{ attempt: 1, workflow_id: "mock-wf-decided", submitted_at: at(s.seq * 10), cost_usd: 1, note: null, note_by: null, state: "succeeded" }],
        });
      }
      const stop = (s: S, status: string, note: string | null, minute: number) => ({
        id: crypto.randomUUID(),
        run_id: id,
        kind: s.checkpoint,
        status,
        approver_role: "approver",
        segment_seq: s.seq,
        decided_by: db.user_id,
        decided_at: at(minute),
        note,
        payload: {},
        created_at: at(minute - 1),
        can_decide: false,
        cannot_approve: null,
      });
      run.checkpoints = [
        stop(segments[0], "approved", "Goals read right", 5),
        stop(segments[1], "changes_requested", "Size the export feature again", 15),
        stop(segments[1], "approved", null, 25),
        stop(segments[2], "approved", null, 35),
        stop(segments[3], "approved", null, 45),
      ];
      Object.assign(run, { status: "succeeded", waiting_on: null });
      db.runs.runs.push(run);
      return id;
    });
  }, DECIDED_RUN);
}
