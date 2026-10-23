/**
 * Mock of Trash, delete/restore and Regenerate (#482) for NEXT_PUBLIC_API_MOCKS=1.
 * Mirrors api/oracle/trash: owners delete a document (with the documents built from it and
 * the runs that write them), an intake (with the PRD it became) or a run; Settings › Trash
 * lists one entry per delete with its days left; Restore brings the entry back together.
 * Approvers and owners regenerate a PRD, roadmap, tech brief or update: an estimate, then a
 * run whose result is the document's next version.
 *
 * A trashed row is moved out of its table into its entry, so every list, read, the Inbox
 * and Home leave it out without knowing about Trash.
 */
import type { Schemas } from "@/lib/api/client";

type Role = Schemas["Me"]["role"];
type TrashItem = Schemas["TrashItem"];
type RunOut = Schemas["RunOut"];
type Intake = Schemas["ProductIntakeOut"];

export interface TrashDocument {
  id: string;
  slug: string;
  title: string;
  kind: string;
}

export interface TrashVersion {
  id: string;
  document_id: string;
  number: number;
  created_at: string;
  approved_at?: string | null;
  source?: { document_id: string } | null;
}

/** One delete and the rows it took (put back as they were on Restore). */
export interface TrashEntryRow {
  out: Omit<Schemas["TrashEntryOut"], "days_left">;
  documents: unknown[];
  versions: unknown[];
  runs: RunOut[];
  intakes: Intake[];
}

export interface TrashDb {
  entries: TrashEntryRow[];
  /** run id -> the document a regeneration estimate is for. */
  estimates: Record<string, { slug: string; flow: string; note: string | null }>;
}

export interface TrashContext<D extends TrashDocument, V extends TrashVersion> {
  db: TrashDb;
  documents: D[];
  versions: V[];
  runs: () => RunOut[];
  intakes: () => Intake[];
  me: { id: string; email: string; role: Role };
  uuid: () => string;
  now: () => string;
}

export const emptyTrash = (): TrashDb => ({ entries: [], estimates: {} });

const RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;
const WORKING = ["awaiting_approval", "running", "awaiting_checkpoint", "paused_overrun"];
const FLOWS: Record<string, string> = { prd: "baseline_to_prd", roadmap: "prd_to_roadmap", spec: "prd_to_spec", update: "update_draft" };
export const PUBLISHED_WARNING =
  "This document is published. Deleting it moves it to Trash here only: the external copy (Notion, Google Docs, Slack) stays where it is. Confirm to delete it.";

const ROLE_ORDER: Role[] = ["viewer", "commenter", "approver", "owner"];
const atLeast = (role: Role, min: Role) => ROLE_ORDER.indexOf(role) >= ROLE_ORDER.indexOf(min);

function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { "content-type": "application/json" },
  });
}

const docItem = (d: TrashDocument): TrashItem => ({ type: "document", id: d.id, slug: d.slug, title: d.title, kind: d.kind });
const runItem = (r: RunOut): TrashItem => ({ type: "run", id: r.id, slug: null, title: r.flow_title ?? r.flow, kind: r.flow });
const intakeItem = (i: Intake): TrashItem => ({ type: "intake", id: i.id, slug: null, title: i.title, kind: "intake" });

/** What goes to Trash with a document: the documents built from its versions, transitively,
 * and the runs that write any of them. */
function resolve<D extends TrashDocument, V extends TrashVersion>(ctx: TrashContext<D, V>, tops: D[]) {
  const docs = [...tops];
  const seen = new Set(tops.map((d) => d.id));
  let frontier = new Set(seen);
  while (frontier.size) {
    const next = new Set<string>();
    for (const v of ctx.versions) {
      if (v.source && frontier.has(v.source.document_id) && !seen.has(v.document_id)) next.add(v.document_id);
    }
    for (const id of next) {
      seen.add(id);
      const d = ctx.documents.find((x) => x.id === id);
      if (d) docs.push(d);
    }
    frontier = next;
  }
  const slugs = new Set(docs.map((d) => d.slug));
  const runs = ctx.runs().filter((r) => r.document_slug != null && slugs.has(r.document_slug));
  return { docs, runs };
}

function daysLeft(entry: TrashEntryRow, now: string): number {
  const ms = new Date(entry.out.purge_after).getTime() - new Date(now).getTime();
  return Math.max(0, Math.ceil(ms / DAY_MS));
}

const entryOut = (e: TrashEntryRow, now: string): Schemas["TrashEntryOut"] => ({ ...e.out, days_left: daysLeft(e, now) });

function take<T>(rows: T[], keep: (row: T) => boolean): T[] {
  const taken = rows.filter((r) => !keep(r));
  const kept = rows.filter(keep);
  rows.splice(0, rows.length, ...kept);
  return taken;
}

export async function routeTrash<D extends TrashDocument, V extends TrashVersion>(
  ctx: TrashContext<D, V>,
  req: Request,
  p: string[],
  q: URLSearchParams,
): Promise<Response | null> {
  const m = req.method;
  const owner = atLeast(ctx.me.role, "owner");
  const ownerOnly = json(403, { detail: "Requires the owner role" });
  const now = ctx.now();
  // The purge the ticker does: entries past their 30 days are gone.
  ctx.db.entries = ctx.db.entries.filter((e) => daysLeft(e, now) > 0);

  if (p[1] === "trash") {
    if (!owner) return ownerOnly;
    if (m === "GET" && !p[2]) return json(200, ctx.db.entries.map((e) => entryOut(e, now)).reverse());
    const entry = ctx.db.entries.find((e) => e.out.id === p[2]);
    if (!entry) return json(404, { detail: "Not in Trash" });
    if (m === "POST" && p[3] === "restore") return json(200, restore(ctx, entry, now));
    if (m === "DELETE" && !p[3]) {
      ctx.db.entries = ctx.db.entries.filter((e) => e !== entry);
      return json(204, undefined);
    }
    return null;
  }

  const kinds: Record<string, TrashItem["type"]> = { documents: "document", intakes: "intake", runs: "run" };
  const type = kinds[p[1]];
  if (!type || !p[2]) return null;
  const leaf = p.slice(3).join("/");

  if (type === "document" && m === "POST" && (leaf === "regenerate/estimate" || leaf === "regenerate")) {
    if (!atLeast(ctx.me.role, "approver")) return json(403, { detail: "Requires the approver role" });
    const doc = ctx.documents.find((d) => d.slug === p[2] || d.id === p[2]);
    if (!doc) return json(404, { detail: "Document not found" });
    const flow = FLOWS[doc.kind];
    if (!flow) return json(422, { detail: `no flow regenerates a ${doc.kind}: edit it instead` });
    const body = (JSON.parse((await req.text()) || "{}") ?? {}) as { note?: string | null; run_id?: string };
    if (leaf === "regenerate/estimate") {
      const runId = ctx.uuid();
      ctx.db.estimates[runId] = { slug: doc.slug, flow, note: body.note ?? null };
      const inputs = [`${doc.title} (${doc.slug}), its latest version`];
      const source = latestVersion(ctx, doc)?.source;
      const prd = source ? ctx.documents.find((d) => d.id === source.document_id) : undefined;
      if (prd) inputs.push(`${prd.title} (${prd.slug}), its latest approved version`);
      const estimate = doc.kind === "prd" ? 18 : 6;
      const out: Schemas["RegenerateEstimateOut"] = {
        run_id: runId, document_slug: doc.slug, kind: doc.kind, flow, inputs, estimate_usd: estimate,
        approval_threshold_usd: 50, needs_owner_approval: estimate > 50, note: body.note ?? null,
      };
      return json(200, out);
    }
    const pending = body.run_id ? ctx.db.estimates[body.run_id] : undefined;
    if (!pending || pending.slug !== doc.slug) return json(404, { detail: `no regeneration of '${doc.slug}' with run ${body.run_id}` });
    delete ctx.db.estimates[body.run_id!];
    // The agents' result, imported as the next version: earlier versions stay in history.
    const latest = latestVersion(ctx, doc);
    if (latest) {
      ctx.versions.push({ ...structuredClone(latest), id: ctx.uuid(), number: latest.number + 1, created_at: now, approved_at: null });
    }
    const template = ctx.runs().find((r) => r.flow === flow) ?? ctx.runs()[0];
    const run = {
      ...structuredClone(template),
      id: body.run_id!, flow, status: "succeeded", document_slug: doc.slug, created_at: now, created_by: ctx.me.id,
    } as RunOut;
    ctx.runs().push(run);
    return json(200, run);
  }

  const isDelete = m === "DELETE" && !leaf;
  const isRestore = m === "POST" && leaf === "restore";
  const isDependents = m === "GET" && leaf === "dependents";
  if (!isDelete && !isRestore && !isDependents) return null;
  if (!owner) return ownerOnly;

  if (isRestore) {
    const entry = ctx.db.entries.find((e) => e.out.root.id === p[2] || e.out.root.slug === p[2] || e.out.items.some((i) => i.id === p[2] || i.slug === p[2]));
    if (!entry) return json(404, { detail: `${type} '${p[2]}' not found in Trash` });
    return json(200, restore(ctx, entry, now));
  }

  let root: TrashItem;
  let docs: D[] = [];
  let runs: RunOut[] = [];
  let intakes: Intake[] = [];
  if (type === "document") {
    const doc = ctx.documents.find((d) => d.slug === p[2] || d.id === p[2]);
    if (!doc) return json(404, { detail: "Document not found" });
    root = docItem(doc);
    ({ docs, runs } = resolve(ctx, [doc]));
  } else if (type === "intake") {
    const intake = ctx.intakes().find((i) => i.id === p[2]);
    if (!intake) return json(404, { detail: "Intake not found" });
    root = intakeItem(intake);
    intakes = [intake];
    const doc = intake.document_id ? ctx.documents.find((d) => d.id === intake.document_id) : undefined;
    if (doc) ({ docs, runs } = resolve(ctx, [doc]));
  } else {
    const run = ctx.runs().find((r) => r.id === p[2]);
    if (!run) return json(404, { detail: "Run not found" });
    root = runItem(run);
    runs = [run];
  }
  const items = [...docs.map(docItem), ...intakes.map(intakeItem), ...runs.map(runItem)].filter((i) => i.id !== root.id);
  const working = runs.filter((r) => WORKING.includes(r.status));
  // The mock has no publications: a document is "published" once a version is approved
  // and it is a PRD (enough for the second confirmation in the dialog).
  const published = docs.some((d) => d.kind === "prd" && ctx.versions.some((v) => v.document_id === d.id && v.approved_at));
  if (isDependents) {
    const out: Schemas["DependentsOut"] = { root, items, published, working_runs: working.map((r) => r.id) };
    return json(200, out);
  }
  if (working.length) return json(409, { detail: `A run is still working on this (${working[0].flow}, ${working[0].status}): cancel it first` });
  if (published && q.get("confirm_published") !== "true") return json(409, { detail: PUBLISHED_WARNING });

  const ids = new Set(docs.map((d) => d.id));
  const runIds = new Set(runs.map((r) => r.id));
  const intakeIds = new Set(intakes.map((i) => i.id));
  const entry: TrashEntryRow = {
    out: {
      id: ctx.uuid(), root, items, deleted_by: ctx.me.id, deleted_by_name: ctx.me.email, deleted_at: now,
      reason: q.get("reason"), published,
      purge_after: new Date(new Date(now).getTime() + RETENTION_DAYS * DAY_MS).toISOString(),
    },
    documents: take(ctx.documents, (d) => !ids.has(d.id)),
    versions: take(ctx.versions, (v) => !ids.has(v.document_id)),
    runs: take(ctx.runs(), (r) => !runIds.has(r.id)),
    intakes: take(ctx.intakes(), (i) => !intakeIds.has(i.id)),
  };
  ctx.db.entries.push(entry);
  return json(200, entryOut(entry, now));
}

function latestVersion<D extends TrashDocument, V extends TrashVersion>(ctx: TrashContext<D, V>, doc: D): V | undefined {
  return ctx.versions.filter((v) => v.document_id === doc.id).sort((a, b) => b.number - a.number)[0];
}

function restore<D extends TrashDocument, V extends TrashVersion>(ctx: TrashContext<D, V>, entry: TrashEntryRow, now: string) {
  ctx.documents.push(...(entry.documents as D[]));
  ctx.versions.push(...(entry.versions as V[]));
  ctx.runs().push(...entry.runs);
  ctx.intakes().push(...entry.intakes);
  ctx.db.entries = ctx.db.entries.filter((e) => e !== entry);
  return entryOut(entry, now);
}
