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

const DRAFT: [string, string, SeedItem["horizon"], string, string][] = [
  ["R-1", "Save a cart for later", "now", "2026-11-09", "2026-12-18"],
  ["R-2", "Carts kept across devices", "next", "2026-12-07", "2027-01-22"],
  ["R-3", "Price-drop note on saved carts", "next", "2027-01-11", "2027-02-12"],
  ["R-4", "Shared carts for teams", "next", "2027-01-25", "2027-03-19"],
  ["R-5", "Saved-cart reminder emails", "later", "2027-03-01", "2027-04-16"],
  ["R-6", "Turn a cart into a quote", "later", "2027-04-05", "2027-05-28"],
];

export function seedMeetingDraftDates(db: SimpleDb, prdId: string): void {
  for (const [key, title, horizon, start, end] of DRAFT) {
    if (db.items.some((x) => x.key === key)) continue;
    db.items.push({ key, title, horizon, roadmap: "onboarding-roadmap", draft_roadmap: true, prd_doc: { id: prdId, ...SAVED_CARTS } });
    db.ids[key] = stableUuid(`simple-item/${key}`);
    db.own[key] = { start, end };
  }
}

/** The PRD's draft items, left in, in roadmap order. */
const drafts = (db: SimpleDb, prdIds: string[]) => db.items.filter((s) => s.draft_roadmap && s.prd_doc && prdIds.includes(s.prd_doc.id) && s.status !== "cut");

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
