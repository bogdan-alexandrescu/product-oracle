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
import { reopenDraftOnly, type SimpleDb } from "./simple-roadmap";

type Role = Schemas["Me"]["role"];
type TrashItem = Schemas["TrashItem"];
type RunOut = Schemas["RunOut"];
type Intake = Schemas["ProductIntakeOut"];

export interface TrashDocument {
  id: string;
  slug: string;
  title: string;
  kind: string;
  company_roadmap?: boolean;
}

export interface TrashVersion {
  id: string;
  document_id: string;
  number: number;
  created_at: string;
  approved_at?: string | null;
  source?: { document_id: string; version?: number } | null;
}

/** One delete and the rows it took (put back as they were on Restore). */
export interface TrashEntryRow {
  out: Omit<Schemas["TrashEntryOut"], "days_left" | "not_restored" | "can_restore">;
  documents: unknown[];
  versions: unknown[];
  runs: RunOut[];
  intakes: Intake[];
  /** What the delete released (New PRD 4: the requests linked to its PRDs), for Restore. */
  released?: unknown;
  /** trash-features-goals: a feature's roadmap (slug), so Restore and the purge touch only its rows. */
  roadmap?: string;
  /** trash-features-goals: a goal deleted with features moved to another goal: their goal_ids
   * as they were (trash_items' `links`), put back on Restore. */
  goal_links?: { id: string; goal_ids: string[]; left?: string[] }[];
  /** goal-delete-dated: the items whose own goal it was, their goals as they were (trash_items' `goal_ids`). */
  item_goals?: { key: string; roadmap?: string; goals: string[]; from: string; to: string }[];
  /** port-an-decisions: a removed agenda item's meeting, row and place, put back on Restore. */
  agenda?: { meeting_id: string; row: unknown; at: number };
  /** port-an-decisions: a deleted request's row, put back on Restore. */
  request?: unknown;
  /** feature-panel: a dropped task's status before the drop, put back on Restore (root status_before). */
  task_status?: string;
}

export interface TrashDb {
  entries: TrashEntryRow[];
  /** run id -> the document a regeneration estimate is for. */
  estimates: Record<string, { slug: string; flow: string; note: string | null }>;
  /** home-deleted-roadmap: the document kinds purged from Trash (the API reads its audit log). */
  purged?: string[];
  /** home-deleted-roadmap: when each kind was last purged (the audit event's time). */
  purged_at?: Record<string, string>;
}

export interface TrashContext<D extends TrashDocument, V extends TrashVersion> {
  db: TrashDb;
  documents: D[];
  versions: V[];
  runs: () => RunOut[];
  intakes: () => Intake[];
  /** The spec requests: a tech brief's link to its PRD (its versions name no source). */
  specRequests: () => { source_document_id: string; document_slug?: string | null }[];
  me: { id: string; email: string; name?: string | null; role: Role };
  /** port-an-decisions: Restore of a meeting's agenda item or a request puts it back; the refusal's
   * words when it cannot (409: its meeting has ended), else null. */
  restoreRoot?: (entry: TrashEntryRow) => string | null;
  /** every-field: the refusal's words when Restore would give an item a code another item took meanwhile (409), else null. */
  refuseRestore?: (entry: TrashEntryRow) => string | null;
  /** The document's designated decider (its review policy), who regenerates it whatever their role. */
  deciderOf?: (documentId: string) => string | null;
  /** New PRD (4): moving these documents to Trash releases what links to them; the result is kept for Restore. */
  onTrash?: (documentIds: string[]) => unknown;
  /** Restore: link back what onTrash released (after the rows are back). */
  onRestore?: (released: unknown) => void;
  /** trash-features-goals: Restore of a roadmap feature or a goal (kept in place, marked `trashed`). */
  simple?: () => TrashedSimple | undefined;
  /** delete-prd-simple: the roadmap items and tracks these PRDs feed, as what stays and what goes with the
   * documents of the delete (`gone`, their slugs): the dependents' `feeds` and `feeds_going`. */
  feeds?: (prdSlugs: string[], gone: string[]) => { stays: TrashItem[]; goes: TrashItem[] };
  /** prd-reads-working-draft: which company roadmap a PRD's run reads (./roadmap-read.ts). */
  roadmapRead?: (me: { id: string; role: Role }) => string | null;
  uuid: () => string;
  now: () => string;
}

export const emptyTrash = (): TrashDb => ({ entries: [], estimates: {} });

/** Deletes an entry for good, noting the kinds of documents it held (as trash.purge's audit event).
 * trash-features-goals: a feature's or a goal's rows go too (trash_items.before_purge): the items
 * that depended on the feature drop its key, and the features drop the goal. */
function purge(db: TrashDb, entry: TrashEntryRow, now: string, simple?: TrashedSimple) {
  db.entries = db.entries.filter((e) => e !== entry);
  const root = entry.out.root;
  if (simple && root.type === "feature") {
    const ours = (s: TrashedSimple["items"][number]) => s.key === root.slug && (!entry.roadmap || s.roadmap === entry.roadmap);
    const gone = simple.items.filter((s) => ours(s) && s.trashed);
    simple.items.splice(0, simple.items.length, ...simple.items.filter((s) => !gone.includes(s)));
    for (const s of simple.items) {
      if ((!entry.roadmap || s.roadmap === entry.roadmap) && s.depends?.includes(root.slug!)) s.depends = s.depends.filter((k) => k !== root.slug);
    }
    for (const gm of simple.goal_milestones ?? []) {
      if ((!entry.roadmap || gm.roadmap === entry.roadmap) && gm.gates.includes(root.slug!)) gm.gates = gm.gates.filter((k) => k !== root.slug);
    }
  }
  if (simple?.goal_buckets && root.type === "goal") {
    const gb = simple.goal_buckets;
    gb.goals.splice(0, gb.goals.length, ...gb.goals.filter((g) => !(g.id === root.id && g.trashed)));
    for (const f of gb.features ?? []) f.goal_ids = f.goal_ids.filter((g) => g !== root.id);
  }
  const kinds = (entry.documents as { kind?: string }[]).flatMap((d) => (d.kind ? [d.kind] : []));
  db.purged = [...new Set([...(db.purged ?? []), ...kinds])];
  // home-deleted-roadmap: when each kind was last purged (the audit event's time).
  db.purged_at = { ...db.purged_at, ...Object.fromEntries(kinds.map((k) => [k, now])) };
}

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

/** What goes to Trash with a document: the documents built from its versions and its spec
 * requests' tech briefs, transitively (never the company roadmap or a roadmap another PRD
 * feeds), and the runs that write any of them. */
function resolve<D extends TrashDocument, V extends TrashVersion>(ctx: TrashContext<D, V>, tops: D[]) {
  const docs = [...tops];
  const seen = new Set(tops.map((d) => d.id));
  let frontier = new Set(seen);
  while (frontier.size) {
    const next = new Set<string>();
    for (const v of ctx.versions) {
      if (v.source && frontier.has(v.source.document_id) && !seen.has(v.document_id)) next.add(v.document_id);
    }
    for (const r of ctx.specRequests()) {
      const brief = frontier.has(r.source_document_id) ? ctx.documents.find((d) => d.slug === r.document_slug) : undefined;
      if (brief && !seen.has(brief.id)) next.add(brief.id);
    }
    // delete-prd-simple (trash.service._not_shared): never the company roadmap, nor a roadmap
    // another PRD outside the delete feeds; the delete's own items on it stay, without it.
    const inside = new Set([...seen, ...next]);
    for (const id of next) {
      const d = ctx.documents.find((x) => x.id === id);
      const fedByOther = ctx.versions.some((v) => v.document_id === id && v.source && !inside.has(v.source.document_id));
      if (d?.company_roadmap || fedByOther) next.delete(id);
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

/** As oracle.trash.service._actor_name: the person's name, else their email. */
export const trashName = (me: { email: string; name?: string | null }): string => me.name || me.email;

export const entryOut = (e: TrashEntryRow, now: string, canRestore = false): Schemas["TrashEntryOut"] => ({
  ...e.out,
  days_left: daysLeft(e, now),
  not_restored: [],
  can_restore: canRestore,
});

/** As oracle.trash.service.may_restore (owner's answer, Nov 5): an owner restores anything;
 * whoever deleted a feature, a goal, a decision, a question or a meeting's agenda item restores it too. */
export function mayRestore(entry: TrashEntryRow, me: { id: string; role: string }): boolean {
  if (me.role === "owner") return true;
  return entry.out.deleted_by === me.id && ["feature", "goal", "decision", "question", "agenda_item", "milestone", "task"].includes(entry.out.root.type);
}

/** trash-features-goals: the Simple rows a feature's or a goal's entry marks `trashed`; the mock
 * db is kept as JSON, so Restore finds them by the entry's root, never through a closure. */
export type TrashedSimple = {
  items: { key: string; roadmap?: string; depends?: string[]; trashed?: boolean }[];
  goal_buckets?: { goals: { id: string; trashed?: boolean }[]; features?: { id: string; goal_ids: string[] }[] };
  /** build-milestones-on-roadmap: each roadmap's goal milestones, their gates the item keys they wait on. */
  goal_milestones?: { roadmap: string; gates: string[] }[];
  /** trash-features-goals review 4: the roadmaps' versions, each with the features it was made without. */
  versions?: { roadmap: string; without: string[] }[];
  /** edit-decisions: Simple's decisions and the PRD's questions (a question's `id` is set when it is trashed). */
  sheet?: { id?: string; trashed?: boolean }[];
  /** goal-map-editing: the Goal map's milestones (`trashed` while in Trash). */
  goal_map?: { milestones: { id: string; trashed?: boolean }[] };
  /** feature-panel: the non-versioned targets, a dropped task among them (trash._task_back). */
  targets?: Record<string, Record<string, unknown>>;
};

/** trash-features-goals: takes `entry` out of Trash, putting back the feature or the goal it
 * holds; the generic `/v1/trash/{id}/restore` and the type's own restore route both end here.
 * `by` is the person restoring: a draft opened for the feature is theirs, as in the API. */
export function restoreFromTrash(db: TrashDb, entry: TrashEntryRow, now: string, simple?: TrashedSimple, by?: string): Schemas["TrashEntryOut"] {
  const root = entry.out.root;
  // Only that roadmap's rows of the key (another roadmap may use the same key).
  // trash_items._reopened: its draft approved while it was in Trash, it goes to an open one.
  if (root.type === "feature" && simple && "ids" in simple) {
    const rm = entry.roadmap ?? simple.items.find((s) => s.key === root.slug)?.roadmap;
    if (root.slug && rm) reopenDraftOnly(simple as SimpleDb, root.slug, rm, by ?? entry.out.deleted_by ?? "");
  }
  if (root.type === "feature") simple?.items.filter((s) => s.key === root.slug && (!entry.roadmap || s.roadmap === entry.roadmap)).forEach((s) => (s.trashed = false));
  if (root.type === "goal") simple?.goal_buckets?.goals.filter((g) => g.id === root.id).forEach((g) => (g.trashed = false));
  // trash_items._parent_back: a restored part stays under its parent while that parent is on the
  // roadmap and open; else (in Trash, merged) or when going back under it would close a loop, it
  // is a feature of its own.
  if (root.type === "feature" && simple && "ids" in simple)
    for (const me of (simple as SimpleDb).items.filter((s) => s.key === root.slug && !s.trashed && s.parent)) {
      const live = (k: string) => (simple as SimpleDb).items.find((y) => y.key === k && !y.trashed && y.roadmap === me.roadmap);
      const parent = live(me.parent!);
      const seen = new Set([me.parent!]);
      let up = parent?.parent;
      while (up && !seen.has(up) && up !== me.key) {
        seen.add(up);
        up = live(up)?.parent;
      }
      if (!parent || parent.merged_into || up === me.key) me.parent = undefined;
    }
  // trash_items._onto_current: back on every version published while it was in Trash.
  if (root.type === "feature")
    for (const v of simple?.versions ?? []) if (!entry.roadmap || v.roadmap === entry.roadmap) v.without = v.without.filter((k) => k !== root.slug);
  // trash_items.after_restore: the features a delete moved get their goals back exactly; one
  // whose goals changed since (moved to another goal) keeps them.
  for (const l of entry.goal_links ?? []) {
    const f = simple?.goal_buckets?.features?.find((x) => x.id === l.id);
    const left = new Set(l.left ?? f?.goal_ids ?? []);
    if (f && f.goal_ids.length === left.size && f.goal_ids.every((g) => left.has(g))) f.goal_ids = [...l.goal_ids];
  }
  // The goal goes back where it was on each item the delete moved; the goal it moved them to comes
  // off only where the delete added it (its own goal, the item's goal_ids in the API).
  for (const w of entry.item_goals ?? []) {
    const s = (simple as SimpleDb | undefined)?.items.find((x) => x.key === w.key && x.roadmap === w.roadmap);
    if (!s) continue;
    let now = [...(s.goal ? [s.goal] : []), ...(s.goals ?? [])].filter((k) => k !== w.from);
    if (!w.goals.includes(w.to) && now[0] === w.to) now = now.slice(1);
    const at = Math.max(0, w.goals.indexOf(w.from));
    const next = [...now.slice(0, at), w.from, ...now.slice(at)];
    s.goal = next[0];
    s.goals = next.slice(1);
  }
  if (root.type === "decision" || root.type === "question") simple?.sheet?.filter((r) => r.id === root.id).forEach((r) => (r.trashed = false));
  if (root.type === "milestone") simple?.goal_map?.milestones.filter((m) => m.id === root.id).forEach((m) => (m.trashed = false));
  // trash._task_back: a dropped task goes back to the status it had.
  const task = root.type === "task" ? simple?.targets?.[root.id] : undefined;
  if (task && task.status === "dropped") task.status = entry.task_status ?? "todo";
  // trash._task_feature_in_trash: its feature still in Trash, the answer says it shows when that is restored.
  const ids = simple && "ids" in simple ? (simple as SimpleDb).ids : {};
  const key = task ? Object.keys(ids).find((k) => ids[k] === task.item_id) : undefined;
  const held = key ? db.entries.find((e) => e.out.root.type === "feature" && e.out.root.slug === key) : undefined;
  db.entries = db.entries.filter((e) => e !== entry);
  const out = entryOut(entry, now);
  if (!held) return out;
  const f = held.out.root;
  return { ...out, not_restored: [{ item: f, reason: `it shows when ${f.code ? `${f.code} ${f.title}` : f.title} is restored` }] };
}

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
  // The purge the ticker does, on every request routed here (Home's included), not only Trash's:
  // entries past their 30 days are gone.
  for (const e of ctx.db.entries) if (daysLeft(e, now) <= 0) purge(ctx.db, e, now, ctx.simple?.());

  if (p[1] === "trash") {
    // Trash's list and Restore: commenters and up, each entry checked (mayRestore); purge: owners.
    if (!atLeast(ctx.me.role, "commenter")) return json(403, { detail: "Requires the commenter role" });
    if (m === "GET" && !p[2]) {
      const mine = ctx.db.entries.filter((e) => owner || mayRestore(e, ctx.me));
      return json(200, mine.map((e) => entryOut(e, now, mayRestore(e, ctx.me))).reverse());
    }
    const entry = ctx.db.entries.find((e) => e.out.id === p[2]);
    if (!entry) return json(404, { detail: "Not in Trash" });
    if (m === "POST" && p[3] === "restore") {
      if (!mayRestore(entry, ctx.me)) return json(403, { detail: "Only an owner, or whoever deleted it, restores this" });
      const refused = entry.agenda || entry.request !== undefined ? (ctx.restoreRoot?.(entry) ?? null) : (ctx.refuseRestore?.(entry) ?? null);
      if (refused) return json(409, { detail: refused });
      return json(200, restore(ctx, entry, now));
    }
    if (!owner) return ownerOnly;
    if (m === "DELETE" && !p[3]) {
      purge(ctx.db, entry, now, ctx.simple?.());
      return json(204, undefined);
    }
    return null;
  }

  const kinds: Record<string, TrashItem["type"]> = { documents: "document", intakes: "intake", runs: "run" };
  const type = kinds[p[1]];
  if (!type || !p[2]) return null;
  const leaf = p.slice(3).join("/");

  if (type === "document" && m === "POST" && (leaf === "regenerate/estimate" || leaf === "regenerate")) {
    const doc = ctx.documents.find((d) => d.slug === p[2] || d.id === p[2]);
    if (!doc) return json(404, { detail: `document '${p[2]}' not found` });
    // As oracle.trash.regenerate: the document's decider (whatever their role) or any approver.
    if (!atLeast(ctx.me.role, "approver") && ctx.deciderOf?.(doc.id) !== ctx.me.id) {
      return json(403, { detail: "Only the document's decider or an approver can regenerate it" });
    }
    const flow = FLOWS[doc.kind];
    if (!flow) return json(422, { detail: `no flow regenerates a ${doc.kind}: edit it instead` });
    const body = (JSON.parse((await req.text()) || "{}") ?? {}) as { note?: string | null; run_id?: string };
    if (leaf === "regenerate/estimate") {
      const runId = ctx.uuid();
      ctx.db.estimates[runId] = { slug: doc.slug, flow, note: body.note ?? null };
      // qa4-docs-23, as oracle.trash.regenerate.estimate: titles and version numbers, never a slug.
      const latest = latestVersion(ctx, doc);
      const inputs = [`${doc.title}, latest version${latest ? ` (v${latest.number})` : ""}`];
      const source = latest?.source;
      const prd = source ? ctx.documents.find((d) => d.id === source.document_id) : undefined;
      if (prd) inputs.push(`${prd.title}, approved version${source?.version != null ? ` (v${source.version})` : ""}`);
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
      // prd-reads-working-draft: a PRD's run follows the company roadmap of record.
      roadmap_read: doc.kind === "prd" ? (ctx.roadmapRead?.(ctx.me) ?? null) : null,
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
  // qa4-docs-26, F-69, as oracle.trash.service._said: a run says when it ran and what it wrote,
  // in the delete dialog and in Trash.
  const said = items.map((i) => {
    const r = i.type === "run" ? runs.find((x) => x.id === i.id) : undefined;
    return r ? { ...i, created_at: r.created_at, wrote: docs.find((d) => d.slug === r.document_slug)?.title ?? null } : i;
  });
  if (isDependents) {
    const prds = docs.filter((d) => d.kind === "prd").map((d) => d.slug);
    const fed = prds.length && ctx.feeds ? ctx.feeds(prds, docs.map((d) => d.slug)) : { stays: [], goes: [] };
    const out: Schemas["DependentsOut"] = { root, items: said, published, working_runs: working.map((r) => r.id), feeds: fed.stays, feeds_going: fed.goes };
    return json(200, out);
  }
  if (working.length) return json(409, { detail: `A run is still working on this (${working[0].flow}, ${working[0].status}): cancel it first` });
  if (published && q.get("confirm_published") !== "true") return json(409, { detail: PUBLISHED_WARNING });

  const ids = new Set(docs.map((d) => d.id));
  const runIds = new Set(runs.map((r) => r.id));
  const intakeIds = new Set(intakes.map((i) => i.id));
  const entry: TrashEntryRow = {
    out: {
      id: ctx.uuid(), root, items: said, deleted_by: ctx.me.id, deleted_by_name: trashName(ctx.me), deleted_at: now,
      reason: q.get("reason"), published,
      purge_after: new Date(new Date(now).getTime() + RETENTION_DAYS * DAY_MS).toISOString(),
    },
    documents: take(ctx.documents, (d) => !ids.has(d.id)),
    versions: take(ctx.versions, (v) => !ids.has(v.document_id)),
    runs: take(ctx.runs(), (r) => !runIds.has(r.id)),
    intakes: take(ctx.intakes(), (i) => !intakeIds.has(i.id)),
    released: ctx.onTrash?.([...ids]),
  };
  ctx.db.entries.push(entry);
  return json(200, entryOut(entry, now, true));
}

function latestVersion<D extends TrashDocument, V extends TrashVersion>(ctx: TrashContext<D, V>, doc: D): V | undefined {
  return ctx.versions.filter((v) => v.document_id === doc.id).sort((a, b) => b.number - a.number)[0];
}

function restore<D extends TrashDocument, V extends TrashVersion>(ctx: TrashContext<D, V>, entry: TrashEntryRow, now: string) {
  ctx.documents.push(...(entry.documents as D[]));
  ctx.versions.push(...(entry.versions as V[]));
  ctx.runs().push(...entry.runs);
  ctx.intakes().push(...entry.intakes);
  const out = restoreFromTrash(ctx.db, entry, now, ctx.simple?.(), ctx.me.id);
  if (entry.released !== undefined) ctx.onRestore?.(entry.released);
  return out;
}
