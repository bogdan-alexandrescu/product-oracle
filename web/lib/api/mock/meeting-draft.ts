/**
 * build-runplan RP2 'Meeting step as draft' (api/oracle/simple/meeting_draft.py): a review
 * meeting's Roadmap step reads its PRD's draft roadmap, the run's dated items not on the
 * roadmap yet (SeedItem.draft_roadmap). Change dates keeps an item draft with typed dates;
 * Leave out drops it; Approve these N dates puts the items on the roadmap with their dates.
 *
 * The "meeting-draft-dates" scenario: the Saved carts PRD, a draft whose run dated six items
 * (invented). Its items land on the Onboarding roadmap, the company's first, as the API's
 * _target picks when a PRD has no items on a roadmap yet.
 */
import type { Schemas } from "@/lib/api/client";
import { stableUuid } from "./ids";
import { roadmapOut, type SeedItem, type SimpleDb } from "./simple-roadmap";

export const SAVED_CARTS = { slug: "saved-carts", title: "Saved carts" };

type DraftRow = [string, string, SeedItem["horizon"], string, string, string];

const DRAFT: DraftRow[] = [
  ["R-1", "Save a cart for later", "now", "2026-11-09", "2026-12-18", "Priya Natarajan"],
  ["R-2", "Carts kept across devices", "next", "2026-12-07", "2027-01-22", "Tomás Ferreira"],
  ["R-3", "Price-drop note on saved carts", "next", "2027-01-11", "2027-02-12", "Priya Natarajan"],
  ["R-4", "Shared carts for teams", "next", "2027-01-25", "2027-03-19", "Ama Owusu"],
  ["R-5", "Saved-cart reminder emails", "later", "2027-03-01", "2027-04-16", "Jonas Lindqvist"],
  ["R-6", "Turn a cart into a quote", "later", "2027-04-05", "2027-05-28", "Ama Owusu"],
];

/** A PRD's run's draft roadmap: its dated items, on no roadmap yet, and the run (`version`: the PRD version it dated). */
export function seedDraftPrd(db: SimpleDb, prd: { id: string; slug: string; title: string }, rows: DraftRow[], run: { version: number; cancelled?: boolean }): void {
  for (const [key, title, horizon, start, end, owner] of rows) {
    if (db.items.some((x) => x.key === key)) continue;
    db.items.push({ key, title, horizon, roadmap: "onboarding-roadmap", draft_roadmap: true, prd_doc: prd, draft_owner: owner });
    db.ids[key] = stableUuid(`simple-item/${key}`);
    db.own[key] = { start, end };
  }
  (db.draft_runs ??= {})[prd.id] = { run_id: stableUuid(`draft-run/${prd.slug}`), ...run };
}

export function seedMeetingDraftDates(db: SimpleDb, prdId: string, version = 1): void {
  seedDraftPrd(db, { id: prdId, ...SAVED_CARTS }, DRAFT, { version });
}

/**
 * RP2 'Draft layer on roadmap' ("roadmap-draft-layer" scenario, invented): Saved carts and Team
 * workspaces in draft, and two drafts the layer leaves out: Online deposits' PRD was replaced,
 * Clinic outreach's run was cancelled.
 */
export const WORKSPACES = { slug: "team-workspaces", title: "Team workspaces" };
export const WORKSPACES_DRAFT: DraftRow[] = [
  ["W-1", "Invite a whole team", "now", "2026-11-16", "2026-12-11", "Lena Fischer"],
  ["W-2", "Team roles and rights", "next", "2026-12-14", "2027-02-05", "Kofi Mensah"],
  ["W-3", "Move items between workspaces", "later", "2027-02-08", "2027-03-26", "Lena Fischer"],
];
export const REPLACED_DRAFT: DraftRow[] = [["D-1", "Deposit at booking", "now", "2026-11-23", "2027-01-15", "Kofi Mensah"]];
export const CANCELLED_DRAFT: DraftRow[] = [["C-1", "Outreach letters", "next", "2026-12-01", "2027-01-29", "Lena Fischer"]];

/** What the API's draft_prds reads of a PRD outside the Simple store: may the reader see it, was it replaced, is the dated version approved. */
export type DraftPrdState = { visible: boolean; replaced: boolean; approved: (version: number) => boolean };

/** The PRD's draft items, left in, in roadmap order. */
const drafts = (db: SimpleDb, prdIds: string[]) => db.items.filter((s) => s.draft_roadmap && s.prd_doc && prdIds.includes(s.prd_doc.id) && s.status !== "cut");

/** GET /v1/simple/roadmap/draft-prds (oracle.simple.roadmap_drafts.draft_prds): each PRD the reader may
 * see whose run's draft holds dated items not approved yet; a replaced PRD, a cancelled run and a
 * PRD with a version at or after the drafted one approved are left out. One card per PRD (its run's
 * newest draft); an undated item is not listed, as approval does not place it. By PRD title. */
export function draftPrdsOut(db: SimpleDb, state: (prdId: string) => DraftPrdState, canChange: boolean): Schemas["SimpleRoadmapDraftPrd"][] {
  const all = roadmapOut(db, "owner", new URLSearchParams({ draft_roadmap: "1" }))?.items ?? [];
  const prds = new Map<string, { id: string; slug: string; title: string }>();
  for (const s of db.items) if (s.draft_roadmap && s.prd_doc && s.status !== "cut") prds.set(s.prd_doc.id, s.prd_doc);
  return [...prds.values()]
    .filter((prd) => {
      const run = db.draft_runs?.[prd.id];
      const st = state(prd.id);
      return st.visible && !st.replaced && !run?.cancelled && !(run && st.approved(run.version));
    })
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((prd) => ({
      prd,
      run_id: db.draft_runs?.[prd.id]?.run_id ?? null,
      can_change: canChange,
      // Only what approval would place (roadmap_drafts._placed): an item with its own dates.
      items: drafts(db, [prd.id])
        .filter((s) => !!db.own[s.key]?.end)
        .map((s) => {
          const i = all.find((x) => x.id === db.ids[s.key])!;
          return { id: i.id, key: s.key, title: s.title, horizon: s.horizon, start: i.start.date, end: i.end.date, owner_name: s.draft_owner ?? null };
        }),
    }))
    .filter((d) => d.items.length > 0);
}

/** The dated items an approval takes from the PRD's run draft (the API's derived items of the version, less those left out). */
export function approvalItems(db: SimpleDb, prdId: string) {
  const all = roadmapOut(db, "owner", new URLSearchParams({ draft_roadmap: "1" }))?.items ?? [];
  return drafts(db, [prdId]).map((s) => {
    const i = all.find((x) => x.id === db.ids[s.key])!;
    return { key: s.key, title: s.title, horizon: s.horizon, outcome: null, start: i.start.date, end: i.end.date, source: "engineering" as const };
  });
}

/** The chosen option of a meeting's Approve these N dates decision, "draft-dates:N" (meeting_draft.APPROVED_KEY). */
export const APPROVED_KEY = "draft-dates";

/**
 * SimpleMeetingOut.draft_roadmap: null without one. With no draft left, `approved` is how many
 * items the meeting's own Approve these N dates put on the roadmap (`approvedHere`), as the API.
 */
export function draftRoadmapOut(db: SimpleDb, prdIds: string[], approvedHere: number | null = null): Schemas["SimpleDraftRoadmap"] | null {
  const rows = drafts(db, prdIds);
  if (!rows.length) return approvedHere == null ? null : { items: [], approved: approvedHere };
  const all = roadmapOut(db, "owner", new URLSearchParams({ draft_roadmap: "1" }))?.items ?? [];
  return {
    items: rows.map((s) => {
      const i = all.find((x) => x.id === db.ids[s.key])!;
      return { id: i.id, key: s.key, title: s.title, horizon: s.horizon, start: i.start.date, end: i.end.date };
    }),
  };
}

/** The three draft routes: change dates, leave out, approve. Returns the error, else null. */
export function draftAct(db: SimpleDb, prdIds: string[], act: { kind: "dates"; id: string; start: string; end: string } | { kind: "leave"; id: string } | { kind: "approve" }): { status: number; detail: string } | { n: number } {
  const rows = drafts(db, prdIds);
  if (act.kind === "approve") {
    if (!rows.length) return { status: 409, detail: "No draft dates to approve" };
    for (const s of rows) delete s.draft_roadmap;
    return { n: rows.length };
  }
  const s = rows.find((x) => db.ids[x.key] === act.id);
  if (!s) return { status: 404, detail: "No such draft item" };
  if (act.kind === "leave") s.status = "cut";
  else {
    if (!act.start || !act.end) return { status: 422, detail: "A start and an end" };
    if (act.end < act.start) return { status: 422, detail: "the end comes before the start" };
    db.own[s.key] = { start: act.start, end: act.end, source: "typed" };
  }
  return { n: 0 };
}
