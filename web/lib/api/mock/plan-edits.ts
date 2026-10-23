/**
 * Mock of the roadmap change-set routes (api/oracle/roadmap/changeset.py, #346): Edit plan
 * opens a draft change set on the roadmap's approved version; its changes (add, move, defer,
 * cut with a reason, reorder) are replaced whole; Propose changes imports the next roadmap
 * version, with the base's items plus the changes and a Plan changes section, for the
 * document's decider. Approving that version (the documents mock's approve) makes it the
 * live plan: the Plan mock reads its items (planVersions).
 *
 * Simplified on purpose: the diff follows E3's statuses for the fields a change set moves
 * (horizon, a new or a cut item, a reorder), not every field. Reads need a viewer; writes
 * an approver, as in the API.
 */
import type { Schemas } from "@/lib/api/client";

type Role = "viewer" | "commenter" | "approver" | "owner";
type Horizon = "now" | "next" | "later";
type Change = Schemas["ChangeSetOut"]["changes"][number];
export type PlanEditItem = { key: string; title: string; horizon: Horizon; outcome?: string | null; feature_id?: string | null };

export interface ChangeSetRow {
  id: string;
  roadmap: string;
  base_version: number;
  status: Schemas["ChangeSetOut"]["status"];
  changes: Change[];
  proposed_version: number | null;
  lock_version: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface PlanEditsDb {
  sets: ChangeSetRow[];
  /** The items of each version a change set proposed, by roadmap slug and version number. */
  versions: Record<string, Record<number, PlanEditItem[]>>;
}

type Doc = { id: string; slug: string; title: string; kind?: string | null; status?: string; updated_at?: string };
type VersionLike = { id: string; document_id: string; number: number; approved_at?: string | null; created_at?: string; sections: { section_key: string; heading: string; level: number }[] };

export interface PlanEditsContext {
  userId: string;
  role: Role;
  documents: Doc[];
  versions: VersionLike[];
  uuid: () => string;
  now: () => string;
  /** The document's designated decider (the review policy), if named. */
  deciderOf: (documentId: string) => string | null;
  /** The approved version's items the Plan mock seeds (a roadmap whose items are not stored here). */
  seededItems: (slug: string, version: number) => PlanEditItem[] | null;
  /** The plan mock treats this roadmap version as approved although its row is not (seeded plans). */
  seededApproved: (slug: string) => number | null;
  /** A new version of `doc` copied from `base`, with a Plan changes section. */
  newVersion: (doc: Doc, base: VersionLike, body: string) => VersionLike;
}

const RANK: Record<Role, number> = { viewer: 0, commenter: 1, approver: 2, owner: 3 };
const HORIZONS: Horizon[] = ["now", "next", "later"];
const LABEL: Record<Horizon, string> = { now: "Now", next: "Next", later: "Later" };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export const emptyPlanEdits = (): PlanEditsDb => ({ sets: [], versions: {} });

export const slugOf = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "item";

/** The roadmap's live plan: its latest approved version (the plan's seeded one at the least). */
export function liveVersion(ctx: PlanEditsContext, doc: Doc): number | null {
  const approved = ctx.versions.filter((v) => v.document_id === doc.id && v.approved_at).map((v) => v.number);
  const seeded = ctx.seededApproved(doc.slug);
  const all = seeded == null ? approved : [...approved, seeded];
  return all.length ? Math.max(...all) : null;
}

function itemsOf(ctx: PlanEditsContext, db: PlanEditsDb, slug: string, version: number): PlanEditItem[] {
  return db.versions[slug]?.[version] ?? ctx.seededItems(slug, version) ?? [];
}

class Refused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Applied = { lanes: Record<Horizon, (PlanEditItem & { isNew: boolean; deferred: boolean })[]>; cut: { item: PlanEditItem; reason: string }[] };

function apply(base: PlanEditItem[], changes: Change[]): Applied {
  const lanes: Applied["lanes"] = { now: [], next: [], later: [] };
  for (const i of base) lanes[i.horizon].push({ ...i, isNew: false, deferred: false });
  const out: Applied = { lanes, cut: [] };
  const all = () => HORIZONS.flatMap((h) => lanes[h]);
  for (const c of changes) {
    if (c.op === "add") {
      const key = c.key ?? slugOf(c.title);
      if (all().some((i) => i.key === key) || out.cut.some((x) => x.item.key === key)) throw new Refused(422, `the plan has an item ${key} already`);
      lanes[c.horizon].push({ key, title: c.title, horizon: c.horizon, outcome: c.outcome ?? null, feature_id: c.feature_id ?? null, isNew: true, deferred: false });
      continue;
    }
    const item = all().find((i) => i.key === c.key);
    if (!item) throw new Refused(422, out.cut.some((x) => x.item.key === c.key) ? `${c.key} is cut from the plan already` : `${c.key} is not an item of the plan`);
    lanes[item.horizon].splice(lanes[item.horizon].indexOf(item), 1);
    if (c.op === "cut") out.cut.push({ item, reason: c.reason });
    else if (c.op === "move" || c.op === "defer") {
      item.horizon = c.op === "move" ? c.horizon : "later";
      item.deferred = c.op === "defer";
      lanes[item.horizon].push(item);
    } else if (c.op === "reorder") lanes[item.horizon].splice(Math.min(c.position, lanes[item.horizon].length), 0, item);
  }
  return out;
}

function view(ctx: PlanEditsContext, db: PlanEditsDb, doc: Doc, row: ChangeSetRow): Schemas["ChangeSetOut"] {
  const base = itemsOf(ctx, db, doc.slug, row.base_version);
  const applied = apply(base, row.changes);
  const items = HORIZONS.flatMap((h) => applied.lanes[h]);
  const laneAt = (list: PlanEditItem[], i: PlanEditItem) => list.filter((x) => x.horizon === i.horizon).findIndex((x) => x.key === i.key);
  const diff: Schemas["ChangeSetDiffItem"][] = [];
  for (const i of items) {
    const was = base.find((b) => b.key === i.key);
    if (!was) diff.push({ key: i.key, title: i.title, status: "added", fields: [], reordered: false });
    else if (was.horizon !== i.horizon) diff.push({ key: i.key, title: i.title, status: "moved", from_horizon: was.horizon, to_horizon: i.horizon, fields: ["horizon"], reordered: false });
    else diff.push({ key: i.key, title: i.title, status: "unchanged", fields: [], reordered: laneAt(base, was) !== applied.lanes[i.horizon].indexOf(i) });
  }
  for (const c of applied.cut) diff.push({ key: c.item.key, title: c.item.title, status: "dropped", fields: [], reordered: false, reason: c.reason });
  const summary: Record<string, number> = { added: 0, dropped: 0, moved: 0, changed: 0, unchanged: 0 };
  for (const d of diff) summary[d.status] += 1;
  summary.reordered = diff.filter((d) => d.reordered).length;
  const proposed = row.proposed_version == null ? undefined : ctx.versions.find((v) => v.document_id === doc.id && v.number === row.proposed_version);
  return {
    id: row.id,
    roadmap: doc.slug,
    roadmap_title: doc.title,
    base_version: row.base_version,
    status: row.status,
    changes: row.changes,
    items: items.map((i, n) => ({ key: i.key, title: i.title, horizon: i.horizon, position: n, outcome: i.outcome ?? null, feature_id: i.feature_id ?? null, new: i.isNew, deferred: i.deferred })),
    cut: applied.cut.map((c) => ({ key: c.item.key, title: c.item.title, horizon: c.item.horizon, reason: c.reason })),
    diff,
    summary,
    proposed_version: row.proposed_version,
    approved: !!proposed?.approved_at,
    decider_id: ctx.deciderOf(doc.id),
    lock_version: row.lock_version,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function checkBase(ctx: PlanEditsContext, doc: Doc, row: ChangeSetRow) {
  const live = liveVersion(ctx, doc);
  if (live !== row.base_version) {
    const now = live == null ? "no version is approved now" : `version ${live} is approved now`;
    throw new Refused(409, `The approved plan changed: these changes were made on version ${row.base_version} and ${now}. Discard them and edit the plan again.`);
  }
}

function linesOf(base: number, changes: Change[], titles: Map<string, string>): string {
  const name = (key: string) => titles.get(key) ?? key;
  const lines = changes.map((c) => {
    if (c.op === "add") return `- Added ${c.title} to ${LABEL[c.horizon]}`;
    if (c.op === "move") return `- Moved ${name(c.key)} to ${LABEL[c.horizon]}`;
    if (c.op === "defer") return `- Deferred ${name(c.key)} to Later`;
    if (c.op === "cut") return `- Cut ${name(c.key)}: ${c.reason.trim()}`;
    return `- Moved ${name(c.key)} to place ${c.position + 1} in its horizon`;
  });
  return [`Proposed as changes to version ${base}:`, "", ...lines].join("\n");
}

/** /v1/roadmaps/{doc}/change-sets[/{id}[/propose]] */
export async function routeChangeSets(ctx: PlanEditsContext, db: PlanEditsDb, req: Request, p: string[], q: URLSearchParams): Promise<Response | null> {
  if (p[1] !== "roadmaps" || !p[2] || p[3] !== "change-sets") return null;
  const m = req.method;
  const doc = ctx.documents.find((d) => d.slug === p[2]);
  if (!doc) return json(404, { detail: `document '${p[2]}' not found` });
  if (doc.kind !== "roadmap") return json(422, { detail: `'${doc.slug}' is a ${doc.kind ?? "prd"}, not a roadmap` });
  const writes = m !== "GET";
  if (writes && RANK[ctx.role] < RANK.approver) return json(403, { detail: "Requires the approver role" });
  const stamp = (row: ChangeSetRow) => {
    row.lock_version += 1;
    row.updated_at = ctx.now();
  };
  try {
    if (!p[4]) {
      if (m === "GET") {
        const status = q.get("status");
        const rows = db.sets.filter((s) => s.roadmap === doc.slug && (!status || s.status === status)).reverse();
        return json(200, rows.map((r) => view(ctx, db, doc, r)));
      }
      if (m !== "POST") return null;
      const open = db.sets.find((s) => s.roadmap === doc.slug && s.status === "draft");
      if (open) return json(200, view(ctx, db, doc, open));
      const live = liveVersion(ctx, doc);
      if (live == null) throw new Refused(422, `'${doc.slug}' has no approved version: edit the plan once a version is approved`);
      const row: ChangeSetRow = {
        id: ctx.uuid(), roadmap: doc.slug, base_version: live, status: "draft", changes: [], proposed_version: null,
        lock_version: 1, created_by: ctx.userId, created_at: ctx.now(), updated_at: ctx.now(),
      };
      db.sets.push(row);
      return json(201, view(ctx, db, doc, row));
    }
    const row = db.sets.find((s) => s.id === p[4] && s.roadmap === doc.slug);
    if (!row) return json(404, { detail: "Change set not found" });
    if (m === "GET" && !p[5]) return json(200, view(ctx, db, doc, row));
    const draft = () => {
      if (row.status !== "draft") throw new Refused(409, `This change set is ${row.status}: edit the plan again to change it`);
    };
    if (m === "PATCH" && !p[5]) {
      draft();
      const input = (await req.json()) as Schemas["ChangeSetPatch"];
      if (input.lock_version !== row.lock_version) throw new Refused(409, "The change set changed since it was loaded");
      checkBase(ctx, doc, row);
      const changes = input.changes.map((c) => (c.op === "add" ? { ...c, key: c.key ?? slugOf(c.title) } : c));
      for (const c of changes) if (c.op === "cut" && !c.reason?.trim()) throw new Refused(422, "a cut needs its reason");
      apply(itemsOf(ctx, db, doc.slug, row.base_version), changes);
      row.changes = changes;
      stamp(row);
      return json(200, view(ctx, db, doc, row));
    }
    if (m === "DELETE" && !p[5]) {
      draft();
      row.status = "discarded";
      stamp(row);
      return json(200, view(ctx, db, doc, row));
    }
    if (m === "POST" && p[5] === "propose") {
      draft();
      checkBase(ctx, doc, row);
      if (!row.changes.length) throw new Refused(422, "Nothing to propose: the change set has no changes");
      const baseItems = itemsOf(ctx, db, doc.slug, row.base_version);
      const applied = apply(baseItems, row.changes);
      const base = ctx.versions.find((v) => v.document_id === doc.id && v.number === row.base_version);
      if (!base) throw new Refused(404, `version ${row.base_version} of '${doc.slug}' not found`);
      const body = linesOf(row.base_version, row.changes, new Map(baseItems.map((i) => [i.key, i.title])));
      const version = ctx.newVersion(doc, base, body);
      (db.versions[doc.slug] ??= {})[version.number] = HORIZONS.flatMap((h) => applied.lanes[h]).map((i) => ({
        key: i.key, title: i.title, horizon: i.horizon, outcome: i.outcome ?? null, feature_id: i.feature_id ?? null,
      }));
      row.status = "proposed";
      row.proposed_version = version.number;
      stamp(row);
      return json(200, view(ctx, db, doc, row));
    }
    return null;
  } catch (e) {
    if (e instanceof Refused) return json(e.status, { detail: e.message });
    throw e;
  }
}
