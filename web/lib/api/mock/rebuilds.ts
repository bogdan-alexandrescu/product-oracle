import type { Schemas } from "../client";
import { FLOW_CATALOG, importsDraft } from "./runs";
import { canSee } from "./updates";

/**
 * GET /v1/rebuilds, as the API's oracle.runs.rebuilds: the runs that will make a new version
 * of a document the member may read, as the rebuild sign says them.
 */

type RunOut = Schemas["RunOut"];
type Rebuild = Schemas["Rebuild"];

export interface RebuildsInput {
  runs: RunOut[];
  documents: { id: string; slug: string; title: string; kind: string; company_roadmap?: boolean; visibility?: Schemas["DocumentOut"]["visibility"] }[];
  /** The reader's role: an `approvers` document is hidden from a commenter or a viewer. */
  role: Schemas["Me"]["role"];
  /** The document's versions: number and whether approved. */
  versions: (documentId: string) => { number: number; approved: boolean }[];
  /** A member's name (else email) by id. */
  name: (userId: string | null) => string | null;
  /** Who decides the document's stops (the API's ask_decider): the first owner. */
  decider: string | null;
  now: Date;
}

const FAILED_DAYS = 7;
const STATES: Partial<Record<RunOut["status"], Rebuild["state"]>> = {
  draft: "scheduled",
  awaiting_approval: "scheduled",
  running: "running",
  awaiting_checkpoint: "waiting",
  paused_overrun: "waiting",
  failed: "failed",
  succeeded: "done",
};
/** The API's CHECKPOINT_TITLES and STOP_ACTIONS. */
const STOP_TITLES: Record<string, string> = {
  baseline_confirm: "Baseline",
  feature_set: "Feature set",
  priority_order: "Priority order",
  prd_review: "PRD review",
  eng_review: "Engineering review",
  roadmap_items: "Roadmap items",
  roadmap_review: "Roadmap review",
};
const STOP_ACTIONS: Record<string, string> = {
  baseline_confirm: "confirm the baseline",
  feature_set: "approve the feature set",
  eng_review: "check the engineering review",
  eng_dates: "set the engineering dates",
  priority_order: "approve the priority order",
  prd_review: "review the new draft",
  roadmap_items: "approve the roadmap items",
  roadmap_review: "review the new roadmap",
};
/** The API's _writes_document: a flow with a segment whose draft Oracle imports. */
const WRITES_DOCUMENT = FLOW_CATALOG.flows.filter((f) => f.segments.some((g) => importsDraft(g.outputs))).map((f) => f.key);

export function rebuildsOut(input: RebuildsInput): Schemas["RebuildsOut"] {
  // As the API: only the documents the reader may see.
  const visible = input.documents.filter((d) => canSee(input.role, d.visibility));
  const docs = new Map(visible.map((d) => [d.slug, d]));
  const rows = input.runs.filter((r) => r.document_slug && STATES[r.status] && WRITES_DOCUMENT.includes(r.flow) && docs.has(r.document_slug));
  const newest = new Map<string, string>();
  for (const r of rows) if ((newest.get(r.document_slug!) ?? "") < r.created_at) newest.set(r.document_slug!, r.created_at);
  const out: Rebuild[] = [];
  for (const r of rows) {
    const doc = docs.get(r.document_slug!)!;
    const state = STATES[r.status]!;
    const vs = input.versions(doc.id);
    const latest = vs.length ? Math.max(...vs.map((v) => v.number)) : null;
    const approvedNs = vs.filter((v) => v.approved).map((v) => v.number);
    const approved = approvedNs.length ? Math.max(...approvedNs) : null;
    const segs = r.segments.filter((s) => s.status !== "skipped");
    const madeNs = segs.flatMap((s) => (s.draft_import && !s.draft_import.error && s.draft_import.version != null ? [s.draft_import.version] : []));
    const made = state === "done" && madeNs.length ? Math.max(...madeNs) : null;
    if (state === "done" && (made == null || made !== latest || approved === latest)) continue;
    if (state === "failed" && (r.created_at < newest.get(r.document_slug!)! || +new Date(r.finished_at ?? r.created_at) < +input.now - FAILED_DAYS * 864e5)) continue;
    let current = state === "failed" ? segs.findIndex((s) => s.status === "failed") : -1;
    if (current < 0) current = segs.findIndex((s) => s.status === "running");
    if (current < 0) current = segs.findIndex((s) => s.status === "pending");
    if (state === "waiting") {
      const done = segs.map((s, i) => (s.status === "succeeded" ? i : -1)).filter((i) => i >= 0);
      current = done.length ? done[done.length - 1] : 0;
    }
    if (current < 0) current = Math.max(segs.length - 1, 0);
    const stop = segs.slice(current).find((s) => s.checkpoint && s.checkpoint_on)?.checkpoint ?? null;
    const waiting = r.checkpoints.find((c) => c.status === "pending")?.kind ?? null;
    const ahead = state === "running" || state === "scheduled";
    out.push({
      run_id: r.id,
      flow: r.flow,
      flow_title: r.flow_title,
      document_slug: doc.slug,
      document_title: doc.title,
      document_kind: doc.kind as Rebuild["document_kind"],
      source_slug: r.flow === "prd_to_roadmap" && r.source && docs.has(r.source.slug) ? r.source.slug : null,
      state,
      steps: segs.map((s) => s.title),
      step: state === "done" ? segs.length : Math.min(current + 1, Math.max(segs.length, 1)),
      from_version: approved,
      to_version: made ?? (latest ?? 0) + 1,
      started_by: input.name(r.created_by ?? null),
      started_at: r.started_at ?? null,
      scheduled_for: state === "scheduled" && typeof (r.knobs as { start_at?: unknown }).start_at === "string" ? ((r.knobs as { start_at?: string }).start_at ?? null) : null,
      // The mock keeps no history of how long steps took: its runs say it on their knobs.
      minutes_left: state === "running" ? ((r.knobs as { minutes_left?: number }).minutes_left ?? null) : null,
      next_stop: stop ? (STOP_TITLES[stop] ?? stop) : null,
      next_stop_who: stop && ahead ? input.decider : null,
      next_stop_action: ahead ? (STOP_ACTIONS[stop ?? ""] ?? null) : null,
      waits_on: state === "waiting" ? input.decider : null,
      waits_on_action: state === "waiting" ? (waiting ? (STOP_ACTIONS[waiting] ?? `decide the ${(STOP_TITLES[waiting] ?? waiting).toLowerCase()}`) : "approve the extra spend") : null,
      review_link: r.review_link ?? null,
      error: state === "failed" ? (r.error ?? null) : null,
    });
  }
  const roadmap = visible.find((d) => d.company_roadmap);
  return {
    rebuilds: out,
    company_roadmap: roadmap ? { slug: roadmap.slug, title: roadmap.title, prds: visible.filter((d) => d.kind === "prd").length } : null,
  };
}
