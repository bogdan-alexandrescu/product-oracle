/**
 * Simple S5 (#723): one-pagers, as api/oracle/simple/one_pager.py serves them:
 * GET /v1/simple/one-pagers/{doc} (and .../pdf), and the change engine's `edit_line` op on
 * POST /v1/simple/changes with its accept, decline and undo. One invented PRD,
 * "guided-setup", version 3, its six fallback blocks; each line names its source sections.
 *
 * Who (D4, D-a): owners and the PRD's decider (none in the default seed) apply a line edit
 * into the PRD's one shared working draft with a section patch for EVERY source section of
 * the line; approvers and commenters propose it to the decider, else the company's owners;
 * viewers read. Those who see the draft (owners, its people) read the edited lines and the
 * margin notes; everyone else the published lines and a `changes_in_review` count. Undo
 * works for the change's author while its session is open.
 *
 * Fixing a number (owner, Nov 5): each "Needs a look" numbers item carries its fix, the
 * `set_section_number` op (the number in one section's words set, through the same draft,
 * rights, Undo and approval as a line edit), as the API's one_pager._create_number.
 *
 * Submit and Remind (owner, 2026-10-26): an owner submits the draft (POST
 * /v1/simple/drafts/{id}/submit): it waits on the PRD's required reviewers (`ctx.reviewers`).
 * Remind (POST /v1/simple/one-pagers/{doc}/remind, owners and the decider) writes each
 * waiting reviewer an Inbox nudge (`ctx.notify`, kind review_reminder) "<name> is waiting
 * for your review of <PRD>", at most once a day per reviewer (409 when none is due).
 */
import type { Schemas } from "@/lib/api/client";
import { milestoneOf, planByMonth } from "@/lib/simple-home";
import { PLAN_PRD_SLUG, planOut, planSlices } from "./simple-plan";
import { mockNowMs } from "./clock";
import { companyDayIso } from "./connections";
import { draftDecisionNotes, leftOut } from "./decision-notes";
import { stableUuid } from "./ids";
import { changePhrase, changeSentence } from "./simple-change-words";
import { annotate, asWritten, resolved, setNumber } from "./one-pager-checks";
import { roadmapOut } from "./simple-roadmap";
import { betSubject, flowFor, flowsOfBets, onePagerFlow, requestVisual, type VisualsDb } from "./simple-visuals";
import { madeOrder } from "./made-order";

type Role = Schemas["Me"]["role"];
type Change = Schemas["SimpleChangeOut"];
type Line = Schemas["OnePagerLine"];
type Patch = Schemas["OnePagerSectionPatch"];

export interface OnePagerCtx {
  id: string;
  role: Role;
  owners: string[];
  names: Record<string, string>;
  /** Each active member's role (a viewer cannot be added as a reviewer). */
  roles?: Record<string, Role>;
  /** The PRD's required reviewers (its review policy). */
  reviewers: string[];
  /** The PRD's decider (Dana Decider in "simple-deciders", as the meetings mock), and its track owners. */
  decider?: string | null;
  trackOwners?: string[];
  /** A submitted draft's next version, its sections as the draft has them (drafts.submit imports it). */
  imported?: (sections: { key: string; heading: string; body: string }[], version: number) => number | void;
  /** Writes one Inbox notification, as oracle.review.collab.notify. */
  notify: (userId: string, kind: "review_reminder", title: string, data: Record<string, unknown>, version: number) => void;
  /** prd-timeline: the PRD's dated plan's milestones ("M1 Prove it"): the PDF prints the timeline, then one page each. */
  planPages?: string[];
  /** e2e-pdf-export ("one-pager-overflow"): the pages the one-pager runs to past its one (the API lays it out). */
  overflowPages?: number;
  /** S-9 ("one-pager-pdf-down"): the API cannot make PDFs (its 503, export.pdf.PdfUnavailable). */
  pdfDown?: boolean;
  /** simple-replaced-prds: the PRDs that replaced this one, when it is marked replaced (its read, PDF and Remind are a 404 naming them). */
  replacedBy?: Schemas["PrdRef"][];
}

const REMIND_EVERY_MS = 24 * 60 * 60 * 1000;

export interface Sec {
  key: string;
  heading: string;
  body: string;
}

interface SeedLine {
  id: string;
  text: string;
  /** The whole text when `text` is shortened with "…" (the API's OnePagerLine.full). */
  full?: string;
  keys: string[];
  metric?: { name: string; from: string; to: string };
}

export interface OnePagerDb {
  doc: { id: string; slug: string; title: string };
  version: number;
  /** qa4-simple-prd-22: a PRD other than the seed keys its bets' flows by its own slug, so it shares none. */
  flowKey?: string;
  /** When `version` was approved (null: never published); unset, the seed's day. */
  published_at?: string | null;
  sections: Sec[];
  /** `missing`: Oracle marked the block "Not in the PRD yet" (nothing of the PRD maps to it). */
  blocks: { key: string; title: string; rules: string; kind: Schemas["OnePagerBlock"]["kind"]; lines: SeedLine[]; missing?: boolean }[];
  draft: null | {
    id: string; base: number; participants: string[]; lines: Record<string, string>; sections: Record<string, string>;
    /** A heading's count fixed (owner, Nov 5, 'Fix the heading too'): the API's overlay["headings"]. */
    headings?: Record<string, string>;
    status?: "working" | "submitted"; waiting_on?: string[]; reminders?: Record<string, string>;
    /** The version number it was submitted as (the API's simple_drafts.version_id): only that version's approval settles it. */
    submitted_as?: number;
  };
  changes: (Change & { session_open: boolean; in_meeting: boolean; meeting_title?: string | null })[];
  /** S10: the visuals (./simple-visuals.ts), shared with the roadmap's. */
  visuals?: VisualsDb;
  /** S8: decided decisions that changed each line (by line id), newest first (./simple-meetings.ts). */
  decisions?: Record<string, { id: string; number: number; title: string }[]>;
  /** Imported by a service token: the PRD has no owner yet. */
  ownerless?: boolean;
  /**
   * The document's owner (one_pager.document_owner, P4): the member who brought the PRD in;
   * unset, the company's first owner (who imported the seeded PRD).
   */
  owner?: string;
  /** The PRD's roadmap slice, when not the default invented one (SLICE). */
  slice?: SliceItem[];
  /** S-8: the Simple roadmap a PRD's own page reads its slice from at each read (prdSlice). */
  roadmap?: RoadmapDb;
  /**
   * oracle.simple.quality: Oracle's build failed its checks twice: its blocks and the failed
   * checks' plain words. Owners read it with a "Needs a look" note; everyone else `blocks`
   * (the last good version).
   */
  held?: { blocks: OnePagerDb["blocks"]; checks: string[] } | null;
  /** S8: the decider approved the draft in a meeting: its title and who it still waits on. */
  approval?: { approved_in: string; waiting_on: { id: string; name: string }[]; blocked_by?: string[] } | null;
  /** The one_pager job is still writing the page: `blocks` are Oracle's quick read (built_by "extract"). */
  writing?: boolean;
  /** The page is Oracle's quick read with no one_pager job writing it (it failed or was never queued). */
  quickRead?: boolean;
}

const DOC_ID = stableUuid("simple-one-pager-doc");

export function seedOnePager(ownerless = false): OnePagerDb {
  const sections: Sec[] = [
    { key: "problem", heading: "Problem", body: "New workspace admins stall during setup and never invite a teammate in the first week." },
    // ad-onepager review: stories before who has it are never who has it.
    { key: "stories", heading: "User stories", body: "- As a new admin, I want a checklist so I know the next step" },
    { key: "who", heading: "Who has it", body: "Admins of new teams with fewer than ten people." },
    { key: "build", heading: "What we will build", body: "- A setup checklist that shows the next step\n- Invite suggestions from the admin's calendar\n- A sample project created on day one" },
    { key: "outcomes", heading: "Outcomes", body: "- Teammate invited in week one from 48% to 65%\n- Setup finished in a day from 30% to 50%*" },
    { key: "not-doing", heading: "Not doing", body: "- Single sign-on setup\n- A mobile setup flow" },
    { key: "risks", heading: "Risks and open decisions", body: "- Calendar access may scare admins away\n- Decide whether the sample project can be deleted\n- F-26 may slip past M1†" },
    // Reads clearly (2026-10-30): a measure, the codes' names and numbers that disagree.
    { key: "definitions", heading: "Definitions", body: "- Teammate invited in week one: counted as admins whose first invite is accepted within 7 days; source: the product events table" },
    { key: "glossary", heading: "Glossary", body: "| Code | Name |\n|---|---|\n| F-26 | Calendar invites |" },
    { key: "targets", heading: "Targets", body: "Each region adds 40 paid workspaces a month. We sell in 5 regions. Company-wide target: 250 paid workspaces a month." },
    { key: "later", heading: "Not this quarter", body: "Eight features wait for next quarter.\n\n- Single sign-on setup\n- A mobile setup flow\n- Setup in more languages\n- Bulk user import\n- Setup analytics\n- A guided tour video" },
  ];
  return {
    doc: { id: DOC_ID, slug: "guided-setup", title: "Guided setup" },
    version: 3,
    sections,
    blocks: [
      { key: "problem", title: "Problem and who has it", rules: "At most 60 words", kind: "text", lines: [
        { id: "problem-1", text: "New workspace admins stall during setup and never invite a teammate in the first week. Admins of new teams with fewer than ten people.", keys: ["problem", "who"] },
      ] },
      { key: "bets", title: "What we will build", rules: "3-5 bets", kind: "lines", lines: [
        { id: "bets-1", text: "A setup checklist that shows the next step", keys: ["build"] },
        { id: "bets-2", text: "Invite suggestions from the admin's calendar", keys: ["build"] },
        { id: "bets-3", text: "A sample project created on day one", keys: ["build"] },
      ] },
      { key: "outcomes", title: "Outcomes and how we measure them", rules: "2-4 metrics, from → to", kind: "metrics", lines: [
        { id: "outcomes-1", text: "Teammate invited in week one from 48% to 65%", keys: ["outcomes"], metric: { name: "Teammate invited in week one", from: "48%", to: "65%" } },
        { id: "outcomes-2", text: "Setup finished in a day from 30% to 50%*", keys: ["outcomes"], metric: { name: "Setup finished in a day", from: "30%", to: "50%*" } },
      ] },
      { key: "not_doing", title: "Not doing", rules: "At most 5 lines", kind: "lines", lines: [
        { id: "not_doing-1", text: "Single sign-on setup", keys: ["not-doing"] },
        { id: "not_doing-2", text: "A mobile setup flow", keys: ["not-doing"] },
      ] },
      { key: "risks", title: "Risks and open decisions", rules: "At most 5", kind: "lines", lines: [
        { id: "risks-1", text: "Calendar access may scare admins away", keys: ["risks"] },
        { id: "risks-2", text: "Decide whether the sample project can be deleted", keys: ["risks"] },
        { id: "risks-3", text: "F-26 may slip past M1†", keys: ["risks"] },
      ] },
      { key: "timeline", title: "Timeline", rules: "The PRD's roadmap slice", kind: "timeline", lines: [] },
    ],
    draft: null,
    changes: [],
    ownerless,
  };
}

/**
 * The PRD's roadmap slice (invented): 12 items carry M1, 5 carry M2, 3 carry M3, 2 have no
 * milestone; one of those is committed past M3's month (the strip's edge).
 */
type SliceItem = {
  /** The roadmap item's own id, when the slice is read from the mock roadmap (prdSlice). */
  id?: string;
  title: string;
  horizon: "now" | "next" | "later";
  start: string;
  end: string;
  estimated: boolean;
  /** Its milestone's label and day (null: the PRD's plan does not date it, a row of its own). */
  milestone: [string, string | null] | null;
  /** The track milestone record naming the item, when any (the strip's row). */
  record?: { id: string; name: string };
  /** The day its milestone starts when the PRD's plan dates it (the strip's row spans it). */
  milestoneStart?: string;
  /** The mock roadmap's item it is (simple-roadmap.ts SEED key), so it carries that feature's mark. */
  key?: string;
};

/** The plan-model lane ("simple-plan"): the slice as the PRD's dated plan has it, one item per slice. */
export function planSlice(): SliceItem[] {
  return planSlices().map((x) => ({
    title: x.name,
    horizon: "now" as const,
    start: x.start_date!,
    end: x.end_date!,
    estimated: !(x.milestone_start && x.milestone_end),
    milestone: [`${x.milestone} · ${x.milestone_name}`, x.milestone_end!] as [string, string],
    milestoneStart: x.milestone_start!,
  }));
}
const BETA_LAUNCH = { id: stableUuid("op-milestone/beta-launch"), name: "Beta launch" };
// build-current-state review 2: a few are the mock roadmap's own items (their features' marks:
// Setup checklist in progress, Sample data import new, Welcome video runs today, Alert routing
// by team runs with old proof), as the API's slice is the PRD's roadmap items.
/** A slice item's roadmap item id: the mock roadmap's own (simple-roadmap.ts ids) when it is one. */
const sliceItemId = (x: SliceItem, i: number) => x.id ?? stableUuid(x.key ? `simple-item/${x.key}` : `op-item-${i + 1}`);
const SEEDED: Record<number, [string, string]> = { 0: ["setup-checklist", "Setup checklist"], 1: ["setup-import", "Sample data import"], 12: ["setup-video", "Welcome video"] };
const SLICE: SliceItem[] = [
  ...Array.from({ length: 12 }, (_, i) => ({ title: SEEDED[i]?.[1] ?? `Setup step ${i + 1}`, key: SEEDED[i]?.[0], horizon: "now" as const, start: "2026-10-05", end: "2026-11-20", estimated: false, milestone: ["M1", "2026-11-20"] as [string, string] })),
  ...Array.from({ length: 5 }, (_, i) => ({ title: SEEDED[12 + i]?.[1] ?? `Calendar invites ${i + 1}`, key: SEEDED[12 + i]?.[0], horizon: "next" as const, start: "2026-11-23", end: "2026-12-18", estimated: i > 2, milestone: ["M2", "2026-12-18"] as [string, string] })),
  ...Array.from({ length: 3 }, (_, i) => ({ title: `Sample project ${i + 1}`, horizon: "later" as const, start: "2026-12-21", end: "2027-01-29", estimated: true, milestone: ["M3", "2027-01-29"] as [string, string] })),
  { title: "Alert routing by team", key: "alert-sso", horizon: "now", start: "2026-10-12", end: "2026-12-11", estimated: false, milestone: null },
  { title: "Setup analytics", horizon: "later", start: "2026-11-02", end: "2027-03-12", estimated: false, milestone: null },
];

/**
 * CLD's production walk (2026-10-27), the "simple-walk" scenario: a slice whose milestone
 * texts carry their items' notes, as real roadmaps do (one row per milestone on the strip),
 * and a problem line the API cut at a word with its whole text kept. Invented data.
 */
const NOTED_SLICE: SliceItem[] = [
  { title: "Usage export", horizon: "now", start: "2026-10-05", end: "2026-11-18", estimated: false, milestone: ["M1 · Measure it, make it safe (the usage report needs the export); Alert digest in M2 · Ship to beta", "2026-11-20"] },
  { title: "Dry run", horizon: "now", start: "2026-10-12", end: "2026-11-20", estimated: true, milestone: ["M1 · Measure it, make it safe (owner asks for a dry run)", "2026-11-20"] },
  { title: "Setup audit", horizon: "now", start: "2026-10-19", end: "2026-11-13", estimated: false, milestone: ["M1 · Measure it, make it safe; follow-up in M3", "2026-11-20"] },
  { title: "Beta invites", horizon: "next", start: "2026-11-23", end: "2026-12-18", estimated: false, milestone: ["M2 · Ship to beta (two teams first)", "2026-12-18"] },
  { title: "Beta feedback form", horizon: "next", start: "2026-12-01", end: "2026-12-11", estimated: true, milestone: ["M2 · Ship to beta", "2026-12-18"] },
  // A track milestone record naming three items: two whose own texts differ, one with none.
  { title: "Beta for two teams", horizon: "next", start: "2026-12-07", end: "2027-01-08", estimated: false, milestone: ["Beta launch, two teams first", "2027-01-15"], record: BETA_LAUNCH },
  { title: "Beta terms", horizon: "next", start: "2026-12-14", end: "2027-01-12", estimated: true, milestone: ["Beta launch - after legal", "2027-01-15"], record: BETA_LAUNCH },
  { title: "Beta docs", horizon: "next", start: "2026-12-14", end: "2027-01-08", estimated: true, milestone: null, record: BETA_LAUNCH },
  { title: "Setup help center", horizon: "now", start: "2026-10-12", end: "2026-12-11", estimated: false, milestone: null },
];
export const WALK_PROBLEM =
  "New workspace admins stall during setup because the checklist hides the invite step. The queue of half-set-up teams grows every week a cohort lands; teams with more than ten people wait the longest, and the promise we make is a first teammate invited within a 48-hour window that we miss for most new teams after a weekend signup.";

/**
 * The "one-pager-needs-look" scenario: Oracle's build failed its checks twice (two bets, a
 * risk saying "TBD"), so it is held: owners read it with the failed checks; everyone else
 * the last good page. Invented data.
 */
export function seedNeedsLookOnePager(): OnePagerDb {
  const db = seedOnePager();
  const blocks = db.blocks.map((b) => ({ ...b, lines: b.lines.map((l) => ({ ...l })) }));
  const bets = blocks.find((b) => b.key === "bets")!;
  bets.lines = bets.lines.slice(0, 2);
  blocks.find((b) => b.key === "risks")!.lines = [{ id: "risks-1", text: "Pricing for teams is TBD", keys: ["risks"] }];
  db.held = { blocks, checks: ["2 bets; a one-pager has 3 to 5", "A line in “Risks and open decisions” says “TBD”"] };
  return db;
}

/**
 * The "one-pager-bet-added" scenario (vqa one-pager 1): the PRD's next version gained a new
 * first bet, so every bet's line moved down one; the flows were drawn before (keyed to the
 * lines they were on then, ./simple-visuals.ts seedVisuals). Invented data.
 */
export function seedBetAddedOnePager(): OnePagerDb {
  const db = seedOnePager();
  const bets = db.blocks.find((b) => b.key === "bets")!;
  const was = bets.lines.map((l) => l.text);
  bets.lines = ["Workspace templates for common teams", ...was].map((text, i) => ({ id: `bets-${i + 1}`, text, keys: ["build"] }));
  return { ...db, version: db.version + 1 };
}

/**
 * The "one-pager-milestone-names" scenario (vqa one-pager 3): the plan's M2 milestone record is
 * named only by its code ("M2") while another item names it ("M2 · Ship to beta"). Invented data.
 */
export function seedMilestoneNamesOnePager(): OnePagerDb {
  const item = (title: string, start: string, end: string, milestone: [string, string], record?: { id: string; name: string }): SliceItem =>
    ({ title, horizon: "now", start, end, estimated: false, milestone, ...(record ? { record } : {}) });
  return {
    ...seedOnePager(),
    slice: [
      item("Setup checklist", "2026-11-02", "2026-11-27", ["M1 · Measured and mapped", "2026-12-04"]),
      item("Calendar invites", "2026-11-09", "2026-12-04", ["M2", "2026-12-11"], { id: stableUuid("op-milestone/m2"), name: "M2" }),
      item("Sample project", "2026-11-16", "2026-12-11", ["M2 · Ship to beta", "2026-12-18"]),
    ],
  };
}

/**
 * The "one-pager-heading-count" scenario (owner, Nov 5, 'Fix the heading too'): the count is
 * in the section's heading, "Later · 8 items" over six listed, and the PRD's full version
 * page reads the same sections (./server.ts). Invented data.
 */
export function seedHeadingCountOnePager(): OnePagerDb {
  const db = seedOnePager();
  const later = db.sections.find((x) => x.key === "later")!;
  later.heading = "Later · 8 items";
  later.body = later.body.replace(/^Eight features wait for next quarter\.\n\n/, "");
  return db;
}

/**
 * The "one-pager-two-counts" scenario (review, Nov 7): two numbers to fix in one section, the
 * heading's "Later · 8 items" over six listed and "Five features wait for next quarter" under
 * it, so the section takes two fixes, each with its own Undo; its targets in decimals ("300.5"
 * per region, "1,250.75" company-wide), whose fix keeps them as written, and two whose sums
 * read as a person writes them ("0.3", "1,234,567.5"), and one whose sum ends in an exact half
 * past the 6th place ("3.0078125"), which rounds up as the API's does. Invented data.
 */
export function seedTwoCountsOnePager(): OnePagerDb {
  const db = seedHeadingCountOnePager();
  const later = db.sections.find((x) => x.key === "later")!;
  later.body = `Five features wait for next quarter.\n\n${later.body}`;
  const targets = db.sections.find((x) => x.key === "targets")!;
  targets.body = [
    "Each region adds 300.5 paid workspaces a month. Each region also adds 246913.5 trial seats.",
    "Each team saves 0.1 support hours a week. We sell in 5 regions. We have 3 teams.",
    "Each squad trims 1.50390625 setup minutes a day. We run 2 squads.",
    "Company-wide target: 1,250.75 paid workspaces a month, 1,000,000 trial seats, 2 support hours a week and 3 setup minutes a day.",
  ].join(" ");
  return db;
}

/**
 * The "one-pager-not-in-prd" scenario: the PRD has no "Not doing" section, and Oracle marked
 * that block "Not in the PRD yet" (the API's OnePagerBlock.missing). Invented data.
 */
export function seedNotInPrdOnePager(): OnePagerDb {
  const db = seedOnePager();
  db.sections = db.sections.filter((x) => x.key !== "not-doing");
  db.blocks = db.blocks.map((b) => (b.key === "not_doing" ? { ...b, lines: [], missing: true } : b));
  // P-9: an older build's lines that only say it, twice in one block: the read says it once.
  db.blocks = db.blocks.map((b) => (b.key === "risks" ? { ...b, lines: [{ id: "risks-1", text: "Not in the PRD yet.", keys: ["risks"] }, { id: "risks-2", text: "Open decisions: Not in the PRD yet", keys: ["risks"] }] } : b));
  return db;
}

/**
 * The "one-pager-run-prd" scenario (CLD's production pass, 2026-10-30): a Goal-traced PRD a
 * Baseline to PRD run wrote, its lines carrying [c:id] citations, read while the one_pager
 * job still writes the page (`writing`): Oracle's quick read, stored as an older build
 * stored it (raw tokens, one cut to "[c…"). The read resolves them (one_pager._tidy). Invented data.
 */
export function seedRunPrdOnePager(): OnePagerDb {
  const db = seedOnePager();
  db.writing = true;
  db.sections = [
    { key: "problem", heading: "Problem", body: "Owners of small photo libraries lose an hour a week finding new photos (about 9 minutes per day) [c:c1]. Every feature below serves sorting time [c:c4]:" },
    { key: "brief-items", heading: "Features by milestone", body: "| Milestone | Feature | Goal | Outcome |\n|---|---|---|---|\n| [M1](#milestone-m1) | [F-10 Auto albums](#feature-auto-albums) | Faster sorting | Albums by event [c:c4] |\n| | [F-12 Face groups](#feature-face-groups) | Faster sorting | People found in one tap [c:c1] |\n| | [F-13 Album names](#feature-album-names) | Faster sorting | Albums named by place and date [c:c1] |" },
    { key: "non-goals", heading: "Non-goals", body: "Editing stays where it is, so F-11 Photo editing is out [c:c1]. Prints are not planned, so F-14 Print orders waits for next year; and F-15 Shared albums is out too [c:c11]." },
    { key: "top-risks", heading: "Top risks", body: "- Albums may group the wrong photos: owners move a photo in one tap [c:c11].\n- F-40 may slip past M1 [c:c4].\n- F-50 requires login before albums show [c:c4]." },
    { key: "audience", heading: "Who has it", body: "- **Primary:** Owners of small photo libraries who add a few hundred photos a week [c:c1].\n- **Job story:** When a batch of photos lands, I want them grouped by event, so I can find one in seconds [c:c1].\n- **Owner:** The person who pays for the library and sets who may edit it [c:c4].\n- **Not the target:** Studios with their own photo tools [c:c11]." },
    { key: "success", heading: "Success measures", body: "- Photos sorted within a day from 40% to 80%, counted as: [c:c4] [c:c11]\n- Time to find a photo from 90s to 20s [c:c1]\n- Albums renamed by hand from 30% to 10%" },
    { key: "sources-data", heading: "Data points", body: "- Time to find a photo: measured as seconds from opening the library to opening the photo; source: [c:c1]" },
  ];
  const problem = "Owners of small photo libraries lose an hour a week finding new photos (about 9 minutes per day) [c:c1]. Every feature below serves sorting time [c:c4]: Primary: Owners of small photo libraries who add a few hundred photos a week [c:c1].";
  db.blocks = [
    { key: "problem", title: "Problem and who has it", rules: "At most 60 words", kind: "text", lines: [
      { id: "problem-1", text: `${problem.split(" ").slice(0, 26).join(" ")} [c…`, full: problem, keys: ["problem", "audience"] },
    ] },
    { key: "bets", title: "What we will build", rules: "3-5 bets", kind: "lines", lines: [
      { id: "bets-1", text: "M1: F-10 Auto albums", keys: ["brief-items"] },
      { id: "bets-2", text: "F-12 Face groups: Faster sorting", keys: ["brief-items"] },
      { id: "bets-3", text: "F-13 Album names: Faster sorting", keys: ["brief-items"] },
    ] },
    { key: "outcomes", title: "Outcomes and how we measure them", rules: "2-4 metrics, from → to", kind: "metrics", lines: [
      { id: "outcomes-1", text: "Photos sorted within a day from 40% to 80%, counted as: [c:c4] [c:c11]", keys: ["success"], metric: { name: "Photos sorted within a day", from: "40%", to: "80%" } },
      { id: "outcomes-2", text: "Time to find a photo from 90s to 20s [c:c1]", keys: ["success"], metric: { name: "Time to find a photo", from: "90s", to: "20s [c:c1]" } },
      { id: "outcomes-3", text: "Albums renamed by hand from 30% to 10%", keys: ["success"], metric: { name: "Albums renamed by hand", from: "30%", to: "10%" } },
    ] },
    { key: "not_doing", title: "Not doing", rules: "At most 5 lines", kind: "lines", lines: [
      { id: "not_doing-1", text: "Editing stays where it is, so F-11 Photo editing is out [c:c1].", keys: ["non-goals"] },
      { id: "not_doing-2", text: "Prints are not planned, so F-14 Print orders waits for next year; and F-15 Shared albums is out too [c:c11].", keys: ["non-goals"] },
    ] },
    { key: "risks", title: "Risks and open decisions", rules: "At most 5", kind: "lines", lines: [
      { id: "risks-1", text: "Albums may group the wrong photos: owners move a photo in one tap [c:c11].", keys: ["top-risks"] },
      { id: "risks-2", text: "F-40 may slip past M1 [c:c4].", keys: ["top-risks"] },
      { id: "risks-3", text: "F-50 requires login before albums show [c:c4].", keys: ["top-risks"] },
    ] },
    { key: "timeline", title: "Timeline", rules: "The PRD's roadmap slice", kind: "timeline", lines: [] },
  ];
  return db;
}

/**
 * The "one-pager-run-prd-walk" scenario (CLD's walk B, 2026-11-01): an approved PRD a run
 * wrote, its one-pager written by Oracle's job. Its Success measures say how in their own
 * words (no "counted as"), its users section has labels, a hypothesis note and a job story,
 * a requirement says what F-01 does after a colon, the features are named by their own
 * sections, a milestone counts its features above its scope, exit and date lines, and the
 * job's target was cut mid-word ("3 hours a we"). Invented data.
 */
export function seedRunPrdWalkOnePager(): OnePagerDb {
  const db = seedOnePager();
  db.doc = { ...db.doc, title: "Onboarding pace" };
  db.sections = [
    { key: "problem", heading: "Problem", body: "New accounts take weeks to go live, and a late step is found only when the customer asks why [c:c1]." },
    { key: "brief-items", heading: "Features by milestone", body: "| Milestone | Feature |\n|---|---|\n| M1 | [Pacing plan](#f-01) |\n| | [Late alerts](#f-02) |" },
    { key: "requirements", heading: "Requirements", body: "- F-01: every newly connected account gets a pacing plan within a day.\n- F-02: a late step reaches its manager the same day." },
    { key: "f-01", heading: "F-01 Pacing plan", body: "One plan of steps for each new account, with a date on every step." },
    { key: "f-02", heading: "F-02 Late alerts", body: "A note to the manager when a step passes its date." },
    { key: "audience", heading: "Who has it", body: "- **Primary:** Customer success managers who run onboarding for new accounts [c:c1].\n- **Secondary:** Account owners who watch onboarding across their book [c:c2].\n- **Not the target:** Self-serve customers with no assigned manager [c:c3].\n- The primary segment is a hypothesis until the pilot confirms it [c:c1].\n\n**Job story:** When a new customer's onboarding is running late, I want to know before they do, so I can step in [c:c1]." },
    { key: "success", heading: "Success measures", body: "- **Onboarding on time:** share of new accounts live within 30 days, from 55% to 80% by Mar 31, 2027; recomputed daily from the onboarding tracker [c:c2].\n- **Hours saved per manager:** from 0 to 3 hours a week by the end of Q2, reported weekly per person [c:c3]." },
    { key: "milestone-m1", heading: "M1 Pace", body: "M1 ships two features to the first ten accounts.\n\n- **Scope:** F-01 Pacing plan, F-02 Late alerts\n- **Exit:** ten accounts on a plan\n- **Date:** Dec 18" },
    { key: "non-goals", heading: "Non-goals", body: "- Billing setup stays as it is." },
    { key: "top-risks", heading: "Top risks", body: "- Managers may tune out alerts: a step sends one note, never a stream." },
  ];
  // As Oracle's one_pager job writes them: the target cut mid-word ("3 hours a we"), the date ISO.
  db.blocks = [
    { key: "problem", title: "Problem and who has it", rules: "At most 60 words", kind: "text", lines: [
      { id: "problem-1", text: "New accounts take weeks to go live, and a late step is found only when the customer asks why.", keys: ["problem"] },
    ] },
    { key: "bets", title: "What we will build", rules: "3-5 bets", kind: "lines", lines: [
      { id: "bets-1", text: "F-01 gives every new account a pace to follow.", keys: ["f-01", "requirements"] },
      { id: "bets-2", text: "F-02 warns the manager when a step runs late.", keys: ["f-02", "requirements"] },
    ] },
    { key: "outcomes", title: "Outcomes and how we measure them", rules: "2-4 metrics, from → to", kind: "metrics", lines: [
      { id: "outcomes-1", text: "Onboarding on time from 55% to 80% by 2027-03-31", keys: ["success"], metric: { name: "Onboarding on time", from: "55%", to: "80%" } },
      { id: "outcomes-2", text: "Hours saved per manager from 0 to 3 hours a week", keys: ["success"], metric: { name: "Hours saved per manager", from: "0", to: "3 hours a we" } },
    ] },
    { key: "not_doing", title: "Not doing", rules: "At most 5 lines", kind: "lines", lines: [
      { id: "not_doing-1", text: "Billing setup stays as it is.", keys: ["non-goals"] },
    ] },
    { key: "risks", title: "Risks and open decisions", rules: "At most 5", kind: "lines", lines: [
      { id: "risks-1", text: "Managers may tune out alerts: a step sends one note, never a stream.", keys: ["top-risks"] },
    ] },
    { key: "timeline", title: "Timeline", rules: "The PRD's roadmap slice", kind: "timeline", lines: [] },
  ];
  return db;
}

export function seedWalkOnePager(): OnePagerDb {
  const db = seedOnePager();
  db.slice = NOTED_SLICE;
  db.sections[0].body = WALK_PROBLEM;
  // As the API stores it: 60 words at most, cut at a word with "…", the whole text kept.
  db.blocks[0].lines[0] = { id: "problem-1", text: `${WALK_PROBLEM.split(" ").slice(0, 52).join(" ")}…`, full: WALK_PROBLEM, keys: ["problem"] };
  return db;
}

/**
 * A PRD started from an empty skeleton (the "simple-walk" scenario): its sections are the
 * template's guidance only, and the lines an older build stored from them (an HTML comment,
 * placeholders, a bare arrow) never show: the API's read drops them (one_pager.template_only)
 * and an empty block reads "Not written yet". Invented data.
 */
export function seedSkeletonOnePager(doc: OnePagerDb["doc"]): OnePagerDb {
  const db = seedOnePager();
  const guide: Record<string, string> = {
    problem: "<!-- Brief: fits one slide; say who has the problem and what it costs them. -->",
    bets: "<Milestone>: <Feature>",
    outcomes: "→",
    not_doing: "<!-- What we leave out -->",
    risks: "<Risk>: <mitigation>",
  };
  db.doc = doc;
  db.sections = db.sections.map((x) => ({ ...x, body: "<!-- Write this section. -->\n- <Milestone>: <Feature>\n- →" }));
  db.blocks = db.blocks.map((b) => ({ ...b, lines: b.kind === "timeline" ? [] : [{ id: `${b.key}-1`, text: guide[b.key] ?? "→", keys: [db.sections[0].key] }] }));
  return db;
}

/**
 * C-13: every PRD but the seed read its own sections, as api/oracle/simple/one_pager.py's
 * `extract` does (Oracle's quick read): each block maps the PRD's own sections by heading
 * words (MATCH order: not_doing, risks, outcomes, problem, bets; the narrower words first),
 * then each block's lines come from those sections' bullets, or sentences for the Problem
 * (one line, `extract`'s whole_block). A block with no matching section is `missing: true`
 * with no lines, never a line of Guided setup's. The timeline carries no lines: the page's
 * `slice` is the PRD's own roadmap items (none wired up here yet: `[]`, so its span and
 * strip read "No roadmap items yet"), never SLICE's 22 invented ones.
 */
interface FallbackSpec {
  key: string;
  title: string;
  rules: string;
  kind: Schemas["OnePagerBlock"]["kind"];
  maxLines: number;
  maxWords: number;
  wholeBlock?: boolean;
  words: string[];
}

const FALLBACK_SPECS: FallbackSpec[] = [
  { key: "problem", title: "Problem and who has it", rules: "At most 60 words", kind: "text", maxLines: 1, maxWords: 60, wholeBlock: true, words: ["problem", "who has it", "who", "user", "customer", "why", "background", "context", "pain"] },
  { key: "bets", title: "What we will build", rules: "3-5 bets", kind: "lines", maxLines: 5, maxWords: 30, words: ["build", "solution", "scope", "bet", "requirement", "feature", "proposal", "approach", "what we"] },
  { key: "outcomes", title: "Outcomes and how we measure them", rules: "2-4 metrics, from → to", kind: "metrics", maxLines: 4, maxWords: 30, words: ["outcome", "metric", "success", "measure", "goal", "kpi", "impact"] },
  { key: "not_doing", title: "Not doing", rules: "At most 5 lines", kind: "lines", maxLines: 5, maxWords: 30, words: ["not doing", "non-goal", "non goal", "out of scope", "won't", "not in scope"] },
  { key: "risks", title: "Risks and open decisions", rules: "At most 5", kind: "lines", maxLines: 5, maxWords: 30, words: ["risk", "open question", "open decision", "decision", "assumption", "dependenc", "question"] },
];
const MATCH_ORDER = ["not_doing", "risks", "outcomes", "problem", "bets"] as const;
const FACT_BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/;
const SENTENCE = /(?<=[.!?])\s+/;
/** As one_pager.metric_of on a quick read's fact: "name: from -> to", each side a number with its unit. */
const METRIC = /^(.*?)[:\s,-]*\s(?:from\s+)?([~<>]?[$€£]?\d[\d.,]*\s?(?:%|ms|s|x|k|m|days?|hours?|minutes?)?)\s*(?:→|->|\bto\b)\s*([~<>]?[$€£]?\d[\d.,]*\s?(?:%|ms|s|x|k|m|days?|hours?|minutes?)?)/i;
const factMetric = (fact: string): Line["metric"] | undefined => {
  const m = METRIC.exec(fact);
  return m ? { name: m[1].replace(/^[\s:,-]+|[\s:,-]+$/g, "") || fact, from: m[2].trim(), to: m[3].trim() } : undefined;
};

/** As one_pager.mapping: each section to the first block (MATCH order) whose words its
 * heading or key holds; an empty section maps nowhere. */
function mapToBlocks(sections: Sec[]): Record<string, Sec[]> {
  const out: Record<string, Sec[]> = { problem: [], bets: [], outcomes: [], not_doing: [], risks: [] };
  const byKey = new Map(FALLBACK_SPECS.map((s) => [s.key, s] as const));
  for (const sec of sections) {
    if (!sec.body.trim()) continue;
    const name = `${sec.heading} ${sec.key}`.toLowerCase().replace(/_/g, " ");
    for (const k of MATCH_ORDER) {
      if (byKey.get(k)!.words.some((w) => name.includes(w))) {
        out[k].push(sec);
        break;
      }
    }
  }
  return out;
}

/** As one_pager._facts: a section's bullets, else its sentences; citations resolved, as the
 * PRD's PDF resolves them (never a raw "[c:id]" on a line). */
function factsOf(sec: Sec): string[] {
  // As one_pager._facts: bullets and table body rows (one line each), else sentences.
  const { rows, rest } = tablesOf(uncomment(resolved(sec.body)));
  const bullets = rest.map((l) => FACT_BULLET.exec(l)?.[1]).filter((x): x is string => !!x).map((x) => unpiped(mdPlain(x)));
  const facts = [...bullets, ...rows.map(rowLine)].filter((x) => x && !templateOnly(x));
  if (facts.length) return facts;
  return mdPlain(rest.join("\n"))
    .split(SENTENCE)
    .map((s) => unpiped(s.trim()))
    .filter((x) => x && !templateOnly(x));
}

/** As one_pager._MD/_plain: no "**", "_" or "`" marks, a link's words only, no footnote marks. */
const MD = /[*_`]+|\[([^\]]*)\]\([^)]*\)|\[\^?[\w-]+\]/g;
const mdPlain = (t: string) => plain(t.replace(MD, (_m, g: string | undefined) => g ?? ""));
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const cellsOf = (row: string) => row.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim());
const rowLine = (cells: string[]) => cells.map((c) => mdPlain(c.replace(/\\\|/g, "/")).replace(/^[\s|]+|[\s|]+$/g, "")).filter(Boolean).slice(0, 2).join(": ");
const unpiped = (text: string) => {
  const t = text.trim();
  return (t.startsWith("|") || t.endsWith("|") ? (t.replace(/^[\s|]+|[\s|]+$/g, "").includes("|") ? rowLine(cellsOf(t)) : t) : t).replace(/^[\s|]+|[\s|]+$/g, "");
};
/** As one_pager._tables: a table's body rows; its header and separator rows are never a line. */
function tablesOf(md: string): { rows: string[][]; rest: string[] } {
  const lines = md.split("\n");
  const rows: string[][] = [];
  const rest: string[] = [];
  for (let i = 0; i < lines.length; ) {
    if (lines[i].includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cellsOf(lines[i++]));
      continue;
    }
    rest.push(lines[i++]);
  }
  return { rows, rest };
}

/** As one_pager.clip: at most `words` words and 300 characters, cut at a word with "…";
 * the whole text (at most 2000 characters) when that cuts it. */
function clip(text: string, words: number): [string, string | undefined] {
  const t = text.split(/\s+/).filter(Boolean).join(" ");
  const w = t.split(" ");
  let shown = w.length <= words ? t : `${w.slice(0, words).join(" ").replace(/[,;:]+$/, "")}…`;
  if (shown.length > 300) {
    const head = shown.slice(0, 299);
    shown = `${(head.includes(" ") ? head.slice(0, head.lastIndexOf(" ")) : head).replace(/[,;: …]+$/, "")}…`;
  }
  return [shown, shown !== t ? t.slice(0, 2000) : undefined];
}

/** As extract's whole_block (the Problem): every mapped section's facts concatenated into
 * one line, held to its word cap; the whole text kept as `full` when that cuts it. */
function buildProblem(spec: FallbackSpec, secs: Sec[]): SeedLine | null {
  let text = "";
  let whole = "";
  const keys: string[] = [];
  for (const sec of secs) {
    for (const fact of factsOf(sec)) {
      whole = `${whole} ${fact}`.trim();
      if (text.split(" ").filter(Boolean).length >= spec.maxWords) continue;
      text = `${text} ${fact}`.trim();
      if (!keys.includes(sec.key)) keys.push(sec.key);
    }
  }
  if (!text) return null;
  const shown = clip(text, spec.maxWords)[0];
  const line: SeedLine = { id: "problem-1", text: shown, keys };
  if (shown !== whole) line.full = whole.slice(0, 2000);
  return line;
}

/** As extract's other blocks: one line per fact (its section's bullets, or sentences with
 * none), held to the block's line cap; a metrics block's "from -> to" facts come first. */
function buildLines(spec: FallbackSpec, secs: Sec[]): SeedLine[] {
  const raw = secs.flatMap((sec) => factsOf(sec).map((fact) => ({ fact, key: sec.key })));
  const ordered =
    spec.kind === "metrics"
      ? raw.map((f, i) => ({ ...f, i, has: METRIC.test(f.fact) })).sort((a, b) => (a.has === b.has ? a.i - b.i : a.has ? -1 : 1))
      : raw;
  return ordered.slice(0, spec.maxLines).map(({ fact, key }, i) => {
    const [text, cut] = clip(fact, spec.maxWords);
    const line: SeedLine = { id: `${spec.key}-${i + 1}`, text, keys: [key], ...(cut ? { full: cut } : {}) };
    if (spec.kind === "metrics") {
      const m = factMetric(fact);
      if (m) line.metric = m;
    }
    return line;
  });
}

/**
 * As one_pager.extract, read from a PRD's own published sections (never Guided setup's
 * copied ones). `slice`: the PRD's own roadmap items, when the mock links any to it; `[]`
 * with none, so the header's span and the strip read the PRD's own (or "No roadmap items
 * yet"), never SLICE's.
 */
export function seedOnePagerFromSections(doc: OnePagerDb["doc"], sections: Sec[], slice: SliceItem[] = []): OnePagerDb {
  const mapped = mapToBlocks(sections);
  const blocks: OnePagerDb["blocks"] = FALLBACK_SPECS.map((spec) => {
    const secs = mapped[spec.key];
    const lines = spec.wholeBlock ? (() => { const l = buildProblem(spec, secs); return l ? [l] : []; })() : buildLines(spec, secs);
    return { key: spec.key, title: spec.title, rules: spec.rules, kind: spec.kind, lines, missing: secs.length === 0 };
  });
  blocks.push({ key: "timeline", title: "Timeline", rules: "The PRD's roadmap slice", kind: "timeline", lines: [] });
  return { doc, version: 1, sections, blocks, draft: null, changes: [], slice };
}

/**
 * vqa B-13: a mock PRD's own one-pager from a version's sections as the API reads them (its
 * `#` title and empty sections left out); never another PRD's words under this PRD's title.
 */
export type PrdSection = { section_key: string; level: number; heading: string; body_md: string };
export function prdOnePager(doc: OnePagerDb["doc"], prdSections: PrdSection[]): OnePagerDb {
  const sections: Sec[] = prdSections
    .filter((s) => s.level > 1 && (s.body_md ?? "").trim())
    .map((s) => ({ key: s.section_key, heading: s.heading, body: s.body_md }));
  return seedOnePagerFromSections(doc, sections, []);
}

type RoadmapDb = Parameters<typeof roadmapOut>[0];

/** As one_pager._feature_code: "f-7", "F-007" read "F-07"; a slice F-15a is F-15. */
function featureCode(raw: string | null | undefined): string | null {
  const m = /^([a-z]{1,3})-0*(\d{1,4})[a-j]?$/i.exec((raw ?? "").trim());
  return m ? `${m[1].toUpperCase()}-${m[2].padStart(2, "0")}` : null;
}

/**
 * S-8, as one_pager.prd_items: the PRD's roadmap items, of the roadmap the reader is shown:
 * those naming the PRD and those of its features (its plan's features and its own coded
 * sections, F-07), by code. Each is placed by THIS PRD's plan only: one per slice of its
 * feature in this plan (an undated milestone a row of its own); an item of another PRD with
 * none under no milestone, never under that PRD's milestone or dates.
 */
function prdSlice(rm: RoadmapDb, role: Role, db: OnePagerDb): { items: SliceItem[]; span: [string, string] | null } {
  const planned = !!rm.plan && (db.doc.slug === PLAN_PRD_SLUG || (rm.plan.prds ?? []).includes(db.doc.slug));
  const plan = planned ? planOut(rm.plan, { id: db.doc.id, slug: db.doc.slug, title: db.doc.title }, role) : null;
  const codes = new Set(db.sections.map((x) => featureCode(x.key)).filter((c): c is string => !!c));
  for (const c of [...(plan?.slices ?? []).map((x) => x.feature_code), ...(plan?.milestones ?? []).flatMap((m) => m.feature_codes)]) {
    const code = featureCode(c);
    if (code) codes.add(code);
  }
  const out = roadmapOut(rm, role, new URLSearchParams());
  const items = (out?.items ?? [])
    .filter((i) => i.prd?.slug === db.doc.slug || i.prd?.id === db.doc.id || (!!featureCode(i.code) && codes.has(featureCode(i.code)!)))
    .filter((i) => i.status !== "cut")
    .flatMap((i): SliceItem[] => {
      const own = i.prd?.slug === db.doc.slug || i.prd?.id === db.doc.id;
      const base = { id: i.id, title: i.title, horizon: i.horizon, start: i.start.date, end: i.end.date, estimated: i.estimated };
      const slices = (plan?.slices ?? []).filter((x) => !!featureCode(i.code) && featureCode(x.feature_code) === featureCode(i.code));
      if (slices.length) {
        return slices.map((x) => ({
          ...base, start: x.start_date ?? base.start, end: x.end_date ?? base.end, estimated: !(x.milestone_start && x.milestone_end),
          milestone: [`${x.milestone} · ${x.milestone_name}`, x.milestone_end ?? null] as [string, string | null],
          ...(x.milestone_start ? { milestoneStart: x.milestone_start } : {}),
        }));
      }
      if (!own) return [{ ...base, milestone: null }];
      return [{
        ...base,
        milestone: i.milestone?.date ? [i.milestone.name ?? "Milestone", i.milestone.date] as [string, string] : null,
        ...(i.milestone?.record_id ? { record: { id: i.milestone.record_id, name: i.milestone.record_name ?? "Milestone" } } : {}),
        ...(i.milestone?.start_date ? { milestoneStart: i.milestone.start_date } : {}),
      }];
    });
  // A dated plan's span is the one its timeline draws.
  const names = Object.fromEntries((plan?.milestones ?? []).filter((m) => m.name).map((m) => [m.code, m.name]));
  return { items: namedMilestones(items, names), span: plan?.dated && plan.span ? [plan.span.start, plan.span.end] : null };
}

/**
 * vqa one-pager 3, as one_pager.plan_items and plan_strip.strip: a milestone said only by its code
 * ("M2", an item with no slice or its milestone record) reads with the name the PRD's plan gives
 * that code (`names`), else the name another of the strip's items gives it ("M2 · Ship to beta").
 */
function namedMilestones(items: SliceItem[], names: Record<string, string>): SliceItem[] {
  const named = (t: string) => {
    const [code, label] = milestoneOf(t);
    return label === code && names[code] ? `${code} · ${names[code]}` : t;
  };
  const out = items.map((x) => ({
    ...x,
    ...(x.milestone ? { milestone: [named(x.milestone[0]), x.milestone[1]] as [string, string | null] } : {}),
    ...(x.record ? { record: { ...x.record, name: named(x.record.name) } } : {}),
  }));
  const said: Record<string, string> = {};
  for (const t of out.flatMap((x) => [x.milestone?.[0], x.record?.name])) {
    const [code, label] = milestoneOf(t ?? "");
    if (t && label !== code) said[code] ??= label;
  }
  const other = (t: string) => {
    const [code, label] = milestoneOf(t);
    return label === code && said[code] ? said[code] : t;
  };
  return out.map((x) => ({
    ...x,
    ...(x.milestone ? { milestone: [other(x.milestone[0]), x.milestone[1]] as [string, string | null] } : {}),
    ...(x.record ? { record: { ...x.record, name: other(x.record.name) } } : {}),
  }));
}

/** As one_pager._says_not_in_prd: a line that only says the PRD lacks it; the block's mark says it, once. */
function saysNotInPrd(text: string): boolean {
  const said = text.split(/\s+/).filter(Boolean).join(" ").replace(/[ .]+$/, "").toLowerCase();
  const no = "not in the prd yet";
  return said === no || (said.endsWith(`: ${no}`) && said.length - no.length <= 40);
}

// P-5, as one_pager.goal_names / with_goal_names: a goal's code ("G2", "G1.2") with its name
// beside it, the name the PRD gives it ("G2 (retention)", "G2: Retention", a row "| G2 | Retention |").
const GOAL_CODE = /\bG\d{1,3}(?:\.\d{1,2})?\b/g;
const GOAL_PAREN = /\b(G\d{1,3}(?:\.\d{1,2})?)\b\**\s*\(([A-Za-z][^()\n]{0,40})\)/g;
const GOAL_AFTER = /^\**\s*(?:[:=—–]\s*|\s-\s)?\**([A-Z][\w'’-]*(?: [A-Za-z][\w'’-]*){0,4})/;
const goalName = (t: string) => {
  const x = t.split(/\s+/).filter(Boolean).join(" ").replace(/^[ *\-—–:]+|[ *\-—–:]+$/g, "");
  return x.slice(0, 1).toUpperCase() + x.slice(1);
};
const GOAL_MD = /[*_`]+|\[([^\]]*)\]\([^)]*\)|\{#[^}]*\}|<!--[\s\S]*?-->/g;

function goalNames(sections: Sec[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const sec of sections) {
    const text = `${sec.heading}\n${sec.body}`.replace(GOAL_MD, (_m, g: string | undefined) => g ?? "");
    for (const m of text.matchAll(GOAL_PAREN)) out[m[1]] ??= goalName(m[2]);
    for (const raw of text.split("\n")) {
      if (raw.trim().startsWith("|")) {
        const cells = raw.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        cells.forEach((c, i) => {
          const next = cells[i + 1];
          if (/^G\d{1,3}(?:\.\d{1,2})?$/.test(c) && next && !/\bG\d/.test(next)) out[c] ??= goalName(next);
        });
        continue;
      }
      for (const m of raw.matchAll(GOAL_CODE)) {
        const n = GOAL_AFTER.exec(raw.slice(m.index! + m[0].length));
        if (n) out[m[0]] ??= goalName(n[1]);
      }
    }
  }
  return out;
}

function withGoalNames(text: string, names: Record<string, string>): string {
  if (!text || !Object.keys(names).length) return text;
  const t = text.replace(GOAL_PAREN, (all, code: string) => (names[code] ? `${code} ${names[code]}` : all));
  return t.replace(GOAL_CODE, (code, at: number) => {
    const name = names[code];
    return !name || t.slice(at + code.length).replace(/^[ :—–\-*]+/, "").toLowerCase().startsWith(name.toLowerCase()) ? code : `${code} ${name}`;
  });
}

/**
 * As one_pager.milestone_span (P4): from the earliest start of the items under dated milestones
 * (or that date, when earlier) to the latest milestone date; null with no dated milestone.
 */
function milestoneSpan(items: SliceItem[]): [string, string] | null {
  const dated = items.filter((i) => i.milestone?.[1]);
  if (!dated.length) return null;
  const end = dated.map((i) => i.milestone![1]!).sort().pop()!;
  const start = dated.flatMap((i) => [i.start, i.milestone![1]!]).sort()[0];
  return [start < end ? start : end, end];
}

/** The API's one_pager.template_only: only a template's comments, placeholders or arrows. */
const uncomment = (t: string) => t.replace(/<!--[\s\S]*?(?:-->|$)/g, " ");
const templateOnly = (t: string) => !/[\p{L}\p{N}]/u.test(uncomment(t).replace(/<[^<>\n]*>/g, ""));

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const RANK: Record<Role, number> = { viewer: 0, commenter: 1, approver: 2, owner: 3 };

/** As one_pager.decides: an owner; the decider; with none, a track owner while an approver. */
function decides(ctx: OnePagerCtx): boolean {
  if (ctx.role === "owner") return true;
  if (ctx.decider) return ctx.id === ctx.decider;
  return (ctx.trackOwners ?? []).includes(ctx.id) && RANK[ctx.role] >= RANK.approver;
}

/** As one_pager.may_decide: a proposal's decider is an owner (has_role on the role ladder), or
 * whom it is routed to; a viewer, commenter or approver decides only what is routed to them. */
function mayDecide(ctx: OnePagerCtx, c: Pick<Change, "routed_to">): boolean {
  return !!ctx.id && (RANK[ctx.role] >= RANK.owner || c.routed_to.includes(ctx.id));
}

/** As one_pager.starts (meetings.may_start): an owner or the PRD's decider start its review. */
function starts(ctx: OnePagerCtx): boolean {
  return ctx.role === "owner" || (!!ctx.decider && ctx.id === ctx.decider);
}

function seesDraft(db: OnePagerDb, ctx: OnePagerCtx): boolean {
  return ctx.role === "owner" || (db.draft?.participants.includes(ctx.id) ?? false) || (!!db.draft && ctx.reviewers.includes(ctx.id)) || (db.draft?.waiting_on ?? []).includes(ctx.id);
}

/** As one_pager.may_remind: the PRD's owners (a company owner, its track owners) and its decider. */
function mayRemind(ctx: OnePagerCtx): boolean {
  return decides(ctx) || (ctx.trackOwners ?? []).includes(ctx.id);
}

/** As one_pager.due_reminders: waiting reviewers not reminded in the last day. */
function dueReminders(db: OnePagerDb): string[] {
  const d = db.draft;
  if (!d || d.status !== "submitted") return [];
  const sent = d.reminders ?? {};
  return (d.waiting_on ?? []).filter((i) => !sent[i] || mockNowMs() - Date.parse(sent[i]) >= REMIND_EVERY_MS);
}

function remindedAt(db: OnePagerDb): string | null {
  const d = db.draft;
  const at = Object.entries(d?.reminders ?? {}).filter(([k]) => d?.waiting_on?.includes(k)).map(([, v]) => v).sort();
  return at.length ? at[at.length - 1] : null;
}

function seedLine(db: OnePagerDb, id: string): SeedLine | undefined {
  return db.blocks.flatMap((b) => b.lines).find((l) => l.id === id);
}

function lineNow(db: OnePagerDb, id: string): string | undefined {
  return db.draft?.lines[id] ?? seedLine(db, id)?.text;
}

function sectionNow(db: OnePagerDb, key: string, sees = true): string {
  return (sees ? db.draft?.sections[key] : undefined) ?? db.sections.find((s) => s.key === key)!.body;
}

/** As one_pager._section_body's heading: the draft's, else the published one. */
function headingNow(db: OnePagerDb, key: string, sees = true): string {
  return (sees ? db.draft?.headings?.[key] : undefined) ?? db.sections.find((s) => s.key === key)!.heading;
}

/** As the API's one_pager.patch_all: the facts (bullets, else sentences) the old line says
 * are replaced by the new line in its first section and dropped from the others; null when
 * a section holds none of them (the edit is refused, never appended). */
function plain(s: string): string {
  return s.split(/\s+/).filter(Boolean).join(" ");
}
function patch(body: string, old: string, next: string, first: boolean): string | null {
  const bullets = body.split("\n").map((l) => /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/.exec(l)?.[1]).filter((x): x is string => !!x);
  const spans = bullets.length ? bullets : body.trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  const o = plain(old).replace(/…$/, "");
  const hits = spans.filter((r) => plain(r) && (o.includes(plain(r)) || (o.split(" ").length > 2 && plain(r).includes(o))));
  if (!hits.length) return null;
  let out = body;
  hits.forEach((raw, i) => {
    if (first && i === 0) out = out.replace(raw, next);
    else if (bullets.length) out = out.split("\n").filter((l) => !(l.includes(raw) && /^\s*(?:[-*+]|\d+[.)])\s/.test(l))).join("\n");
    else out = out.replace(new RegExp(raw.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&") + "\\s*"), "");
  });
  return out;
}

/** As the API's metric_of: "name from X to Y". */
function metricOf(text: string): Line["metric"] {
  const m = /^(.*?)[:\s,-]*\s(?:from\s+)?(\S+)\s*(?:→|->|\bto\b)\s*(\S+)/i.exec(text);
  return m ? { name: m[1].trim() || text, from: m[2], to: m[3] } : null;
}

/** set_section_number (owner, Nov 5): a "Needs a look" numbers item's fix, as the API's one_pager. */
const NUMBER_OP = "set_section_number" as const;

/** As one_pager._ensure: while the PRD's draft is in review, a change that applies is refused. */
const inReview = (db: OnePagerDb) => db.draft?.status === "submitted";
const IN_REVIEW = "This PRD's draft is in review: changes wait until it is approved";

/** As one_pager._number_values: the section and the lines resting on it, as the reader has them. */
function numberValues(db: OnePagerDb, key: string, sees: boolean) {
  const heading = headingNow(db, key, sees);
  const lines = Object.fromEntries(db.blocks.flatMap((b) => b.lines).filter((l) => l.keys.includes(key)).map((l) => [l.id, (sees ? db.draft?.lines[l.id] : undefined) ?? l.text]));
  return { sections: { [key]: { heading, body: sectionNow(db, key, sees) } }, lines };
}

const held = (v: Record<string, unknown>) => JSON.stringify({ sections: v.sections ?? {}, lines: v.lines ?? {} });

function numberConflict(db: OnePagerDb, ctx: OnePagerCtx, key: string, sees: boolean, message: string): Response {
  const last = sees ? [...liveChanges(db)].reverse().find((c) => key in ((c.after.sections ?? {}) as Record<string, unknown>)) : undefined;
  const by = last ? { id: last.by, name: ctx.names[last.by] ?? last.by_name } : null;
  return json(409, { detail: { message: by ? `Changed by ${by.name}` : message, current: { section: key, heading: headingNow(db, key, sees), body: sectionNow(db, key, sees) }, changed_by: by, changed_at: last?.at ?? null } });
}

/** As one_pager._number_undone: the section and its lines as now, with only `c`'s number put back (either of two fixes in one section undoes); null when that number is gone. */
function numberUndone(c: Change, now: ReturnType<typeof numberValues>): Record<string, unknown> | null {
  if (held(now) === held(c.after)) return { sections: c.before.sections ?? {}, lines: c.before.lines ?? {} };
  const key = String(c.target.section), part = (c.target.part ?? "body") as "body" | "heading";
  const [first, ...rest] = spaces(String(c.target.said)).split(" ");
  const was = String(c.before.number ?? first);
  const said = [asWritten(first, String(c.after.number ?? "")), ...rest].join(" ");
  const sec = { ...now.sections[key] };
  const put = setNumber(sec[part], said, was);
  if (put === null) return null;
  sec[part] = put;
  const [setBefore, setAfter] = [(c.before.lines ?? {}) as Record<string, string>, (c.after.lines ?? {}) as Record<string, string>];
  const lines = Object.fromEntries(Object.entries(now.lines).map(([i, x]) => [i, setBefore[i] !== setAfter[i] ? (setNumber(x, said, was) ?? x) : x]));
  return { sections: { [key]: sec }, lines };
}

/** Python's str.split() with no argument: as one_pager._create_number collapses the spaces of `said` (" ".join(said.split())), no more. */
function spaces(s: string): string {
  return s.split(/[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/).filter(Boolean).join(" ");
}

function writeNumber(db: OnePagerDb, ctx: OnePagerCtx, values: Record<string, unknown>) {
  db.draft ??= { id: stableUuid(`simple-one-pager-draft-${db.doc.id}-${mockNowMs()}`), base: db.version, participants: [], lines: {}, sections: {} };
  if (!db.draft.participants.includes(ctx.id)) db.draft.participants.push(ctx.id);
  for (const [id, text] of Object.entries((values.lines ?? {}) as Record<string, string>)) {
    if (text === seedLine(db, id)?.text) delete db.draft.lines[id];
    else db.draft.lines[id] = text;
  }
  for (const [k, v] of Object.entries((values.sections ?? {}) as Record<string, { heading?: string; body: string }>)) {
    const sec = db.sections.find((s) => s.key === k);
    if (v.body === sec?.body) delete db.draft.sections[k];
    else db.draft.sections[k] = v.body;
    const heads = (db.draft.headings ??= {});
    if (v.heading === undefined || v.heading === sec?.heading) delete heads[k];
    else heads[k] = v.heading;
  }
}

function write(db: OnePagerDb, ctx: OnePagerCtx, lineId: string, values: Record<string, unknown>) {
  db.draft ??= { id: stableUuid(`simple-one-pager-draft-${db.doc.id}-${mockNowMs()}`), base: db.version, participants: [], lines: {}, sections: {} };
  if (!db.draft.participants.includes(ctx.id)) db.draft.participants.push(ctx.id);
  const line = String(values.line);
  if (line === seedLine(db, lineId)?.text) delete db.draft.lines[lineId];
  else db.draft.lines[lineId] = line;
  for (const [k, v] of Object.entries((values.sections ?? {}) as Record<string, { body: string }>)) {
    if (v.body === db.sections.find((s) => s.key === k)?.body) delete db.draft.sections[k];
    else db.draft.sections[k] = v.body;
  }
}

/**
 * S8: the decider's Approve in a meeting with no required reviewer waiting publishes the
 * PRD's draft (drafts.approve_in_meeting): its lines and sections become the page's, the
 * version moves on, no working draft is left; open proposals stay.
 */
export function publishOnePager(db: OnePagerDb) {
  const d = db.draft;
  if (!d) return;
  for (const b of db.blocks) for (const l of b.lines) if (d.lines[l.id] !== undefined) l.text = d.lines[l.id];
  for (const sec of db.sections) if (d.sections[sec.key] !== undefined) sec.body = d.sections[sec.key];
  for (const sec of db.sections) if (d.headings?.[sec.key] !== undefined) sec.heading = d.headings[sec.key];
  db.version += 1;
  // qa4-simple-decide-25: as the API (the new version's approved_at), the header's day moves on.
  db.published_at = new Date(mockNowMs()).toISOString();
  db.draft = null;
  db.approval = null;
  db.changes = db.changes.filter((c) => c.status === "proposed");
}

function liveChanges(db: OnePagerDb) {
  const undone = new Set(db.changes.filter((c) => c.status === "undone").map((c) => c.undoes_id));
  return madeOrder(db.changes, (c) => [c.at]).filter((c) => (c.status === "applied" || c.status === "accepted") && !undone.has(c.id));
}

function out(db: OnePagerDb, ctx: OnePagerCtx, c: Change): Change {
  return {
    ...c,
    can_decide: c.status === "proposed" && mayDecide(ctx, c),
    can_undo: c.status === "applied" && c.by === ctx.id && !db.changes.some((u) => u.undoes_id === c.id),
  };
}

function patches(c: Change): Patch[] {
  const before = (c.before.sections ?? {}) as Record<string, { heading: string; body: string }>;
  return Object.entries((c.after.sections ?? {}) as Record<string, { heading: string; body: string }>).map(([key, v]) => ({
    key, heading: v.heading, before: before[key]?.body ?? "", after: v.body,
  }));
}

function onePager(db: OnePagerDb, ctx: OnePagerCtx): Schemas["OnePagerOut"] {
  const sees = seesDraft(db, ctx);
  const sees_ = (c: Change) => c.by === ctx.id || mayDecide(ctx, c);
  // As the API: a numbers fix proposed shows on its "Needs a look" item, never as a line's note.
  // As one_pager.py: changes by when, a tie in the order they were made (seq), never by id.
  const made = madeOrder(db.changes, (c) => [c.at]);
  const fixes = made.filter((c) => c.status === "proposed" && c.op === NUMBER_OP && sees_(c));
  const proposals = made.filter((c) => c.status === "proposed" && c.op === "edit_line");
  const shown = proposals.filter(sees_);
  const live = sees ? liveChanges(db).filter((c) => c.status !== "undone" && c.op === "edit_line") : [];
  // As the API's OnePagerOut.fixed: the draft's number fixes, each with its Undo while it can be undone.
  const fixed: Schemas["OnePagerFixed"][] = (sees ? liveChanges(db).filter((c) => c.op === NUMBER_OP) : []).map((c) => {
    const key = String(c.target.section ?? "");
    const heading = ((c.after.sections ?? {}) as Record<string, { heading?: string }>)[key]?.heading ?? key;
    return { change_id: c.id, words: `Fixed: set to ${String(c.after.number ?? "")} in “${heading}”`, can_undo: c.status === "applied" && c.by === ctx.id && c.session_open };
  });
  const note = (c: (typeof db.changes)[number], kind: "change" | "proposal"): Schemas["OnePagerNote"] => {
    const lineId = String(c.target.line_id);
    return {
      change_id: c.id, line_id: lineId, kind, by: c.by, by_name: c.by_name, at: c.at, in_meeting: c.in_meeting,
      before: String(c.before.line ?? ""), after: String(c.after.line ?? ""), sections: patches(c),
      can_undo: kind === "proposal" ? c.by === ctx.id : c.by === ctx.id && c.session_open,
      can_decide: kind === "proposal" && mayDecide(ctx, c),
      adds_feature: lineId.startsWith("bets-"), flow: onePagerFlow(flowFor(db.visuals, "change", c.id)), meeting_title: c.meeting_title ?? null,
    };
  };
  const notes = [...live.map((c) => note(c, "change")), ...shown.map((c) => note(c, "proposal"))];
  const proposed = new Set(notes.filter((n) => n.kind === "proposal").map((n) => n.line_id));
  const hiddenDraft = !sees && db.draft ? Object.keys(db.draft.lines).length : 0;
  const owner = db.ownerless ? undefined : db.owner ?? ctx.owners[0];
  // S-8: a PRD's own page reads its slice from the roadmap at each read (one_pager.prd_items).
  const read = db.roadmap ? prdSlice(db.roadmap, ctx.role, db) : null;
  const placed = read ? read.items : namedMilestones(db.slice ?? SLICE, {});
  const span = read?.span ?? milestoneSpan(placed);
  // The Timeline lists each item once; the strip reads one input per slice.
  const slice = placed.filter((x, i) => !x.id || placed.findIndex((y) => y.id === x.id) === i);
  const held = ctx.role === "owner" ? db.held ?? null : null;
  // A build held for owners (oracle.simple.quality) is what owners read; others the last good.
  // vqa one-pager 1, as visuals.flows_of_bets: each bet's flow on the bet it was drawn for.
  const betLines = (held?.blocks ?? db.blocks).find((b) => b.key === "bets")?.lines ?? [];
  const keyOf = (id: string) => (db.flowKey ? `${db.flowKey}/${id}` : id);
  const betIndex = new Map(betLines.map((l, i) => [l.id, i]));
  const found = flowsOfBets(db.visuals, db.flowKey ?? db.doc.slug, betLines.map((l) => ({ key: keyOf(l.id), text: uncomment(l.text).split(/\s+/).filter(Boolean).join(" ") })));
  const blocks: Schemas["OnePagerBlock"][] = (held?.blocks ?? db.blocks).map((b) => ({
      key: b.key, title: b.title, rules: b.rules, kind: b.kind, who: null,
      // P-9: a line that only says "Not in the PRD yet" is the block's mark, said once.
      missing: (!!b.missing || b.lines.some((l) => !(sees && db.draft?.lines[l.id] !== undefined) && saysNotInPrd(l.text))) && !b.lines.some((l) => (sees && db.draft?.lines[l.id] !== undefined) || (!templateOnly(l.text) && !saysNotInPrd(l.text))),
      lines: b.lines.filter((l) => (sees && db.draft?.lines[l.id] !== undefined) || (!templateOnly(l.text) && !saysNotInPrd(l.text))).map((l): Line => {
        const edited = sees && db.draft?.lines[l.id] !== undefined;
        // As one_pager._tidy: a stored line's citations resolved, as the PRD's PDF resolves them.
        const text = edited ? db.draft!.lines[l.id] : resolved(uncomment(l.text)).split(/\s+/).filter(Boolean).join(" ");
        const metric = l.metric ? { name: resolved(l.metric.name).trim(), from: resolved(l.metric.from).trim(), to: resolved(l.metric.to).trim() } : null;
        const bet = b.key === "bets" ? found[betIndex.get(l.id) ?? -1] : undefined;
        const flow = bet ? onePagerFlow(bet.flow) : null;
        return {
          id: l.id, text, full: edited || !l.full ? null : resolved(l.full), source_keys: l.keys, metric: edited && b.kind === "metrics" ? metricOf(text) : metric,
          state: edited ? "edited" : proposed.has(l.id) ? "proposal" : "published",
          // S10: each bet carries its visual, keyed by its line: an edit keeps the flow. Its
          // brief is the published words (the API's bet_line): never a draft's.
          ...(b.key === "bets" ? { flow_subject: bet?.subject ?? betSubject(keyOf(l.id)), flow } : {}),
          decisions: [...(db.decisions?.[l.id] ?? [])],
          measure: null, measure_source: null, footnotes: [],
          // 2026-10-30: a bet with no flow offers "Draw the flow" to those who change the PRD (visuals.may_revise).
          can_draw_flow: b.key === "bets" && !flow && decides(ctx),
        };
      }),
    }));
  // Reads clearly (2026-10-30): as one_pager_checks.annotate on the PRD's sections.
  // The numbers as the reader's working draft has them, so a fixed number clears.
  const looks = annotate(blocks, db.sections, db.sections.map((x) => ({ ...x, heading: headingNow(db, x.key, sees), body: sectionNow(db, x.key, sees) }))).map((x): Schemas["OnePagerLook"] => {
    if (!x.fix) return { ...x, fix: null };
    const f = x.fix;
    const c = fixes.find((y) => y.target.section === f.target.section && y.target.said === f.target.said && (y.target.part ?? "body") === (f.target.part ?? "body"));
    // As the API: a draft in review takes no change that applies, so who would apply the fix is offered none (an open proposal stays).
    if (!c && inReview(db) && decides(ctx)) return { ...x, fix: null };
    return {
      ...x,
      fix: {
        ...f, target: { ...f.target, document_id: db.doc.id },
        proposal: c ? { change_id: c.id, by_name: c.by_name, can_decide: mayDecide(ctx, c), can_undo: c.by === ctx.id } : null,
      },
    };
  });
  // P-5: each goal code with its name beside it; the Edit box keeps the PRD's words.
  const goals = goalNames(db.sections);
  for (const b of blocks) {
    for (const x of b.lines) {
      const said = x.words ?? x.full ?? x.text;
      x.text = withGoalNames(x.text, goals);
      if (x.full) x.full = withGoalNames(x.full, goals);
      if (x.metric) x.metric.name = withGoalNames(x.metric.name, goals);
      if (x.measure) x.measure = withGoalNames(x.measure, goals);
      if (!x.words && (x.full ?? x.text) !== said) x.words = said;
    }
  }
  return {
    document: db.doc,
    version: db.version,
    published_at: db.published_at === undefined ? "2026-10-20T15:00:00Z" : db.published_at,
    owner: owner ? { id: owner, name: ctx.names[owner] ?? "Owner" } : null,
    decider: ctx.decider ? { id: ctx.decider, name: ctx.names[ctx.decider] ?? "someone" } : null,
    span_start: span?.[0] ?? null,
    span_end: span?.[1] ?? null,
    built_by: (db.writing || db.quickRead) && !held ? "extract" : "oracle",
    writing: !!db.writing && !held,
    built_at: "2026-10-20T15:05:00Z",
    blocks,
    timeline: slice.map((x, i) => ({ id: sliceItemId(x, i), title: x.title, horizon: x.horizon, start: x.start, end: x.end, estimated: x.estimated })),
    plan: planByMonth(
      placed.map((x, i) => ({ id: sliceItemId(x, i), start: x.start, end: x.end, estimated: x.estimated, milestone: x.milestone?.[0] ?? null, milestoneDate: x.milestone?.[1] ?? null, milestoneStart: x.milestoneStart ?? null, record: x.record ?? null })),
      // qa4-simple-prd-10: the company's day, as the API's slice (and the notes' times) read it.
      companyDayIso(new Date(mockNowMs())),
    ),
    // As the API: the sections the page's lines rest on.
    sections: db.sections.filter((s) => db.blocks.some((b) => b.lines.some((l) => l.keys.includes(s.key)))).map((s) => ({ key: s.key, heading: headingNow(db, s.key, sees), body: sectionNow(db, s.key, sees) })),
    // decisions-reversed-or-trashed: the lines' decisions left out as no longer standing.
    left_out: leftOut(),
    notes,
    draft: sees && db.draft
      ? {
          id: db.draft.id, status: db.draft.status ?? "working", changes: liveChanges(db).length, base_version: db.draft.base, decider_approved: !!db.approval, approved_in: db.approval?.approved_in ?? null, blocked_by: db.approval?.blocked_by ?? [],
          waiting_on: db.approval?.waiting_on ?? (db.draft.waiting_on ?? []).map((i) => ({ id: i, name: ctx.names[i] ?? "someone" })),
          // build-review: who approves once sent (the PRD's required reviewers), on a working draft.
          reviewers: (db.draft.status ?? "working") === "working" ? ctx.reviewers.map((i) => ({ id: i, name: ctx.names[i] ?? "someone" })) : [],
          can_submit: (db.draft.status ?? "working") === "working" && decides(ctx) && liveChanges(db).length > 0,
          reminded_at: remindedAt(db), can_remind: mayRemind(ctx) && dueReminders(db).length > 0, decision_notes: draftDecisionNotes(),
        }
      : null,
    changes_in_review: hiddenDraft + (proposals.length - shown.length),
    // build-review: the same changes, one each, for readers who do not see the draft.
    in_review: sees ? [] : [
      ...Object.entries(db.draft?.lines ?? {}).map(([id, after]) => {
        const c = [...db.changes].reverse().find((x) => x.status !== "proposed" && x.status !== "undone" && String(x.target.line_id) === id);
        return {
          line_id: id, kind: "change" as const, before: seedLine(db, id)?.text ?? "", after, by_name: c?.by_name ?? ctx.names[ctx.owners[0]] ?? "an owner",
          waiting_on: (db.draft?.status === "submitted" ? db.draft.waiting_on ?? [] : []).map((i) => ({ id: i, name: ctx.names[i] ?? "someone" })),
        };
      }),
      ...proposals.filter((c) => !shown.includes(c)).map((c) => ({
        line_id: String(c.target.line_id), kind: "proposal" as const, before: String(c.before.line ?? ""), after: String(c.after.line ?? ""), by_name: c.by_name,
        waiting_on: c.routed_to.map((i) => ({ id: i, name: ctx.names[i] ?? "someone" })),
      })),
    ],
    can_edit: decides(ctx),
    can_propose: !decides(ctx) && RANK[ctx.role] >= RANK.commenter,
    can_start: starts(ctx),
    // As one_pager.owns: a company owner, the PRD's track owners and its document owner read the
    // PRD's numbers and codes to look at; owners also read the checks a held build failed.
    fixed,
    needs_look: [
      // Who is no owner reads only the items holding a proposal of theirs or one they decide (the Inbox's Open lands there).
      ...(ctx.role === "owner" || (ctx.trackOwners ?? []).includes(ctx.id) || (!!owner && ctx.id === owner) ? looks : looks.filter((x) => !!x.fix?.proposal)),
      ...(held ? held.checks.map((text) => ({ kind: "check", text, where: [], source_keys: [] })) : []),
    ],
  };
}

async function body(req: Request): Promise<Record<string, unknown>> {
  return ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
}

export async function routeOnePager(db: OnePagerDb, ctx: OnePagerCtx, req: Request, p: string[]): Promise<Response | null> {
  if (p[1] !== "simple") return null;
  const m = req.method;
  // simple-replaced-prds (as one_pager._document with current): a replaced PRD has no one-pager in Simple.
  const replaced = () => json(404, { detail: { message: "This PRD was replaced", replaced_by: ctx.replacedBy ?? [] } });
  if (p[2] === "one-pagers" && m === "GET") {
    if (p[3] !== db.doc.slug && p[3] !== db.doc.id) return json(404, { detail: "No such PRD" });
    if (ctx.replacedBy?.length) return replaced();
    if (p[4] === "pdf") {
      if (ctx.pdfDown) return json(503, { detail: "PDF export is unavailable: WeasyPrint cannot load its system libraries (install Pango, see api/Dockerfile): cannot load library 'libpango-1.0-0'" });
      const over = !ctx.planPages?.length && ctx.overflowPages ? ctx.overflowPages : 0;
      const pages = ctx.planPages?.length ? ["The timeline", ...ctx.planPages] : over ? Array.from({ length: over }, (_, i) => `Page ${i + 1}`) : ["One page"];
      // The page's lines as the read resolves them (the API's PDF renders one_pager.read).
      const lines = onePager(db, ctx).blocks.flatMap((b) => b.lines.map((l) => `% line: ${l.text}\n`));
      // As the API: a one-pager past its page says so in X-Oracle-Overflow-Pages, never in the PDF.
      return new Response(`%PDF-1.7\n${pages.map((t, i) => `% page ${i + 1}: ${t}\n`).join("")}${lines.join("")}`, {
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "content-disposition": `attachment; filename="${db.doc.slug}-v${db.version}-one-pager.pdf"`,
          ...(over ? { "x-oracle-overflow-pages": String(over) } : {}),
        },
      });
    }
    return json(200, onePager(db, ctx));
  }
  if (p[2] === "drafts" && p[4] === "submit" && m === "POST" && db.draft && p[3] === db.draft.id) {
    if (!decides(ctx)) return json(403, { detail: "Only an owner or the PRD's decider submits its draft" });
    if ((db.draft.status ?? "working") !== "working") return json(409, { detail: "This draft is submitted already" });
    // build-review: Send for approval… may add reviewers (members only), after the required ones.
    const added = ((await body(req)).reviewer_ids ?? []) as string[];
    if (added.some((i) => !(i in ctx.names))) return json(422, { detail: "Each reviewer you add must be an active member of the company" });
    // As oracle.simple.drafts._added_reviewers: a viewer cannot approve.
    const viewers = added.filter((i) => ctx.roles?.[i] === "viewer" && !ctx.reviewers.includes(i)).map((i) => ctx.names[i]);
    if (viewers.length)
      return json(422, { detail: `${viewers.length === 1 ? viewers[0] : `${viewers.slice(0, -1).join(", ")} and ${viewers[viewers.length - 1]}`} can only view, so cannot approve: pick someone else` });
    db.draft.status = "submitted";
    db.draft.waiting_on = [...new Set([...ctx.reviewers, ...added])];
    db.draft.reminders = {};
    db.changes.forEach((c) => (c.session_open = false));
    const as = ctx.imported?.(db.sections.map((x) => ({ key: x.key, heading: headingNow(db, x.key), body: sectionNow(db, x.key) })), db.version + 1) ?? db.version + 1;
    db.draft.submitted_as = as;
    return json(200, { id: db.draft.id, status: "submitted", version: as, waiting_on: db.draft.waiting_on });
  }
  if (p[2] === "one-pagers" && p[4] === "remind" && m === "POST") {
    if (p[3] !== db.doc.slug && p[3] !== db.doc.id) return json(404, { detail: "No such PRD" });
    if (ctx.replacedBy?.length) return replaced();
    if (RANK[ctx.role] < RANK.commenter || !mayRemind(ctx)) return json(403, { detail: "Only the PRD's owners and its decider remind its reviewers" });
    const d = db.draft;
    if (!d || d.status !== "submitted" || !d.waiting_on?.length) return json(409, { detail: "No submitted draft of this PRD waits on a review" });
    const due = dueReminders(db);
    if (!due.length) return json(409, { detail: "Every reviewer it waits on was reminded in the last day" });
    const at = new Date(mockNowMs()).toISOString();
    const n = liveChanges(db).length;
    for (const i of due) {
      if (i === ctx.id) continue;
      ctx.notify(i, "review_reminder", `${ctx.names[ctx.id] ?? "Someone"} is waiting for your review of ${db.doc.title}`, {
        draft_id: d.id, href: `/simple/one-pagers/${db.doc.slug}`, waits: `Version ${db.version + 1} · ${n} ${n === 1 ? "change" : "changes"}`,
      }, db.version + 1);
    }
    d.reminders = { ...(d.reminders ?? {}), ...Object.fromEntries(due.map((i) => [i, at])) };
    return json(200, { reminded: due.map((i) => ({ id: i, name: ctx.names[i] ?? "someone" })), reminded_at: at });
  }
  if (p[2] !== "changes") return null;
  if (m === "POST" && p.length === 3) {
    const b = await body(req.clone());
    if (b.op === NUMBER_OP) return createNumber(db, ctx, b);
    if (b.op !== "edit_line") return null;
    const target = (b.target ?? {}) as Record<string, string>;
    const lineId = String(target.line_id ?? "");
    // Who cannot see the draft proposes against the published line and sections.
    const sees = seesDraft(db, ctx);
    const cur = sees ? lineNow(db, lineId) : seedLine(db, lineId)?.text;
    if (cur === undefined) return json(404, { detail: "No such line on this one-pager" });
    if (RANK[ctx.role] < RANK.commenter) return json(403, { detail: "Viewers read the one-pager" });
    const old = String(((b.before ?? {}) as Record<string, unknown>).line ?? "");
    const next = String(((b.after ?? {}) as Record<string, unknown>).line ?? "").split(/\s+/).filter(Boolean).join(" ");
    if (!next || next.length > 300) return json(422, { detail: "after.line: 1 to 300 characters" });
    if (old !== cur) return json(409, { detail: { message: "This line changed since you read it", current: { line: cur }, changed_by: null, changed_at: null } });
    const keys = seedLine(db, lineId)!.keys;
    const heads = Object.fromEntries(db.sections.map((s) => [s.key, s.heading]));
    const patched = keys.map((k, i) => patch(sectionNow(db, k, sees), cur, next, i === 0));
    if (patched.some((x) => x === null)) return json(409, { detail: "Oracle could not find this line's words in its sections; open the detailed view to edit them" });
    if (decides(ctx) && inReview(db)) return json(409, { detail: IN_REVIEW });
    const before = { line: cur, sections: Object.fromEntries(keys.map((k) => [k, { heading: heads[k], body: sectionNow(db, k, sees) }])) };
    const after = { line: next, sections: Object.fromEntries(keys.map((k, i) => [k, { heading: heads[k], body: patched[i]! }])) };
    const applies = decides(ctx);
    const c = {
      id: stableUuid(`op-change-${db.doc.id}-${db.changes.length}-${mockNowMs()}`), session_id: applies ? stableUuid(`op-session-${ctx.id}`) : null,
      document_id: db.doc.id, draft_ids: [] as string[], op: "edit_line" as const,
      target: { document_id: db.doc.id, line_id: lineId, version: db.version }, before, after,
      status: (applies ? "applied" : "proposed") as Change["status"], by: ctx.id, by_name: ctx.names[ctx.id] ?? "someone",
      at: new Date(mockNowMs()).toISOString(), decided_by: null, decided_at: null, reason: null, decision_reason: null,
      routed_to: applies ? [] : ctx.owners, undoes_id: null, undone: false, can_decide: false, can_undo: false,
      session_open: applies, in_meeting: false,
    };
    if (applies) {
      write(db, ctx, lineId, after);
      c.draft_ids = [db.draft!.id];
    }
    db.changes.push(c);
    // S10: a bet's new wording comes with its visual (Oracle drafts it with the proposal).
    if (lineId.startsWith("bets-")) requestVisual(db.visuals, "change", c.id, `A bet of the PRD's one-pager, reworded to: ${next}`);
    return json(201, { change: out(db, ctx, c), flags: [] });
  }
  const c = db.changes.find((x) => x.id === p[3]);
  if (!c || m !== "POST") return null;
  if (p[4] === "accept" || p[4] === "decline") {
    if (!mayDecide(ctx, c)) return json(403, { detail: "Only an owner or the PRD's decider decides this proposal" });
    if (c.status !== "proposed") return json(409, { detail: `This change is ${c.status} already` });
    const lineId = String(c.target.line_id);
    if (p[4] === "accept" && c.op === NUMBER_OP) {
      const key = String(c.target.section);
      if (held(numberValues(db, key, true)) !== held(c.before)) return numberConflict(db, ctx, key, true, "outdated: the section changed since the proposal");
      if (inReview(db)) return json(409, { detail: IN_REVIEW });
      writeNumber(db, ctx, c.after);
      c.draft_ids = [db.draft!.id];
    } else if (p[4] === "accept") {
      if (lineNow(db, lineId) !== c.before.line) return json(409, { detail: { message: "outdated: the line or its sections changed since the proposal", current: { line: lineNow(db, lineId) }, changed_by: null, changed_at: null } });
      if (inReview(db)) return json(409, { detail: IN_REVIEW });
      write(db, ctx, lineId, c.after);
      c.draft_ids = [db.draft!.id];
    }
    c.status = p[4] === "accept" ? "accepted" : "declined";
    c.decided_by = ctx.id;
    c.decided_at = new Date(mockNowMs()).toISOString();
    return json(200, { change: out(db, ctx, c), flags: [] });
  }
  if (p[4] === "undo") {
    // qa-simple-prd-p3-17: a proposal is withdrawn by its author (declined, the PRD untouched).
    if (c.status === "proposed") {
      if (c.by !== ctx.id) return json(403, { detail: "Only the person who proposed it withdraws it" });
      c.status = "declined";
      c.decided_by = ctx.id;
      c.decided_at = new Date(mockNowMs()).toISOString();
      c.decision_reason = "Withdrawn by its author";
      return json(201, { change: out(db, ctx, c), flags: [] });
    }
    if (c.status !== "applied") return json(409, { detail: `Only an applied change undoes; this one is ${c.status}` });
    if (c.by !== ctx.id) return json(403, { detail: "Only the person who made a change undoes it" });
    if (db.changes.some((u) => u.undoes_id === c.id)) return json(409, { detail: "This change is undone already" });
    if (c.op === NUMBER_OP) {
      const key = String(c.target.section);
      const now = numberValues(db, key, true);
      const back = numberUndone(c, now);
      if (!back) return numberConflict(db, ctx, key, true, "Changed since");
      writeNumber(db, ctx, back);
      return undone(db, ctx, c, { ...now, number: c.after.number }, { ...back, number: c.before.number });
    }
    write(db, ctx, String(c.target.line_id), c.before);
    return undone(db, ctx, c, c.after, c.before);
  }
  return null;
}

/** As one_pager.undo: the undo of `c`, written already, recorded as its own change (`before`: what it found, `after`: what it put back). */
function undone(db: OnePagerDb, ctx: OnePagerCtx, c: OnePagerDb["changes"][number], before: Change["before"], after: Change["after"]): Response {
  const u = { ...c, id: stableUuid(`op-undo-${c.id}`), status: "undone" as const, before, after, undoes_id: c.id, at: new Date(mockNowMs()).toISOString() };
  db.changes.push(u);
  return json(201, { change: out(db, ctx, u), flags: [] });
}

/** As one_pager._create_number: the number in the words `said` of one section set, with the lines saying the same words. */
function createNumber(db: OnePagerDb, ctx: OnePagerCtx, b: Record<string, unknown>): Response {
  const t = (b.target ?? {}) as Record<string, string>;
  if (t.document_id !== db.doc.id) return json(404, { detail: "No such PRD" });
  const key = String(t.section ?? ""), said = spaces(String(t.said ?? ""));
  const part = (t.part ?? "body") as "body" | "heading";
  const old = String(((b.before ?? {}) as Record<string, unknown>).number ?? "").trim();
  const next = String(((b.after ?? {}) as Record<string, unknown>).number ?? "").trim();
  if (!key || !said) return json(422, { detail: "target: the section and the words the number is in" });
  if (part !== "body" && part !== "heading") return json(422, { detail: "target.part: body or heading" });
  if (!/^\d[\d,]*(?:\.\d+)?$/.test(next)) return json(422, { detail: "after.number: a number" });
  if (!old) return json(422, { detail: "before.number: the number as you saw it" });
  if (!db.sections.some((s) => s.key === key)) return json(404, { detail: "No such section in this PRD" });
  const applies = decides(ctx);
  if (!applies && RANK[ctx.role] < RANK.commenter) return json(403, { detail: "Viewers read the one-pager" });
  const sees = seesDraft(db, ctx);
  const before: Record<string, unknown> = numberValues(db, key, sees);
  const sec = (before.sections as Record<string, { heading: string; body: string }>)[key];
  const patched = said.split(" ")[0].toLowerCase() === old.toLowerCase() ? setNumber(sec[part], said, next) : null;
  if (patched === null) return numberConflict(db, ctx, key, sees, "This number changed since you read it");
  if (applies && inReview(db)) return json(409, { detail: IN_REVIEW });
  const after: Record<string, unknown> = {
    sections: { [key]: { ...sec, [part]: patched } },
    // A heading's count is no line's words: the lines stay as they are.
    lines: Object.fromEntries(Object.entries(before.lines as Record<string, string>).map(([i, x]) => [i, part === "heading" ? x : (setNumber(x, said, next) ?? x)])),
    number: next,
  };
  before.number = old;
  const c = {
    id: stableUuid(`op-change-${db.doc.id}-${db.changes.length}-${mockNowMs()}`), session_id: applies ? stableUuid(`op-session-${ctx.id}`) : null,
    document_id: db.doc.id, draft_ids: [] as string[], op: NUMBER_OP,
    target: { document_id: db.doc.id, section: key, said, ...(part === "heading" ? { part } : {}), version: db.version }, before, after,
    status: (applies ? "applied" : "proposed") as Change["status"], by: ctx.id, by_name: ctx.names[ctx.id] ?? "someone",
    at: new Date(mockNowMs()).toISOString(), decided_by: null, decided_at: null, reason: null, decision_reason: null,
    // As one_pager.route: the PRD's decider, else its track owners (approvers), else the company's owners.
    routed_to: applies ? [] : ctx.decider ? [ctx.decider] : (ctx.trackOwners ?? []).length ? [...ctx.trackOwners!] : ctx.owners, undoes_id: null, undone: false, can_decide: false, can_undo: false,
    session_open: applies, in_meeting: false,
  };
  if (applies) {
    writeNumber(db, ctx, after);
    c.draft_ids = [db.draft!.id];
  }
  db.changes.push(c);
  return json(201, { change: out(db, ctx, c), flags: [] });
}

/**
 * GET /v1/simple/changes?status=proposed's one-pager part (changes.listing sees edit_line and
 * set_section_number on a PRD): the proposals this reader sees (an owner, its author, whom it is
 * routed to), each with whether they may decide it and its words.
 */
export function onePagerProposalsOut(dbs: OnePagerDb[], me: { id: string; role: Role }, mine: boolean): Change[] {
  return dbs
    .flatMap((d) => d.changes)
    .filter((c) => c.status === "proposed" && (!mine || c.by === me.id) && (me.role === "owner" || c.by === me.id || c.routed_to.includes(me.id)))
    .map((c) => ({ ...c, can_decide: me.role === "owner" || c.routed_to.includes(me.id), can_undo: c.by === me.id, words: changeSentence(c, c.by_name, null, false) }));
}

/**
 * inbox-meeting-proposals fix (changes.inbox_rows): the proposed wordings waiting for `me` (an
 * owner, or whom the proposal is routed to), each named by its line as it read, and the
 * decisions on mine of these one-pagers.
 */
export function onePagerInboxRows(
  dbs: OnePagerDb[],
  me: { id: string; role: Role },
  seen: string | null,
): { proposals: Schemas["InboxSimpleChange"][]; decisions: Schemas["InboxSimpleChange"][] } {
  // What the row is on and what was asked, as changes.inbox_rows (_subject, asked_of) for each kind:
  // a line's wording quotes the line; a number fix names its PRD and the section it changes.
  const words = (d: OnePagerDb, c: Change): Pick<Schemas["InboxSimpleChange"], "asked" | "subject" | "line_id" | "section"> => {
    const proposed = c.status === "proposed";
    if (c.op === "set_section_number") {
      const n = String(c.after.number ?? "");
      const name = `Section number on ${d.doc.title}`;
      const done = changePhrase(c.op, c.target, c.before, c.after, null);
      return {
        subject: n ? `${name}: Use ${n}` : name,
        // Still to decide: "proposed setting the number in “Not this quarter” to 6".
        asked: proposed ? `proposed setting${done.slice("set".length)}` : done,
        line_id: null,
        section: String(c.target.section ?? "") || null,
      };
    }
    const line = String(c.before.line ?? "").split(/\s+/).filter(Boolean).join(" ");
    const next = String(c.after.line ?? "").split(/\s+/).filter(Boolean).join(" ");
    return {
      subject: line || null,
      // Still to decide, it reads as proposed (changes.inbox_rows asked_of); once decided, as done.
      asked: proposed ? `proposed new wording for a one-pager line${next ? `: “${next}”` : ""}` : changePhrase(c.op, c.target, c.before, c.after, null),
      line_id: String(c.target.line_id ?? "") || null,
      section: null,
    };
  };
  const row = (d: OnePagerDb, c: Change, at: string | null, state?: Schemas["InboxSimpleChange"]["state"]): Schemas["InboxSimpleChange"] => ({
    id: c.id, op: c.op, status: c.status, item_id: null, item_title: null, document_id: c.document_id, by: c.by, by_name: c.by_name, at: c.at,
    decided_by: c.decided_by, decided_at: c.decided_at, reason: c.reason, decision_reason: c.decision_reason,
    state: state ?? (!seen || (at && at > seen) ? "new" : "open"), from_meeting: null,
    can_decide: c.status === "proposed" && (me.role === "owner" || c.routed_to.includes(me.id)), from_ask: false,
    question_id: null, ...words(d, c),
  });
  const all = dbs.flatMap((d) => d.changes.map((c) => [d, c] as const));
  return {
    // As the API: routed to me (the mock routes a proposal to the owners).
    proposals: all.filter(([, c]) => c.status === "proposed" && c.routed_to.includes(me.id)).map(([d, c]) => row(d, c, c.at)),
    decisions: all
      .filter(([, c]) => c.by === me.id && (c.status === "accepted" || c.status === "declined") && c.decision_reason !== "Withdrawn by its author")
      .map(([d, c]) => row(d, c, c.decided_at, !seen || (c.decided_at ?? "") > seen ? undefined : "done")),
  };
}
