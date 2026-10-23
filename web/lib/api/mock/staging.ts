/**
 * Mock of G4 One staging list for NEXT_PUBLIC_API_MOCKS=1: GET /v1/staging over the mock's
 * C1e suggestions, discussions' next-draft rows (./next-draft.ts) and D8's checkpoint draft
 * actions (./runs.ts), and POST /v1/next-draft-changes/{id}/unstage.
 *
 * As oracle.staging.service: a row from a private discussion the caller is not in names no
 * discussion; `from_private` is how it was staged.
 */
import type { Schemas } from "@/lib/api/client";

import type { DraftRow } from "./runs";
import type { LlmContext } from "./llm-jobs";
import { originLine, stagedChanges } from "./next-draft";

type Item = Schemas["StagingItem"];
type Role = Schemas["Me"]["role"];
type Checkpoint = Schemas["CheckpointOut"];

export type StagingContext = {
  llm: LlmContext;
  role: Role;
  checkpoint: (id: string) => Checkpoint | null;
  draft: (checkpointId: string) => DraftRow | null;
};

const RANK: Role[] = ["viewer", "commenter", "approver", "owner"];
const atLeast = (role: Role, min: string) => RANK.indexOf(role) >= RANK.indexOf(min as Role);
const WORDS: Record<string, string> = { roadmap_items: "Roadmap items", feature_set: "Feature set", prd_review: "PRD review" };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const fail = (status: number, detail: string) => json(status, { detail });

/** As oracle.staging.mapping: a D8 action as the G1 kind and sentence it reads as. */
function mapped(a: { item_key: string; kind: string; field?: string | null; value?: unknown }): { kind: string; label: string } {
  if (a.kind === "edit" && a.field === "horizon") {
    const h = String(a.value);
    return { kind: "item_horizon", label: `Move ${a.item_key} to ${h.charAt(0).toUpperCase()}${h.slice(1)}` };
  }
  if (a.kind === "edit" && a.field === "outcome") return { kind: "item_outcome", label: `Change ${a.item_key}'s outcome to ${String(a.value)}` };
  if (a.kind === "edit" && a.field === "milestone_date") return { kind: "item_date_remove", label: `Remove ${a.item_key}'s date` };
  if (a.kind === "edit" && a.field) return { kind: "edit", label: `Change ${a.item_key}'s ${a.field}` };
  if (a.kind === "drop") return { kind: "item_drop", label: `Drop ${a.item_key}` };
  if (a.kind === "split" || a.kind === "merge") return { kind: `item_${a.kind}`, label: `${a.kind === "split" ? "Split" : "Merge"} ${a.item_key}` };
  const k = a.kind.replace("_", " ");
  return { kind: a.kind, label: `${k.charAt(0).toUpperCase()}${k.slice(1)} ${a.item_key}` };
}

/** A next-draft row's discussion as the caller sees it now. */
function discussionOf(ctx: StagingContext, rowId: string): Schemas["StagingDiscussion"] | null {
  const row = (ctx.llm.db.next_draft_changes ?? []).find((r) => r.id === rowId);
  return row?.discussion_id ? (ctx.llm.discussion?.(row.discussion_id) ?? { id: null, title: null, private: row.from_private }) : null;
}

function documentList(ctx: StagingContext, slug: string): Response {
  const doc = ctx.llm.documents.find((d) => d.slug === slug || d.id === slug);
  if (!doc) return fail(404, `Document '${slug}' not found`);
  const staged = stagedChanges(ctx.llm, doc, true);
  const items: Item[] = staged.items.map((c) => ({
    id: c.suggestion_id,
    source: "suggestion",
    kind: "section_edit",
    label: `Change ${c.section_heading}: ${c.feedback_summary}`,
    section_key: c.section_key,
    payload: { section_key: c.section_key, text: c.text },
    state: "staged",
    origin: "review",
    from_private: false,
    at: c.accepted_at ?? null,
    section_gone: c.section_gone ?? false,
    section_locked: c.section_locked ?? false,
  }));
  for (const r of staged.next_draft_changes ?? []) {
    items.push({
      id: r.id,
      source: "next_draft_change",
      kind: "section_edit",
      label: `Change ${r.section_heading}: ${r.instruction}`,
      section_key: r.section_key,
      payload: { section_key: r.section_key, instruction: r.instruction },
      state: "staged",
      reason: r.reason ?? null,
      origin: "discussion",
      discussion: discussionOf(ctx, r.id),
      from_private: r.from_private ?? false,
      origin_line: r.origin_line,
      at: r.staged_at ?? null,
      section_gone: r.section_gone ?? false,
      section_locked: r.section_locked ?? false,
      lock_version: r.lock_version,
    });
  }
  return json(200, {
    target: { kind: "document", label: doc.title, document_id: doc.id, slug: doc.slug, next_version: staged.next_version },
    items,
    counts: { staged: items.length, suggested: 0 },
    revision: null,
    can_stage: atLeast(ctx.role, "approver"),
  });
}

function checkpointList(ctx: StagingContext, id: string): Response {
  const cp = ctx.checkpoint(id);
  if (!cp) return fail(404, `checkpoint ${id} not found`);
  const draft = ctx.draft(id);
  const items: Item[] = (draft?.actions ?? []).map((a) => {
    const { kind, label } = mapped(a);
    const view = a.discussion_id ? (ctx.llm.discussion?.(a.discussion_id) ?? null) : null;
    const fromDiscussion = a.origin === "discussion";
    return {
      id: a.id,
      source: "checkpoint_action",
      kind,
      label,
      item_key: a.item_key,
      payload: { item_key: a.item_key, field: a.field, value: a.value },
      state: a.state,
      reason: a.note ?? null,
      origin: fromDiscussion ? "discussion" : "row",
      discussion: fromDiscussion ? (view ?? { id: null, title: null, private: !!a.from_private }) : null,
      from_private: !!a.from_private,
      origin_line: fromDiscussion ? originLine(view) : null,
      at: a.updated_at,
      section_gone: false,
      section_locked: false,
    };
  });
  return json(200, {
    target: { kind: "checkpoint", label: WORDS[cp.kind] ?? cp.kind, run_id: cp.run_id, checkpoint_id: cp.id, checkpoint_kind: cp.kind },
    items,
    counts: { staged: items.filter((i) => i.state === "staged").length, suggested: items.filter((i) => i.state === "suggested").length },
    revision: draft?.revision ?? 0,
    can_stage: cp.status === "pending" && atLeast(ctx.role, cp.approver_role),
  });
}

/** Handles /v1/staging and /v1/next-draft-changes/{id}/unstage; null otherwise. */
export async function routeStaging(ctx: StagingContext, req: Request, p: string[], q: URLSearchParams): Promise<Response | null> {
  if (p[1] === "staging" && p.length === 2 && req.method === "GET") {
    const doc = q.get("document");
    const cp = q.get("checkpoint");
    if (!doc === !cp) return fail(422, "Name one target: document or checkpoint");
    return doc ? documentList(ctx, doc) : checkpointList(ctx, cp!);
  }
  if (p[1] === "next-draft-changes" && p[3] === "unstage" && req.method === "POST") {
    if (!atLeast(ctx.role, "approver")) return fail(403, "Requires the approver role");
    const row = (ctx.llm.db.next_draft_changes ?? []).find((r) => r.id === p[2]);
    if (!row) return fail(404, "Staged change not found");
    if (row.status === "applied") return fail(409, `Already in draft ${row.applied_in_version}`);
    if (row.status !== "staged") return fail(409, "This change is not staged");
    const { lock_version } = JSON.parse((await req.text()) || "{}") as { lock_version?: number };
    if (lock_version !== row.lock_version) return fail(409, "This change changed since you loaded it; look again");
    Object.assign(row, { status: "unstaged", lock_version: row.lock_version + 1 });
    return json(200, {
      id: row.id,
      document_id: row.document_id,
      section_key: row.section_key,
      raised_on_version: row.raised_on_version,
      instruction: row.instruction,
      text: row.text,
      reason: row.reason,
      status: row.status,
      applied_in_version: row.applied_in_version,
      from_private: row.from_private,
      lock_version: row.lock_version,
    });
  }
  return null;
}
