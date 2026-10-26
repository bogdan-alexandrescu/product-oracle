/**
 * Mock of Oracle's built-in model jobs: the Jobs panel, suggestions on feedback items,
 * version reports and section refinement. A queued job "runs" the next time anyone
 * reads it (the mock's stand-in for `oracle tick` and the background worker), and its
 * answers come from simple rules instead of a model, so every screen can be driven.
 */
import type { Schemas } from "@/lib/api/client";
import { wordDiff } from "@/lib/diff";
import { turnedOff } from "@/lib/format";
import { plainText } from "@/lib/markdown";

import { jobOut } from "./refusal";
import {
  KIND as BATCH,
  nextDraftRoute,
  runBatch,
  shownJob,
  shownNote,
  shownSuggestion,
  stageRoute,
  stateOf,
  type AgentsRun,
  type NextDraftChangeRow,
  type StartRun,
} from "./next-draft";

type Job = Schemas["LlmJobOut"];
type Suggestion = Schemas["SuggestionOut"];
/** A stored feedback item; its C1e state is derived on the way out (withSuggestion). */
type Feedback = Omit<Schemas["FeedbackItemOut"], "state" | "staged_for_version" | "staged_for_agents"> & {
  /** D12: staged for the agents (when, by whom); open items only count. */
  staged_for_agents_at?: string | null;
  staged_for_agents_by?: string | null;
  /** #636 re-review: a kept late-answer item withholding its quote (feedback_items.withheld_at). */
  withheld_at?: string | null;
};
type Role = Schemas["Me"]["role"];
type Section = { section_key: string; level: number; heading: string; body_md: string; body_text: string };
type Version = { id: string; document_id: string; number: number; created_at: string; sections: Section[] };
type Doc = { id: string; slug: string; title: string };

export interface LlmDb {
  jobs: Job[];
  suggestions: Suggestion[];
  /** G4: discussions' section changes staged for the next draft (a mock db saved before G4 has none). */
  next_draft_changes?: NextDraftChangeRow[];
  /** Job kinds an owner turned off, per document id. */
  disabled: Record<string, Job["kind"][]>;
  /** #561 review: job kinds the Claude pool refuses (every account spent; the "stored-refusals" scenario). */
  refuse?: Job["kind"][];
  /** Whether each accepted suggestion's Accept closed its item (the API's accept audit,
   * ``closed_item``): Undo re-opens only an item Accept closed. Absent: it did. */
  accept_closed?: Record<string, boolean>;
}

export type LlmContext = {
  db: LlmDb;
  userId: string;
  role: Role;
  documents: Doc[];
  versions: Version[];
  feedback: Feedback[];
  uuid: () => string;
  now: () => string;
  lockedKeys: (v: Version) => string[];
  /** Whether a feedback-loop run still going was sent this suggestion (Build next draft, D12). */
  sentToAgents?: (suggestionId: string) => boolean;
  reply: (feedbackId: string, body: string) => void;
  /** Imports a revised section as the next version and applies the resolutions. */
  importRevision: (
    doc: Doc,
    base: Version,
    key: string,
    heading: string,
    body: string,
    resolutions: { feedback_id: string; status: "addressed" | "declined"; note: string | null }[],
  ) => Version;
  /** C1e: imports the next version with several sections replaced, and applies the resolutions. */
  importSections: (
    doc: Doc,
    base: Version,
    replace: Record<string, { heading: string; body: string }>,
    resolutions: { feedback_id: string; status: "addressed" | "declined"; note: string | null }[],
  ) => Version;
  /** G4: a discussion as the caller sees it (a private one they are not in names nothing). */
  discussion?: (id: string) => Schemas["StagingDiscussion"] | null;
  /** A member's name (their email) for "accepted by". */
  memberName?: (id: string) => string | null;
  /** D12: the mock's override of the agents' run estimate (the "costly" setting). */
  runEstimateUsd?: () => number | null;
  /** D12: starts the agents' feedback-loop run for Build next draft. */
  startRun?: StartRun;
  /** #574 review: the agents' feedback-loop run under way on the document, with the ids it was sent. */
  agentsRun?: (docId: string) => AgentsRun | null;
  /** H11 `next_drafts`: Oracle's level for next drafts and its staged-changes limit (default Draft, 5). */
  nextDrafts?: () => { level: "observe" | "draft" | "recommend" | "act"; min_staged: number };
  /** CR-08: stores a quality_review job's answer as a model-output report (./quality.ts); returns its output. */
  runQualityReview?: (job: Job, versionId: string) => Record<string, unknown>;
  /** O5: runs a queued public_text job (./shares.ts draftPublicTexts) and returns its output. */
  publicText?: (job: Job) => Record<string, unknown>;
};

/** The per-document switches; the next-draft batch is refinement and shares its switch. */
const KINDS: (keyof Schemas["JobSettings"])[] = ["review_comments", "reporting", "refinement", "quality_review", "public_text"];
const SWITCH: Partial<Record<Job["kind"], keyof Schemas["JobSettings"]>> = { refinement_batch: "refinement" };
const switchOf = (kind: Job["kind"]) => (SWITCH[kind] ?? kind) as keyof Schemas["JobSettings"];
const RANK: Role[] = ["viewer", "commenter", "approver", "owner"];
const atLeast = (role: Role, min: Role) => RANK.indexOf(role) >= RANK.indexOf(min);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const fail = (status: number, detail: string) => json(status, { detail });

function makeJob(ctx: LlmContext, doc: Doc, kind: Job["kind"], v: Version | null, extra: Partial<Job> = {}): Job {
  return {
    id: ctx.uuid(),
    kind,
    document_id: doc.id,
    version_number: v?.number ?? null,
    section_key: null,
    status: "queued",
    input: v ? { version: v.number } : {},
    output: null,
    account_label: null,
    via: null,
    model: null,
    input_tokens: null,
    output_tokens: null,
    cost_usd: null,
    attempts: 0,
    error: null,
    error_reason: null,
    next_reset_at: null,
    requested_by: ctx.userId,
    created_at: ctx.now(),
    started_at: null,
    finished_at: null,
    ...extra,
  };
}

function suggestion(ctx: LlmContext, f: Feedback, job: Job, extra: Partial<Suggestion>): Suggestion {
  return {
    id: ctx.uuid(),
    document_id: f.document_id,
    feedback_item_id: f.id,
    job_id: job.id,
    version_number: job.version_number ?? f.raised_on_version,
    classification: "other",
    group_key: null,
    duplicate_of: null,
    kind: "none",
    section_key: f.section_key ?? null,
    text: null,
    edited_text: null,
    rationale: null,
    pushback: null,
    status: "open",
    override_reason: null,
    decided_by: null,
    decided_at: null,
    applied_in_version: null,
    created_at: ctx.now(),
    updated_at: ctx.now(),
    ...extra,
  };
}

const live = (db: LlmDb, feedbackId: string) =>
  db.suggestions.filter((s) => s.feedback_item_id === feedbackId && s.status !== "superseded").at(-1) ?? null;

/** The feedback item with Oracle's suggestion and its C1e state, as GET /feedback returns it. */
export function withSuggestion(db: LlmDb | undefined, f: Feedback, latest: number | null = null): Schemas["FeedbackItemOut"] {
  const suggestion = db ? live(db, f.id) : null;
  return { ...f, resolution_note: shownNote(f, db), suggestion: shownSuggestion(f, suggestion), ...stateOf(f, suggestion, latest) };
}

function versionsOf(ctx: LlmContext, doc: Doc) {
  return ctx.versions.filter((v) => v.document_id === doc.id).sort((a, b) => a.number - b.number);
}

// ------------------------------------------------------------------ the "worker"

function finish(ctx: LlmContext, job: Job, output: Record<string, unknown>) {
  Object.assign(job, {
    status: "succeeded",
    output,
    account_label: "personal",
    via: "account",
    model: "claude-opus-5",
    input_tokens: 3200 + Math.round(Math.random() * 400),
    output_tokens: 600,
    cost_usd: 0.0312,
    attempts: job.attempts + 1,
    error: null,
    error_reason: null,
    next_reset_at: null,
    started_at: job.started_at ?? ctx.now(),
    finished_at: ctx.now(),
  });
}

function runReview(ctx: LlmContext, job: Job, doc: Doc, v: Version) {
  const locked = new Set(ctx.lockedKeys(v));
  const items = ctx.feedback.filter(
    (f) => f.document_id === doc.id && f.status === "open" && f.raised_on_version <= v.number && !live(ctx.db, f.id),
  );
  const firstBySection = new Map<string, Feedback>();
  for (const f of items) {
    const section = v.sections.find((s) => s.section_key === f.section_key);
    const question = f.summary.trim().endsWith("?");
    const twin = f.section_key ? firstBySection.get(f.section_key) : undefined;
    // D13: a remark on the whole draft gets an answer, not one section's new text.
    if (!f.section_key) {
      ctx.db.suggestions.push(
        suggestion(ctx, f, job, {
          classification: question ? "question" : "change_request",
          kind: "answer",
          text: "This is about the whole draft: the next version will work it into the sections it touches.",
          rationale: "Feedback on the whole draft, not one section.",
        }),
      );
      continue;
    }
    if (twin && !question) {
      ctx.db.suggestions.push(
        suggestion(ctx, f, job, {
          classification: "change_request",
          kind: "duplicate",
          duplicate_of: twin.id,
          group_key: f.section_key ?? null,
          rationale: "Asks for the same change as an earlier item.",
        }),
      );
      continue;
    }
    if (question) {
      ctx.db.suggestions.push(
        suggestion(ctx, f, job, {
          classification: "question",
          kind: "answer",
          text: `The draft does not settle this yet; the next version will say it in ${section?.heading ?? "the section"}.`,
          rationale: "A question the draft can answer directly.",
        }),
      );
    } else if (section && !locked.has(section.section_key)) {
      if (f.section_key) firstBySection.set(f.section_key, f);
      ctx.db.suggestions.push(
        suggestion(ctx, f, job, {
          classification: "change_request",
          kind: "section_text",
          group_key: f.section_key ?? null,
          text: `${section.body_md}\n\n${f.summary.replace(/\s+/g, " ").trim()}`,
          rationale: "Works the request into the section and keeps the rest.",
        }),
      );
    } else {
      ctx.db.suggestions.push(
        suggestion(ctx, f, job, {
          classification: "change_request",
          rationale: "The section is approved and locked, so Oracle proposes no new text for it.",
        }),
      );
    }
  }
  return { handled: items.length, pushbacks: 0 };
}

function runReports(ctx: LlmContext, doc: Doc, v: Version, since: number | null) {
  const items = ctx.feedback.filter((f) => f.document_id === doc.id && f.raised_on_version < v.number);
  const counts: Record<string, number> = {};
  for (const f of items) counts[f.status] = (counts[f.status] ?? 0) + 1;
  const before = since ? versionsOf(ctx, doc).find((x) => x.number === since) : undefined;
  const changed = (before ? v.sections : [])
    .map((s) => ({ s, old: before?.sections.find((o) => o.section_key === s.section_key) }))
    .filter(({ s, old }) => !old || old.body_md !== s.body_md || old.heading !== s.heading)
    .map(({ s, old }) => ({
      section_key: s.section_key,
      status: old ? "changed" : "added",
      heading: s.heading,
      summary: old ? `${s.heading} was revised.` : `${s.heading} is new.`,
    }));
  const addressed = counts.addressed ?? 0;
  return {
    version: v.number,
    since,
    resolution: {
      summary: items.length
        ? `${addressed} of ${items.length} feedback item${items.length === 1 ? " was" : "s were"} addressed in this version.`
        : "No feedback was raised on earlier versions.",
      counts,
      items: items.map((f) => ({
        feedback_id: f.id,
        summary: f.summary,
        section_key: f.section_key,
        status: f.status,
        resolution_note: f.resolution_note,
        addressed_in_version: f.addressed_in_version,
        explanation:
          f.status === "addressed"
            ? `Handled in version ${f.addressed_in_version}: ${f.resolution_note ?? "addressed"}.`
            : f.status === "open"
              ? "Still open: the draft does not answer it yet."
              : `Not changed: ${f.resolution_note ?? f.status}.`,
      })),
    },
    changes: {
      since,
      summary: since
        ? `${changed.length} section${changed.length === 1 ? "" : "s"} changed since version ${since}.`
        : "This is the first version.",
      sections: changed,
      new_sources: since
        ? [{ title: "Q3 support ticket export", kind: "upload", about: "Shipping step", url: null, added_at: v.created_at }]
        : [],
    },
  };
}

function runRefinement(ctx: LlmContext, job: Job, doc: Doc, v: Version) {
  const key = job.section_key!;
  const section = v.sections.find((s) => s.section_key === key)!;
  const ids = (job.input.suggestion_ids as string[] | undefined) ?? [];
  const used = ctx.db.suggestions.filter((s) => ids.includes(s.id));
  const instruction = String(job.input.instruction ?? "").trim();
  let body = used.at(-1)?.edited_text ?? used.at(-1)?.text ?? section.body_md;
  if (instruction) body = `${body}\n\n${instruction}`;
  // O1c: no citation markers or links in the body.
  body = body.replace(/[ \t]*\[c:[^\]]*\]/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  return {
    base_version: v.number,
    section_key: key,
    level: section.level,
    heading: section.heading,
    body_md: body,
    before: { heading: section.heading, body_md: section.body_md },
    o1c_fixes: [],
    data_points: [],
    notes: "Worked the accepted suggestions into the section; the rest is unchanged.",
    suggestion_ids: ids,
    resolutions: used.map((s) => ({ feedback_id: s.feedback_item_id, status: "addressed", note: "Refined in this version" })),
    preview: wordDiff(`${section.heading}\n${section.body_text}`, `${section.heading}\n${plainText(body)}`),
  };
}

/** A comment or verdict arrived: queue review comments (one queued job per version). */
export function onFeedback(ctx: LlmContext, documentId: string, number: number) {
  const doc = ctx.documents.find((d) => d.id === documentId);
  const v = doc && versionsOf(ctx, doc).find((x) => x.number === number);
  if (!doc || !v || (ctx.db.disabled[doc.id] ?? []).includes("review_comments")) return;
  const queued = ctx.db.jobs.some(
    (j) => j.document_id === doc.id && j.kind === "review_comments" && j.status === "queued" && j.version_number === number,
  );
  if (!queued) ctx.db.jobs.push(makeJob(ctx, doc, "review_comments", v, { requested_by: null }));
}

/**
 * Queues a job for a person (oracle.jobs.service.enqueue with coalesce): refused while its
 * switch is off, and a queued job of the same kind and version is reused.
 */
export function queueJob(ctx: LlmContext, documentId: string, kind: Job["kind"], number: number): Job | string {
  const doc = ctx.documents.find((d) => d.id === documentId)!;
  if ((ctx.db.disabled[doc.id] ?? []).includes(switchOf(kind))) return turnedOff(switchOf(kind));
  const queued = ctx.db.jobs.find((j) => j.document_id === doc.id && j.kind === kind && j.status === "queued" && j.version_number === number);
  if (queued) return queued;
  const job = makeJob(ctx, doc, kind, versionsOf(ctx, doc).find((v) => v.number === number) ?? null);
  ctx.db.jobs.push(job);
  return job;
}

/** Runs every queued job (one per document, in order): the mock's `oracle tick`. */
export function tick(ctx: LlmContext) {
  for (const job of ctx.db.jobs.filter((j) => j.status === "queued").sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const doc = ctx.documents.find((d) => d.id === job.document_id);
    const vs = doc ? versionsOf(ctx, doc) : [];
    const v = vs.find((x) => x.number === job.version_number) ?? vs.at(-1);
    if (!doc || !v) continue;
    if (ctx.db.refuse?.includes(job.kind)) {
      Object.assign(job, { status: "failed", attempts: job.attempts + 1, started_at: ctx.now(), finished_at: ctx.now(), error: SPENT, error_reason: "no_account_available", next_reset_at: SPENT_RESET });
      continue;
    }
    if (job.kind === "review_comments") finish(ctx, job, runReview(ctx, job, doc, v));
    else if (job.kind === "reporting") {
      const since = (job.input.since as number | undefined) ?? (v.number > 1 ? v.number - 1 : null);
      finish(ctx, job, runReports(ctx, doc, v, since));
    } else if (job.kind === BATCH) finish(ctx, job, runBatch(ctx, job, v));
    else if (job.kind === "quality_review") {
      if (ctx.runQualityReview) finish(ctx, job, ctx.runQualityReview(job, v.id));
    } else if (job.kind === "public_text") {
      if (ctx.publicText) finish(ctx, job, ctx.publicText(job));
    } else finish(ctx, job, runRefinement(ctx, job, doc, v));
  }
}

/** POST .../quality-review (CR-08): queues the version's quality review, or the 409 while its switch is off. */
export function queueQualityReview(ctx: LlmContext, documentId: string, n: number): Job | { status: number; detail: string } {
  const doc = ctx.documents.find((d) => d.id === documentId);
  const v = doc && versionsOf(ctx, doc).find((x) => x.number === n);
  if (!doc || !v) return { status: 404, detail: "Version not found" };
  if ((ctx.db.disabled[doc.id] ?? []).includes("quality_review")) return { status: 409, detail: turnedOff("quality_review") };
  const job = makeJob(ctx, doc, "quality_review", v);
  ctx.db.jobs.push(job);
  return job;
}

// ------------------------------------------------------------------ stored refusals

/** A refusal stored before #403's wording: every account spent, the earliest reset as raw UTC. */
export const SPENT_RESET = "2026-10-25T22:00:00.475990Z";
export const SPENT = "No Claude account can take this call: every Claude account is spent; the earliest window clears 2026-10-25T22:00:00.475990+00:00";


// ------------------------------------------------------------------ seed

/** Team workspaces v2: three comments, one review job that ran, one reporting job that could not. */
export function seedLlm(ctx: Omit<LlmContext, "db"> & { db?: LlmDb }): LlmDb {
  const db: LlmDb = { jobs: [], suggestions: [], disabled: {} };
  const c = { ...ctx, db };
  const doc = ctx.documents.find((d) => d.slug === "team-workspaces");
  const v = doc && versionsOf(c, doc).at(-1);
  if (!doc || !v) return db;
  const items = ctx.feedback.filter((f) => f.document_id === doc.id && f.raised_on_version === v.number);
  const find = (text: string) => items.find((f) => f.summary.includes(text));
  const review = makeJob(c, doc, "review_comments", v, {
    created_at: "2026-10-13T11:05:00Z",
    requested_by: null,
  });
  finish(c, review, { handled: 3, groups: 2, duplicates: 1, pushbacks: 1 });
  Object.assign(review, { started_at: "2026-10-13T11:05:02Z", finished_at: "2026-10-13T11:05:40Z" });
  db.jobs.push(review);
  const demand = find("how many teams");
  const quantify = find("quantify");
  const custom = find("custom roles");
  const problem = v.sections.find((s) => s.section_key === "problem")!;
  if (demand) {
    db.suggestions.push(
      suggestion(c, demand, review, {
        classification: "change_request",
        group_key: "demand figure",
        kind: "section_text",
        section_key: "problem",
        text: `${problem.body_md.replace(/[ \t]*\[c:[^\]]*\]/g, "")} Seven in ten sales calls with teams this quarter asked for shared editing.`,
        rationale: "Two reviewers ask for the size of the demand; the headline number goes in the body and its source in Sources and data points.",
        created_at: "2026-10-13T11:05:40Z",
      }),
    );
  }
  if (quantify && demand) {
    db.suggestions.push(
      suggestion(c, quantify, review, {
        classification: "change_request",
        group_key: "demand figure",
        kind: "duplicate",
        duplicate_of: demand.id,
        section_key: "problem",
        rationale: "Asks for the same figure as an earlier item.",
        created_at: "2026-10-13T11:05:40Z",
      }),
    );
  }
  if (custom) {
    const roles = v.sections.find((s) => s.section_key === "roles")!;
    db.suggestions.push(
      suggestion(c, custom, review, {
        classification: "change_request",
        group_key: "custom roles",
        kind: "section_text",
        section_key: "roles",
        text: `${roles.body_md.replace(/[ \t]*\[c:[^\]]*\]/g, "").replace("Custom roles are out of scope for the first release.", "Teams can also define custom roles.")}`,
        rationale: "Adds custom roles as asked.",
        pushback: {
          reason:
            "Custom roles in the first release work against the goal of getting teams live quickly: the evidence says they add support cost early, and no confirmed goal needs them yet. Oracle advises keeping three fixed roles; you decide.",
          sources: [
            { ref: "goal:team-adoption", kind: "goal", title: "Team adoption", url: null, excerpt: "More accounts with three or more active members.", confidence: null },
            {
              ref: "ev:1",
              kind: "evidence",
              title: "Roles research notes",
              url: "https://docs.example.com/d/roles-research",
              excerpt: "Start with a small, fixed set of roles; custom roles add support cost early.",
              confidence: 0.82,
            },
          ],
        },
        created_at: "2026-10-13T11:05:40Z",
      }),
    );
  }
  db.jobs.push(
    makeJob(c, doc, "reporting", v, {
      status: "failed",
      attempts: 1,
      requested_by: null,
      created_at: "2026-10-13T10:31:00Z",
      started_at: "2026-10-13T10:31:02Z",
      finished_at: "2026-10-13T10:31:02Z",
      error: "No Claude account can take this call: every Claude account is paused",
      error_reason: "pool_paused",
      next_reset_at: null,
    }),
  );
  seedOutreach(c);
  seedStoredRefusal(c);
  return db;
}

/** #556 item 2: Saved carts v2's reports failed on Oct 18 with a refusal stored before #403's wording. */
function seedStoredRefusal(c: LlmContext) {
  const doc = c.documents.find((d) => d.slug === "saved-carts");
  const v = doc && versionsOf(c, doc).find((x) => x.number === 2);
  if (!doc || !v) return;
  c.db.jobs.push(
    makeJob(c, doc, "reporting", v, {
      status: "failed",
      attempts: 1,
      requested_by: null,
      created_at: "2026-10-18T23:11:58Z",
      started_at: "2026-10-18T23:12:00Z",
      finished_at: "2026-10-18T23:12:00Z",
      error: SPENT,
      error_reason: "no_account_available",
      next_reset_at: SPENT_RESET,
    }),
  );
}

/** #561 review, the "stored-refusals" scenario: Clinic outreach's draft 6 build failed on Oct 18 on the same refusal, and every refinement now is refused. */
export function seedStoredRefusals(c: LlmContext) {
  const doc = c.documents.find((d) => d.slug === "clinic-outreach");
  const v = doc && versionsOf(c, doc).at(-1);
  if (!doc || !v) return;
  c.db.jobs.push(
    makeJob(c, doc, BATCH, v, {
      status: "failed",
      attempts: 1,
      created_at: "2026-10-18T23:11:58Z",
      started_at: "2026-10-18T23:12:00Z",
      finished_at: "2026-10-18T23:12:00Z",
      error: SPENT,
      error_reason: "no_account_available",
      next_reset_at: SPENT_RESET,
    }),
  );
  c.db.refuse = ["refinement"];
}

/**
 * C1e on Clinic outreach (Galatia-like, draft 5): two accepted changes staged for draft 6
 * (Goal trace from v4, F-38 Outbound check from v5), one declined with its note, one open
 * with a suggestion to review.
 */
function seedOutreach(c: LlmContext) {
  const doc = c.documents.find((d) => d.slug === "clinic-outreach");
  const v = doc && versionsOf(c, doc).at(-1);
  if (!doc || !v) return;
  const find = (text: string) => c.feedback.find((f) => f.document_id === doc.id && f.summary.includes(text));
  const review = makeJob(c, doc, "review_comments", v, { created_at: "2026-10-19T09:31:00Z", requested_by: null });
  finish(c, review, { handled: 4, groups: 4, duplicates: 0, pushbacks: 0 });
  Object.assign(review, { started_at: "2026-10-19T09:31:02Z", finished_at: "2026-10-19T09:31:40Z" });
  c.db.jobs.push(review);
  const accepted = { status: "accepted" as const, decided_by: c.userId, decided_at: "2026-10-19T20:10:00Z" };
  const goal = find("G2 retention");
  if (goal) {
    c.db.suggestions.push(
      suggestion(c, goal, review, {
        classification: "change_request",
        kind: "section_text",
        section_key: "goal-trace",
        version_number: 4,
        text: "Serves G2 retention: patients who missed a visit come back within 14 days.",
        rationale: "Returning patients are a retention goal.",
        created_at: "2026-10-09T15:05:00Z",
        ...accepted,
      }),
    );
  }
  const check = find("before the call is placed");
  if (check) {
    c.db.suggestions.push(
      suggestion(c, check, review, {
        classification: "change_request",
        kind: "section_text",
        section_key: "f-38",
        text: "Before each outbound call is placed, the agent checks the patient's consent and the clinic's calling hours; the call is blocked when either check fails, and the outcome is recorded.",
        rationale: "A check after the call cannot stop a call that should not happen.",
        created_at: "2026-10-19T09:31:40Z",
        ...accepted,
        decided_at: "2026-10-19T20:12:00Z",
      }),
    );
  }
  const figure = find("40% figure");
  if (figure) {
    c.db.suggestions.push(
      suggestion(c, figure, review, {
        classification: "factual_correction",
        kind: "section_text",
        section_key: "problem",
        text: "Most missed visits are never rebooked. Front desks in the three pilot clinics call back when they have time, from paper lists.",
        status: "dismissed",
        decided_by: c.userId,
        decided_at: "2026-10-19T20:14:00Z",
        created_at: "2026-10-19T09:31:40Z",
      }),
    );
    Object.assign(figure, {
      status: "declined",
      resolution_note: "The 2024 audit is still the latest count; keep the figure.",
      addressed_in_version: v.number,
      updated_at: "2026-10-19T20:14:00Z",
    });
  }
  const metric = find("outbound check works");
  if (metric) {
    const metrics = v.sections.find((s) => s.section_key === "metrics")!;
    c.db.suggestions.push(
      suggestion(c, metric, review, {
        classification: "change_request",
        kind: "section_text",
        section_key: "metrics",
        text: `${metrics.body_md}\n- Calls blocked by the outbound check: counted weekly.`,
        rationale: "Counts what the check stops.",
        created_at: "2026-10-19T09:31:40Z",
      }),
    );
  }
}

// ------------------------------------------------------------------ routes

function reportsMarkdown(doc: Doc, n: number, out: Record<string, unknown> | null): string {
  if (!out) return `# ${doc.title}: reports for version ${n}\n\nNo reports have been generated for this version yet.\n`;
  const r = out.resolution as { summary: string; items: { status: string; summary: string; explanation: string }[] };
  const c = out.changes as { since: number | null; summary: string; sections: { heading: string; status: string; summary: string }[] };
  return [
    `# ${doc.title}: reports for version ${n}`,
    "",
    "## How feedback was handled",
    "",
    r.summary,
    "",
    ...r.items.map((i) => `- **${i.status}**: ${i.summary}\n  ${i.explanation}`),
    "",
    `## What changed${c.since ? ` since version ${c.since}` : ""}`,
    "",
    c.summary,
    "",
    ...c.sections.map((s) => `- **${s.heading}** (${s.status}): ${s.summary}`),
    "",
  ].join("\n");
}

/** Handles the built-in job routes, or returns null for any other path. */
export async function llmJobsRoute(ctx: LlmContext, req: Request, p: string[], q: URLSearchParams): Promise<Response | null> {
  const m = req.method;
  const body = async <T>() => JSON.parse((await req.text()) || "null") as T;
  const { db } = ctx;
  const approver = atLeast(ctx.role, "approver");
  const findDoc = (ref: string) => ctx.documents.find((d) => d.slug === ref || d.id === ref);
  const enabled = (doc: Doc, kind: Job["kind"]) => !(db.disabled[doc.id] ?? []).includes(SWITCH[kind] ?? kind);
  const jobRoute = p[1] === "llm-jobs" && p[2];
  const suggestionRoute = p[1] === "suggestions" && p[2];
  const docRoute =
    p[1] === "documents" &&
    p[2] &&
    (p[3] === "llm-jobs" ||
      p[3] === "suggestions" ||
      p[3] === "staged-changes" ||
      p[3] === "next-draft" ||
      (p[3] === "versions" && (p[5] === "reports" || p[7] === "refine")));
  if (p[1] === "feedback" && p[3] === "stage-for-agents" && !approver) return fail(403, "Requires the approver role");
  const staging = await stageRoute(ctx, req, p, (f) => withSuggestion(db, f).suggestion ?? null);
  if (staging) return staging;
  if (!jobRoute && !suggestionRoute && !docRoute) return null;
  if (m !== "GET" && !approver && !(docRoute && p[4] === "settings")) return fail(403, "Requires the approver role");

  // Reading runs the queue, as the worker would have by now.
  tick(ctx);

  const batch = await nextDraftRoute(ctx, req, p, q, {
    startRun: ctx.startRun,
    makeJob: (doc, v, input) => makeJob(ctx, doc, BATCH, v, { input: { version: v.number, ...input } }),
    enabled: (doc) => enabled(doc, BATCH),
    onImported: (doc, v) => {
      if (enabled(doc, "reporting")) db.jobs.push(makeJob(ctx, doc, "reporting", v));
    },
  });
  if (batch) return batch;

  if (jobRoute) {
    const job = db.jobs.find((j) => j.id === p[2]);
    if (!job) return fail(404, "Job not found");
    if (!p[3] && m === "GET") return json(200, jobOut(shownJob(ctx, job)));
    if (p[3] === "cancel" && m === "POST") {
      if (!["queued", "running"].includes(job.status)) return fail(409, `a ${job.status} job cannot be cancelled`);
      Object.assign(job, { status: "cancelled", finished_at: ctx.now() });
      return json(200, jobOut(shownJob(ctx, job)));
    }
    if (p[3] === "retry" && m === "POST") {
      if (!["failed", "cancelled"].includes(job.status)) return fail(409, `a ${job.status} job cannot be retried`);
      const doc = ctx.documents.find((d) => d.id === job.document_id);
      if (doc && !enabled(doc, job.kind)) return fail(409, turnedOff(switchOf(job.kind)));
      Object.assign(job, { status: "queued", attempts: 0, error: null, error_reason: null, next_reset_at: null, started_at: null, finished_at: null });
      return json(200, jobOut(shownJob(ctx, job)));
    }
    if (p[3] === "preview" && m === "GET") {
      if (job.kind !== "refinement" || job.status !== "succeeded") return fail(409, "only a finished refinement has a preview");
      const o = job.output as Record<string, unknown>;
      return json(200, { section_key: o.section_key, heading: o.heading, body_md: o.body_md, words: o.preview });
    }
    if (p[3] === "apply" && m === "POST") {
      if (job.kind !== "refinement" || job.status !== "succeeded") return fail(409, "only a finished refinement can be accepted");
      const o = job.output as Record<string, unknown>;
      if (o.applied_version) return fail(409, `already accepted as version ${o.applied_version}`);
      const doc = ctx.documents.find((d) => d.id === job.document_id)!;
      const vs = versionsOf(ctx, doc);
      const base = vs.find((x) => x.number === o.base_version)!;
      if (vs.at(-1)!.number !== base.number) return fail(409, "a newer version exists; refine the section again");
      // As the API: a newer refinement of the section (no key reads as "", as Undo) replaced it.
      const newer = db.jobs.some(
        (j) =>
          j.document_id === job.document_id &&
          j.kind === "refinement" &&
          (j.section_key ?? "") === (job.section_key ?? "") &&
          ["queued", "running", "succeeded"].includes(j.status) &&
          (j.created_at > job.created_at || (j.created_at === job.created_at && j.id > job.id)),
      );
      if (newer) return fail(409, "a newer refinement of this section replaced it; apply that one");
      const edit = await body<Schemas["RefinementApply"]>();
      const heading = edit?.heading ?? (o.heading as string);
      const text = (edit?.body_md ?? (o.body_md as string)).replace(/[ \t]*\[c:[^\]]*\]/g, "");
      const next = ctx.importRevision(doc, base, o.section_key as string, heading, text, o.resolutions as never);
      job.output = { ...o, applied_version: next.number };
      for (const s of db.suggestions) {
        if ((o.suggestion_ids as string[]).includes(s.id) || (s.kind === "duplicate" && db.suggestions.some((u) => (o.suggestion_ids as string[]).includes(u.id) && u.feedback_item_id === s.duplicate_of))) {
          Object.assign(s, { status: "applied", applied_in_version: next.number, updated_at: ctx.now() });
        }
      }
      if (enabled(doc, "reporting")) db.jobs.push(makeJob(ctx, doc, "reporting", next));
      return json(201, { number: next.number, document_id: doc.id, id: next.id });
    }
    return fail(404, "Route not found");
  }

  if (suggestionRoute) {
    const s = db.suggestions.find((x) => x.id === p[2]);
    if (!s) return fail(404, "Suggestion not found");
    const item = ctx.feedback.find((f) => f.id === s.feedback_item_id);
    const doc = ctx.documents.find((d) => d.id === s.document_id);
    const latest = doc ? (versionsOf(ctx, doc).at(-1)?.number ?? null) : null;
    if (m === "PATCH") {
      if (s.status !== "open") return fail(409, `an ${s.status} suggestion cannot be edited`);
      Object.assign(s, { edited_text: (await body<Schemas["SuggestionPatch"]>()).text, updated_at: ctx.now() });
      return json(200, shownSuggestion(item, s));
    }
    if (p[3] === "accept" && m === "POST") {
      if (s.status !== "open") return fail(409, `an ${s.status} suggestion cannot be accepted`);
      const input = (await body<Schemas["SuggestionAccept"]>()) ?? {};
      const reason = input.reason?.trim();
      if (s.pushback && !reason) return fail(422, "Oracle pushed back on this feedback: say why you keep your call (reason)");
      // As the API: section text for a section approved (locked) since is refused.
      const last = doc ? versionsOf(ctx, doc).at(-1) : undefined;
      if (s.kind === "section_text" && s.section_key && last && ctx.lockedKeys(last).includes(s.section_key)) {
        return fail(409, `section '${s.section_key}' is approved and locked`);
      }
      Object.assign(s, {
        status: "accepted",
        edited_text: input.text ?? s.edited_text,
        override_reason: s.pushback ? reason : null,
        decided_by: ctx.userId,
        decided_at: ctx.now(),
        updated_at: ctx.now(),
      });
      const final = s.edited_text ?? s.text;
      db.accept_closed = { ...db.accept_closed, [s.id]: item?.status === "open" };
      if (item && item.status === "open") {
        if (s.kind === "answer" && final) {
          ctx.reply(item.id, final);
          Object.assign(item, { status: "addressed", resolution_note: `Answered: ${final}`, addressed_in_version: latest, updated_at: ctx.now() });
        } else if (s.kind === "none") {
          Object.assign(item, { status: "addressed", resolution_note: s.rationale ?? "Nothing to change", addressed_in_version: latest, updated_at: ctx.now() });
        } else if (s.kind === "duplicate") {
          Object.assign(item, { status: "superseded", resolution_note: `Duplicate of feedback item ${s.duplicate_of}`, updated_at: ctx.now() });
        }
      }
      return json(200, shownSuggestion(item, s));
    }
    // D14: Undo Accept, as jobs.service.undo_accept: back to open, or refused with the reason.
    if (p[3] === "undo-accept" && m === "POST") {
      if (s.status === "applied") return fail(409, `draft ${s.applied_in_version} already applied it; it stays`);
      if (s.status !== "accepted") return fail(409, `an ${s.status} suggestion has no accept to undo`);
      if (s.kind === "answer") return fail(409, "the answer is posted on the comment thread: reply there to correct it");
      if (s.kind === "section_text") {
        // A section refinement has no discard: it holds the change only while it can still be
        // applied (on the latest version, and its section's newest refinement).
        type Out = { applied_version?: number; discarded_at?: string; base_version?: number } | null;
        const newest = new Set<string>();
        const jobs = db.jobs
          .filter((j) => j.document_id === s.document_id && (j.kind === "refinement" || j.kind === "refinement_batch") && ["queued", "running", "succeeded"].includes(j.status))
          .sort((a, b) => b.created_at.localeCompare(a.created_at));
        for (const j of jobs) {
          const out = j.output as Out;
          const replaced = j.kind === "refinement" && newest.has(j.section_key ?? "");
          if (j.kind === "refinement") newest.add(j.section_key ?? "");
          if (out?.applied_version || out?.discarded_at || replaced) continue;
          if (j.kind === "refinement" && out?.base_version != null && out.base_version !== latest) continue;
          if (!((j.input as { suggestion_ids?: string[] } | null)?.suggestion_ids ?? []).includes(s.id)) continue;
          return fail(409, j.kind === "refinement" ? "a refinement of its section uses it: apply it or refine the section again" : "the next draft being built uses it: discard that build first");
        }
        if (ctx.sentToAgents?.(s.id)) return fail(409, "the agents' next draft uses it: cancel that run first");
      } else if (item && (db.accept_closed?.[s.id] ?? true)) {
        const closed = s.kind === "none" ? "addressed" : "superseded";
        if (item.status !== closed) return fail(409, `the item is ${item.status} since; open it to change it`);
        Object.assign(item, { status: "open", resolution_note: null, addressed_in_version: null, updated_at: ctx.now() });
      }
      Object.assign(s, { status: "open", decided_by: null, decided_at: null, override_reason: null, edited_text: null, updated_at: ctx.now() });
      return json(200, shownSuggestion(item, s));
    }
    if (p[3] === "dismiss" && m === "POST") {
      if (!["open", "accepted"].includes(s.status)) return fail(409, `an ${s.status} suggestion cannot be dismissed`);
      const input = (await body<Schemas["SuggestionDismiss"]>()) ?? {};
      Object.assign(s, { status: "dismissed", decided_by: ctx.userId, decided_at: ctx.now(), updated_at: ctx.now() });
      if (input.decline && item && item.status === "open") {
        Object.assign(item, {
          status: "declined",
          resolution_note: input.reason || s.pushback?.reason || "Declined on Oracle's suggestion",
          addressed_in_version: latest,
          updated_at: ctx.now(),
        });
      }
      return json(200, shownSuggestion(item, s));
    }
    return fail(404, "Route not found");
  }

  const doc = findDoc(p[2]);
  if (!doc) return fail(404, "Document not found");
  const vs = versionsOf(ctx, doc);

  if (p[3] === "llm-jobs" && p[4] === "settings") {
    if (m === "PUT") {
      if (!atLeast(ctx.role, "owner")) return fail(403, "Requires the owner role");
      const s = await body<Schemas["JobSettings"]>();
      db.disabled[doc.id] = KINDS.filter((k) => s[k] === false);
    }
    return json(200, Object.fromEntries(KINDS.map((k) => [k, enabled(doc, k)])));
  }
  if (p[3] === "llm-jobs") {
    if (m === "POST") {
      const input = await body<Schemas["JobCreate"]>();
      if (!enabled(doc, input.kind)) return fail(409, turnedOff(switchOf(input.kind)));
      const v = vs.find((x) => x.number === input.version) ?? vs.at(-1)!;
      const job = makeJob(ctx, doc, input.kind, v, input.since ? { input: { version: v.number, since: input.since } } : {});
      db.jobs.push(job);
      return json(201, jobOut(job));
    }
    return json(
      200,
      db.jobs
        .filter((j) => j.document_id === doc.id)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map((j) => jobOut(shownJob(ctx, j))),
    );
  }
  if (p[3] === "suggestions") {
    const status = q.get("status");
    const key = q.get("section_key");
    return json(
      200,
      db.suggestions
        .filter((s) => s.document_id === doc.id && (!status || s.status === status) && (!key || s.section_key === key))
        .map((s) => shownSuggestion(ctx.feedback.find((f) => f.id === s.feedback_item_id), s)),
    );
  }
  const v = vs.find((x) => x.number === Number(p[4]));
  if (!v) return fail(404, "Version not found");
  if (p[5] === "reports") {
    const jobs = db.jobs.filter((j) => j.document_id === doc.id && j.kind === "reporting" && j.version_number === v.number).sort((a, b) => b.created_at.localeCompare(a.created_at));
    // As the API: a withheld item's lines are withheld in the reports, their export and latest_job.
    const done = shownJob(ctx, jobs.find((j) => j.status === "succeeded" && j.output));
    if (p[6] === "export") {
      const md = reportsMarkdown(doc, v.number, done?.output ?? null);
      return new Response(md, { headers: { "content-type": q.get("format") === "html" ? "text/html" : "text/markdown" } });
    }
    return json(200, {
      document_id: doc.id,
      version: v.number,
      report_job_id: done?.id ?? null,
      generated_at: done?.finished_at ?? null,
      resolution: done?.output?.resolution ?? null,
      changes: done?.output?.changes ?? null,
      latest_job: jobs[0] ? jobOut(shownJob(ctx, jobs[0])) : null,
    });
  }
  // .../sections/{key}/refine
  const key = p[6];
  if (!enabled(doc, "refinement")) return fail(409, turnedOff("refinement"));
  if (vs.at(-1)!.number !== v.number) return fail(409, "refine the latest version; a newer one exists");
  if (!v.sections.some((s) => s.section_key === key)) return fail(404, `section '${key}' is not in version ${v.number}`);
  if (ctx.lockedKeys(v).includes(key)) return fail(409, `section '${key}' is approved and locked; it is never changed`);
  const input = (await body<Schemas["RefineIn"]>()) ?? {};
  const accepted = db.suggestions.filter(
    (s) => s.document_id === doc.id && s.section_key === key && s.kind === "section_text" && s.status === "accepted" && (!input.suggestion_ids || input.suggestion_ids.includes(s.id)),
  );
  const instruction = input.instruction?.trim() ?? "";
  if (!accepted.length && !instruction) return fail(422, "accept a suggestion for this section or give an instruction");
  const job = makeJob(ctx, doc, "refinement", v, {
    section_key: key,
    input: { version: v.number, suggestion_ids: accepted.map((s) => s.id), instruction },
  });
  db.jobs.push(job);
  return json(201, jobOut(job));
}
