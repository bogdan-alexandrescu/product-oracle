/**
 * H8 Board and investor drafts in the mock: the two built-in update templates (word for word
 * api/oracle/templates/builtin/update/*.md), the draft an update_draft run writes, the dates
 * check over every PRD with an active product track, and who sees an update (owners and
 * approvers). The synthetic updates the default company starts with are in ./fixtures.ts.
 * No real company or customer data: the company is the fictional "Example Co".
 */
import type { Schemas } from "@/lib/api/client";

import { UPDATE_SOURCES, type SectionSeed } from "./fixtures";
import { dateMarks, type RoadmapDb } from "./roadmap";

export type UpdateTemplate = "investor-update" | "board-product";
export type UpdatePeriod = Schemas["UpdatePeriod"];
type Role = Schemas["Me"]["role"];
type Visibility = Schemas["DocumentSummary"]["visibility"];

export const UPDATE_TEMPLATES: readonly UpdateTemplate[] = ["investor-update", "board-product"];

/** The board deck: two slides, each a group of brief sections (front matter `slides`). */
export const BOARD_SLIDES = [
  ["headline", "goals"],
  ["timeline", "shipped", "lowlights", "asks"],
];

export const UPDATE_BRIEF: Record<UpdateTemplate, string[]> = {
  "board-product": ["headline", "goals", "timeline", "shipped", "lowlights", "asks"],
  "investor-update": ["metrics", "asks", "highlights", "lowlights", "product"],
};

export const ASKS_PLACEHOLDER: Record<UpdateTemplate, string> = {
  "board-product": "Owner to fill: the decisions you need from the board this meeting.",
  "investor-update": "Owner to fill: what you need from investors this month (intros, hires, customers).",
};

const TEMPLATE_MD: Record<UpdateTemplate, string> = {
  "board-product": `# Board update: product {#title}
<!-- The product section of a board update: one to two slides, a dated timeline against the quarterly and yearly goals, and candid highlights and lowlights. Oracle drafts; the CEO decides what is said to the board, and only an owner approves. Front matter: period (from, to) and, when there is one, previous (the last approved board update and its version). Every number cites a row in Sources and data points. -->

## Product in one line {#headline}
<!-- Brief, slide 1. Where product stands this period, in one sentence. -->

## Goals: where we are {#goals}
<!-- Brief, slide 1. A table: goal, target, now, distance to go, trend since the last board, on or off track. Confirmed goals only; each number has its data point row. -->

## Timeline {#timeline}
<!-- Brief, slide 2. Now items with verified dates only (a date no verified schedule basis supports is never written); Next and Later without dates. -->

## Shipped since last board {#shipped}
<!-- Brief, slide 2. Launches or roadmap items done in the period. -->

## What slipped or did not work {#lowlights}
<!-- Brief, slide 2. Slipped milestones, predictions that did not hold, at-risk tracks, stated plainly. -->

## Decisions we need from the board {#asks}
<!-- Brief, slide 2. The owner writes this; Oracle never invents asks and leaves the placeholder below as it is. -->

Owner to fill: the decisions you need from the board this meeting.

# Full version {#full}
<!-- Everything below is the detail behind the brief. -->

## Predicted versus actual {#outcomes}
<!-- What each shipped item was predicted to move and what it moved, from outcome records. -->

## Risks and blockers {#risks}
<!-- Critical blockers and accepted risks, each with its review date. -->

## Decisions made {#decisions}
<!-- The decisions decided in the period, from the decision log. -->

## Sources and data points {#sources}
<!-- The only place for sources, numbers and evidence. List each source with its citation id from the front matter as plain text; no inline citation markers anywhere. -->

### Sources {#sources-list}
<!-- One line per source: citation id, kind (slack, notion, gdocs, github, fireflies, upload, web, oracle), title, date retrieved. -->

### Data points {#sources-data}
<!-- Each number used in the document: the value, what it measures, its as-of date, and the source id it came from. -->

### Evidence by section {#sources-evidence}
<!-- One bullet per body section, keyed by section id (e.g. "goals: c1, c2"), saying which sources and data points support it. Sections with no support say so. -->
`,
  "investor-update": `# Investor update {#title}
<!-- The monthly investor update's product part: metrics first, asks near the top, then a short recap. Oracle drafts; the CEO decides what is said to investors, and only an owner approves. Front matter: period (from, to) and, when there is one, previous (the last approved investor update and its version). Every number cites a row in Sources and data points. -->

## Metrics {#metrics}
<!-- Brief, first. The confirmed goals and their numbers: current value, target, distance to go and the change since the last update. Each number has its data point row. -->

## Asks {#asks}
<!-- Brief, second. The owner writes this; Oracle never invents asks and leaves the placeholder below as it is. -->

Owner to fill: what you need from investors this month (intros, hires, customers).

## Highlights {#highlights}
<!-- Brief. Three to five bullets. -->

## Lowlights {#lowlights}
<!-- Brief. One to three bullets, candid. -->

## Product recap {#product}
<!-- Brief. What shipped and what is next. Dates only where a verified schedule basis supports them. -->

# Full version {#full}
<!-- Everything below is the detail behind the brief. -->

## Sources and data points {#sources}
<!-- The only place for sources, numbers and evidence. List each source with its citation id from the front matter as plain text; no inline citation markers anywhere. -->

### Sources {#sources-list}
<!-- One line per source: citation id, kind (slack, notion, gdocs, github, fireflies, upload, web, oracle), title, date retrieved. -->

### Data points {#sources-data}
<!-- Each number used in the document: the value, what it measures, its as-of date, and the source id it came from. -->

### Evidence by section {#sources-evidence}
<!-- One bullet per body section, keyed by section id (e.g. "metrics: c1"), saying which sources and data points support it. Sections with no support say so. -->
`,
};

const HEADING = /^(#{1,6})\s+(.*?)\s*\{#([A-Za-z0-9][\w.-]*)\}\s*$/;

/** The template's sections with their raw bodies (hint comments included). */
function templateParts(t: UpdateTemplate): SectionSeed[] {
  const out: SectionSeed[] = [];
  for (const line of TEMPLATE_MD[t].split("\n")) {
    const h = HEADING.exec(line);
    if (h) out.push({ key: h[3], level: h[1].length, heading: h[2], body: "" });
    else if (out.length) out[out.length - 1].body += `${line}\n`;
  }
  return out.map((s) => ({ ...s, body: s.body.trim() }));
}

export const isUpdateTemplate = (key: string | null | undefined): key is UpdateTemplate =>
  !!key && (UPDATE_TEMPLATES as readonly string[]).includes(key);

/**
 * A new update from its template (start_draft): one section per heading, the hints kept as
 * italic prompts (as the mock's PRD drafts do) and the Asks placeholder as it is.
 */
export function templateSections(t: UpdateTemplate, title: string): SectionSeed[] {
  return templateParts(t).map((s) => ({
    ...s,
    heading: s.level === 1 && s.key === "title" ? title : s.heading,
    body: s.body.replace(/<!--\s*([\s\S]*?)\s*-->/g, "_$1_").trim() || "_To write._",
  }));
}

/** An update version's front matter: kind, template, period, its brief and (board) slides. */
export function updateFrontMatter(t: UpdateTemplate, slug: string, title: string, period: UpdatePeriod): Record<string, unknown> {
  return {
    document: slug,
    title,
    template: t,
    template_version: "1",
    kind: "update",
    brief: UPDATE_BRIEF[t],
    ...(t === "board-product" ? { slides: BOARD_SLIDES } : {}),
    period,
  };
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "October 2026" for the period's last day. */
export function periodMonth(period: UpdatePeriod): string {
  const [y, m] = period.to.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

/**
 * The draft an update_draft run writes for `period`: metrics first, the Asks placeholder
 * left as it is, only verified dates in the timeline, evidence only in Sources and data points.
 */
export function draftSections(t: UpdateTemplate, title: string, period: UpdatePeriod): SectionSeed[] {
  const month = periodMonth(period);
  if (t === "investor-update") {
    return [
      { key: "title", level: 1, heading: title, body: `Example Co's product update for ${month}.` },
      {
        key: "metrics",
        level: 2,
        heading: "Metrics",
        body: [
          "| Goal | Target | Now | Distance to go | Change since last update |",
          "| --- | --- | --- | --- | --- |",
          "| Weekly active teams | 1,200 | 1,010 | 190 | +70 |",
          "| Trial to paid conversion | 12% | 10.1% | 1.9 pts | +0.7 pts |",
          "| Monthly churn | 2.0% | 2.4% | 0.4 pts | -0.2 pts |",
        ].join("\n"),
      },
      { key: "asks", level: 2, heading: "Asks", body: ASKS_PLACEHOLDER[t] },
      {
        key: "highlights",
        level: 2,
        heading: "Highlights",
        body: "- Usage alerts reached beta readiness with 14 pilot teams.\n- Trial to paid conversion rose for the third month running.\n- Onboarding checklist cut time to first project to under a day.",
      },
      {
        key: "lowlights",
        level: 2,
        heading: "Lowlights",
        body: "- Team billing slipped: the invoicing partner's sandbox came late.\n- Churn is still above target among teams of fewer than five seats.",
      },
      {
        key: "product",
        level: 2,
        heading: "Product recap",
        body: "Shipped: the onboarding checklist and usage alerts for pilot teams.\n\nNext: usage alerts beta on 2026-11-30; team billing once its schedule basis is verified.",
      },
      ...UPDATE_SOURCES(
        ["Weekly active teams: 1,010, as of the period's end, from g1", "Trial to paid conversion: 10.1%, from g1", "Monthly churn: 2.4%, from g1", "Usage alerts beta date, verified basis ENG-412, from t1"],
        ["metrics: g1", "highlights: g1, t1", "lowlights: t1", "product: t1"],
      ),
    ];
  }
  return [
    { key: "title", level: 1, heading: title, body: `Example Co's product section for the board, ${month}.` },
    { key: "headline", level: 2, heading: "Product in one line", body: "Usage alerts are ready for beta; team billing is a month behind." },
    {
      key: "goals",
      level: 2,
      heading: "Goals: where we are",
      body: [
        "| Goal | Target | Now | Distance to go | Trend since last board | Track |",
        "| --- | --- | --- | --- | --- | --- |",
        "| Weekly active teams | 1,200 | 1,010 | 190 | +160 | On track |",
        "| Trial to paid conversion | 12% | 10.1% | 1.9 pts | +1.5 pts | On track |",
        "| Monthly churn | 2.0% | 2.4% | 0.4 pts | -0.5 pts | Off track |",
      ].join("\n"),
    },
    { key: "timeline", level: 2, heading: "Timeline", body: "**Now**\n\n- Usage alerts beta: 2026-11-30\n\n**Next**\n\n- Team billing\n- Seat-based plans\n\n**Later**\n\n- Annual invoicing" },
    { key: "shipped", level: 2, heading: "Shipped since last board", body: "- Onboarding checklist\n- Usage alerts for pilot teams" },
    { key: "lowlights", level: 2, heading: "What slipped or did not work", body: "- Team billing slipped a month: the invoicing partner's sandbox came late.\n- The pricing page test did not move conversion." },
    { key: "asks", level: 2, heading: "Decisions we need from the board", body: ASKS_PLACEHOLDER[t] },
    ...boardDetail(),
  ];
}

function boardDetail(): SectionSeed[] {
  return [
    { key: "full", level: 1, heading: "Full version", body: "The detail behind the brief." },
    { key: "outcomes", level: 2, heading: "Predicted versus actual", body: "- Onboarding checklist: predicted +5 weekly active teams a week; measured +6." },
    { key: "risks", level: 2, heading: "Risks and blockers", body: "- Invoicing partner dependency for team billing; reviewed at the next planning meeting." },
    { key: "decisions", level: 2, heading: "Decisions made", body: "- Usage alerts launch to every plan, not only paid plans." },
    ...UPDATE_SOURCES(
      ["Weekly active teams: 1,010, as of the period's end, from g1", "Trial to paid conversion: 10.1%, from g1", "Monthly churn: 2.4%, from g1"],
      ["goals: g1", "timeline: t1", "shipped: t1", "lowlights: t1"],
    ).slice(1),
  ];
}

/**
 * The dates an update writes, each checked against the schedule bases of every PRD with an
 * active product track (the multi-PRD variant of the roadmap check): a date any of them
 * verifies is verified; otherwise withdrawn when a withdrawn basis named it, else unverified.
 */
export function updateDateMarks(
  roadmap: RoadmapDb | undefined,
  sections: { section_key: string; level: number; heading: string; body_md: string }[],
): Schemas["DateMarkOut"][] {
  const db: RoadmapDb = roadmap ?? { items: {}, tracks: [], milestones: [], bases: [], records: [], changes: [] };
  const prds = [...new Set(db.tracks.filter((t) => t.status === "active").map((t) => t.prd_id))];
  const rank = { unverified: 0, withdrawn: 1, verified: 2 } as const;
  const out = new Map<string, Schemas["DateMarkOut"]>();
  for (const prd of prds.length ? prds : [undefined]) {
    for (const m of dateMarks(db, prd, sections)) {
      const key = `${m.section_key}|${m.text}|${m.where}`;
      const had = out.get(key);
      if (!had || rank[m.status] > rank[had.status]) out.set(key, m);
    }
  }
  return [...out.values()];
}

/** Owners and approvers see an `approvers` document; commenters and viewers do not (H8 §5). */
export function canSee(role: Role, visibility: Visibility | undefined): boolean {
  return visibility !== "approvers" || role === "owner" || role === "approver";
}
