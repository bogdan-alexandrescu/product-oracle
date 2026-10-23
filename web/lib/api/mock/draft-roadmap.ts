/**
 * E1 Roadmap per PRD draft, in the mock: every PRD version's items-only roadmap (a
 * `draft_roadmaps` row each), the four routes, the summary on VersionOut, the queue a new
 * PRD version joins, and the tick that moves a derivation queued -> running -> ready (one
 * step per tick) with canned items. Seeded on checkout-redesign v1 and v2 (synthetic
 * placeholders); every other PRD version reads `none`.
 */
import type { Schemas } from "@/lib/api/client";
import type { DraftRoadmapCheck, DraftRoadmapOut, DraftRoadmapStatus, DraftRoadmapSummary } from "@/lib/api/draft-roadmap";

import { finishDraftItemsRun, startDraftItemsRun, type RunsDb } from "./runs";

type Item = Schemas["RoadmapItemOut"];
type Role = "viewer" | "commenter" | "approver" | "owner";
type Doc = { id: string; slug: string; title: string; kind: string };
type Version = {
  id: string;
  document_id: string;
  number: number;
  approved_at?: string | null;
  sections: { section_key: string; heading: string; level: number; content_hash: string }[];
};
type Member = { id: string; role: Role; status?: string | null };

export interface DraftRow {
  document_id: string;
  version: number;
  status: Exclude<DraftRoadmapStatus, "none">;
  requested_via: "auto" | "derive";
  requested_by: string | null;
  requested_at: string;
  run_id: string | null;
  ready_at: string | null;
  error: string | null;
  depth: "quick" | "standard" | "deep";
  check: DraftRoadmapCheck | null;
  items: Item[];
}

export interface DraftRoadmapDb {
  rows: DraftRow[];
  /** PRD document ids whose "Derive for each new draft" is off. */
  off: string[];
}

export interface DraftRoadmapContext {
  role: Role;
  userId: string;
  documents: Doc[];
  versions: Version[];
  members: Member[];
  uuid: () => string;
  now: () => string;
  /** The mock's runs (created on first use). */
  runs: () => RunsDb;
}

const RANK: Record<Role, number> = { viewer: 0, commenter: 1, approver: 2, owner: 3 };
// The API's text for a refused date (api/oracle/roadmap/schedule.py UNVERIFIED).
const UNVERIFIED =
  "a date needs a verified estimate, capacity or commitment recorded for this PRD (and item) that supports it (record one with POST /v1/schedule-bases); Oracle never invents dates";
const CANNOT_START = "The person who imported this draft can no longer start runs. An approver can derive again.";
const SEED_PRD = "checkout-redesign";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type ItemSeed = {
  key: string;
  title: string;
  outcome: string;
  horizon: Item["horizon"];
  section: string;
  rank: number;
  confidence: string;
  milestone?: Record<string, unknown> | null;
  depends_on?: string[];
};

function item(ctx: DraftRoadmapContext, doc: Doc, v: Version, s: ItemSeed, position: number): Item {
  const section = v.sections.find((x) => x.section_key === s.section);
  return {
    id: ctx.uuid(),
    item_key: s.key,
    position,
    title: s.title,
    outcome: s.outcome,
    horizon: s.horizon,
    milestone: (s.milestone ?? null) as Item["milestone"],
    freshness: "fresh",
    stale_reasons: [],
    stale_since: null,
    caused_by_change_id: null,
    prd: {
      document: { id: doc.id, slug: doc.slug, title: doc.title, version: v.number, approved: !!v.approved_at },
      section_key: s.section,
      section_hash: section?.content_hash ?? null,
      link: `/documents/${doc.slug}/v/${v.number}#${s.section}`,
      reconciled_version: null,
      reconciled_section_hash: null,
    } as Item["prd"],
    track_id: null,
    feature: null,
    requirements: [],
    blockers: [],
    trace: [],
    depends_on: s.depends_on ?? [],
    validation_gates: [],
    economics: {},
    priority: { rank: s.rank, score: null, explanation: null } as Item["priority"],
    confidence: s.confidence,
    engineering: [],
    note: null,
  } as Item;
}

function checkOf(items: Item[], problems: DraftRoadmapCheck["problems"] = []): DraftRoadmapCheck {
  const n = (h: string) => items.filter((i) => i.horizon === h).length;
  return { items: items.length, by_horizon: { now: n("now"), next: n("next"), later: n("later") }, problems };
}

const CART: ItemSeed = { key: "cart-review", title: "Cart review shows the full price", outcome: "Buyers see the whole price before they start checkout", horizon: "now", section: "s-5-1", rank: 1, confidence: "high", milestone: { name: "Beta" } };
const GUEST: ItemSeed = { key: "guest-checkout", title: "Guest checkout", outcome: "First-time buyers check out without an account", horizon: "next", section: "scope", rank: 3, confidence: "medium" };

/** checkout-redesign v1: four items, no problems. */
function seedV1(): ItemSeed[] {
  return [
    CART,
    { key: "shipping-step", title: "Shipping step on one screen", outcome: "Buyers choose a shipping option without leaving the step", horizon: "now", section: "s-5-2", rank: 2, confidence: "medium", milestone: { name: "Beta", date: "2026-11-30", date_source: "EST-1", basis_ids: [] } },
    GUEST,
    { key: "wallet-pay", title: "One-tap wallet pay", outcome: "Returning buyers pay in one tap", horizon: "later", section: "scope", rank: 4, confidence: "low" },
  ];
}

/** checkout-redesign v2: guest checkout moved to Now, the shipping date removed, saved addresses new, wallet pay gone. */
function seedV2(): ItemSeed[] {
  return [
    CART,
    { ...GUEST, horizon: "now", rank: 2 },
    { key: "shipping-step", title: "Shipping step on one screen", outcome: "Buyers choose a shipping option without leaving the step", horizon: "now", section: "s-5-2", rank: 3, confidence: "medium", milestone: { name: "Beta" } },
    {
      key: "saved-addresses",
      title: "Saved addresses",
      outcome: "Returning buyers pick a saved address instead of typing it",
      horizon: "next",
      section: "s-5-3",
      rank: 4,
      confidence: "medium",
      depends_on: ["shipping-step"],
      milestone: { name: "GA", date: null, basis_ids: [], refused_date: "2026-12-15", refused: UNVERIFIED },
    },
  ];
}

const V2_PROBLEMS: DraftRoadmapCheck["problems"] = [
  { code: "unverified_date", item: "saved-addresses", message: "saved-addresses: 2026-12-15 has no verified schedule basis" },
];

/** The seeded rows: checkout-redesign v1 and v2, ready. */
export function seedDraftRoadmaps(ctx: DraftRoadmapContext): DraftRoadmapDb {
  const db: DraftRoadmapDb = { rows: [], off: [] };
  const doc = ctx.documents.find((d) => d.slug === SEED_PRD);
  if (!doc) return db;
  const seeds: [number, ItemSeed[], DraftRoadmapCheck["problems"], string, string][] = [
    [1, seedV1(), [], "2026-10-16T14:06:00Z", "2026-10-16T14:12:00Z"],
    [2, seedV2(), V2_PROBLEMS, "2026-10-17T09:21:00Z", "2026-10-17T09:28:00Z"],
  ];
  for (const [n, seeds_, problems, requested, ready] of seeds) {
    const v = ctx.versions.find((x) => x.document_id === doc.id && x.number === n);
    if (!v) continue;
    const items = seeds_.map((s, i) => item(ctx, doc, v, s, i));
    db.rows.push({
      document_id: doc.id,
      version: n,
      status: "ready",
      requested_via: "auto",
      requested_by: null,
      requested_at: requested,
      run_id: null,
      ready_at: ready,
      error: null,
      depth: "standard",
      check: checkOf(items, problems),
      items,
    });
  }
  return db;
}

/** Canned items for a derivation that finishes: the seed's for checkout-redesign v1/v2, else one per subsection. */
function cannedItems(ctx: DraftRoadmapContext, doc: Doc, v: Version): { items: Item[]; problems: DraftRoadmapCheck["problems"] } {
  if (doc.slug === SEED_PRD && (v.number === 1 || v.number === 2)) {
    const seeds = v.number === 1 ? seedV1() : seedV2();
    return { items: seeds.map((s, i) => item(ctx, doc, v, s, i)), problems: v.number === 2 ? V2_PROBLEMS : [] };
  }
  const picked = v.sections.filter((s) => s.level >= 2).slice(0, 3);
  const horizons: Item["horizon"][] = ["now", "now", "next"];
  const seeds = picked.map<ItemSeed>((s, i) => ({
    key: s.section_key,
    title: s.heading.replace(/^[\d.]+\s*/, ""),
    outcome: `What ${s.heading.replace(/^[\d.]+\s*/, "").toLowerCase()} delivers`,
    horizon: horizons[i],
    section: s.section_key,
    rank: i + 1,
    confidence: "medium",
  }));
  return { items: seeds.map((s, i) => item(ctx, doc, v, s, i)), problems: [] };
}

const rowOf = (db: DraftRoadmapDb, docId: string, n: number) => db.rows.find((r) => r.document_id === docId && r.version === n);

/**
 * A new PRD version joins the queue (the API's version_imported handler): `skipped` for the
 * template's empty skeleton, `off` when the PRD's switch is off, else `queued`; an older
 * version only queued automatically is superseded (latest draft wins).
 */
export function queueDraftRoadmap(
  ctx: Pick<DraftRoadmapContext, "now">,
  db: DraftRoadmapDb,
  doc: Doc,
  v: Pick<Version, "number">,
  by: string | null,
  origin?: "skeleton",
) {
  if (doc.kind !== "prd") return;
  const status: DraftRow["status"] = origin === "skeleton" ? "skipped" : db.off.includes(doc.id) ? "off" : "queued";
  if (status === "queued") {
    for (const r of db.rows) {
      if (r.document_id === doc.id && r.version < v.number && r.status === "queued" && r.requested_via === "auto") r.status = "superseded";
    }
  }
  db.rows = db.rows.filter((r) => !(r.document_id === doc.id && r.version === v.number));
  db.rows.push({
    document_id: doc.id,
    version: v.number,
    status,
    requested_via: "auto",
    requested_by: by,
    requested_at: ctx.now(),
    run_id: null,
    ready_at: null,
    error: null,
    depth: "standard",
    check: null,
    items: [],
  });
}

/** VersionOut.draft_roadmap: PRD versions only. */
export function draftRoadmapSummary(db: DraftRoadmapDb | undefined, doc: Doc | undefined, n: number): DraftRoadmapSummary | null {
  if (!doc || doc.kind !== "prd") return null;
  const r = db ? rowOf(db, doc.id, n) : undefined;
  return r ? { status: r.status, items: r.items.length, problems: r.check?.problems.length ?? 0 } : { status: "none", items: 0, problems: 0 };
}

/**
 * POST /v1/internal/tick: a running derivation finishes (its items stored, its run
 * succeeded); then, per PRD with nothing running, the queued request for the highest
 * version starts (a run, created by its requester) unless the requester can no longer
 * start runs.
 */
export function tickDraftRoadmaps(ctx: DraftRoadmapContext, db: DraftRoadmapDb) {
  const busy = new Set<string>();
  for (const r of db.rows.filter((x) => x.status === "running")) {
    busy.add(r.document_id);
    const doc = ctx.documents.find((d) => d.id === r.document_id);
    const v = ctx.versions.find((x) => x.document_id === r.document_id && x.number === r.version);
    if (!doc || !v) continue;
    const { items, problems } = cannedItems(ctx, doc, v);
    finishDraftItemsRun(ctx.runs(), r.run_id, { uuid: ctx.uuid, now: ctx.now() });
    Object.assign(r, { status: items.length ? "ready" : "failed", items, check: checkOf(items, problems), ready_at: ctx.now(), error: items.length ? null : "the items file lists no items" });
  }
  const docs = new Set(db.rows.filter((r) => r.status === "queued").map((r) => r.document_id));
  for (const docId of docs) {
    if (busy.has(docId)) continue;
    const r = db.rows.filter((x) => x.document_id === docId && x.status === "queued").sort((a, b) => b.version - a.version)[0];
    const doc = ctx.documents.find((d) => d.id === docId);
    const v = ctx.versions.find((x) => x.document_id === docId && x.number === r.version);
    if (!doc || !v) continue;
    const who = r.requested_by ? ctx.members.find((m) => m.id === r.requested_by) : null;
    if (r.requested_by && who && (who.status === "disabled" || RANK[who.role] < RANK.approver)) {
      Object.assign(r, { status: "failed", error: CANNOT_START });
      continue;
    }
    const run = startDraftItemsRun(ctx.runs(), {
      uuid: ctx.uuid,
      now: ctx.now(),
      createdBy: r.requested_by ?? ctx.userId,
      depth: r.depth,
      source: { document_id: doc.id, slug: doc.slug, title: doc.title, kind: "prd", version: v.number, version_id: v.id, approved_at: v.approved_at ?? null },
    });
    Object.assign(r, { status: "running", run_id: run.id, error: null });
  }
}

function out(ctx: DraftRoadmapContext, db: DraftRoadmapDb, doc: Doc, v: Version, view: "full" | "brief"): DraftRoadmapOut {
  const r = rowOf(db, doc.id, v.number);
  const prev = db.rows
    .filter((x) => x.document_id === doc.id && x.version < v.number && x.status === "ready")
    .sort((a, b) => b.version - a.version)[0];
  const items = r?.items ?? [];
  return {
    prd: { id: doc.id, slug: doc.slug, title: doc.title, version: v.number, approved: !!v.approved_at },
    status: r?.status ?? "none",
    run_id: r?.run_id ?? null,
    requested_at: r?.requested_at ?? null,
    ready_at: r?.ready_at ?? null,
    error: r?.error ?? null,
    check: r?.check ?? null,
    previous: prev ? { version: prev.version, status: prev.status, items: prev.items.length } : null,
    auto: !db.off.includes(doc.id),
    view,
    items: view === "brief" ? items.map((i) => ({ ...i, trace: [], validation_gates: [] })) : items,
  };
}

/** The four routes; null for anything else. */
export async function routeDraftRoadmap(ctx: DraftRoadmapContext, db: DraftRoadmapDb, req: Request, p: string[], q: URLSearchParams): Promise<Response | null> {
  if (p[1] !== "documents" || !p[2]) return null;
  const m = req.method;
  const itemsRoute = p[3] === "versions" && p[5] === "roadmap-items";
  const settingsRoute = p.length === 5 && p[3] === "roadmap-items" && p[4] === "settings";
  if (!itemsRoute && !settingsRoute) return null;
  const doc = ctx.documents.find((d) => d.slug === p[2] || d.id === p[2]);
  if (!doc) return json(404, { detail: "Document not found" });
  if (doc.kind !== "prd") return json(422, { detail: `document '${doc.slug}' is not a PRD: only a PRD draft has roadmap items` });
  const can = (role: Role) => RANK[ctx.role] >= RANK[role];

  if (settingsRoute) {
    if (m === "GET") return json(200, { each_draft: !db.off.includes(doc.id) });
    if (m === "PUT") {
      if (!can("owner")) return json(403, { detail: "Requires the owner role" });
      const input = JSON.parse((await req.text()) || "{}") as { each_draft?: boolean };
      db.off = db.off.filter((id) => id !== doc.id);
      if (input.each_draft === false) db.off.push(doc.id);
      return json(200, { each_draft: input.each_draft !== false });
    }
    return null;
  }

  const n = Number(p[4]);
  const v = ctx.versions.find((x) => x.document_id === doc.id && x.number === n);
  if (!v) return json(404, { detail: "Version not found" });
  const view = q.get("view") === "brief" ? "brief" : "full";

  if (p.length === 6 && m === "GET") return json(200, out(ctx, db, doc, v, view));
  if (p.length === 7 && p[6] === "derive" && m === "POST") {
    if (!can("approver")) return json(403, { detail: "Requires the approver role" });
    const input = JSON.parse((await req.text()) || "{}") as { depth?: DraftRow["depth"] } | null;
    const r = rowOf(db, doc.id, n);
    if (r && (r.status === "queued" || r.status === "running")) return json(409, { detail: `Roadmap items for v${n} are already being derived` });
    // A person's request supersedes nothing and is never superseded; current items stay until new ones are stored.
    const row: DraftRow = r ?? {
      document_id: doc.id,
      version: n,
      status: "queued",
      requested_via: "derive",
      requested_by: ctx.userId,
      requested_at: ctx.now(),
      run_id: null,
      ready_at: null,
      error: null,
      depth: "standard",
      check: null,
      items: [],
    };
    Object.assign(row, { status: "queued", requested_via: "derive", requested_by: ctx.userId, requested_at: ctx.now(), run_id: null, error: null, depth: input?.depth ?? "standard" });
    if (!r) db.rows.push(row);
    return json(202, out(ctx, db, doc, v, "full"));
  }
  return null;
}
