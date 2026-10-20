/**
 * Mock of the roadmap alignment and product track routes (api/oracle/roadmap/router.py,
 * CR-11) for NEXT_PUBLIC_API_MOCKS=1: roadmap items traced to their PRD version, the
 * read-only alignment report, verified schedule bases, tracker records, tracks with
 * their overview and monitoring, milestones (a date only with a verified basis that
 * supports it), the tracker plan and the disabled two-way gate.
 *
 * Seeded on the usage-alerts PRD and the usage-alerts-roadmap built from it. Simplified
 * on purpose: health, drift and staleness follow the API's rules, not its every message.
 * Synthetic placeholders only. Reads need a viewer; writes an approver, as in the API.
 */
import type { Schemas } from "@/lib/api/client";

import { mockUuid, seeded } from "./ids";

type Role = "viewer" | "commenter" | "approver" | "owner";
type Item = Schemas["RoadmapItemOut"];
type Track = { id: string; prd_id: string; roadmap_id: string | null; title: string; status: Schemas["TrackOverview"]["status"]; owner_id: string | null; started_version: number; current_version: number; lock_version: number; created_at: string; monitored_at: string | null; monitor: Record<string, unknown> };
type Milestone = Schemas["MilestoneOut"];
type Basis = Schemas["ScheduleBasisOut"];
type TrackerRecord = Schemas["TrackerRecordOut"];
type Change = Schemas["TrackChange"] & { track_id: string };

interface Doc {
  id: string;
  slug: string;
  title: string;
  kind?: string | null;
}
interface Version {
  id: string;
  document_id: string;
  number: number;
  approved_at?: string | null;
  source?: Schemas["VersionSource"] | null;
  sections: { section_key: string; heading: string; level: number; content_hash: string }[];
}

export interface RoadmapDb {
  /** Items by roadmap version id. */
  items: Record<string, Item[]>;
  tracks: Track[];
  milestones: Milestone[];
  bases: Basis[];
  records: TrackerRecord[];
  changes: Change[];
}

export interface RoadmapContext {
  userId: string;
  role: Role;
  documents: Doc[];
  versions: Version[];
}

const RANK: Record<Role, number> = { viewer: 0, commenter: 1, approver: 2, owner: 3 };
const AT = "2026-10-19T09:00:00Z";
const OFF_REASON = "Two-way tracker sync is off: Oracle makes no tracker writes. Use the read-only alignment report.";
const UNVERIFIED = "a dated milestone needs a verified estimate, capacity or commitment (basis_ids); Oracle never invents dates";

const now = () => new Date().toISOString();
const today = () => now().slice(0, 10);
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
const notFound = (what: string) => json(404, { detail: `${what} not found` });

const connector = (): Schemas["TrackerConnectorOut"] => ({
  two_way_enabled: false,
  writes_allowed: false,
  read_only_alignment: true,
  reason: OFF_REASON,
});

function latest(ctx: RoadmapContext, docId: string, approved = false): Version | undefined {
  return ctx.versions
    .filter((v) => v.document_id === docId && (!approved || v.approved_at))
    .sort((a, b) => b.number - a.number)[0];
}

/** One item per level-3 section under Now, Next and Later, traced to the PRD section it links. */
function itemsFor(ctx: RoadmapContext, roadmap: Version, trackId: string | null): Item[] {
  const prd = roadmap.source ? ctx.versions.find((v) => v.id === roadmap.source!.version_id) : undefined;
  const prdDoc = prd && ctx.documents.find((d) => d.id === prd.document_id);
  let horizon: Item["horizon"] | null = null;
  const out: Item[] = [];
  for (const s of roadmap.sections) {
    if (s.level === 2) horizon = (["now", "next", "later"] as const).find((h) => h === s.section_key) ?? null;
    if (s.level !== 3 || !horizon) continue;
    const prdKey = s.section_key.replace(/^item-/, "");
    const section = prd?.sections.find((x) => x.section_key === prdKey);
    out.push({
      id: mockUuid(),
      item_key: s.section_key,
      position: out.length,
      title: s.heading,
      outcome: null,
      horizon,
      milestone: horizon === "now" ? { name: "First release" } : null,
      freshness: "fresh",
      stale_reasons: [],
      stale_since: null,
      caused_by_change_id: null,
      prd: {
        document: prdDoc ? { id: prdDoc.id, slug: prdDoc.slug, title: prdDoc.title, version: prd!.number, approved: !!prd!.approved_at } : null,
        section_key: section ? prdKey : null,
        section_hash: section?.content_hash ?? null,
        link: prdDoc ? `/documents/${prdDoc.slug}/v/${prd!.number}${section ? `#${prdKey}` : ""}` : null,
      },
      track_id: trackId,
      feature: null,
      requirements: [],
      blockers: [],
      trace: [],
      depends_on: [],
      validation_gates: [],
      economics: {},
      priority: null,
      confidence: null,
      engineering: [],
      note: null,
    });
  }
  return out;
}

export function seedRoadmap(ctx: RoadmapContext): RoadmapDb {
  return seeded("roadmap", () => {
    const db: RoadmapDb = { items: {}, tracks: [], milestones: [], bases: [], records: [], changes: [] };
    const prd = ctx.documents.find((d) => d.slug === "usage-alerts");
    const roadmap = ctx.documents.find((d) => d.slug === "usage-alerts-roadmap");
    const accepted = prd && latest(ctx, prd.id, true);
    if (!prd || !accepted) return db;
    const track: Track = {
      id: mockUuid(), prd_id: prd.id, roadmap_id: roadmap?.id ?? null, title: prd.title, status: "active",
      owner_id: null, started_version: accepted.number, current_version: accepted.number, lock_version: 1,
      created_at: AT, monitored_at: null, monitor: {},
    };
    db.tracks.push(track);
    const rv = roadmap && latest(ctx, roadmap.id);
    if (rv) db.items[rv.id] = itemsFor(ctx, rv, track.id);
    db.milestones.push({
      id: mockUuid(), track_id: track.id, name: "First release", horizon: "now", target_date: null, basis_ids: [],
      item_keys: (rv ? db.items[rv.id] : []).filter((i) => i.horizon === "now").map((i) => i.item_key),
      status: "planned", lock_version: 1, created_at: AT, updated_at: AT,
    });
    return db;
  });
}

function itemsVersion(ctx: RoadmapContext, db: RoadmapDb, doc: Doc, n: number | null, approvedFirst = false): Version | undefined {
  const versions = ctx.versions.filter((v) => v.document_id === doc.id).sort((a, b) => b.number - a.number);
  if (n != null) return versions.find((v) => v.number === n);
  const withItems = versions.filter((v) => db.items[v.id]?.length);
  return (approvedFirst && withItems.find((v) => v.approved_at)) || withItems[0] || versions[0];
}

function withEngineering(db: RoadmapDb, item: Item, view: string): Item {
  const engineering = db.records
    .filter((r) => r.track_id === item.track_id && r.item_key === item.item_key)
    .map((r) => ({ tracker: r.tracker, external_ref: r.external_ref, state: r.state, raw_status: r.raw_status, target_date: r.target_date, estimate: r.estimate, url: r.url }));
  if (view === "brief") return { ...item, feature: null, requirements: [], blockers: [], trace: [], depends_on: [], validation_gates: [], economics: {}, priority: null, confidence: null, engineering: [] };
  return { ...item, engineering };
}

function docRef(doc: Doc, v?: Version): Schemas["DocumentRef"] {
  return { id: doc.id, slug: doc.slug, title: doc.title, version: v?.number ?? null, approved: v ? !!v.approved_at : null };
}

function itemDate(db: RoadmapDb, item: Item): string | null {
  const days = db.milestones
    .filter((m) => m.track_id === item.track_id && m.status === "planned" && m.target_date && m.item_keys.includes(item.item_key))
    .map((m) => m.target_date!);
  const own = (item.milestone as { date?: string | null } | null)?.date;
  if (own) days.push(own);
  return days.sort()[0] ?? null;
}

function drift(db: RoadmapDb, item: Item): Schemas["DriftEntry"][] {
  const recs = db.records.filter((r) => r.track_id === item.track_id && r.item_key === item.item_key);
  if (!recs.length) return [];
  const out: Schemas["DriftEntry"][] = [];
  const states = new Set(recs.map((r) => r.state));
  if (item.horizon !== "now" && (states.has("in_progress") || states.has("done"))) out.push({ kind: "ahead", item_key: item.item_key, detail: `Engineering has started work planned for ${item.horizon}.` });
  if (states.size === 1 && states.has("cancelled")) out.push({ kind: "cancelled", item_key: item.item_key, detail: "Every tracker issue for this item is cancelled." });
  const when = itemDate(db, item);
  if (when) {
    for (const r of recs) {
      if (r.state !== "done" && r.state !== "cancelled" && r.target_date && r.target_date > when) {
        out.push({ kind: "date_slip", item_key: item.item_key, tracker_ref: r.external_ref, detail: `${r.external_ref} targets ${r.target_date}, after the milestone date ${when}.` });
      }
    }
    if (when < today() && [...states].some((s) => s !== "done" && s !== "cancelled")) out.push({ kind: "overdue", item_key: item.item_key, detail: `The milestone date ${when} has passed and the work is not done.` });
  }
  return out;
}

function unplanned(db: RoadmapDb, trackId: string, keys: Set<string>): Schemas["DriftEntry"][] {
  return db.records
    .filter((r) => r.track_id === trackId && r.state !== "cancelled" && (!r.item_key || !keys.has(r.item_key)))
    .map((r) => ({ kind: "unplanned", tracker_ref: r.external_ref, item_key: r.item_key, detail: `${r.external_ref} (${r.title ?? "untitled"}) is not on the roadmap.` }));
}

function overview(ctx: RoadmapContext, db: RoadmapDb, t: Track): Schemas["TrackOverview"] {
  const prd = ctx.documents.find((d) => d.id === t.prd_id)!;
  const roadmap = t.roadmap_id ? ctx.documents.find((d) => d.id === t.roadmap_id) : undefined;
  const rv = roadmap ? itemsVersion(ctx, db, roadmap, null, true) : undefined;
  const items = rv ? db.items[rv.id] ?? [] : [];
  const latestApproved = latest(ctx, prd.id, true)?.number ?? null;
  const counts: Record<string, number> = { items: items.length, now: 0, next: 0, later: 0, at_risk: 0, blocked: 0, stale: 0, slipping: 0, done: 0 };
  const atRisk: Schemas["AtRiskItem"][] = [];
  const allDrift: Schemas["DriftEntry"][] = [];
  for (const i of items) {
    counts[i.horizon] += 1;
    const reasons: Record<string, string>[] = [];
    if (i.freshness === "potentially_stale" || i.freshness === "under_review") reasons.push({ kind: "stale", detail: i.stale_reasons.join("; ") || "its PRD trace changed" });
    const d = drift(db, i);
    allDrift.push(...d);
    for (const e of d) if (e.kind !== "ahead") reasons.push({ kind: "slipping", detail: e.detail });
    if (reasons.length) {
      for (const k of ["blocked", "stale", "slipping"]) if (reasons.some((r) => r.kind === k)) counts[k] += 1;
      atRisk.push({ item_key: i.item_key, title: i.title, horizon: i.horizon, reasons });
    }
  }
  counts.at_risk = atRisk.length;
  allDrift.push(...unplanned(db, t.id, new Set(items.map((i) => i.item_key))));
  const milestones = db.milestones.filter((m) => m.track_id === t.id);
  const planned = milestones.filter((m) => m.status === "planned");
  const next = planned.filter((m) => m.target_date && m.target_date >= today()).sort((a, b) => a.target_date!.localeCompare(b.target_date!))[0] ?? planned.find((m) => !m.target_date);
  const source = rv?.source?.version ?? null;
  const prdMoved = !!(source && latestApproved && latestApproved > source);
  const slippingNext = !!next && atRisk.some((a) => next.item_keys.includes(a.item_key) && a.reasons.some((r) => r.kind === "slipping"));
  const health: Schemas["TrackOverview"]["health"] =
    t.status !== "active" ? t.status : !items.length ? "no_roadmap" : slippingNext ? "off_track" : atRisk.length || prdMoved ? "at_risk" : "on_track";
  const when = next ? ` Next: ${next.name}${next.target_date ? ` (${next.target_date})` : ""}.` : "";
  const headline =
    health === "closed" ? "Closed." : health === "paused" ? "Paused." : health === "no_roadmap" ? "No roadmap items yet: derive the roadmap from the PRD." : health === "on_track" ? `On track: ${items.length} items.${when}` : `${health === "off_track" ? "Off track" : "At risk"}: ${atRisk.length} of ${items.length} items need attention.${when}`;
  return {
    id: t.id, title: t.title, status: t.status, owner_id: t.owner_id, prd: docRef(prd), started_version: t.started_version,
    current_version: t.current_version, latest_approved_version: latestApproved,
    roadmap: roadmap ? docRef(roadmap, rv) : null, lock_version: t.lock_version, created_at: t.created_at, monitored_at: t.monitored_at,
    health, headline, counts,
    next_milestone: next ? { milestone_id: next.id, name: next.name, horizon: next.horizon, target_date: next.target_date, dated: !!next.target_date, bases: db.bases.filter((b) => next.basis_ids.includes(b.id)).map((b) => ({ id: b.id, kind: b.kind, reference: b.reference })), items: next.item_keys.length } : null,
    at_risk: atRisk, drift: allDrift, engineering_known: db.records.some((r) => r.track_id === t.id), prd_moved: prdMoved, milestones,
  };
}

function checkDate(db: RoadmapDb, t: Track, horizon: string, date: string | null | undefined, basisIds: string[], itemKeys: string[] = []): string | null {
  if (!date) return null;
  if (horizon !== "now") return `dated milestones belong only in now (this one is in ${horizon})`;
  if (!basisIds.length) return UNVERIFIED;
  for (const id of basisIds) {
    const b = db.bases.find((x) => x.id === id);
    if (!b) return `schedule basis ${id} is unknown`;
    if (b.status !== "verified") return `schedule basis ${b.reference} was withdrawn`;
    if (b.prd_document_id !== t.prd_id) return `schedule basis ${b.reference} belongs to another PRD`;
    if (b.supports_date !== date) return `schedule basis ${b.reference} supports ${b.supports_date}, not ${date}`;
    // O4: a basis limited to one item supports only a milestone of that item. (The mock
    // does not resolve tracker_key scopes; the real API does.)
    if (b.item_key && !(itemKeys.length && itemKeys.every((k) => k === b.item_key))) return `schedule basis ${b.reference} supports only ${b.item_key}; list only those items`;
  }
  return null;
}

export async function routeRoadmap(ctx: RoadmapContext, db: RoadmapDb, req: Request, p: string[], q: URLSearchParams): Promise<Response | null> {
  const m = req.method;
  const body = async <T>() => JSON.parse((await req.text()) || "null") as T;
  const can = (role: Role) => RANK[ctx.role] >= RANK[role];
  const forbidden = () => json(403, { detail: "Requires the approver role" });
  const findDoc = (ref: string) => ctx.documents.find((d) => d.id === ref || d.slug === ref);
  const findTrack = (id: string) => db.tracks.find((t) => t.id === id);

  // /v1/roadmaps/{doc}/items | /alignment | /items/staleness | /versions/{n}/items
  if (p[1] === "roadmaps" && p[2]) {
    const doc = findDoc(p[2]);
    if (!doc) return notFound(`document '${p[2]}'`);
    if (doc.kind !== "roadmap") return json(422, { detail: `'${doc.slug}' is a ${doc.kind}, not a roadmap` });
    const n = q.get("version") ? Number(q.get("version")) : null;
    if (p[3] === "items" && !p[4] && m === "GET") {
      const v = itemsVersion(ctx, db, doc, n);
      if (n != null && !v) return notFound(`version ${n} of '${doc.slug}'`);
      const view = q.get("view") === "brief" ? "brief" : "full";
      const src = v?.source;
      const out: Schemas["RoadmapItemsOut"] = {
        roadmap: docRef(doc, v),
        source: src ? { id: src.document_id, slug: src.slug, title: src.title, version: src.version, approved: !!src.approved_at } : null,
        track_id: db.tracks.find((t) => t.roadmap_id === doc.id)?.id ?? null,
        view,
        items: (v ? db.items[v.id] ?? [] : []).map((i) => withEngineering(db, i, view)),
      };
      return json(200, out);
    }
    if (p[3] === "alignment" && m === "GET") {
      const v = itemsVersion(ctx, db, doc, n);
      const items = v ? db.items[v.id] ?? [] : [];
      const trackId = db.tracks.find((t) => t.roadmap_id === doc.id)?.id ?? null;
      const counts: Record<string, number> = { items: items.length, aligned: 0, drift: 0, untracked: 0, done: 0 };
      const rows = items.map((i) => {
        const recs = db.records.filter((r) => r.track_id === i.track_id && r.item_key === i.item_key);
        const d = drift(db, i);
        const alignment: Schemas["AlignmentItem"]["alignment"] = !recs.length ? "untracked" : d.length ? "drift" : recs.every((r) => r.state === "done") ? "done" : "aligned";
        counts[alignment] += 1;
        return { item_key: i.item_key, title: i.title, horizon: i.horizon, milestone: i.milestone, alignment, tracker: withEngineering(db, i, "full").engineering, drift: d };
      });
      const extra = trackId ? unplanned(db, trackId, new Set(items.map((i) => i.item_key))) : [];
      counts.unplanned = extra.length;
      const out: Schemas["AlignmentReport"] = { mode: "read_only", generated_at: now(), roadmap: docRef(doc, v), track_id: trackId, connector: connector(), counts, items: rows, unplanned: extra };
      return json(200, out);
    }
    if (p[3] === "items" && p[4] === "staleness" && m === "POST") {
      if (!can("approver")) return forbidden();
      const b = await body<Schemas["ItemStalenessAction"]>();
      const v = itemsVersion(ctx, db, doc, b.version ?? null);
      const items = (v ? db.items[v.id] ?? [] : []).filter((i) => !b.item_keys?.length || b.item_keys.includes(i.item_key));
      if (b.action === "reconcile" && !b.reason?.trim()) return json(422, { detail: "reconciling needs a reason" });
      const from = b.action === "review" ? ["potentially_stale"] : ["potentially_stale", "under_review"];
      const targets = items.filter((i) => from.includes(i.freshness));
      if (!targets.length) return json(409, { detail: `nothing to ${b.action}` });
      const changed = targets.map((i) => {
        const entry = { item: i.item_key, id: i.id, from: i.freshness, to: b.action === "review" ? "under_review" : "reconciled" };
        i.freshness = entry.to as Item["freshness"];
        if (b.reason) i.note = b.reason;
        return entry;
      });
      return json(200, { changed, items: v ? db.items[v.id] : [] });
    }
    if (p[3] === "versions" && p[5] === "items" && m === "PUT") {
      if (!can("approver")) return forbidden();
      return json(422, { detail: { message: "roadmap_items.yaml was refused", problems: [{ code: "mock", message: "The mock does not parse roadmap_items.yaml; use the real API." }] } });
    }
    return null;
  }

  // /v1/schedule-bases[/{id}/withdraw]
  if (p[1] === "schedule-bases") {
    if (!p[2] && m === "GET") {
      const prd = q.get("prd") ? findDoc(q.get("prd")!) : undefined;
      if (q.get("prd") && !prd) return notFound(`document '${q.get("prd")}'`);
      return json(200, db.bases.filter((b) => (!prd || b.prd_document_id === prd.id) && (!q.get("status") || b.status === q.get("status"))));
    }
    if (!p[2] && m === "POST") {
      if (!can("approver")) return forbidden();
      const b = await body<Schemas["ScheduleBasisCreate"]>();
      // O4: a basis is recorded for one PRD, optionally one item or one tracker issue.
      if (!b.prd) return json(422, { detail: "prd: a schedule basis is recorded for one PRD" });
      if (b.item_key && b.tracker_key) return json(422, { detail: "name an item_key or a tracker_key, not both" });
      const prd = findDoc(b.prd);
      if (!prd) return notFound(`document '${b.prd}'`);
      const row: Basis = {
        id: mockUuid(), kind: b.kind, reference: b.reference.trim(), supports_date: b.supports_date, detail: b.detail ?? null,
        prd_document_id: prd.id, item_key: b.item_key ?? null, tracker_key: b.tracker_key ?? null, tracker_record_id: b.tracker_record_id ?? null, status: "verified",
        verified_by: ctx.userId, verified_at: now(), withdrawn_by: null, withdrawn_at: null, created_at: now(),
      };
      db.bases.push(row);
      return json(201, row);
    }
    if (p[2] && p[3] === "withdraw" && m === "POST") {
      if (!can("approver")) return forbidden();
      const row = db.bases.find((b) => b.id === p[2]);
      if (!row) return notFound("Schedule basis");
      if (row.status === "withdrawn") return json(409, { detail: "This schedule basis is already withdrawn" });
      Object.assign(row, { status: "withdrawn", withdrawn_by: ctx.userId, withdrawn_at: now() });
      const undated: string[] = [];
      for (const ms of db.milestones.filter((x) => x.basis_ids.includes(row.id))) {
        ms.basis_ids = ms.basis_ids.filter((id) => id !== row.id && db.bases.find((b) => b.id === id)?.status === "verified");
        if (!ms.basis_ids.length && ms.target_date) {
          ms.target_date = null;
          undated.push(ms.id);
        }
      }
      return json(200, { basis: row, undated_milestones: undated, stale_items: [] });
    }
    return null;
  }

  // /v1/tracker/connector | /v1/tracker/records
  if (p[1] === "tracker") {
    if (p[2] === "connector" && m === "GET") return json(200, connector());
    if (p[2] === "records" && m === "GET") return json(200, db.records.filter((r) => !q.get("track_id") || r.track_id === q.get("track_id")));
    if (p[2] === "records" && m === "POST") {
      if (!can("approver")) return forbidden();
      const b = await body<Schemas["TrackerRecordsImport"]>();
      if (b.records.some((r) => r.track_id && !findTrack(r.track_id))) return json(422, { detail: "unknown track" });
      let created = 0;
      let updated = 0;
      const rows = b.records.map((r) => {
        let row = db.records.find((x) => x.tracker === b.tracker && x.external_ref === r.external_ref);
        const values = {
          title: r.title ?? null, url: r.url ?? null, track_id: r.track_id ?? null, item_key: r.item_key ?? null, state: r.state,
          raw_status: r.raw_status ?? null, estimate: r.estimate ?? null, estimate_unit: r.estimate_unit ?? null,
          target_date: r.target_date ?? null, observed_at: r.observed_at ?? now(), recorded_by: ctx.userId, updated_at: now(),
        };
        if (row) {
          Object.assign(row, values);
          updated += 1;
        } else {
          row = { id: mockUuid(), tracker: b.tracker, external_ref: r.external_ref, created_at: now(), ...values } as TrackerRecord;
          db.records.push(row);
          created += 1;
        }
        return row;
      });
      return json(200, { created, updated, records: rows });
    }
    return null;
  }

  // /v1/milestones/{id}
  if (p[1] === "milestones" && p[2] && m === "PATCH") {
    if (!can("approver")) return forbidden();
    const row = db.milestones.find((x) => x.id === p[2]);
    if (!row) return notFound("Milestone");
    const b = await body<Schemas["MilestonePatch"]>();
    if (b.lock_version !== row.lock_version) return json(409, { detail: "The milestone changed since it was loaded" });
    const horizon = b.horizon ?? row.horizon;
    const date = "target_date" in b ? b.target_date ?? null : row.target_date;
    const basisIds = b.basis_ids ?? row.basis_ids;
    const problem = checkDate(db, findTrack(row.track_id)!, horizon, date, basisIds, b.item_keys ?? row.item_keys);
    if (problem) return json(422, { detail: problem });
    Object.assign(row, { horizon, target_date: date, basis_ids: basisIds, name: b.name ?? row.name, item_keys: b.item_keys ?? row.item_keys, status: b.status ?? row.status, lock_version: row.lock_version + 1, updated_at: now() });
    return json(200, row);
  }

  if (p[1] !== "tracks") return null;
  // /v1/tracks
  if (!p[2]) {
    if (m === "GET") {
      const status = q.get("status");
      const SUMMARY: (keyof Schemas["TrackSummary"])[] = [
        "id", "title", "status", "owner_id", "prd", "started_version", "current_version", "latest_approved_version",
        "roadmap", "lock_version", "created_at", "monitored_at", "health", "headline",
      ];
      return json(200, db.tracks.filter((t) => !status || t.status === status).map((t) => {
        const o = overview(ctx, db, t);
        return Object.fromEntries(SUMMARY.map((k) => [k, o[k]]));
      }));
    }
    if (m === "POST") {
      if (!can("approver")) return forbidden();
      const b = await body<Schemas["TrackCreate"]>();
      const prd = findDoc(b.prd);
      if (!prd) return notFound(`document '${b.prd}'`);
      if (db.tracks.some((t) => t.prd_id === prd.id)) return json(409, { detail: `'${prd.slug}' already has a track` });
      const accepted = latest(ctx, prd.id, true);
      if (!accepted) return json(422, { detail: `'${prd.slug}' has no approved version: a track starts from an accepted PRD` });
      const roadmap = ctx.versions.find((v) => v.source?.document_id === prd.id);
      const t: Track = {
        id: mockUuid(), prd_id: prd.id, roadmap_id: roadmap?.document_id ?? null, title: b.title ?? prd.title, status: "active", owner_id: null,
        started_version: accepted.number, current_version: accepted.number, lock_version: 1, created_at: now(), monitored_at: null, monitor: {},
      };
      db.tracks.push(t);
      return json(201, overview(ctx, db, t));
    }
    return null;
  }
  const t = findTrack(p[2]);
  if (!t) return notFound("Track");
  if (!p[3]) {
    if (m === "GET") return json(200, overview(ctx, db, t));
    if (m === "PATCH") {
      if (!can("approver")) return forbidden();
      const b = await body<Schemas["TrackPatch"]>();
      if (b.lock_version !== t.lock_version) return json(409, { detail: "The track changed since it was loaded" });
      Object.assign(t, { title: b.title ?? t.title, status: b.status ?? t.status, owner_id: b.owner_id ?? t.owner_id, lock_version: t.lock_version + 1 });
      return json(200, overview(ctx, db, t));
    }
    return null;
  }
  if (p[3] === "monitor" && m === "POST") {
    if (!can("approver")) return forbidden();
    const o = overview(ctx, db, t);
    const after = { health: o.health, at_risk: o.at_risk.map((a) => a.item_key).sort(), next_milestone: o.next_milestone ? { name: o.next_milestone.name, date: o.next_milestone.target_date } : null, prd_moved: o.prd_moved };
    const changed = (Object.keys(after) as (keyof typeof after)[]).filter((k) => JSON.stringify(t.monitor[k]) !== JSON.stringify(after[k]));
    let eventId: string | null = null;
    if (changed.length) {
      eventId = mockUuid();
      db.changes.unshift({ id: eventId, track_id: t.id, cause: "track_monitored", actor: `user:${ctx.userId}`, data: { before: Object.keys(t.monitor).length ? t.monitor : null, after, changed }, created_at: now() });
    }
    t.monitor = after;
    t.monitored_at = now();
    return json(200, { overview: { ...o, monitored_at: t.monitored_at }, change_event_id: eventId, changed });
  }
  if (p[3] === "changes" && m === "GET") {
    return json(200, db.changes.filter((c) => c.track_id === t.id).map((c) => ({ id: c.id, cause: c.cause, actor: c.actor, data: c.data, created_at: c.created_at })));
  }
  if (p[3] === "tracker-plan" && m === "GET") {
    const o = overview(ctx, db, t);
    const roadmap = t.roadmap_id ? ctx.documents.find((d) => d.id === t.roadmap_id) : undefined;
    const rv = roadmap ? itemsVersion(ctx, db, roadmap, null, true) : undefined;
    const epics = (rv ? db.items[rv.id] ?? [] : [])
      .filter((i) => i.horizon !== "later")
      .map((i) => ({ item_key: i.item_key, title: i.title, horizon: i.horizon, description: i.outcome, prd_link: i.prd.link, issues: i.requirements.map((r) => ({ title: r.title, requirement_key: r.key })) }));
    return json(200, { track_id: o.id, would_write: false, connector: connector(), epics });
  }
  if (p[3] === "tracker-push" && m === "POST") {
    if (!can("approver")) return forbidden();
    return json(409, { detail: OFF_REASON });
  }
  if (p[3] === "milestones") {
    if (m === "GET") return json(200, db.milestones.filter((x) => x.track_id === t.id));
    if (m === "POST") {
      if (!can("approver")) return forbidden();
      const b = await body<Schemas["MilestoneCreate"]>();
      const horizon = b.horizon ?? "now";
      const problem = checkDate(db, t, horizon, b.target_date, b.basis_ids ?? [], b.item_keys ?? []);
      if (problem) return json(422, { detail: problem });
      if (db.milestones.some((x) => x.track_id === t.id && x.name === b.name)) return json(409, { detail: `the track already has a milestone '${b.name}'` });
      const row: Milestone = {
        id: mockUuid(), track_id: t.id, name: b.name, horizon, target_date: b.target_date ?? null, basis_ids: b.basis_ids ?? [],
        item_keys: b.item_keys ?? [], status: "planned", lock_version: 1, created_at: now(), updated_at: now(),
      };
      db.milestones.push(row);
      return json(201, row);
    }
  }
  // /v1/tracks/{id}/roadmap-run is answered by the runs mock (server.ts forwards it).
  return null;
}

/** The body of the prd_to_roadmap run a track's roadmap-run route drafts. */
export function trackRunBody(ctx: RoadmapContext, db: RoadmapDb, trackId: string): Schemas["RunCreate"] | null {
  const t = db.tracks.find((x) => x.id === trackId);
  if (!t) return null;
  const prd = ctx.documents.find((d) => d.id === t.prd_id)!;
  const roadmap = t.roadmap_id ? ctx.documents.find((d) => d.id === t.roadmap_id) : undefined;
  return { flow: "prd_to_roadmap", source: prd.slug, document: roadmap?.slug ?? null, knobs: { depth: "standard", roles: {}, checkpoints: {} } };
}
