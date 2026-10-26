/**
 * Mock of C1e: staged changes and the next draft built from them in one job.
 *
 * An accepted section-text suggestion not applied in any draft is "staged". Build next
 * draft queues one `refinement_batch` job over the latest version; the job "runs" the
 * next time anything reads it (as the other mock jobs do) and rewrites every affected
 * section from simple rules. Apply imports exactly one new version without the dropped
 * sections, whose suggestions stay staged; Discard keeps everything staged.
 *
 * Also the derived feedback state (open, staged, declined, done) and the Inbox's states
 * (new, open, staged, declined, done) with its staged rows.
 *
 * G4: a discussion's section change staged for the next draft (a `next_draft_changes` row)
 * is listed next to the accepted suggestions, ticked by default, built with them and marked
 * applied when its section is kept.
 */
import type { Schemas } from "@/lib/api/client";
import { wordDiff } from "@/lib/diff";
import { turnedOff } from "@/lib/format";
import { plainText } from "@/lib/markdown";

import type { LlmContext } from "./llm-jobs";

type Job = Schemas["LlmJobOut"];
type Suggestion = Schemas["SuggestionOut"];
type Feedback = LlmContext["feedback"][number];
type Doc = LlmContext["documents"][number];
type Version = LlmContext["versions"][number];
type Resolution = { feedback_id: string; status: "addressed" | "declined"; note: string | null };
type BuiltSection = {
  section_key: string;
  level: number;
  heading: string;
  body_md: string;
  before: { heading: string; body_md: string };
  o1c_fixes: string[];
  data_points: { value: string; as_of: string; source: string }[];
  notes: string;
  suggestion_ids: string[];
  /** G4: the discussions' section changes built into it. */
  next_draft_change_ids?: string[];
  resolutions: Resolution[];
  preview: Schemas["WordOp"][];
};
type BatchOutput = {
  base_version: number;
  notes: string;
  sections: BuiltSection[];
  skipped: { section_key: string | null; suggestion_ids: string[]; reason: string }[];
  suggestion_ids: string[];
  applied_version?: number;
  discarded_at?: string;
};

export const KIND = "refinement_batch" as const;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const fail = (status: number, detail: string) => json(status, { detail });

const versionsOf = (ctx: LlmContext, docId: string) =>
  ctx.versions.filter((v) => v.document_id === docId).sort((a, b) => a.number - b.number);
const latestOf = (ctx: LlmContext, docId: string) => versionsOf(ctx, docId).at(-1) ?? null;

export const isStaged = (s: Suggestion | null | undefined): boolean =>
  !!s && s.kind === "section_text" && s.status === "accepted" && s.applied_in_version == null;

/** D12: an open item an approver staged for the agents. */
export const stagedForAgents = (f: Pick<Feedback, "status" | "staged_for_agents_at">) =>
  f.status === "open" && !!f.staged_for_agents_at;

/**
 * C1e: open / staged / declined / done, from the item's status and its live suggestion.
 * Staged first, as the API (owner, 2026-10-20): an accepted change carries into the next
 * draft until a draft applies it or someone discards it, even once its item is closed.
 * D12: an open item staged for the agents is Staged too.
 */
export function feedbackState(
  status: Feedback["status"],
  s: Suggestion | null | undefined,
  agents = false,
): Schemas["FeedbackItemOut"]["state"] {
  if (isStaged(s)) return "staged";
  if (status === "declined") return "declined";
  if (status !== "open") return "done";
  if (agents) return "staged";
  if (s?.status === "applied") return "done";
  return "open";
}

/** The derived state and, when staged, the draft it waits for. */
export function stateOf(f: Feedback, s: Suggestion | null, latest: number | null) {
  const agents = stagedForAgents(f);
  const state = feedbackState(f.status, s, agents);
  return { state, staged_for_version: state === "staged" ? (latest ?? 0) + 1 : null, staged_for_agents: agents };
}

/** D12: the document's items staged for the agents, oldest first. */
export function agentItems(ctx: LlmContext, docId: string): Schemas["AgentItem"][] {
  return ctx.feedback
    .filter((f) => f.document_id === docId && stagedForAgents(f))
    .sort((a, b) => (a.staged_for_agents_at ?? "").localeCompare(b.staged_for_agents_at ?? ""))
    .map((f) => ({
      feedback_id: f.id,
      summary: f.summary,
      section_key: f.section_key ?? null,
      staged_by_name: memberName(ctx, f.staged_for_agents_by),
      staged_at: f.staged_for_agents_at ?? null,
    }));
}

/** G4: a discussion's section change waiting for the document's next draft (`next_draft_changes`). */
export type NextDraftChangeRow = Omit<Schemas["NextDraftChangeOut"], "text" | "reason" | "applied_in_version"> & {
  text: string | null;
  reason: string | null;
  applied_in_version: number | null;
  discussion_id: string | null;
  staged_by: string;
  suggested_by: string | null;
  created_at: string;
};

export const PRIVATE_LINE = "From a private discussion";

/** "From discussion <title>", or for a private one the reader is not in, only that. */
export function originLine(view: Schemas["StagingDiscussion"] | null | undefined): string {
  return view?.title ? `From discussion ${view.title}` : PRIVATE_LINE;
}

/** G4: the document's staged next-draft rows, oldest first. */
export function stagedRows(ctx: LlmContext, docId: string): NextDraftChangeRow[] {
  return (ctx.db.next_draft_changes ?? [])
    .filter((r) => r.document_id === docId && r.status === "staged")
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

type Reason = Schemas["NextDraftReason"];
const many = (n: number, one: string, more: string) => `${n} ${n === 1 ? one : more}`;

/** The API's choose_engine: the agents when any chosen item needs them, else Oracle. */
export function chooseEngine(texts: Schemas["StagedChange"][], agents: Schemas["AgentItem"][]): { engine: "oracle" | "agents"; why: Reason[] } {
  const why: Reason[] = [];
  const general = agents.filter((a) => !a.section_key).map((a) => a.feedback_id);
  const sectioned = agents.filter((a) => a.section_key).map((a) => a.feedback_id);
  const gone = texts.filter((t) => t.section_gone);
  if (general.length)
    why.push({ code: "whole_draft", text: `${many(general.length, "remark is", "remarks are")} about the whole draft`, feedback_ids: general, suggestion_ids: [] });
  if (sectioned.length)
    why.push({
      code: "structure",
      text: `${many(sectioned.length, "item needs", "items need")} more than a section's text changed`,
      feedback_ids: sectioned,
      suggestion_ids: [],
    });
  if (gone.length) {
    const n = new Set(gone.map((t) => t.section_key)).size;
    why.push({
      code: "section_gone",
      text: `${many(n, "section", "sections")} to change ${n === 1 ? "is" : "are"} gone`,
      feedback_ids: [],
      suggestion_ids: gone.map((t) => t.suggestion_id),
    });
  }
  return { engine: why.length ? "agents" : "oracle", why };
}

/** The feedback loop's estimate, as the runs mock's cost table makes it (analyst + writer). */
const RUN_BASE_USD = 9;
const DEPTH: Record<string, number> = { quick: 0.5, standard: 1, deep: 2 };
const OWNER_APPROVAL_USD = 50;

export function staged(ctx: LlmContext, docId: string, ids?: string[] | null): Suggestion[] {
  return ctx.db.suggestions
    .filter((s) => s.document_id === docId && isStaged(s) && (!ids || ids.includes(s.id)))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** The latest next-draft build while it is pending (queued, running, failed, ready to preview). */
export function currentJob(ctx: LlmContext, docId: string): Job | null {
  const job = ctx.db.jobs
    .filter((j) => j.document_id === docId && j.kind === KIND)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const out = job?.output as BatchOutput | null | undefined;
  if (!job || job.status === "cancelled" || out?.applied_version || out?.discarded_at) return null;
  return job;
}

function memberName(ctx: LlmContext, id: string | null | undefined): string | null {
  if (!id) return null;
  return ctx.memberName?.(id) ?? null;
}

export function stagedChanges(ctx: LlmContext, doc: Doc, includeGone: boolean): Schemas["StagedChanges"] {
  const latest = latestOf(ctx, doc.id);
  const locked = new Set(latest ? ctx.lockedKeys(latest) : []);
  const rows = staged(ctx, doc.id);
  let gone = 0;
  const items: Schemas["StagedChange"][] = [];
  for (const s of rows) {
    const key = s.section_key ?? "";
    const section = latest?.sections.find((x) => x.section_key === key);
    if (!section) gone += 1;
    if (!section && !includeGone) continue;
    const f = ctx.feedback.find((x) => x.id === s.feedback_item_id);
    const older = versionsOf(ctx, doc.id)
      .filter((v) => v.number <= s.version_number)
      .reverse()
      .flatMap((v) => v.sections)
      .find((x) => x.section_key === key);
    items.push({
      suggestion_id: s.id,
      feedback_item_id: s.feedback_item_id,
      section_key: key,
      section_heading: section?.heading ?? older?.heading ?? key,
      feedback_summary: f?.summary ?? "",
      // #636 re-review: none of a withheld item's text (the next draft still takes it).
      text: f?.withheld_at ? "" : (s.edited_text ?? s.text ?? ""),
      accepted_by: s.decided_by ?? null,
      accepted_by_name: memberName(ctx, s.decided_by),
      accepted_at: s.decided_at ?? null,
      raised_on_version: f?.raised_on_version ?? s.version_number,
      suggested_on_version: s.version_number,
      section_gone: !section,
      section_locked: locked.has(key),
    });
  }
  const changes: Schemas["StagedDiscussionChange"][] = [];
  for (const r of stagedRows(ctx, doc.id)) {
    const section = latest?.sections.find((x) => x.section_key === r.section_key);
    if (!section && !includeGone) continue;
    const view = r.discussion_id ? (ctx.discussion?.(r.discussion_id) ?? null) : null;
    changes.push({
      id: r.id,
      source: "next_draft_change",
      section_key: r.section_key,
      section_heading: section?.heading ?? r.section_key,
      instruction: r.instruction,
      text: r.text,
      reason: r.reason,
      origin_line: originLine(view),
      discussion_id: view?.id ?? null,
      discussion_title: view?.title ?? null,
      from_private: r.from_private,
      staged_by_name: memberName(ctx, r.staged_by),
      staged_at: r.created_at,
      raised_on_version: r.raised_on_version,
      section_gone: !section,
      section_locked: locked.has(r.section_key),
      lock_version: r.lock_version,
    });
  }
  const job = currentJob(ctx, doc.id);
  const sections = new Set([...items, ...changes].filter((i) => !i.section_gone).map((i) => i.section_key));
  return {
    document_id: doc.id,
    slug: doc.slug,
    latest_version: latest?.number ?? null,
    next_version: (latest?.number ?? 0) + 1,
    items,
    gone_count: gone,
    estimate_usd: sections.size ? Math.round(sections.size * 0.0312 * 10000) / 10000 : null,
    draft_job: job,
    agent_items: agentItems(ctx, doc.id),
    next_draft_changes: changes,
  };
}

type Chosen = {
  texts: Schemas["StagedChange"][];
  agents: Schemas["AgentItem"][];
  /** G4: the discussions' section changes the build takes. */
  rows: Schemas["StagedDiscussionChange"][];
  staged: Schemas["StagedChanges"];
};

/** The staged items a build takes (the API's _chosen), or why not. */
function chosen(ctx: LlmContext, doc: Doc, input: Schemas["NextDraftIn"]): Chosen | Response {
  const all = stagedChanges(ctx, doc, true);
  const sids = input.suggestion_ids ?? null;
  const fids = input.feedback_ids ?? null;
  const texts = sids ? all.items.filter((i) => sids.includes(i.suggestion_id)) : all.items.filter((i) => !i.section_gone);
  if (sids && texts.length !== new Set(sids).size) return fail(422, "every suggestion must be a staged (accepted, not applied) change");
  const agents = fids ? all.agent_items.filter((a) => fids.includes(a.feedback_id)) : all.agent_items;
  if (fids && agents.length !== new Set(fids).size) return fail(422, "every feedback item must be staged for the agents");
  const nids = input.next_draft_change_ids ?? null;
  const rows = nids ? all.next_draft_changes.filter((r) => nids.includes(r.id)) : all.next_draft_changes.filter((r) => !r.section_gone);
  if (nids && rows.length !== new Set(nids).size) return fail(422, "every discussion change must be staged for the next draft");
  if (!texts.length && !agents.length && !rows.length) return fail(422, "nothing is staged for the next draft");
  return { texts, agents, rows, staged: all };
}

/** The run estimate at a depth; the mock's "costly" setting stands in for a bigger run. */
export function runEstimate(ctx: LlmContext, depth: string): number {
  return ctx.runEstimateUsd?.() ?? RUN_BASE_USD * (DEPTH[depth] ?? 1);
}

export type StartRun = (
  doc: Doc,
  input: { feedback_ids: string[]; suggestion_ids: string[]; depth: string; estimate_usd: number },
) => Promise<Response>;

/** POST /v1/feedback/{id}/stage-for-agents (and DELETE): D12 staging for the agents; null for other paths. */
export async function stageRoute(ctx: LlmContext, req: Request, p: string[], live: (f: Feedback) => Suggestion | null): Promise<Response | null> {
  if (p[1] !== "feedback" || !p[2] || p[3] !== "stage-for-agents" || !["POST", "DELETE"].includes(req.method)) return null;
  const f = ctx.feedback.find((x) => x.id === p[2]);
  if (!f) return fail(404, `Feedback item ${p[2]} not found`);
  const s = live(f);
  if (isStaged(s)) return fail(409, "already staged as a text change for the next draft");
  if (f.status !== "open") return fail(409, `the item is ${f.status}, not open`);
  const on = req.method === "POST";
  if (on && s?.kind === "section_text" && s.status === "open")
    return fail(409, "it has a text suggestion: accept it (a text change) or dismiss it first");
  if (on && !f.staged_for_agents_at) Object.assign(f, { staged_for_agents_at: ctx.now(), staged_for_agents_by: ctx.userId });
  if (!on) Object.assign(f, { staged_for_agents_at: null, staged_for_agents_by: null });
  f.updated_at = ctx.now();
  const latest = latestOf(ctx, f.document_id)?.number ?? null;
  return json(200, { ...f, resolution_note: shownNote(f, s), suggestion: shownSuggestion(f, s), ...stateOf(f, s, latest) });
}

/** A withheld item's suggestion: what its pushback says instead of its reason (jobs.service.WITHHELD_REASON). */
export const WITHHELD_REASON = "Withheld while its finding is not shared in full";

/** A suggestion as every output serves it (jobs.service.suggestion_out, #636 re-review): on a
 * withheld item (a late answer whose finding is not shared in full) its text, edited text and
 * rationale are left out, and its pushback keeps its sources but not its reason. */
export function shownSuggestion<S extends Suggestion | null>(f: Pick<Feedback, "withheld_at"> | undefined, s: S): S {
  if (!s || !f?.withheld_at) return s;
  return { ...s, text: null, edited_text: null, rationale: null, pushback: s.pushback ? { ...s.pushback, reason: WITHHELD_REASON } : null };
}

/** The item's resolution note as outputs serve it (jobs.service.shown_note): on a withheld item
 * a note Accept wrote from its suggestion is withheld with it; a person's note is shown as written. */
export function shownNote(f: Feedback, s: Suggestion | null): string | null {
  const note = f.resolution_note ?? null;
  if (!f.withheld_at || note == null || !s) return note;
  if ([`Answered: ${s.edited_text ?? s.text}`, s.rationale, s.pushback?.reason].includes(note)) return WITHHELD_REASON;
  return note;
}

function strip(body: string) {
  return body.replace(/[ \t]*\[c:[^\]]*\]/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
}

/** The "model": every affected section rewritten from its staged suggestions. */
export function runBatch(ctx: LlmContext, job: Job, v: Version): BatchOutput {
  const ids = (job.input.suggestion_ids as string[] | undefined) ?? [];
  const used = staged(ctx, job.document_id ?? "", ids);
  const keys = new Set(v.sections.map((s) => s.section_key));
  const skipped: BatchOutput["skipped"] = used
    .filter((s) => !keys.has(s.section_key ?? ""))
    .map((s) => ({
      section_key: s.section_key ?? null,
      suggestion_ids: [s.id],
      reason: `the section is not in version ${v.number}`,
    }));
  const usable = used.filter((s) => keys.has(s.section_key ?? ""));
  const rowIds = (job.input.next_draft_change_ids as string[] | undefined) ?? [];
  const rows = stagedRows(ctx, job.document_id ?? "").filter((r) => rowIds.includes(r.id) && keys.has(r.section_key));
  const sections: BuiltSection[] = [];
  for (const section of v.sections) {
    const mine = usable.filter((s) => s.section_key === section.section_key);
    const mineRows = rows.filter((r) => r.section_key === section.section_key);
    if (!mine.length && !mineRows.length) continue;
    const body = strip(
      [...mine.map((s) => s.edited_text ?? s.text ?? ""), ...mineRows.map((r) => r.text ?? `${section.body_md}\n\n${r.instruction}`)]
        .filter(Boolean)
        .at(-1) ?? section.body_md,
    );
    sections.push({
      section_key: section.section_key,
      level: section.level,
      heading: section.heading,
      body_md: body,
      before: { heading: section.heading, body_md: section.body_md },
      o1c_fixes: [],
      data_points: [],
      notes: mine.length === 1 ? "Worked the accepted change in." : `Worked ${mine.length} accepted changes in together.`,
      suggestion_ids: mine.map((s) => s.id),
      next_draft_change_ids: mineRows.map((r) => r.id),
      resolutions: mine.map((s) => ({
        feedback_id: s.feedback_item_id,
        status: "addressed",
        note: "Worked into the next draft",
      })),
      preview: wordDiff(`${section.heading}\n${section.body_text}`, `${section.heading}\n${plainText(body)}`),
    });
  }
  return {
    base_version: v.number,
    notes: `${sections.length} section${sections.length === 1 ? "" : "s"} revised together.`,
    sections,
    skipped,
    suggestion_ids: usable.map((s) => s.id),
  };
}

function preview(ctx: LlmContext, job: Job): Schemas["NextDraftPreview"] {
  const out = (job.output ?? null) as BatchOutput | null;
  const base = (job.input.version as number | undefined) ?? null;
  const latest = latestOf(ctx, job.document_id ?? "")?.number ?? null;
  const done = job.status === "succeeded" && out;
  return {
    job,
    base_version: base,
    next_version: base ? base + 1 : null,
    latest_version: latest,
    stale: !!base && latest != null && latest !== base && !out?.applied_version,
    applied_version: out?.applied_version ?? null,
    discarded: !!out?.discarded_at,
    notes: done ? out.notes : "",
    sections: done
      ? out.sections.map((s) => ({
          section_key: s.section_key,
          heading: s.heading,
          before_heading: s.before.heading,
          before_body_md: s.before.body_md,
          body_md: s.body_md,
          words: s.preview,
          notes: s.notes,
          o1c_fixes: s.o1c_fixes,
          data_points: s.data_points,
          resolutions: s.resolutions,
          suggestion_ids: s.suggestion_ids,
          next_draft_change_ids: s.next_draft_change_ids ?? [],
          instructions: (s.next_draft_change_ids ?? []).flatMap((id) => {
            const r = (ctx.db.next_draft_changes ?? []).find((x) => x.id === id);
            if (!r) return [];
            const view = r.discussion_id ? (ctx.discussion?.(r.discussion_id) ?? null) : null;
            return [{ next_draft_change_id: r.id, instruction: r.instruction, text: r.text, origin: originLine(view) }];
          }),
          feedback: s.resolutions.map((r) => ({
            id: r.feedback_id,
            summary: ctx.feedback.find((f) => f.id === r.feedback_id)?.summary ?? "",
          })),
        }))
      : [],
    skipped: done ? out.skipped : [],
  };
}

/** Handles /documents/{doc}/staged-changes and /documents/{doc}/next-draft/*; null otherwise. */
export async function nextDraftRoute(
  ctx: LlmContext,
  req: Request,
  p: string[],
  q: URLSearchParams,
  hooks: {
    /** D12: starts the agents' feedback-loop run with the chosen items. */
    startRun?: StartRun;
    makeJob: (doc: Doc, v: Version, input: Record<string, unknown>) => Job;
    enabled: (doc: Doc) => boolean;
    /** A version was imported: queue its reports. */
    onImported: (doc: Doc, v: Version) => void;
  },
): Promise<Response | null> {
  const { makeJob, enabled } = hooks;
  if (p[1] !== "documents" || !p[2] || (p[3] !== "staged-changes" && p[3] !== "next-draft")) return null;
  const m = req.method;
  const doc = ctx.documents.find((d) => d.slug === p[2] || d.id === p[2]);
  if (!doc) return fail(404, "Document not found");
  if (p[3] === "staged-changes" && m === "GET") return json(200, stagedChanges(ctx, doc, q.get("include_gone") === "true"));
  if (p[3] !== "next-draft") return fail(404, "Route not found");
  const body = async <T>() => JSON.parse((await req.text()) || "null") as T;

  if (p[4] === "plan" && m === "POST") {
    const input = (await body<Schemas["NextDraftPlanIn"]>()) ?? {};
    const c = chosen(ctx, doc, input);
    if (c instanceof Response) return c;
    const { engine, why } = chooseEngine(c.texts, c.agents);
    const estimate = engine === "agents" ? runEstimate(ctx, input.depth ?? "standard") : null;
    const latest = latestOf(ctx, doc.id);
    const locked = new Set(latest ? ctx.lockedKeys(latest) : []);
    const hit = [...c.texts, ...c.rows].filter((t) => locked.has(t.section_key));
    const refused =
      engine === "agents"
        ? null
        : !enabled(doc)
          ? "Refinement is turned off for this document"
          : hit.length
            ? `approved and locked, never changed: ${[...new Set(hit.map((t) => `${t.section_heading} (${t.section_key})`))].join(", ")}; untick them`
            : null;
    return json(200, {
      engine,
      why,
      text_changes: c.texts.length + c.rows.length,
      agent_items: c.agents.length,
      sections: new Set([...c.texts, ...c.rows].map((t) => t.section_key)).size,
      next_version: c.staged.next_version,
      needs_owner_approval: estimate != null && estimate > OWNER_APPROVAL_USD,
      estimate_usd: estimate,
      refused,
    } satisfies Schemas["NextDraftPlan"]);
  }

  if (p[4] === "run" && m === "POST") {
    const input = (await body<Schemas["NextDraftRunIn"]>()) ?? {};
    const c = chosen(ctx, doc, input);
    if (c instanceof Response) return c;
    if (chooseEngine(c.texts, c.agents).engine === "oracle") return fail(409, "these changes need no agents; build them with Oracle");
    if (!hooks.startRun) return fail(503, "runs are not available");
    const depth = input.depth ?? "standard";
    return hooks.startRun(doc, {
      feedback_ids: c.agents.map((a) => a.feedback_id),
      suggestion_ids: c.texts.map((t) => t.suggestion_id),
      depth,
      estimate_usd: runEstimate(ctx, depth),
    });
  }

  if (!p[4] && m === "POST") {
    const latest = latestOf(ctx, doc.id);
    if (!latest) return fail(409, `'${doc.slug}' has no version yet`);
    if (!enabled(doc)) return fail(409, turnedOff("refinement"));
    const pending = currentJob(ctx, doc.id);
    if (pending && ["queued", "running"].includes(pending.status)) {
      return fail(409, "the next draft is already being built; wait for it or discard it");
    }
    const input = (await body<Schemas["NextDraftIn"]>()) ?? {};
    // D12: the built-in engine builds only what needs no agents.
    const c = chosen(ctx, doc, input);
    if (c instanceof Response) return c;
    const plan = chooseEngine(c.texts, c.agents);
    if (plan.engine === "agents")
      return json(409, {
        detail: `these changes need the agents: ${plan.why.map((w) => w.text).join("; ")}`,
        code: "needs_agents",
        why: plan.why,
      });
    const ids = input.suggestion_ids ?? null;
    let rows = staged(ctx, doc.id, ids);
    if (ids && rows.length !== new Set(ids).size)
      return fail(422, "every suggestion must be a staged (accepted, not applied) change");
    const keys = new Set(latest.sections.map((s) => s.section_key));
    // Named items whose section is gone are refused; by default they are left out.
    const gone = new Set(ids ? rows.filter((s) => !keys.has(s.section_key ?? "")).map((s) => s.section_key ?? "?") : []);
    if (input.next_draft_change_ids) for (const r of c.rows) if (!keys.has(r.section_key)) gone.add(r.section_key);
    if (!ids) rows = rows.filter((s) => keys.has(s.section_key ?? ""));
    if (gone.size) return fail(422, `section(s) ${[...gone].join(", ")} are no longer in version ${latest.number}; untick them`);
    const nd = c.rows.filter((r) => keys.has(r.section_key));
    if (!rows.length && !nd.length) return fail(422, "nothing is staged for the next draft");
    const locked = new Set(ctx.lockedKeys(latest));
    const touched = new Set([...rows.map((r) => r.section_key ?? ""), ...nd.map((r) => r.section_key)]);
    const hit = latest.sections.filter((s) => locked.has(s.section_key) && touched.has(s.section_key));
    if (hit.length)
      return fail(
        409,
        `approved and locked, never changed: ${hit.map((s) => `${s.heading} (${s.section_key})`).join(", ")}; untick them`,
      );
    const job = makeJob(doc, latest, { suggestion_ids: rows.map((r) => r.id), next_draft_change_ids: nd.map((r) => r.id) });
    ctx.db.jobs.push(job);
    return json(201, job);
  }

  const job = ctx.db.jobs.find((j) => j.id === p[4] && j.document_id === doc.id && j.kind === KIND);
  if (!job) return fail(404, "next-draft build not found");
  const out = job.output as BatchOutput | null;
  if (!p[5] && m === "GET") return json(200, preview(ctx, job));

  if (p[5] === "discard" && m === "POST") {
    if (out?.applied_version) return fail(409, `already applied as version ${out.applied_version}`);
    if (job.status === "cancelled" || out?.discarded_at) return fail(409, "this next draft was already discarded");
    if (["queued", "running"].includes(job.status)) Object.assign(job, { status: "cancelled", finished_at: ctx.now() });
    else job.output = { ...(out ?? {}), discarded_at: ctx.now() };
    return json(200, job);
  }

  if (p[5] === "apply" && m === "POST") {
    if (out?.discarded_at) return fail(409, "this next draft was discarded; build it again");
    if (out?.applied_version) return fail(409, `already applied as version ${out.applied_version}`);
    if (job.status !== "succeeded" || !out) return fail(409, "only a finished next-draft build can be applied");
    const vs = versionsOf(ctx, doc.id);
    const base = vs.find((v) => v.number === out.base_version);
    if (!base || vs.at(-1)!.number !== base.number)
      return fail(409, "a newer version exists since this draft was built; build it again");
    const input = (await body<Schemas["NextDraftApply"]>()) ?? {};
    const drop = new Set(input.drop_sections ?? []);
    const edits = input.edits ?? {};
    const built = new Map(out.sections.map((s) => [s.section_key, s]));
    const unknown = [...drop, ...Object.keys(edits)].filter((k) => !built.has(k));
    if (unknown.length) return fail(422, `not in this draft: ${unknown.join(", ")}`);
    const kept = out.sections.filter((s) => !drop.has(s.section_key));
    if (!kept.length) return fail(422, "keep at least one section, or discard the draft");
    if (Object.keys(edits).some((k) => drop.has(k))) return fail(422, "edits for dropped sections");
    const locked = new Set(ctx.lockedKeys(base));
    const hit = kept.filter((s) => locked.has(s.section_key));
    if (hit.length)
      return fail(
        409,
        `approved and locked since the build, never changed: ${hit.map((s) => `${s.before.heading} (${s.section_key})`).join(", ")}`,
      );
    const replace: Record<string, { heading: string; body: string }> = {};
    for (const s of kept) replace[s.section_key] = { heading: s.heading, body: strip(edits[s.section_key] ?? s.body_md) };
    const used = ctx.db.suggestions.filter((s) => kept.some((k) => k.suggestion_ids.includes(s.id)) && s.status === "accepted");
    const live = new Set(used.map((s) => s.feedback_item_id));
    const resolutions = kept.flatMap((s) => s.resolutions).filter((r) => live.has(r.feedback_id));
    const next = ctx.importSections(doc, base, replace, resolutions);
    job.output = { ...out, applied_version: next.number, dropped_sections: [...drop] };
    for (const s of ctx.db.suggestions) {
      const dupe =
        s.kind === "duplicate" &&
        used.some((u) => u.feedback_item_id === s.duplicate_of) &&
        ["open", "accepted"].includes(s.status);
      if (used.includes(s) || dupe)
        Object.assign(s, { status: "applied", applied_in_version: next.number, updated_at: ctx.now() });
    }
    // G4: the discussions' changes built into the kept sections are applied.
    const builtRows = new Set(kept.flatMap((k) => k.next_draft_change_ids ?? []));
    for (const r of ctx.db.next_draft_changes ?? [])
      if (builtRows.has(r.id) && r.status === "staged") Object.assign(r, { status: "applied", applied_in_version: next.number });
    hooks.onImported(doc, next);
    return json(201, { number: next.number, document_id: doc.id, id: next.id });
  }
  return fail(404, "Route not found");
}

// ------------------------------------------------------------------ inbox

type InboxItem = Schemas["InboxFeedbackItem"];

/** The Inbox's feedback by state, its counts and the staged rows, as GET /v1/inbox returns them. */
/** An Inbox row shows this much of a suggestion's text, as the API cuts it. */
const EXCERPT = 280;
const excerpt = (text: string | null | undefined) => (text == null ? null : text.length <= EXCERPT ? text : `${text.slice(0, EXCERPT)}…`);

export function inboxStates(ctx: LlmContext, seen: string | null) {
  const live = (id: string) =>
    ctx.db.suggestions.filter((s) => s.feedback_item_id === id && s.status !== "superseded").at(-1) ?? null;
  const counts = { new: 0, open: 0, staged: 0, declined: 0, done: 0 };
  const items: InboxItem[] = [];
  for (const f of ctx.feedback) {
    const doc = ctx.documents.find((d) => d.id === f.document_id);
    if (!doc) continue;
    const s = live(f.id);
    const latest = latestOf(ctx, doc.id)?.number ?? null;
    const { state: base, staged_for_version, staged_for_agents } = stateOf(f, s, latest);
    const state: InboxItem["state"] = base === "open" && (!seen || f.created_at > seen) ? "new" : base;
    const acting = shownSuggestion(f, s?.status === "open" ? s : null);
    counts[state] += 1;
    items.push({
      id: f.id,
      summary: f.summary,
      kind: f.kind,
      section_key: f.section_key ?? null,
      raised_on_version: f.raised_on_version,
      created_at: f.created_at,
      updated_at: f.updated_at,
      document_id: doc.id,
      slug: doc.slug,
      title: doc.title,
      latest_version: latest,
      state,
      resolution_note: shownNote(f, s),
      addressed_in_version: f.addressed_in_version ?? null,
      staged_for_version,
      staged_for_agents,
      suggestion_status: s?.status ?? null,
      suggestion_kind: s?.kind ?? null,
      // D14: what the row's actions need, while the suggestion is open.
      suggestion_id: acting?.id ?? null,
      suggestion_text: acting ? excerpt(acting.edited_text ?? acting.text) : null,
      suggestion_pushback: acting ? acting.pushback != null : null,
      suggestion_rationale: acting ? excerpt(acting.rationale) : null,
    });
  }
  items.sort((a, b) => b.created_at.localeCompare(a.created_at));
  const stagedRows: Schemas["InboxStaged"][] = ctx.documents.flatMap((doc) => {
    const rows = staged(ctx, doc.id);
    const agents = agentItems(ctx, doc.id).length;
    if (!rows.length && !agents) return [];
    const latest = latestOf(ctx, doc.id);
    const keys = new Set(latest?.sections.map((s) => s.section_key) ?? []);
    const buildable = rows.filter((s) => keys.has(s.section_key ?? "")).length;
    const count = buildable + agents;
    const job = currentJob(ctx, doc.id);
    return [
      {
        document_id: doc.id,
        slug: doc.slug,
        title: doc.title,
        latest_version: latest?.number ?? null,
        next_version: (latest?.number ?? 0) + 1,
        count,
        gone_count: rows.length - buildable,
        draft_job_id: job?.id ?? null,
        draft_job_status: job?.status ?? null,
      },
    ];
  });
  return { items, counts, staged: stagedRows, needs_me: counts.new + counts.open };
}
