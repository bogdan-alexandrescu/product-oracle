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
import type { AcceptDateOut, InboxTrack, TrackAlertAction, TrackAlertOut, TrackerRecordEventOut } from "@/lib/api/track-alerts";

import { mockUuid, seeded, stableUuid } from "./ids";
import type { PlanEditItem, PlanEditsDb } from "./plan-edits";
import { diffItems, snapshot } from "./roadmap-diff";
import itemsFixture from "./roadmap-items.json";

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
  status?: string;
  updated_at?: string;
}
interface Version {
  id: string;
  document_id: string;
  number: number;
  approved_at?: string | null;
  created_at?: string;
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
  /** F2: track alerts (seeded only in the "track-alerts" scenario, so other specs' Inbox counts stay). */
  alerts?: StoredAlert[];
  /** F2: tracker record history, one row per changed field. */
  recordEvents?: (TrackerRecordEventOut & { record_id: string })[];
  /** F2: dates accepted from the tracker, by item key, with the reference of the basis they rest on (the Plan row reads them). */
  accepted?: Record<string, { day: string; reference: string }>;
}

export interface RoadmapContext {
  userId: string;
  role: Role;
  /** A3: the caller carries the engineering lead flag (they may record and withdraw date bases). */
  engineeringLead?: boolean;
  /** F3: some member carries the flag (an approver's basis then waits as proposed). */
  leadNamed?: boolean;
  /** How the caller is named (F2: "Kept by <name>"). */
  userName?: string;
  documents: Doc[];
  versions: Version[];
  /** The mock approver's id (who proposed the seeded basis). */
  approverId?: string;
  /** E3b: the PRD drafts' items-only roadmaps (./draft-roadmap.ts), for draft refs. */
  drafts?: () => readonly DraftItems[];
}

/** A PRD version's draft roadmap as the diff reads it (./draft-roadmap.ts DraftRow). */
export interface DraftItems {
  document_id: string;
  version: number;
  status: string;
  ready_at: string | null;
  items: Item[];
}

const RANK: Record<Role, number> = { viewer: 0, commenter: 1, approver: 2, owner: 3 };
const AT = "2026-10-19T09:00:00Z";
const OFF_REASON = "Two-way tracker sync is off: Oracle makes no tracker writes. Use the read-only alignment report.";
const UNVERIFIED = "a dated milestone needs a verified estimate, capacity or commitment (basis_ids); Oracle never invents dates";
// The API's texts for an item's refused date (api/oracle/roadmap/schedule.py).
// #396: where a person records a date basis (api/oracle/wording.py RECORD_DATE_BASIS).
const RECORD_DATE_BASIS = "record a date basis on Plan › Dates (or ask the engineering lead to)";
const DATE_UNVERIFIED =
  `a date needs a verified estimate, capacity or commitment recorded for this PRD (and item) that supports it (${RECORD_DATE_BASIS}); Oracle never invents dates`;
const OUTSIDE_NOW = "dated milestones belong only in now; the date was dropped";
/** The mock scenario (MOCK_SCENARIO_KEY) whose roadmap items carry every field the Items tab shows (E2). */
export const ITEMS_SCENARIO = "roadmap-items";
/** F3 Date bases: commenter@example.com is the engineering lead, a basis waits for them. */
export const DATE_BASES_SCENARIO = "date-bases";
/** #396: the default company, GA's date with no basis, and usage-alerts-roadmap v1 carrying the API's date and citation warnings. */
export const VERSION_WARNINGS_SCENARIO = "version-warnings";
/** The mock scenario whose usage-alerts-roadmap v2 moved, added and dropped one item each since the approved v1 (E3). */
export const DIFF_SCENARIO = "roadmap-diff";
/** The mock scenario whose usage-alerts v2 draft moved and added one item against the approved usage-alerts-roadmap v1 (E3b). */
export const APPROVED_PLAN_SCENARIO = "approved-plan";

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

/**
 * The roadmap data. In the "roadmap-items" scenario (E2), usage-alerts-roadmap v1's items are
 * those of ./roadmap-items.json, the fixture api/tests/test_roadmap_items_contract.py checks
 * against the API, with the mock's own ids; the default seed has no dates and nothing stale
 * (roadmap-tracks-mock.spec.ts expects the track on track).
 */
export function seedRoadmap(ctx: RoadmapContext, scenario?: string | null): RoadmapDb {
  const withItems = scenario === ITEMS_SCENARIO;
  const withDiff = scenario === DIFF_SCENARIO;
  const noGaBasis = scenario === DATE_BASES_SCENARIO || scenario === VERSION_WARNINGS_SCENARIO;
  const key = withItems || withDiff || noGaBasis ? `roadmap:${scenario}` : "roadmap";
  return seeded(key, () => {
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
    // O4 'document dates': the roadmap's Beta date rests on ENG-412; its GA date's basis
    // (ENG-413) was withdrawn, so the version view marks it "date withdrawn". In the
    // "plan-decider" scenario (#346) it stands, so a version proposed from it can be approved.
    // F3 "date-bases": GA's date has no basis at all (unverified), and an approver's
    // ENG-420 waits for the engineering lead.
    const ga = scenario === "plan-decider" ? "verified" : "withdrawn";
    const seeds =
      noGaBasis
        ? ([["ENG-412", "2026-11-30", "verified"], ["ENG-420", "2027-01-15", "proposed"]] as const)
        : ([["ENG-412", "2026-11-30", "verified"], ["ENG-413", "2026-12-15", ga]] as const);
    for (const [reference, day, status] of seeds) {
      const proposed = status === "proposed";
      db.bases.push({
        id: mockUuid(), kind: "estimate", reference, supports_date: day, detail: null, prd_document_id: prd.id,
        item_key: null, tracker_key: null, tracker_record_id: null, status, note: null,
        proposed_by: proposed ? (ctx.approverId ?? null) : null, proposed_at: proposed ? AT : null,
        verified_by: proposed ? null : ctx.userId, verified_at: proposed ? null : AT,
        withdrawn_by: status === "withdrawn" ? ctx.userId : null, withdrawn_at: status === "withdrawn" ? AT : null,
        withdrawn_reason: status === "withdrawn" ? "The team re-estimated" : null,
        rejected_by: null, rejected_at: null, rejected_reason: null, created_at: AT,
      });
    }
    // F3 "date-bases": the tracker record a basis may be recorded from (the GA date's issue).
    if (scenario === DATE_BASES_SCENARIO) {
      db.records.push({
        id: mockUuid(), tracker: "linear", external_ref: "ENG-431", title: "Alerts in the team chat", url: "https://tracker.example.com/ENG-431",
        track_id: track.id, item_key: "slack-alerts", state: "todo", raw_status: null, estimate: null, estimate_unit: null,
        target_date: "2026-12-15", observed_at: AT, recorded_by: ctx.userId, created_at: AT, updated_at: AT,
      } as TrackerRecord);
    }
    db.milestones.push({
      id: mockUuid(), track_id: track.id, name: "First release", horizon: "now", target_date: null, basis_ids: [],
      item_keys: (rv ? db.items[rv.id] : []).filter((i) => i.horizon === "now").map((i) => i.item_key),
      status: "planned", lock_version: 1, created_at: AT, updated_at: AT,
    });
    // F7: acme/app#418 is already linked to "Spend forecast for the month" (the move flow).
    db.records.push(issueRecord(SYNCED_ISSUES[1], prd.id, "spend-forecast", ctx.userId));
    if (withItems && rv) db.items[rv.id] = db.items[rv.id].map((i) => fromFixture(db, i));
    if (withDiff && roadmap) seedDiff(ctx, db, roadmap.id, track.id);
    if (scenario === TRACK_ALERTS_SCENARIO || scenario === TRACK_ALERTS_MANY_SCENARIO || scenario === TRACK_ALERTS_ACTIONS_SCENARIO)
      seedAlerts(db, track.id, scenario === TRACK_ALERTS_MANY_SCENARIO, scenario === TRACK_ALERTS_ACTIONS_SCENARIO);
    return db;
  });
}

/**
 * "roadmap-diff" (E3): the approved v1 has Behaviour (Now), Success metrics (Next) and Usage
 * exports (Later); the draft v2 adds Spend limits (Now), moves Behaviour to Next and drops
 * Usage exports.
 */
function seedDiff(ctx: RoadmapContext, db: RoadmapDb, roadmapId: string, trackId: string) {
  const v1 = ctx.versions.find((v) => v.document_id === roadmapId && v.number === 1);
  const v2 = ctx.versions.find((v) => v.document_id === roadmapId && v.number === 2);
  if (!v1 || !v2) return;
  const extra = (like: Item, key: string, title: string, horizon: Item["horizon"]): Item => ({
    ...structuredClone(like), id: mockUuid(), item_key: key, title, horizon, milestone: horizon === "now" ? { name: "First release" } : null,
    prd: { ...like.prd, section_key: null, section_hash: null },
  });
  const first = itemsFor(ctx, v1, trackId);
  db.items[v1.id] = [...first, extra(first[0], "item-exports", "Usage exports", "later")].map((i, position) => ({ ...i, position }));
  const second = itemsFor(ctx, v2, trackId).map((i) => (i.item_key === "item-behaviour" ? { ...i, horizon: "next" as const } : i));
  db.items[v2.id] = [extra(second[0], "item-limits", "Spend limits", "now"), ...second].map((i, position) => ({ ...i, position }));
}

type Side = { doc: Doc; v: Version; kind: Schemas["ItemsRef"]["kind"]; items: Item[] };

/** A PRD version's ready draft roadmap (E1), if any. */
function readyDraft(ctx: RoadmapContext, doc: Doc, n: number): DraftItems | undefined {
  return ctx.drafts?.().find((r) => r.document_id === doc.id && r.version === n && r.status === "ready");
}

/** Whether a roadmap version's items trace to the PRD. */
const tracesTo = (db: RoadmapDb, v: Version, prdId: string) => (db.items[v.id] ?? []).some((i) => i.prd.document?.id === prdId);

/**
 * E3: GET /v1/roadmap-items/diff, a roadmap version's items or a PRD draft's (E3b) against
 * another's (api/oracle/roadmap/diff_views.py).
 */
function itemsDiff(ctx: RoadmapContext, db: RoadmapDb, q: URLSearchParams): Response {
  const parse = (ref: string | null): Side | Response => {
    const m = /^([^@\s]+)@([1-9][0-9]{0,5})$/.exec(ref ?? "");
    if (!m) return json(422, { detail: `'${ref}' is not a ref: write <slug>@<version>` });
    const doc = ctx.documents.find((d) => d.slug === m[1]);
    const v = doc && ctx.versions.find((x) => x.document_id === doc.id && x.number === Number(m[2]));
    if (!doc || !v) return notFound(doc ? `version ${m[2]} of '${doc.slug}'` : `document '${m[1]}'`);
    if (doc.kind === "prd") {
      const draft = readyDraft(ctx, doc, v.number);
      if (!draft) return json(409, { detail: `Roadmap items for v${v.number} are not ready yet` });
      return { doc, v, kind: "prd_draft", items: draft.items };
    }
    if (doc.kind !== "roadmap") return json(422, { detail: `'${doc.slug}' is a ${doc.kind}: it has no roadmap items` });
    return { doc, v, kind: "roadmap", items: db.items[v.id] ?? [] };
  };
  const head = parse(q.get("head"));
  if (head instanceof Response) return head;
  const label = (s: Side) => `${s.kind === "prd_draft" ? "Draft" : "Roadmap"} v${s.v.number}`;
  const ref = (s: Side): Schemas["ItemsRef"] => ({ ref: `${s.doc.slug}@${s.v.number}`, kind: s.kind, label: label(s), document: docRef(s.doc, s.v) });
  const roadmapSide = (v: Version): Side => ({ doc: ctx.documents.find((d) => d.id === v.document_id)!, v, kind: "roadmap", items: db.items[v.id] ?? [] });
  let previous: Side | undefined;
  let approved: Side | undefined;
  if (head.kind === "prd_draft") {
    const earlier = ctx.versions
      .filter((v) => v.document_id === head.doc.id && v.number < head.v.number && readyDraft(ctx, head.doc, v.number))
      .sort((a, b) => b.number - a.number)[0];
    if (earlier) previous = { doc: head.doc, v: earlier, kind: "prd_draft", items: readyDraft(ctx, head.doc, earlier.number)!.items };
    // The approved plan: the latest approved roadmap version tracing to the PRD, its track's roadmap first.
    const own = db.tracks.find((t) => t.prd_id === head.doc.id)?.roadmap_id;
    const plan = ctx.versions
      .filter((v) => v.approved_at && tracesTo(db, v, head.doc.id))
      .sort((a, b) => Number(b.document_id === own) - Number(a.document_id === own) || (b.approved_at ?? "").localeCompare(a.approved_at ?? "") || b.number - a.number)[0];
    if (plan) approved = roadmapSide(plan);
  } else {
    const others = ctx.versions
      .filter((v) => v.document_id === head.doc.id && v.id !== head.v.id && db.items[v.id]?.length)
      .sort((a, b) => b.number - a.number);
    const p = others.find((v) => v.number < head.v.number);
    const a = others.find((v) => v.approved_at);
    previous = p && roadmapSide(p);
    approved = a && roadmapSide(a);
  }
  const base = q.get("base") ?? "previous";
  let against: Side | undefined;
  if (base === "previous") against = previous;
  else if (base === "approved") against = approved;
  else {
    if (!base.includes("@")) return json(422, { detail: `base must be previous, approved or a ref, not '${base}'` });
    const other = json(422, { detail: `'${base}' is not a version of '${head.doc.slug}'` });
    const named = parse(base);
    if (named instanceof Response) {
      const sameDraft = named.status === 409 && head.kind === "prd_draft" && base.split("@")[0] === head.doc.slug;
      return named.status === 404 || sameDraft ? named : other;
    }
    const fits = named.doc.id === head.doc.id || (head.kind === "prd_draft" && named.kind === "roadmap" && tracesTo(db, named.v, head.doc.id));
    if (!fits) return other;
    against = named;
  }
  const option = (s?: Side) => (s ? { ref: ref(s).ref, label: label(s) } : null);
  const out: Schemas["ItemsDiffOut"] = {
    head: ref(head), base: null, options: { previous: option(previous), approved: option(approved) }, summary: null, items: [],
  };
  if (!against) return json(200, out);
  const live = (s: Side) => s.items.map((i) => liveItem(db, i));
  const diff = diffItems(live(against), live(head));
  return json(200, { ...out, base: ref(against), summary: diff.summary, items: diff.items });
}

/**
 * E3: GET /v1/roadmap-items/history, an item across the PRD's ready drafts (E3b) and the
 * roadmap versions tracing to it, in the order their items were stored.
 */
function itemHistory(ctx: RoadmapContext, db: RoadmapDb, q: URLSearchParams): Response {
  const prd = ctx.documents.find((d) => d.slug === q.get("prd"));
  if (!prd) return notFound(`document '${q.get("prd")}'`);
  const key = q.get("item_key") ?? "";
  type Stored = { kind: Schemas["ItemsRef"]["kind"]; v: Version; at: string; items: Item[] };
  const stored: Stored[] = [
    ...ctx.versions
      .filter((v) => (db.items[v.id] ?? []).some((i) => i.prd.document?.id === prd.id))
      .map((v): Stored => ({ kind: "roadmap", v, at: v.created_at ?? AT, items: db.items[v.id] ?? [] })),
    ...(ctx.drafts?.() ?? [])
      .filter((r) => r.document_id === prd.id && r.status === "ready")
      .flatMap((r): Stored[] => {
        const v = ctx.versions.find((x) => x.document_id === prd.id && x.number === r.version);
        return v ? [{ kind: "prd_draft", v, at: r.ready_at ?? AT, items: r.items }] : [];
      }),
  ]
    .sort((a, b) => a.at.localeCompare(b.at) || a.v.number - b.v.number)
    .slice(-50);
  const entries: Schemas["RoadmapItemHistoryEntry"][] = [];
  let last: Item | null = null;
  for (const { kind, v, at, items } of stored) {
    const found = items.find((i) => i.item_key === key);
    const item = found ? liveItem(db, found) : null;
    if (!item && !last) continue;
    const doc = ctx.documents.find((d) => d.id === v.document_id)!;
    const label = `${kind === "prd_draft" ? "Draft" : "Roadmap"} v${v.number}`;
    const common = { ref: `${doc.slug}@${v.number}`, kind, label, approved: !!v.approved_at, at };
    if (!item) {
      entries.push({ ...common, present: false, title: null, horizon: null, milestone_name: null, milestone_date: null, change: "dropped" });
      last = null;
      continue;
    }
    const s = snapshot(item);
    const change = last ? diffItems([last], [item]).items[0].change : "added";
    entries.push({ ...common, present: true, title: s.title, horizon: s.horizon, milestone_name: s.milestone_name, milestone_date: s.milestone_date, change });
    last = item;
  }
  return json(200, { prd: { id: prd.id, slug: prd.slug, title: prd.title, version: null, approved: null }, item_key: key, entries });
}

/** The fixture's item in place of `seed`, keeping the mock's ids; its basis named by reference. */
function fromFixture(db: RoadmapDb, seed: Item): Item {
  const f = (itemsFixture.items as unknown as Item[]).find((x) => x.item_key === seed.item_key);
  if (!f) return seed;
  const item = structuredClone(f);
  const ms = item.milestone as { date_source?: string | null; basis_ids?: string[] } | null;
  if (ms?.basis_ids) ms.basis_ids = db.bases.filter((b) => b.reference === ms.date_source).map((b) => b.id);
  return {
    ...item,
    id: seed.id,
    track_id: seed.track_id,
    prd: { ...item.prd, document: seed.prd.document, section_hash: seed.prd.section_hash },
  };
}

/**
 * An item's milestone as it stands now, as the API's live_milestones re-check: a date stays
 * only while a verified basis it rests on (basis_ids, or the date_source reference) supports
 * it; one whose basis was withdrawn comes back refused. An item that names no basis the mock
 * knows keeps its date (the default seed has no item dates).
 */
function liveItem(db: RoadmapDb, item: Item): Item {
  const ms = item.milestone as { date?: string | null; date_source?: string | null; basis_ids?: string[] } | null;
  if (!ms?.date) return item;
  const named = db.bases.filter((b) => ms.basis_ids?.includes(b.id) || (!!ms.date_source && b.reference === ms.date_source));
  if (!named.length || (item.horizon === "now" && named.some((b) => b.status === "verified" && b.supports_date === ms.date))) return item;
  return {
    ...item,
    milestone: { ...ms, date: null, basis_ids: [], refused_date: ms.date, refused: item.horizon === "now" ? DATE_UNVERIFIED : OUTSIDE_NOW },
  };
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
    .map((r) => ({ id: r.id, tracker: r.tracker, external_ref: r.external_ref, state: r.state, raw_status: r.raw_status, target_date: r.target_date, estimate: r.estimate, url: r.url }));
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

/**
 * An item's stale reasons as one line, as the API says them (oracle.roadmap.staleness.stale_why,
 * #505): one counted line per verb, the latest, so two bulk writes never read as two counts.
 */
function staleWhy(reasons: readonly string[], fallback: string): string {
  const counted = /^(\d+) baseline items? (.+)$/;
  const out: string[] = [];
  for (const r of reasons) {
    const verb = counted.exec(r)?.[2];
    if (verb) out.splice(0, out.length, ...out.filter((o) => counted.exec(o)?.[2] !== verb));
    if (!out.includes(r)) out.push(r);
  }
  return out.join("; ") || fallback;
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
    if (i.freshness === "potentially_stale" || i.freshness === "under_review") reasons.push({ kind: "stale", detail: staleWhy(i.stale_reasons, "its PRD trace changed") });
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
  // F3, as oracle.members.leads.date_rights: leads and owners verify; an approver
  // verifies while no lead is named and proposes once one is.
  const rights = (): "verify" | "propose" | null =>
    ctx.role === "owner" || (!!ctx.engineeringLead && can("commenter")) ? "verify" : can("approver") ? (ctx.leadNamed ? "propose" : "verify") : null;
  const notVerifier = () => json(403, { detail: "Requires the approver role or the engineering lead" });
  const notDecider = () => json(403, { detail: "Requires the engineering lead or an owner" });
  const findDoc = (ref: string) => ctx.documents.find((d) => d.id === ref || d.slug === ref);
  const findTrack = (id: string) => db.tracks.find((t) => t.id === id);

  // E3: /v1/roadmap-items/diff | /history
  if (p[1] === "roadmap-items" && m === "GET") {
    if (p[2] === "diff" && !p[3]) return itemsDiff(ctx, db, q);
    if (p[2] === "history" && !p[3]) return itemHistory(ctx, db, q);
    return null;
  }

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
        items: (v ? db.items[v.id] ?? [] : []).map((i) => withEngineering(db, liveItem(db, i), view)),
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
      return json(200, { changed, items: (v ? db.items[v.id] ?? [] : []).map((i) => withEngineering(db, liveItem(db, i), "full")) });
    }
    if (p[3] === "versions" && p[5] === "items" && m === "PUT") {
      if (!can("approver")) return forbidden();
      return json(422, { detail: { message: "roadmap_items.yaml was refused", problems: [{ code: "mock", message: "The mock does not parse roadmap_items.yaml; use the real API." }] } });
    }
    return null;
  }

  // F2: /v1/track-alerts[/{id}/keep|reopen|accept-date]
  if (p[1] === "track-alerts") return trackAlerts(ctx, db, m, p, q, body);

  // /v1/schedule-bases[/{id}/withdraw]
  if (p[1] === "schedule-bases") {
    if (!p[2] && m === "GET") {
      const prd = q.get("prd") ? findDoc(q.get("prd")!) : undefined;
      if (q.get("prd") && !prd) return notFound(`document '${q.get("prd")}'`);
      const item = q.get("item_key");
      return json(200, db.bases.filter((b) => (!prd || b.prd_document_id === prd.id) && (!q.get("status") || b.status === q.get("status")) && (!item || b.item_key === item)));
    }
    if (p[2] === "rights" && m === "GET") return json(200, { rights: rights(), lead_named: !!ctx.leadNamed });
    if (!p[2] && m === "POST") {
      const may = rights();
      if (!may) return notVerifier();
      const b = await body<Schemas["ScheduleBasisCreate"]>();
      // O4: a basis is recorded for one PRD, optionally one item or one tracker issue.
      if (!b.prd) return json(422, { detail: "prd: a schedule basis is recorded for one PRD" });
      if (b.item_key && b.tracker_key) return json(422, { detail: "name an item_key or a tracker_key, not both" });
      const prd = findDoc(b.prd);
      if (!prd) return notFound(`document '${b.prd}'`);
      // From a tracker record: the record's own target date must be that date.
      if (b.tracker_record_id) {
        const rec = db.records.find((r) => r.id === b.tracker_record_id);
        if (!rec) return notFound("Tracker record");
        if (rec.target_date !== b.supports_date)
          return json(422, { detail: `tracker record ${rec.external_ref} targets ${rec.target_date}, not ${b.supports_date}` });
      }
      const verified = may === "verify";
      const row: Basis = {
        id: mockUuid(), kind: b.kind, reference: b.reference.trim(), supports_date: b.supports_date, detail: b.detail ?? null,
        prd_document_id: prd.id, item_key: b.item_key ?? null, tracker_key: b.tracker_key ?? null, tracker_record_id: b.tracker_record_id ?? null,
        status: verified ? "verified" : "proposed", note: b.note ?? null,
        proposed_by: verified ? null : ctx.userId, proposed_at: verified ? null : now(),
        verified_by: verified ? ctx.userId : null, verified_at: verified ? now() : null, withdrawn_by: null, withdrawn_at: null,
        withdrawn_reason: null, rejected_by: null, rejected_at: null, rejected_reason: null, created_at: now(),
      };
      db.bases.push(row);
      return json(201, row);
    }
    const row = p[2] ? db.bases.find((b) => b.id === p[2]) : undefined;
    // F3: what withdrawing would change, writing nothing.
    if (p[2] && p[3] === "impact" && m === "GET") {
      if (!row) return notFound("Schedule basis");
      const milestones = db.milestones
        .filter((x) => x.basis_ids.includes(row.id))
        .map((x) => ({
          id: x.id, track_id: x.track_id, name: x.name, target_date: x.target_date,
          keeps_date: x.basis_ids.some((id) => id !== row.id && db.bases.find((b) => b.id === id)?.status === "verified"),
        }));
      const items: Schemas["ImpactItem"][] = [];
      const documents: Schemas["ImpactDocument"][] = [];
      if (row.status === "verified") {
        for (const v of ctx.versions) {
          const doc = ctx.documents.find((d) => d.id === v.document_id);
          if (!doc || doc.kind !== "roadmap" || v.source?.document_id !== row.prd_document_id || latest(ctx, doc.id)?.id !== v.id) continue;
          for (const i of db.items[v.id] ?? []) {
            const ms = liveItem(db, i).milestone;
            if (ms?.date === row.supports_date && ((ms?.basis_ids ?? []) as string[]).includes(row.id)) {
              items.push({ id: i.id, roadmap: doc.slug, version: v.number, item_key: i.item_key });
            }
          }
          const sections = v.sections as unknown as Parameters<typeof dateMarks>[2];
          const marks = dateMarks(db, row.prd_document_id, sections).filter(
            (mk) => mk.status === "verified" && mk.date === row.supports_date && mk.bases.length === 1 && mk.bases[0] === row.reference,
          ).length;
          if (marks) documents.push({ slug: doc.slug, version: v.number, marks });
        }
      }
      return json(200, { basis_id: row.id, milestones, items, documents });
    }
    if (p[2] && (p[3] === "verify" || p[3] === "reject") && m === "POST") {
      if (rights() !== "verify") return notDecider();
      if (!row) return notFound("Schedule basis");
      if (row.status !== "proposed") return json(409, { detail: `Only a proposed basis is decided; this one is ${row.status}` });
      const b = await body<{ note?: string | null; reason?: string }>();
      if (p[3] === "verify") Object.assign(row, { status: "verified", verified_by: ctx.userId, verified_at: now(), note: b?.note ?? row.note });
      else {
        if (!b?.reason?.trim()) return json(422, { detail: "reason: a rejection needs a reason" });
        Object.assign(row, { status: "rejected", rejected_by: ctx.userId, rejected_at: now(), rejected_reason: b.reason });
      }
      return json(200, row);
    }
    if (p[2] && p[3] === "withdraw" && m === "POST") {
      if (rights() !== "verify") return notDecider();
      if (!row) return notFound("Schedule basis");
      if (row.status === "withdrawn") return json(409, { detail: "This schedule basis is already withdrawn" });
      if (row.status !== "verified") return json(409, { detail: `Only a verified basis is withdrawn; this one is ${row.status}` });
      const b = await body<{ reason?: string }>();
      if (!b?.reason?.trim()) return json(422, { detail: "reason: a withdrawal needs a reason" });
      Object.assign(row, { status: "withdrawn", withdrawn_by: ctx.userId, withdrawn_at: now(), withdrawn_reason: b.reason });
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

  // /v1/tracker/connector | /v1/tracker/records | /v1/tracker/issues | /v1/tracker/links (F7)
  if (p[1] === "tracker") {
    if (p[2] === "issues" || p[2] === "links") {
      if (rights() === null) return notVerifier();
      return trackerLinks(ctx, db, m, p, q, body);
    }
    if (p[2] === "connector" && m === "GET") return json(200, connector());
    // F2: a tracker record's history.
    if (p[2] === "records" && p[3] && p[4] === "events" && !p[5] && m === "GET") {
      if (!db.records.some((r) => r.id === p[3]) && !(db.recordEvents ?? []).some((e) => e.record_id === p[3])) return notFound("Tracker record");
      return json(200, (db.recordEvents ?? []).filter((e) => e.record_id === p[3]).map(({ observed_at, field, before, after }) => ({ observed_at, field, before, after })));
    }
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
      Object.assign(t, { title: b.title ?? t.title, status: b.status ?? t.status, owner_id: "owner_id" in b ? b.owner_id ?? null : t.owner_id, lock_version: t.lock_version + 1 });
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

// --- O4 'document dates' ---------------------------------------------------------------

const ISO_DATE = /(?<![0-9])(\d{4})-(\d{2})-(\d{2})(?![0-9])/g;
const MARK_RANK = { withdrawn: 0, unverified: 1, verified: 2 } as const;
const ITEM_ANCHOR = /^(?:now|next|later)-(.+)$/;

/**
 * The dates a roadmap version's text writes, each checked against its PRD's schedule
 * bases now (oracle.roadmap.doc_dates, simplified: ISO dates in headings and bodies; a
 * basis with an item key counts in that item's own section). One mark per date and
 * section, worst status; Sources and data points (and its sub-sections) are not read.
 */
export function dateMarks(
  db: RoadmapDb,
  prdId: string | undefined,
  sections: { section_key: string; level: number; heading: string; body_md: string }[],
): Schemas["DateMarkOut"][] {
  const out = new Map<string, Schemas["DateMarkOut"]>();
  let sourcesLevel: number | null = null;
  for (const s of sections) {
    if (s.section_key === "sources") {
      sourcesLevel = s.level;
      continue;
    }
    if (sourcesLevel != null && s.level > sourcesLevel) continue;
    sourcesLevel = null;
    // The mock keys an item by its section (item-<key>); a draft anchors it <horizon>-<key>.
    const owner = ITEM_ANCHOR.exec(s.section_key)?.[1] ?? s.section_key;
    const places: [Schemas["DateMarkOut"]["where"], string][] = [
      ["heading", s.heading],
      ["body", s.body_md.replace(/\]\([^)\s]*\)/g, "]()")],
    ];
    for (const [where, text] of places) {
      for (const m of text.matchAll(ISO_DATE)) {
        const day = m[0];
        const covers = (b: Basis) => b.prd_document_id === prdId && b.supports_date === day && (!b.item_key || b.item_key === owner);
        const verified = db.bases.filter((b) => b.status === "verified" && covers(b));
        const withdrawn = db.bases.filter((b) => b.status === "withdrawn" && covers(b));
        const status = verified.length ? "verified" : withdrawn.length ? "withdrawn" : "unverified";
        const mark: Schemas["DateMarkOut"] = {
          section_key: s.section_key,
          text: day,
          date: day,
          status,
          label: status === "verified" ? null : status === "withdrawn" ? "date withdrawn" : "unverified",
          bases: (verified.length ? verified : withdrawn).map((b) => b.reference),
          where,
        };
        const key = `${s.section_key}|${day}`;
        const had = out.get(key);
        if (!had || MARK_RANK[status] < MARK_RANK[had.status]) out.set(key, mark);
      }
    }
  }
  return [...out.values()];
}

// --- F1 Plan screen: GET /v1/plan, GET /v1/plan/items/history -----------------------------

type PlanItem = Schemas["PlanItem"];
type PlanPrd = Schemas["PlanPrd"];
type Who = Schemas["PlanWho"];
type Horizon = PlanItem["horizon"];

export interface PlanContext extends RoadmapContext {
  /** The baseline's goals (id and key), for the items' goal ids. */
  goals: { id: string; key: string }[];
  /** #346: the versions change sets proposed (./plan-edits.ts); an approved one is the live plan. */
  edits?: PlanEditsDb;
}

/** One item of the mock plan: an approved row, its draft twin (when the roadmap draft changes it), or a new draft row. */
type PlanSeedItem = {
  key: string;
  title: string;
  horizon: Horizon;
  goals?: string[];
  state?: PlanItem["state"];
  records?: { ref: string; state: "todo" | "in_progress" | "done"; target?: string }[];
  date?: string;
  dateStatus?: "verified" | "unverified" | "withdrawn";
  /** The milestone's date_source: the text that names the basis references the date rests on. */
  dateSource?: string;
  slipDays?: number;
  reasons?: { kind: string; detail: string }[];
  next?: { action: NonNullable<Schemas["PlanNext"]["action"]>; who: Who["role"] };
  section: string;
};

export const ALERTS_ROADMAP_SLUG = "usage-alerts-roadmap";
const CHECKOUT_ROADMAP_SLUG = "checkout-redesign-roadmap";
const NEXT_LABEL: Record<NonNullable<Schemas["PlanNext"]["action"]>, string> = {
  review_prd: "PRD review",
  verify_date: "Verify date",
  reverify_date: "Re-verify date",
  decide_slip: "Decide on slip",
  resolve_blocker: "Resolve blocker",
  reconcile: "Reconcile",
  link_issue: "Link issue",
};

/** The tracked PRD's approved roadmap (usage-alerts-roadmap v1, from Usage alerts PRD v1). */
const ALERTS_APPROVED: PlanSeedItem[] = [
  { key: "threshold-alerts", title: "Threshold alerts on spend", horizon: "now", goals: ["g.activation"], state: "on_track", section: "behaviour",
    records: [{ ref: "ENG-402", state: "in_progress" }], date: "2026-11-20", dateStatus: "verified", dateSource: "ENG-402" },
  { key: "alert-digest", title: "Daily alert digest email", horizon: "now", goals: ["g.paid-conversion"], state: "at_risk", section: "behaviour",
    records: [{ ref: "ENG-405", state: "in_progress", target: "2026-12-09" }], date: "2026-11-30", dateStatus: "verified", dateSource: "ENG-412", slipDays: 9,
    reasons: [
      // #505: two bulk baseline writes marked it stale, as the API's stale reasons read.
      { kind: "stale", detail: staleWhy(["42 baseline items changed", "11 baseline items changed"], "its PRD trace changed") },
      { kind: "slipping", detail: "ENG-405 targets 2026-12-09, after the milestone date 2026-11-30." },
    ],
    next: { action: "decide_slip", who: "owner" } },
  { key: "alert-rules-api", title: "Alert rules API", horizon: "now", goals: ["g.activation"], state: "done", section: "behaviour",
    records: [{ ref: "ENG-398", state: "done" }] },
  { key: "slack-alerts", title: "Alerts in the team chat", horizon: "now", goals: ["g.activation"], state: "on_track", section: "behaviour",
    records: [{ ref: "ENG-431", state: "todo" }], date: "2026-12-15", dateStatus: "unverified", dateSource: "ENG-431", next: { action: "verify_date", who: "approver" } },
  { key: "usage-dashboard", title: "Usage dashboard", horizon: "now", goals: ["g.activation"], state: "planned", section: "behaviour",
    next: { action: "link_issue", who: "approver" } },
  { key: "spend-forecast", title: "Spend forecast for the month", horizon: "next", state: "planned", section: "behaviour",
    next: { action: "link_issue", who: "approver" } },
  { key: "team-budgets", title: "Budgets per team", horizon: "later", goals: ["g.early-churn"], state: "planned", section: "behaviour" },
];
/** The seeded approved plan's items (usage-alerts-roadmap v1), for a change set's base (#346). */
export function seededPlanItems(slug: string, version: number): PlanEditItem[] | null {
  if (slug !== ALERTS_ROADMAP_SLUG || version !== 1) return null;
  return ALERTS_APPROVED.map((i) => ({ key: i.key, title: i.title, horizon: i.horizon }));
}

/** The latest approved version a change set proposed, with its items (#346). */
function editedPlan(ctx: PlanContext, slug: string): { version: number; items: PlanEditItem[] } | null {
  const doc = ctx.documents.find((d) => d.slug === slug);
  const proposed = ctx.edits?.versions[slug];
  if (!doc || !proposed) return null;
  const approved = ctx.versions.filter((v) => v.document_id === doc.id && v.approved_at && proposed[v.number]).map((v) => v.number);
  if (!approved.length) return null;
  const version = Math.max(...approved);
  return { version, items: proposed[version] };
}

/** usage-alerts-roadmap draft 2: twins of approved items (E3: only plan changes count). */
const ALERTS_DRAFT: Record<string, { horizon?: Horizon; change: Schemas["ItemChange"] }> = {
  "alert-rules-api": { change: { kind: "unchanged", fields: [], notes: ["confidence"] } },
  "usage-dashboard": { change: { kind: "changed", fields: ["outcome"], notes: [] } },
  "spend-forecast": { horizon: "now", change: { kind: "moved", from_horizon: "next", to_horizon: "now", fields: ["horizon"], notes: [] } },
  "team-budgets": { change: { kind: "dropped", draft_version: 2, fields: [], notes: [] } },
};
/** checkout-redesign-roadmap draft 2, from Checkout redesign PRD v2 (never approved): every item new. */
const CHECKOUT_DRAFT: PlanSeedItem[] = [
  { key: "one-page-checkout", title: "One-page checkout", horizon: "now", goals: ["g.paid-conversion"], section: "problem" },
  { key: "saved-addresses", title: "Saved addresses as cards", horizon: "next", goals: ["g.paid-conversion"], section: "s-5-3" },
  { key: "shipping-choices", title: "Three clear shipping choices", horizon: "later", section: "s-5-2" },
];

/**
 * The Plan's mock (api/oracle/plan): a tracked PRD (Usage alerts, with a roadmap draft 2 that
 * moves, changes and drops items), a PRD waiting at the feature set checkpoint (Saved carts),
 * a PRD at the engineering check with a lead named (Clinic outreach), and a never-approved PRD
 * with a roadmap draft (Checkout redesign); the other PRDs by their versions. Simplified on
 * purpose: the rows are seeded with the state, engineering and next decision the API's rules
 * give them, not computed from the other mocks.
 */
export function routePlan(ctx: PlanContext, db: RoadmapDb, req: Request, p: string[], q: URLSearchParams): Response | null {
  if (p[1] !== "plan" || req.method !== "GET") return null;
  if (p[2] === "items" && p[3] === "history") return planHistory(db, q);
  if (p[2]) return null;
  const scope = q.get("scope") ?? "all";
  if (scope !== "all" && scope !== "approved") return json(422, { detail: "scope: all or approved" });
  return json(200, planOut(ctx, db, scope));
}

/**
 * Whether `text` names `reference` as an exact token, case-insensitively, as the API's
 * schedule._names: not inside a longer key (ENG-41 is not named by ENG-41-2, ENG-41.2,
 * A-ENG-41 or ENG-412); trailing punctuation (ENG-41.) is not part of it.
 */
function namesReference(reference: string, text: string): boolean {
  const ref = reference.trim();
  if (!ref) return false;
  const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_])(?<![A-Za-z0-9][-./])${escaped}(?![A-Za-z0-9_])(?![-./][A-Za-z0-9])`, "i").test(text);
}

/**
 * F3: the seeded date status as the bases now stand, and the bases the date rests on (verified) or
 * lost (withdrawn), as the API's plan reads them (schedule.supporting, then plan._engineering):
 * verified while, in Now, a verified basis of the PRD supports exactly the date, covers this item
 * (the whole PRD, this item, or a tracker issue matched to it) and is named in the date's source,
 * and those are its basis_ids; otherwise withdrawn when a withdrawn basis of the PRD is named
 * there, with the named withdrawn ones that supported the date for this item; else unverified. A
 * date whose source names no basis the mock knows keeps its seeded status and lists no basis.
 */
function dateStatus(
  db: RoadmapDb,
  prdId: string,
  s: PlanSeedItem,
): { date_status: NonNullable<PlanSeedItem["dateStatus"]> | null; basis_ids: string[] } {
  const seeded = { date_status: s.dateStatus ?? null, basis_ids: [] };
  if (!s.date) return seeded;
  const source = s.dateSource ?? "";
  const named = db.bases.filter((b) => b.prd_document_id === prdId && namesReference(b.reference, source));
  if (!named.length) return seeded;
  const covers = (b: Basis) =>
    b.item_key
      ? b.item_key === s.key
      : b.tracker_key
        ? db.records.some((r) => r.external_ref === b.tracker_key && r.item_key === s.key && db.tracks.find((t) => t.id === r.track_id)?.prd_id === prdId)
        : true;
  const supporting = (status: Basis["status"]) =>
    named
      .filter((b) => b.status === status && b.supports_date === s.date && covers(b))
      .map((b) => b.id)
      .sort();
  const verified = s.horizon === "now" ? supporting("verified") : [];
  if (verified.length) return { date_status: "verified", basis_ids: verified };
  if (named.some((b) => b.status === "withdrawn")) return { date_status: "withdrawn", basis_ids: supporting("withdrawn") };
  return { date_status: "unverified", basis_ids: [] };
}

function planHistory(db: RoadmapDb, q: URLSearchParams): Response {
  const roadmap = q.get("roadmap");
  const key = q.get("item") ?? "";
  // F2 §2: the tracker history of the item's issues (the Plan's seeded records), oldest first.
  const refs = new Map(
    (roadmap === ALERTS_ROADMAP_SLUG ? (ALERTS_APPROVED.find((i) => i.key === key)?.records ?? []) : []).map((r) => [stableUuid(`plan:record:${r.ref}#0`), r.ref]),
  );
  const tracker_events: Schemas["ItemTrackerEvent"][] = (db.recordEvents ?? [])
    .filter((e) => refs.has(e.record_id))
    .map((e) => ({ record_id: e.record_id, tracker: "linear", external_ref: refs.get(e.record_id)!, observed_at: e.observed_at, field: e.field, before: e.before ?? null, after: e.after ?? null }))
    .sort((a, b) => a.observed_at.localeCompare(b.observed_at));
  const out = (versions: Schemas["ItemVersion"][]): Response => json(200, { roadmap, item: key, versions, tracker_events });
  if (roadmap === ALERTS_ROADMAP_SLUG) {
    const a = ALERTS_APPROVED.find((i) => i.key === key);
    if (!a) return out([]);
    const versions: Schemas["ItemVersion"][] = [{ version: 1, prd_version: 1, horizon: a.horizon, approved_at: "2026-10-18T10:00:00Z" }];
    const d = ALERTS_DRAFT[key];
    if (!d || d.change.kind !== "dropped") versions.push({ version: 2, prd_version: 1, horizon: d?.horizon ?? a.horizon, approved_at: null });
    return out(versions);
  }
  if (roadmap === CHECKOUT_ROADMAP_SLUG) {
    const d = CHECKOUT_DRAFT.find((i) => i.key === key);
    return out(d ? [{ version: 2, prd_version: 2, horizon: d.horizon, approved_at: null }] : []);
  }
  return notFound(`document '${roadmap}'`);
}

function planOut(ctx: PlanContext, db: RoadmapDb, scope: string): Schemas["PlanOut"] {
  const may = (role: Who["role"]) => RANK[ctx.role] >= RANK[(role === "engineering_lead" || role === "track_owner" ? "approver" : role) as Role];
  const doc = (slug: string) => ctx.documents.find((d) => d.slug === slug);
  const goalIds = (keys: string[] = []) => keys.map((k) => ctx.goals.find((g) => g.key === k)?.id).filter((id): id is string => !!id);
  const alerts = doc("usage-alerts");
  const checkout = doc("checkout-redesign");
  const track = alerts ? db.tracks.find((t) => t.prd_id === alerts.id) : undefined;

  const row = (
    s: PlanSeedItem,
    prd: Doc,
    prdVersion: number,
    roadmap: { slug: string; version: number },
    origin: PlanItem["origin"],
    change: Schemas["ItemChange"] | null,
    horizon: Horizon = s.horizon,
  ): PlanItem => {
    const records = [
      ...(s.records ?? []).map((r) => ({
        id: seeded(`plan:record:${r.ref}`, mockUuid), tracker: "linear" as const, external_ref: r.ref, state: r.state, raw_status: null,
        target_date: r.target ?? null, estimate: null, url: `https://tracker.example.com/${r.ref}`,
      })),
      // F7: issues linked to this item (matched by PRD and item key; the mock's rows carry no track).
      ...(db.records as LinkedRecord[])
        .filter((r) => r.prd_document_id === prd.id && r.item_key === s.key)
        .map((r) => ({ id: r.id, tracker: r.tracker, external_ref: r.external_ref, state: r.state, raw_status: r.raw_status, target_date: r.target_date, estimate: r.estimate, url: r.url })),
    ];
    const href = `/documents/${prd.slug}/v/${prdVersion}`;
    // F2: a slip accepted from its alert: the item rests on the tracker's date now.
    // Its date source names the new basis (the API moves the milestone onto it), so F3's
    // dateStatus reads it verified rather than the withdrawn basis of the old date.
    const accepted = origin === "approved" && prd.slug === "usage-alerts" ? db.accepted?.[s.key] : undefined;
    if (accepted) s = { ...s, date: accepted.day, dateSource: accepted.reference, dateStatus: "verified", slipDays: undefined, state: "on_track", reasons: [], next: undefined };
    const next: Schemas["PlanNext"] =
      origin === "draft"
        ? { action: "review_prd", label: "PRD review", who: { role: "approver", user_id: null }, href, viewer_may: may("approver") }
        : s.next && !(s.next.action === "link_issue" && records.length)
          ? { action: s.next.action, label: NEXT_LABEL[s.next.action], who: { role: s.next.who, user_id: null }, href: null, viewer_may: may(s.next.who) }
          : { action: null, label: "—", who: null, href: null, viewer_may: false };
    return {
      id: seeded(`plan:${roadmap.slug}:${roadmap.version}:${s.key}`, mockUuid),
      key: s.key,
      title: s.title,
      outcome: null,
      horizon,
      position: 0,
      origin,
      change,
      prd: { id: prd.id, slug: prd.slug, title: prd.title, version: prdVersion, approved: origin === "approved" || prd.slug === "usage-alerts", link: `${href}#${s.section}` },
      roadmap: { slug: roadmap.slug, version: roadmap.version, anchor: `${horizon}-${s.key}` },
      track_id: prd.slug === "usage-alerts" ? (track?.id ?? null) : null,
      goal_ids: goalIds(s.goals),
      state: origin === "draft" ? "proposed" : (s.state ?? "planned"),
      reasons: origin === "draft" ? [] : (s.reasons ?? []),
      engineering: { records, date: s.date ?? null, ...dateStatus(db, prd.id, s), slip_days: s.slipDays ?? null, tracked: records.length > 0 },
      next,
    };
  };

  const items: PlanItem[] = [];
  const edited = alerts ? editedPlan(ctx, ALERTS_ROADMAP_SLUG) : null;
  if (alerts && edited) {
    // #346: a proposed version the decider approved is the live plan (draft 2 is superseded).
    for (const e of edited.items) {
      const s: PlanSeedItem = { ...(ALERTS_APPROVED.find((a) => a.key === e.key) ?? { section: "behaviour" }), key: e.key, title: e.title, horizon: e.horizon };
      items.push(row(s, alerts, 1, { slug: ALERTS_ROADMAP_SLUG, version: edited.version }, "approved", null));
    }
  } else if (alerts) {
    for (const s of ALERTS_APPROVED) {
      const d = scope === "all" ? ALERTS_DRAFT[s.key] : undefined;
      if (d && d.change.kind !== "dropped") items.push(row(s, alerts, 1, { slug: ALERTS_ROADMAP_SLUG, version: 2 }, "draft", d.change, d.horizon));
      else items.push(row(s, alerts, 1, { slug: ALERTS_ROADMAP_SLUG, version: 1 }, "approved", d?.change ?? null));
    }
  }
  if (checkout && scope === "all") {
    for (const s of CHECKOUT_DRAFT) items.push(row(s, checkout, 2, { slug: CHECKOUT_ROADMAP_SLUG, version: 2 }, "draft", { kind: "new", fields: [], notes: [] }));
  }

  const risky = items.some((i) => i.state === "at_risk" || i.state === "slipped");
  const prds: PlanPrd[] = [];
  const order = new Map<string, number>();
  for (const d of ctx.documents) {
    if ((d.kind ?? "prd") !== "prd") continue;
    const versions = ctx.versions.filter((v) => v.document_id === d.id).sort((a, b) => a.number - b.number);
    const latest = versions.at(-1)?.number ?? null;
    const approved = versions.filter((v) => v.approved_at).at(-1)?.number ?? null;
    const base = {
      document: { id: d.id, slug: d.slug, title: d.title }, latest_version: latest, approved_version: approved,
      run: null, track: null, figure: null, waiting_for_viewer: false, updated_at: d.updated_at ?? AT,
    } satisfies Partial<PlanPrd>;
    let card: PlanPrd;
    if (d.slug === "usage-alerts" && track) {
      card = { ...base, stage: "approved", stage_label: `Approved v${approved}`, journey_step: 9, figure: risky ? "At risk" : "On track",
        track: { id: track.id, status: track.status, health: risky ? "at_risk" : "on_track", owner_id: track.owner_id } };
    } else if (d.slug === "saved-carts") {
      const mine = may("approver");
      card = { ...base, stage: "waiting", stage_label: `Feature set · waiting for ${mine ? "you" : "approver"}`, journey_step: 7, figure: "9 features",
        waiting_for_viewer: mine, run: { id: seeded("plan:run:saved-carts", mockUuid), status: "awaiting_checkpoint", checkpoint: "feature_set", checkpoint_role: "approver", segment: null } };
    } else if (d.slug === "clinic-outreach") {
      // A lead is named (A3): the engineering check waits for them, whoever looks. The run
      // imported the PRD's draft on Oct 20, which updated the document.
      card = { ...base, updated_at: "2026-10-20T08:00:00Z", stage: "waiting", stage_label: "Engineering check · waiting for the engineering lead", journey_step: 7,
        run: { id: seeded("plan:run:clinic-outreach", mockUuid), status: "awaiting_checkpoint", checkpoint: "eng_review", checkpoint_role: "approver", segment: null } };
    } else if (approved != null && latest === approved) {
      continue;
    } else if (latest == null) {
      card = { ...base, stage: "idea", stage_label: "Brief", journey_step: 1 };
    } else {
      const review = d.status === "in_review";
      const draft = d.slug === "checkout-redesign" ? " · roadmap draft 2" : "";
      const label = approved != null ? `Approved v${approved} · draft ${latest}` : `Draft ${latest}`;
      card = { ...base, stage: review ? "in_review" : "draft", stage_label: review ? `${label} in review${draft}` : label, journey_step: 8 };
      if (d.slug === "checkout-redesign" && scope === "all") card.figure = `${CHECKOUT_DRAFT.length} items`;
    }
    order.set(d.id, (card.waiting_for_viewer ? 0 : 2) + (card.track?.health === "at_risk" ? 0 : 1));
    prds.push(card);
  }
  const rank = (c: PlanPrd) => order.get(c.document.id) ?? 3;
  prds.sort((a, b) => rank(a) - rank(b) || b.updated_at.localeCompare(a.updated_at));
  return {
    scope: scope as Schemas["PlanOut"]["scope"],
    generated_at: now(),
    counts: {
      prds: prds.length,
      at_risk: items.filter((i) => i.state === "at_risk" || i.state === "slipped").length,
      proposed: items.filter((i) => i.origin === "draft").length,
      items: items.length,
    },
    prds,
    items,
  };
}

// --- F7 Link tracker issues: GET /v1/tracker/issues, POST /v1/tracker/links, DELETE /v1/tracker/links/{id}

/** A tracker record with F7's link columns (TrackerRecordOut gains them with the API). */
type LinkedRecord = TrackerRecord & {
  prd_document_id?: string | null;
  source_item_id?: string | null;
  linked_by?: string | null;
  linked_at?: string | null;
  refresh_lost_at?: string | null;
};
/** One of the signed-in person's synced GitHub issues (a source item of kind issue), as its text reads. */
type SyncedIssue = { id: string; repo: string; number: number; title: string; raw: string; milestone: { title: string; due: string | null } | null; updated_at: string };

/** The signed-in person's synced GitHub issues (mock rows: GitHub is never called). */
const SYNCED_ISSUES: SyncedIssue[] = [
  { id: stableUuid("tracker-issue/acme/app#412"), repo: "acme/app", number: 412, title: "Saved cards checkout", raw: "open",
    milestone: { title: "Beta", due: "2026-11-30" }, updated_at: "2026-10-20T15:00:00Z" },
  { id: stableUuid("tracker-issue/acme/app#418"), repo: "acme/app", number: 418, title: "Monthly spend forecast", raw: "open",
    milestone: { title: "Beta", due: "2026-11-30" }, updated_at: "2026-10-19T11:00:00Z" },
  { id: stableUuid("tracker-issue/acme/app#425"), repo: "acme/app", number: 425, title: "Usage dashboard charts", raw: "open",
    milestone: null, updated_at: "2026-10-18T09:30:00Z" },
  { id: stableUuid("tracker-issue/acme/app#397"), repo: "acme/app", number: 397, title: "Alert rules endpoint", raw: "closed (completed)",
    milestone: { title: "Alpha", due: "2026-10-15" }, updated_at: "2026-10-15T17:00:00Z" },
];

const issueRef = (i: SyncedIssue) => `${i.repo}#${i.number}`;
const issueUrl = (i: SyncedIssue) => `https://github.com/${i.repo}/issues/${i.number}`;
/** The API's github_issue_facts mapping of the "- State:" line. */
function issueState(raw: string): TrackerRecord["state"] {
  if (raw === "open") return "todo";
  if (raw === "closed" || raw === "closed (completed)") return "done";
  if (raw === "closed (not planned)") return "cancelled";
  return "unknown";
}

/** The plan item a PRD's key names (the mock's Plan rows), with its title. */
function planItem(prdSlug: string, key: string): PlanSeedItem | undefined {
  if (prdSlug === "usage-alerts") return ALERTS_APPROVED.find((i) => i.key === key);
  if (prdSlug === "checkout-redesign") return CHECKOUT_DRAFT.find((i) => i.key === key);
  return undefined;
}

/** The Plan item's title, by its PRD's slug and key (a question about it, C2). */
export const planItemTitle = (prdSlug: string, key: string): string | null => planItem(prdSlug, key)?.title ?? null;

function issueRecord(i: SyncedIssue, prdId: string, itemKey: string, by: string, at = AT): LinkedRecord {
  return {
    id: mockUuid(), tracker: "github", external_ref: issueRef(i), title: i.title, url: issueUrl(i), track_id: null, item_key: itemKey,
    state: issueState(i.raw), raw_status: i.raw, estimate: null, estimate_unit: null, target_date: i.milestone?.due ?? null,
    observed_at: i.updated_at, recorded_by: by, created_at: at, updated_at: at,
    prd_document_id: prdId, source_item_id: i.id, linked_by: by, linked_at: at, refresh_lost_at: null,
  };
}

/** True when `q` names the issue: "#412", "acme/app#412", its URL, or words of its title. */
function issueMatches(i: SyncedIssue, q: string): boolean {
  const t = q.trim().toLowerCase();
  if (!t) return true;
  const url = /github\.com\/([^/\s]+\/[^/\s]+)\/issues\/(\d+)/.exec(t);
  if (url) return i.repo === url[1] && i.number === Number(url[2]);
  const ref = /^(?:([\w.-]+\/[\w.-]+))?#?(\d+)$/.exec(t);
  if (ref) return i.number === Number(ref[2]) && (!ref[1] || ref[1] === i.repo);
  const title = i.title.toLowerCase();
  return t.split(/\s+/).every((w) => title.includes(w));
}

function trackerLinks(
  ctx: RoadmapContext,
  db: RoadmapDb,
  m: string,
  p: string[],
  q: URLSearchParams,
  body: <T>() => Promise<T>,
): Promise<Response | null> | Response | null {
  const records = db.records as LinkedRecord[];
  const linkedOf = (i: SyncedIssue) => records.find((r) => r.source_item_id === i.id && r.item_key && r.prd_document_id);
  const linkOut = (r: LinkedRecord) => {
    const doc = ctx.documents.find((d) => d.id === r.prd_document_id);
    return { prd: doc?.slug ?? "", item_key: r.item_key!, record_id: r.id, item_title: (doc && planItem(doc.slug, r.item_key!)?.title) ?? null };
  };
  if (p[2] === "issues" && !p[3] && m === "GET") {
    const limit = Math.min(Number(q.get("limit") ?? 20) || 20, 50);
    const out = SYNCED_ISSUES.filter((i) => issueMatches(i, q.get("q") ?? "")).slice(0, limit).map((i) => {
      const r = linkedOf(i);
      return {
        source_item_id: i.id, external_ref: issueRef(i), title: i.title, url: issueUrl(i), state: issueState(i.raw), raw_status: i.raw,
        milestone: i.milestone && { title: i.milestone.title, due: i.milestone.due }, linked: r ? linkOut(r) : null,
      };
    });
    return json(200, out);
  }
  if (p[2] === "links" && !p[3] && m === "POST") {
    return (async () => {
      const b = await body<{ prd: string; item_key: string; source_item_id?: string | null; url?: string | null; move?: boolean }>();
      const doc = ctx.documents.find((d) => d.slug === b.prd || d.id === b.prd);
      if (!doc) return notFound(`document '${b.prd}'`);
      if (!planItem(doc.slug, b.item_key)) return json(422, { detail: `'${b.item_key}' is not an item of '${doc.slug}'` });
      const issue = b.source_item_id
        ? SYNCED_ISSUES.find((i) => i.id === b.source_item_id)
        : b.url
          ? SYNCED_ISSUES.find((i) => issueMatches(i, b.url!))
          : undefined;
      if (!issue) return notFound("source item");
      const had = records.find((r) => r.source_item_id === issue.id) ?? records.find((r) => r.tracker === "github" && r.external_ref === issueRef(issue));
      const elsewhere = had?.item_key && had.prd_document_id && !(had.prd_document_id === doc.id && had.item_key === b.item_key);
      if (had && elsewhere && !b.move) {
        const l = linkOut(had);
        return json(409, { detail: { message: `${issueRef(issue)} is linked to ${l.item_title ?? l.item_key}`, linked: { prd: l.prd, item_key: l.item_key, item_title: l.item_title } } });
      }
      const fresh = issueRecord(issue, doc.id, b.item_key, ctx.userId, now());
      if (had) {
        Object.assign(had, { ...fresh, id: had.id, created_at: had.created_at });
        return json(201, had);
      }
      records.push(fresh);
      return json(201, fresh);
    })();
  }
  if (p[2] === "links" && p[3] && !p[4] && m === "DELETE") {
    const r = records.find((x) => x.id === p[3]);
    if (!r) return notFound("tracker record");
    Object.assign(r, { item_key: null, track_id: null, prd_document_id: null, updated_at: now() });
    return new Response(null, { status: 204 });
  }
  return null;
}

// --- F2 Track health: track alerts, their actions and the Inbox's track group -------------

/** The mock scenario (MOCK_SCENARIO_KEY) with one open date slip on Usage alerts (F2). */
export const TRACK_ALERTS_SCENARIO = "track-alerts";
/** "track-alerts" plus two tracker issues not on the roadmap: one track row, three open alerts (#514). */
export const TRACK_ALERTS_MANY_SCENARIO = "track-alerts-many";
/**
 * "track-alerts" plus an open blocker on "Alerts in the team chat" and a synced GitHub issue on
 * the track that no item names (acme/app#425): Open blocker and Link to item.
 */
export const TRACK_ALERTS_ACTIONS_SCENARIO = "track-alerts-actions";
const ACTIONS_BLOCKER_ID = stableUuid("track-alert/slack-alerts/blocker");
type StoredAlert = Omit<TrackAlertOut, "prd" | "actions" | "inbox_state">;
/** The Plan's ENG-405 record (routePlan seeds it as plan:record:ENG-405). */
const SLIP_RECORD_ID = stableUuid("plan:record:ENG-405#0");
const DONE_DAYS = 30;

/**
 * One open date slip: ENG-405 (Daily alert digest email) moved from Nov 30 to Dec 9; Beta rests
 * on Nov 30. `many` adds two open "not on the roadmap" alerts on the same track.
 */
function seedAlerts(db: RoadmapDb, trackId: string, many = false, actions = false) {
  db.alerts = [
    {
      id: stableUuid("track-alert/alert-digest/date_slip"), track_id: trackId, item_key: "alert-digest", item_title: "Daily alert digest email",
      kind: "date_slip", detail: "ENG-405 moved to 2026-12-09; Beta rests on 2026-11-30",
      data: {
        tracker_ref: "ENG-405", tracker_date: "2026-12-09", milestone_date: "2026-11-30", milestone_name: "Beta", slip_days: 9,
        previous_tracker_date: "2026-11-30", changed_at: "2026-10-20T15:00:00Z", record_id: SLIP_RECORD_ID,
      },
      state: "open", opened_at: "2026-10-20T15:02:00Z", kept_by: null, kept_by_name: null, kept_at: null, note: null, resolved_at: null,
    },
  ];
  if (many) {
    for (const [ref, title] of [["ENG-501", "Export retries"], ["ENG-502", "Alert sounds"]]) {
      db.alerts.push({
        id: stableUuid(`track-alert/${ref}/unplanned`), track_id: trackId, item_key: null, item_title: null,
        kind: "unplanned", detail: `${ref} (${title}) is not on the roadmap.`, data: { tracker_ref: ref },
        state: "open", opened_at: "2026-10-20T15:05:00Z", kept_by: null, kept_by_name: null, kept_at: null, note: null, resolved_at: null,
      });
    }
  }
  if (actions) {
    const open = { state: "open" as const, opened_at: "2026-10-20T15:05:00Z", kept_by: null, kept_by_name: null, kept_at: null, note: null, resolved_at: null };
    db.alerts.push(
      {
        id: stableUuid("track-alert/slack-alerts/blocked"), track_id: trackId, item_key: "slack-alerts", item_title: "Alerts in the team chat",
        kind: "blocked", detail: "Chat app review takes two weeks (open)", data: { blocker_id: ACTIONS_BLOCKER_ID, blocker_status: "open" }, ...open,
      },
      {
        id: stableUuid("track-alert/acme/app#425/unplanned"), track_id: trackId, item_key: null, item_title: null,
        kind: "unplanned", detail: "acme/app#425 (Usage dashboard charts) is not on the roadmap", data: { tracker_ref: "acme/app#425" }, ...open,
      },
    );
  }
  db.recordEvents = [{ record_id: SLIP_RECORD_ID, observed_at: "2026-10-20T15:00:00Z", field: "target_date", before: "2026-11-30", after: "2026-12-09" }];
}

/** Ask fits a slip, an overdue item and work started early (F2 §3); Discuss fits every kind. */
const ASK_KINDS: StoredAlert["kind"][] = ["date_slip", "overdue", "ahead"];

/**
 * What the caller may do on the alert now: approvers and owners act; commenters ask and
 * discuss; everyone may open a blocker.
 */
function alertActions(ctx: RoadmapContext, a: StoredAlert): TrackAlertAction[] {
  if (a.state === "resolved") return [];
  const talk: TrackAlertAction[] = RANK[ctx.role] >= RANK.commenter ? [...(ASK_KINDS.includes(a.kind) ? (["ask"] as const) : []), "discuss"] : [];
  if (RANK[ctx.role] < RANK.approver) return [...(a.kind === "blocked" ? (["open_blocker"] as const) : []), ...talk];
  if (a.state === "kept") return [...talk, "reopen"];
  const first: Record<StoredAlert["kind"], TrackAlertAction[]> = {
    date_slip: ["accept_date", "replan"],
    overdue: ["replan"],
    cancelled: ["replan"],
    ahead: ["replan"],
    unplanned: ["link"],
    blocked: ["open_blocker"],
    stale: ["review"],
    prd_moved: ["replan"],
  };
  return [...first[a.kind], ...talk, "keep"];
}

function alertOut(ctx: RoadmapContext, db: RoadmapDb, a: StoredAlert, seen?: string | null): TrackAlertOut {
  const t = db.tracks.find((x) => x.id === a.track_id);
  const prd = t && ctx.documents.find((d) => d.id === t.prd_id);
  const inbox: TrackAlertOut["inbox_state"] =
    seen === undefined ? null : a.state !== "open" ? "done" : seen === null || a.opened_at > seen ? "new" : "open";
  return { ...a, prd: { slug: prd?.slug ?? "", title: prd?.title ?? "" }, actions: alertActions(ctx, a), inbox_state: inbox };
}

function trackAlerts(
  ctx: RoadmapContext,
  db: RoadmapDb,
  m: string,
  p: string[],
  q: URLSearchParams,
  body: <T>() => Promise<T>,
): Response | Promise<Response> | null {
  const alerts = (db.alerts ??= []);
  if (!p[2] && m === "GET") {
    const state = q.get("state") ?? "open";
    if (!["open", "kept", "resolved", "all"].includes(state)) return json(422, { detail: "state: open, kept, resolved or all" });
    const track = q.get("track_id");
    if (track && !db.tracks.some((t) => t.id === track)) return notFound("Track");
    return json(
      200,
      alerts
        .filter((a) => (state === "all" || a.state === state) && (!track || a.track_id === track))
        .sort((a, b) => b.opened_at.localeCompare(a.opened_at))
        .map((a) => alertOut(ctx, db, a)),
    );
  }
  if (!p[2] || !p[3] || p[4] || m !== "POST") return null;
  const a = alerts.find((x) => x.id === p[2]);
  if (!a) return notFound("Track alert");
  const verb = p[3];
  if (verb === "keep") {
    if (RANK[ctx.role] < RANK.approver) return json(403, { detail: "Requires the approver role" });
    if (a.state !== "open") return json(409, { detail: "Only an open alert can be kept" });
    return body<{ note?: string | null } | null>().then((b) => {
      const note = b?.note?.trim() || null;
      if (note && note.length > 500) return json(422, { detail: "note: at most 500 characters" });
      Object.assign(a, { state: "kept", kept_by: ctx.userId, kept_by_name: ctx.userName ?? null, kept_at: now(), note });
      return json(200, alertOut(ctx, db, a));
    });
  }
  if (verb === "reopen") {
    if (RANK[ctx.role] < RANK.approver) return json(403, { detail: "Requires the approver role" });
    if (a.state !== "kept") return json(409, { detail: "Only a kept alert can be reopened" });
    Object.assign(a, { state: "open", kept_by: null, kept_by_name: null, kept_at: null, note: null });
    return json(200, alertOut(ctx, db, a));
  }
  if (verb === "accept-date") {
    const verifies = RANK[ctx.role] >= RANK.approver || (!!ctx.engineeringLead && RANK[ctx.role] >= RANK.commenter);
    if (!verifies) return json(403, { detail: "Requires the approver role or the engineering lead" });
    if (a.state !== "open" || a.kind !== "date_slip") return json(409, { detail: "Only an open date slip can take its new date" });
    return body<{ reason?: string | null } | null>().then(() => {
      const t = db.tracks.find((x) => x.id === a.track_id)!;
      const day = String(a.data.tracker_date);
      const from = String(a.data.milestone_date);
      const ref = String(a.data.tracker_ref);
      const basis: Basis = {
        id: mockUuid(), kind: "estimate", reference: ref, supports_date: day, detail: null, prd_document_id: t.prd_id,
        item_key: a.item_key, tracker_key: null, tracker_record_id: String(a.data.record_id ?? "") || null, status: "verified",
        verified_by: ctx.userId, verified_at: now(), withdrawn_by: null, withdrawn_at: null, created_at: now(),
      };
      // The bases the old date rested on are withdrawn; the new one supports the tracker's date.
      const withdrawn = db.bases.filter((b) => b.prd_document_id === t.prd_id && b.status === "verified" && b.supports_date === from);
      for (const b of withdrawn) Object.assign(b, { status: "withdrawn", withdrawn_by: ctx.userId, withdrawn_at: now() });
      db.bases.push(basis);
      const moved: AcceptDateOut["milestones_moved"] = [];
      for (const ms of db.milestones.filter((x) => x.track_id === t.id && x.status === "planned" && x.target_date === from && a.item_key && x.item_keys.includes(a.item_key))) {
        moved.push({ id: ms.id, from, to: day });
        Object.assign(ms, { target_date: day, basis_ids: [basis.id], lock_version: ms.lock_version + 1, updated_at: now() });
      }
      if (a.item_key) (db.accepted ??= {})[a.item_key] = { day, reference: ref };
      Object.assign(a, { state: "resolved", resolved_at: now() });
      const out: AcceptDateOut = {
        alert: alertOut(ctx, db, a), basis, withdrawn_basis_ids: withdrawn.map((b) => b.id), milestones_moved: moved, stale_item_ids: [],
      };
      return json(200, out);
    });
  }
  return null;
}

/**
 * The Inbox's track group (F2 §4): for the track's owner, else every owner, one entry per
 * track with open alerts or alerts done in the last 30 days. `total` counts each track with new
 * or open alerts once: its alerts are the row's children (#514, as the API counts).
 */
export function inboxTracks(ctx: RoadmapContext, db: RoadmapDb, seen: string | null): { tracks: InboxTrack[]; total: number } {
  const tracks: InboxTrack[] = [];
  let total = 0;
  const since = new Date(Date.now() - DONE_DAYS * 86_400_000).toISOString();
  for (const t of db.tracks) {
    const audience = t.owner_id ? t.owner_id === ctx.userId : ctx.role === "owner";
    if (!audience) continue;
    const mine = (db.alerts ?? []).filter((a) => a.track_id === t.id).map((a) => alertOut(ctx, db, a, seen));
    const open = mine.filter((a) => a.state === "open").sort((a, b) => b.opened_at.localeCompare(a.opened_at));
    const done = mine.filter((a) => a.state !== "open" && (a.kept_at ?? a.resolved_at ?? a.opened_at) >= since);
    if (!open.length && !done.length) continue;
    const fresh = open.filter((a) => a.inbox_state === "new").length;
    const health = overview(ctx, db, t).health;
    tracks.push({
      track_id: t.id,
      prd: open[0]?.prd ?? done[0].prd,
      // An open alert puts an on-track track at risk.
      health: open.length && health === "on_track" ? "at_risk" : health,
      counts: { open: open.length - fresh, new: fresh, kept: mine.filter((a) => a.state === "kept").length },
      newest_at: open[0]?.opened_at ?? null,
      alerts: open.slice(0, 3),
      more: Math.max(0, open.length - 3),
      done,
    });
    if (open.length) total += 1;
  }
  return { tracks, total };
}

/**
 * #396: the warnings the API stores on a roadmap version for GA's date with no basis, a
 * citation whose source item Oracle no longer has and the feedback an agent's draft left open,
 * worded as api/oracle/roadmap/doc_dates.py problem_message and api/oracle/wording.py
 * unknown_source_item and feedback_left_open write them; the ids in refs.
 */
export function versionWarnings(prdTitle: string, prdSlug: string): Schemas["VersionWarning"][] {
  return [
    {
      code: "unverified_date",
      message: `the date 2026-12-15 ("Behaviour", line 1) rests on no verified estimate, capacity or commitment of the PRD "${prdTitle}" for this item; ${RECORD_DATE_BASIS} or drop the date. Oracle never invents dates`,
      section_keys: ["item-behaviour"],
      refs: { date: "2026-12-15", prd: prdSlug },
    },
    {
      code: "unknown_citation_item",
      message: 'a citation in "Summary" names a source item Oracle no longer has; the citation is kept without it',
      section_keys: ["summary"],
      refs: { cite_key: "c-usage", source_item: "00000000-0000-4000-8000-000000000396" },
    },
    {
      code: "resolution_not_applied",
      message:
        'an agent\'s draft closes feedback only as addressed, and only on a section whose text or evidence it changed in this version; 2 feedback items stay open: on "Summary" and "Behaviour"',
      section_keys: ["item-behaviour", "summary"],
      refs: { feedback_items: ["00000000-0000-4000-8000-000000000397", "00000000-0000-4000-8000-000000000398"] },
    },
  ];
}
