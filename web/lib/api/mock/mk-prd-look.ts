/**
 * MOCK-HOOK (mk-prd-look, mock-ups only): one invented PRD in the shape of a real one (about 50
 * sections on the oracle-default template, long lists, a wide risk table, 20 features with long
 * names, decisions, open questions and citations) for the "PRD look" mock-ups, plus the hook that
 * swaps the mock's PRDs for the ones in MOCK_PRD_FILE (inlined at build time by next.config.ts as
 * NEXT_PUBLIC_MOCK_PRD). Every person, product and number here is made up.
 */
import type { CitationSeed, DocumentSeed, SectionSeed } from "./fixtures";

export const MK_PRD_SLUG = "crew-notes"; // MOCK-HOOK

const FEATURES: [string, string, string][] = [
  ["F-1", "Offline job notes that sync when the crew is back in signal", "Lena Okafor"],
  ["F-2", "Photo markup with arrows, labels and a measuring line", "Tomas Reyes"],
  ["F-3", "Shared crew roster with today's site assignments", "Mara Ellison"],
  ["F-4", "Voice notes turned into text with the speaker named", "Jonah Pike"],
  ["F-5", "Site checklists that carry over from the last visit", "Lena Okafor"],
  ["F-6", "Customer sign-off on a phone with a typed or drawn name", "Priya Nandakumar"],
  ["F-7", "Parts used on the job, picked from the van stock list", "Tomas Reyes"],
  ["F-8", "Hand-over notes between the morning and the evening crew", "Mara Ellison"],
  ["F-9", "Safety walk-round with photos required before work starts", "Jonah Pike"],
  ["F-10", "Office view of every open job on one map with the crew's last update", "Priya Nandakumar"],
  ["F-11", "Search across notes, photos and voice by place, crew or part", "Lena Okafor"],
  ["F-12", "Job summary emailed to the customer when the job closes", "Mara Ellison"],
  ["F-13", "Follow-up visits booked from the job, with the notes attached", "Tomas Reyes"],
  ["F-14", "Time on site recorded from arrival and departure, not typed", "Jonah Pike"],
  ["F-15", "Supervisor review queue for jobs flagged by the crew", "Priya Nandakumar"],
  ["F-16", "Templates for the twelve most common job types", "Lena Okafor"],
  ["F-17", "Export of a job's notes and photos as one printable report", "Mara Ellison"],
  ["F-18", "Read-only share link for the customer's facilities manager", "Tomas Reyes"],
  ["F-19", "Weekly digest of repeat faults by site and by part", "Jonah Pike"],
  ["F-20", "Admin settings for retention, photo quality and who sees what", "Priya Nandakumar"],
];

const MILESTONES: [string, string, string, string][] = [
  ["pilot", "Pilot with two crews", "Dec 14, 2026", "F-1, F-2, F-3, F-5, F-9"],
  ["beta", "Beta for all north-region crews", "Feb 22, 2027", "F-4, F-6, F-7, F-8, F-10, F-11, F-14"],
  ["general", "General release", "Apr 26, 2027", "F-12, F-13, F-15, F-16, F-17, F-18, F-19, F-20"],
];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const fKey = (code: string) => `feature-${code.toLowerCase()}`;
const milestoneOf = (code: string) => MILESTONES.find((m) => m[3].split(", ").includes(code))!;

const featureRows = MILESTONES.flatMap(([mk, name, , codes]) =>
  codes.split(", ").map((code, i) => {
    const f = FEATURES.find((x) => x[0] === code)!;
    return `| ${i === 0 ? `[${name}](#milestone-${mk})` : ""} | [${code} ${f[1]}](#${fKey(code)}) | G-2 Fewer repeat visits | ${
      ["Notes reach the office the same day", "No job closes without photos", "Crews stop retyping notes", "The customer signs before the crew leaves"][code.length % 4]
    } |`;
  }),
);

function featureBody(code: string, name: string, owner: string, i: number): string {
  const r = (n: number) => `R${i * 3 + n}`;
  const m = milestoneOf(code);
  return [
    `**Owner:** ${owner} · **Milestone:** [${m[1]}](#milestone-${m[0]}) · **Goal:** G-2 Fewer repeat visits`,
    `${name} is for the crew on site and the office that plans their next day. Today the crew writes this on paper or in a group chat, and the office retypes it the next morning [c:c${(i % 6) + 1}].`,
    "User stories:",
    [
      `- As a crew lead, I want ${name.toLowerCase()} so that the office knows what happened without calling me.`,
      "- As an office planner, I want the job's notes in one place so that I can book the follow-up visit before the crew leaves the area.",
      "- As a supervisor, I want to see which jobs had problems so that I can coach the crew that week.",
    ].join("\n"),
    "Requirements:",
    [
      `- ${r(1)} (${code}) Works with no signal for a full shift and keeps every change made offline.`,
      `- ${r(2)} (${code}) Shows who wrote each note and when, in the crew's own time zone.`,
      `- ${r(3)} (${code}) Opens in under two seconds on the oldest phone the crews use.`,
    ].join("\n"),
    i % 4 === 1
      ? `Depends on ${FEATURES[(i + 1) % 20][0]} and on the van stock list from the parts team. Acceptance is checked on the pilot crews' phones, not in the office.`
      : `Depends on ${FEATURES[(i + 3) % 20][0]}. Acceptance is checked on the pilot crews' phones.`,
  ].join("\n\n");
}

const RISK_TABLE = [
  "| ID | Risk | Likelihood | Impact | Owner | Mitigation | Trigger to act | Review by |",
  "|---|---|---|---|---|---|---|---|",
  "| K1 | Crews keep using the group chat because it is faster to type in | High | High | Mara Ellison | Voice notes (F-4) and job templates (F-16) make the first note quicker than a chat message | Fewer than half the pilot jobs have a note by noon | Dec 21, 2026 |",
  "| K2 | Photos fill the phones of crews on older handsets | Medium | High | Tomas Reyes | Upload on Wi-Fi, keep a small copy on the phone, settings in F-20 | Any pilot phone under 1 GB free | Dec 7, 2026 |",
  "| K3 | Offline sync loses a note when two people edit the same job | Medium | High | Lena Okafor | Every edit is kept; the second one is shown beside the first, never overwritten | One lost note reported in the pilot | Jan 11, 2027 |",
  "| K4 | Customers refuse to sign on a crew member's phone | Low | Medium | Priya Nandakumar | Typed name accepted; sign-off can be sent as a link (F-18) | Over 10% of jobs closed without sign-off | Mar 1, 2027 |",
  "| K5 | The parts team's stock list is not ready for the beta | Medium | Medium | Tomas Reyes | Beta ships with free-text parts; the list joins when ready | Stock list not live by Jan 25, 2027 | Jan 25, 2027 |",
  "| K6 | Voice-to-text gets site names and part numbers wrong | High | Medium | Jonah Pike | The crew checks the text before it is saved; a word list per region | Over 1 in 5 voice notes corrected | Feb 8, 2027 |",
  "| K7 | Office planners do not trust the map's last-update times | Medium | Medium | Priya Nandakumar | Show the time of the last note, not of the last app open | Planners still phone crews for status | Mar 15, 2027 |",
  "| K8 | Retention rules differ by customer contract | Low | High | Priya Nandakumar | Retention per customer in F-20, default 24 months | A contract asks for less than 12 months | Apr 5, 2027 |",
  "| K9 | Union reps object to recorded time on site | Medium | High | Jonah Pike | Time is shown to the crew first and used for planning only | A formal objection is raised | Jan 18, 2027 |",
  "| K10 | The pilot crews are not typical of the region | Medium | Low | Mara Ellison | Pick one fast and one slow crew; compare with two crews not in the pilot | Pilot numbers differ by more than 30% | Dec 21, 2026 |",
].join("\n");

const CITATIONS: CitationSeed[] = [
  { id: "c1", source: "fireflies", ref: "https://notes.example.com/view/crew-ride-along-03", title: "Ride-along with the north crew (transcript)", excerpt: "We write it on the back of the job sheet and Sam types it up in the morning.", retrieved_at: "2026-10-28T09:10:00Z", confidence: 0.8 },
  { id: "c2", source: "slack", ref: "https://example.slack.com/archives/C0FIELD/p1730000001", title: "#field-ops thread on repeat visits", excerpt: "A third of the repeat visits last month were for jobs where the first note was lost.", retrieved_at: "2026-10-29T14:22:00Z", confidence: 0.7 },
  { id: "c3", source: "gdocs", ref: "https://docs.example.com/d/office-planning-survey", title: "Office planning survey, October", excerpt: "Planners spend 70 to 90 minutes each morning chasing yesterday's notes.", retrieved_at: "2026-10-30T11:05:00Z", confidence: 0.75 },
  { id: "c4", source: "notion", ref: "https://notion.example.com/crew-handbook", title: "Crew handbook: closing a job", excerpt: "The customer signs the paper sheet; the sheet goes in the van's tray.", retrieved_at: "2026-10-27T08:40:00Z", confidence: 0.9 },
  { id: "c5", source: "upload", ref: "https://files.example.com/repeat-visits-q3.xlsx", title: "Repeat visits, Q3 (spreadsheet)", excerpt: "Repeat visits: 18.4% of jobs in Q3, up from 15.9% in Q2.", retrieved_at: "2026-10-30T16:30:00Z", confidence: 0.85 },
  { id: "c6", source: "fireflies", ref: "https://notes.example.com/view/supervisor-call-11", title: "Supervisors' call, Oct 22 (transcript)", excerpt: "If it takes longer than a text message, they won't do it.", retrieved_at: "2026-10-23T10:00:00Z", confidence: 0.6, low_confidence: true, confidence_note: "one call, not repeated" },
];

const S = (key: string, level: number, heading: string, body: string): SectionSeed => ({ key, level, heading, body });

const SECTIONS: SectionSeed[] = [
  S("title", 1, "Crew notes PRD", "Shared job notes for field crews: written once on site, read the same day in the office."),
  S(
    "summary",
    2,
    "Summary",
    "We will build Crew notes, a phone app where field crews write, photograph and voice their job notes on site, and the office reads them the same day. It serves **G-2 Fewer repeat visits**: repeat visits fall from 18% to 12% of jobs by the end of Q2 2027 [c:c5]. The pilot starts on Dec 14 with two crews. We ask the leads to approve the scope of the pilot and the three decisions below.",
  ),
  S(
    "goal-trace",
    2,
    "Goal trace",
    "- **G-2 Fewer repeat visits** (this year): measure, repeat visits as a share of all jobs; target, from 18% to 12% by Jun 30, 2027 [c:c5]. Main contribution: notes and photos reach the office the same day.\n- **G-4 Office time back** (this year): measure, minutes planners spend each morning chasing notes; target, from 80 to 20 minutes [c:c3].\n- **G-1 Customer trust** (next year): measure, jobs closed with the customer's sign-off; target, 95% of jobs. Contribution: F-6 and F-12.",
  ),
  S(
    "problem",
    2,
    "Problem",
    "Crews finish a job and the office does not know what happened until the next morning. Notes are written on paper or in a group chat, and a third of last month's repeat visits were for jobs whose first note was lost [c:c2]. Planners spend over an hour each morning chasing notes instead of planning [c:c3].",
  ),
  S(
    "brief-items",
    2,
    "Features by milestone",
    ["| Milestone | Feature | Goal | Outcome |", "|---|---|---|---|", ...featureRows].join("\n"),
  ),
  S(
    "brief-roadmap",
    2,
    "Roadmap",
    MILESTONES.map(([k, name, date]) => `- [${name}](#milestone-${k}), ${date}: ${k === "pilot" ? "two crews stop using paper" : k === "beta" ? "every north-region job has notes the same day" : "every crew and office uses Crew notes"}`).join("\n"),
  ),
  S(
    "non-goals",
    2,
    "Non-goals",
    "- Replacing the job booking system; Crew notes reads jobs from it and never changes them.\n- Invoicing or quoting from the phone.\n- Chat between crews; the group chat stays for talk, Crew notes is for the record.\n- A desktop app for crews.\n- Tracking where crews are during the day; only arrival and departure at a job are kept (F-14).",
  ),
  S(
    "top-risks",
    2,
    "Top risks",
    "- Crews keep using the group chat: voice notes and templates make a note quicker than a chat message. See [Risks and open questions](#risks).\n- Offline sync loses a note: every edit is kept, never overwritten.\n- Union reps object to recorded time on site: time is shown to the crew first and used for planning only.",
  ),
  S(
    "decisions",
    2,
    "Decisions needed",
    "- D1 — Pilot with the north crew and the harbour crew: owner Mara Ellison, needed by Nov 20, 2026\n- D2 — Keep photos for 24 months unless a contract says otherwise: owner Priya Nandakumar, needed by Dec 1, 2026\n- D3 — Ship voice notes in the beta, not the pilot: owner Jonah Pike, needed by Dec 1, 2026",
  ),
  S("full", 1, "Full version", ""),
  S("problem-alignment", 2, "Problem alignment", "Who has the problem, why it matters now, and how we will know it is solved."),
  S(
    "audience",
    3,
    "Who has it",
    "1. **Crew leads** (about 140): write the job note today on paper; want to leave the site without a call from the office.\n2. **Crew members** (about 380): take photos on their own phones and send them to the group chat.\n3. **Office planners** (12): read every note each morning and book follow-up visits.\n4. **Supervisors** (9): review jobs with problems and coach crews.\n5. **Customers' facilities managers**: ask for a record of each visit, today sent by email a week later.",
  ),
  S(
    "why-now",
    3,
    "Why now",
    "Repeat visits rose from 15.9% to 18.4% of jobs between Q2 and Q3 [c:c5]. Two large customers renew their contracts in spring and both asked for a visit record within a day. The crews' phones were replaced in September, so every crew now has a phone that can run the app [c:c1].",
  ),
  S(
    "success",
    3,
    "Success measures",
    "| Measure | Today | Pilot target | General release target | Source |\n|---|---|---|---|---|\n| Repeat visits, share of jobs | 18.4% | 16% | 12% | Job system |\n| Jobs with a note the same day | 41% | 90% | 95% | Crew notes |\n| Planner minutes chasing notes, each morning | 80 | 45 | 20 | Survey |\n| Jobs closed with customer sign-off | 62% | 80% | 95% | Crew notes |",
  ),
  S("solution-alignment", 2, "Solution alignment", "What we will build, in what order, and the rules it follows."),
  S(
    "approach",
    3,
    "Approach",
    "Start with the note the crew already writes, and make it quicker than paper. Every other feature hangs off the job note: photos, voice, parts, sign-off, hand-over. The office sees the same note on a map the moment it syncs.\n\nWe build for no signal first. A crew in a basement plant room must be able to finish the job and close it, and the note syncs when the van is back on the road [c:c1].",
  ),
  S(
    "features",
    3,
    "Prioritized features",
    FEATURES.map(([code, name], i) => `${i + 1}. ${code} ${name}`).join("\n"),
  ),
  S(
    "flows",
    3,
    "Key flows",
    "1. The crew lead opens today's jobs; the first job is at the top.\n2. On arrival the time on site starts (F-14) and the safety walk-round opens (F-9).\n3. The crew writes or speaks the note, adds photos and marks them up (F-2, F-4).\n4. Parts used are picked from the van stock (F-7).\n5. The customer signs on the phone (F-6).\n6. The job closes; the summary goes to the customer (F-12) and the office sees it on the map (F-10).\n7. If a follow-up is needed, the crew books it from the job (F-13).",
  ),
  S(
    "requirements",
    3,
    "Requirements",
    "- R61 (F-1) A crew can write, edit and close a job with no signal for a full ten-hour shift.\n- R62 (F-2) A photo can be marked up with arrows, labels and a measuring line, and the original is kept.\n- R63 (F-6) A job cannot close without either a signature or a reason for none.\n- R64 (F-9) Work cannot be marked started until the walk-round has its required photos.\n- R65 (F-14) Time on site is taken from arrival and departure at the job's address; the crew can correct it with a reason.\n- R66 (F-20) An admin sets photo retention per customer, from 12 to 60 months.\n- R67 (F-10) The office map shows each open job's last note time, to the minute.\n- R68 (F-17) A job's report prints on Letter paper with every photo and its markup.",
  ),
  S(
    "edge-cases",
    3,
    "Rules and edge cases",
    "- Two crew members edit the same note offline: both edits are kept and shown side by side; nothing is overwritten.\n- A job is cancelled while the crew is on site: the note stays and is marked cancelled.\n- A photo shows a person's face: it is kept but blurred in the customer's report.\n- The phone's clock is wrong: times are taken from the sync server when the phone reconnects.\n- A crew member leaves the company: their notes stay, under their name.",
  ),
  S("feature-detail", 2, "Feature detail", "One section per feature, in priority order."),
  ...FEATURES.map(([code, name, owner], i) => S(fKey(code), 3, `${code} ${name}`, featureBody(code, name, owner, i))),
  S("risks", 2, "Risks and open questions", `${RISK_TABLE}\n\nOpen questions:\n\n- Q1: Do supervisors see time on site per person or only per crew? Owner Jonah Pike, by Dec 7, 2026.\n- Q2: Can a customer's facilities manager comment on a shared job, or only read it? Owner Tomas Reyes, by Jan 18, 2027.\n- Q3: Which job types get templates first? Owner Lena Okafor, by Dec 14, 2026.\n- Q4: Does the parts team want parts used sent back to their stock system in the beta? Owner Tomas Reyes, by Jan 11, 2027.`),
  S("milestones", 2, "Milestones", "| Milestone | Date | Features | Exit criteria | Date source |\n|---|---|---|---|---|\n" + MILESTONES.map(([, name, date, codes]) => `| ${name} | ${date} | ${codes} | ${name.startsWith("Pilot") ? "Two crews, four weeks, no paper notes" : name.startsWith("Beta") ? "90% of north-region jobs have a note the same day" : "All crews; repeat visits under 14%"} | Tracker estimate |`).join("\n")),
  ...MILESTONES.map(([k, name, date, codes]) =>
    S(
      `milestone-${k}`,
      3,
      name,
      `**Date:** ${date} (tracker estimate)\n\n**Scope:** ${codes}.\n\n**Exit criteria:**\n\n- Crews in this stage write no paper notes for four weeks.\n- Planners read every note by 9 AM the next day.\n- No note is lost in sync.`,
    ),
  ),
  S(
    "launch",
    2,
    "Launch",
    "1. **Internal** (Dec 1, 2026): the product team and two supervisors use it on real jobs for a week.\n2. **Pilot** (Dec 14, 2026): the north crew and the harbour crew; daily check-in with Mara Ellison.\n3. **Beta** (Feb 22, 2027): every north-region crew; support answers within the shift.\n4. **General** (Apr 26, 2027): every crew; the paper job sheet is withdrawn a month later.\n\nTeams that must be ready: support (a one-page guide for crews), office planning (a morning routine without phone calls), the parts team (stock list), and data (the repeat-visit report).",
  ),
  S("recap", 2, "Post-launch recap", "Filled after the general release."),
  S("sources", 2, "Sources and data points", "Every source and number this PRD uses."),
  S("sources-list", 3, "Sources", CITATIONS.map((c) => `- ${c.id}, ${c.source}: ${c.title}, read ${new Date(c.retrieved_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}`).join("\n")),
  S(
    "sources-data",
    3,
    "Data points",
    "| Value | What it measures | Period | Source |\n|---|---|---|---|\n| 18.4% | Repeat visits as a share of jobs | Q3 2026 | c5 |\n| 15.9% | Repeat visits as a share of jobs | Q2 2026 | c5 |\n| 80 minutes | Planner time chasing notes each morning | October 2026 | c3 |\n| 41% | Jobs with a note the same day | October 2026 | c2 |\n| 62% | Jobs closed with customer sign-off | Q3 2026 | c4 |",
  ),
  S("sources-evidence", 3, "Evidence by section", "- summary: c5\n- goal-trace: c3, c5\n- problem: c2, c3\n- why-now: c1, c5\n- approach: c1\n- feature-detail: c1 to c6\n- edge-cases: none yet"),
];

export const MK_PRD: DocumentSeed = {
  slug: MK_PRD_SLUG,
  title: "Crew notes PRD",
  template: "oracle-default",
  template_version: "1",
  versions: [
    {
      number: 3,
      created_at: "2026-11-04T16:20:00Z",
      snapshot: "2026-11-04T16:00Z",
      brief: ["title", "summary", "goal-trace", "problem", "brief-items", "brief-roadmap", "non-goals", "top-risks", "decisions"],
      sections: SECTIONS,
      citations: CITATIONS,
    },
  ],
};

/** MOCK-HOOK: the real-content file, MOCK_PRD_FILE, as next.config.ts inlined it (empty when unset). */
type RealPrd = { title?: string; code?: string; version?: number | string; status?: string; sections?: { key: string; title: string; markdown: string; level?: number }[]; citations?: CitationSeed[] };
export function realPrds(): RealPrd[] {
  const raw = process.env.NEXT_PUBLIC_MOCK_PRD; // MOCK-HOOK
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { prds?: RealPrd[] };
    return Array.isArray(parsed.prds) ? parsed.prds : [];
  } catch {
    return [];
  }
}

const LEVEL1 = new Set(["title", "full"]);
const LEVEL3 = new Set(["audience", "why-now", "success", "approach", "features", "flows", "requirements", "edge-cases", "sources-list", "sources-data", "sources-evidence"]);
const levelOf = (key: string) => (LEVEL1.has(key) ? 1 : LEVEL3.has(key) || /^(feature|milestone)-/.test(key) ? 3 : 2);

/** MOCK-HOOK: a seed with its title, version number and sections taken from a real PRD; ids (slug) kept. */
export function withRealPrd(seed: DocumentSeed, real: RealPrd | undefined): DocumentSeed {
  if (!real?.sections?.length) return seed;
  const last = seed.versions[seed.versions.length - 1];
  const before = seed.versions.slice(0, -1);
  const asked = Number(real.version);
  const number = asked && before.every((v) => v.number < asked) ? asked : last.number;
  const sections = real.sections.map((s) => ({ key: slug(s.key) || slug(s.title), level: s.level ?? levelOf(slug(s.key)), heading: s.title, body: s.markdown ?? "" }));
  return {
    ...seed,
    title: real.title ?? seed.title,
    versions: [...before, { ...last, number, brief: undefined, sections, citations: real.citations ?? [] }],
  };
}

/** MOCK-HOOK: the document status the real PRD names (Draft, In review, Approved), else the mock's. */
export function realStatus(real: RealPrd | undefined, fallback: string): string {
  const s = real?.status?.toLowerCase().replace(/\s+/g, "_");
  return s && ["draft", "in_review", "approved"].includes(s) ? s : fallback;
}

/* ---- MOCK-HOOK (mk-prd-look PS1, "PRD on the Simple side"): the PRD's one-pager and its features, read from its own sections. ---- */
type MkSec = { key: string; heading: string; body: string }; // MOCK-HOOK
type MkBlock = { key: string; title: string; rules: string; kind: "text" | "lines" | "metrics" | "timeline"; who?: string; lines: { id: string; text: string; keys: string[]; metric?: { name: string; from: string; to: string } }[] }; // MOCK-HOOK
type MkSlice = { key?: string; title: string; horizon: "now" | "next" | "later"; start: string; end: string; estimated: boolean; milestone: [string, string] | null }; // MOCK-HOOK

/** MOCK-HOOK: the mock's first PRD as built (MOCK_PRD_FILE's first PRD when given): its sections, last version. */
export function mkSections(): { version: number; sections: MkSec[] } {
  const d = withRealPrd(MK_PRD, realPrds()[0]); // MOCK-HOOK
  const last = d.versions[d.versions.length - 1]; // MOCK-HOOK
  return { version: last.number, sections: last.sections.map((s) => ({ key: s.key, heading: s.heading, body: s.body })) }; // MOCK-HOOK
}

const mdPlain = (t: string) => t.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/\s+/g, " ").trim(); // MOCK-HOOK
const bulletsOf = (body: string) => body.split("\n").map((l) => /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/.exec(l)?.[1]).filter((x): x is string => !!x); // MOCK-HOOK
const sentencesOf = (body: string) => body.split(/\n\s*\n/)[0].trim().split(/(?<=[.!?])\s+/).filter(Boolean); // MOCK-HOOK
function tableOf(body: string): { head: string[]; rows: string[][] } | null {
  const rows = body.split("\n").filter((l) => /^\s*\|.*\|\s*$/.test(l)).map((l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim())); // MOCK-HOOK
  if (rows.length < 3) return null; // MOCK-HOOK
  return { head: rows[0], rows: rows.slice(2) }; // MOCK-HOOK
}
/** MOCK-HOOK: a section by its key, else the first whose heading matches, never an empty one. */
function findSec(secs: MkSec[], keys: string[], re: RegExp): MkSec | undefined {
  const full = (s: MkSec) => /[\p{L}\p{N}]/u.test(s.body); // MOCK-HOOK
  return keys.map((k) => secs.find((s) => s.key === k && full(s))).find(Boolean) ?? secs.find((s) => re.test(s.heading) && full(s)); // MOCK-HOOK
}
const CODE = /\b([A-Z]{1,3}-\d+)\b/; // MOCK-HOOK
/** MOCK-HOOK: the PRD's features: "F-7 Parts used on the job…" from its features list, else its feature sections. */
export function mkFeatures(secs: MkSec[]): { code: string; name: string; key: string }[] {
  const list = findSec(secs, ["features"], /prioriti[sz]ed features|^features$/i); // MOCK-HOOK
  const from = list ? bulletsOf(list.body).map(mdPlain) : secs.filter((s) => /^feature-/.test(s.key)).map((s) => s.heading); // MOCK-HOOK
  return from.map((t) => /^([A-Z]{1,3}-\d+)[\s:—-]+(.+)$/.exec(t)).filter((m): m is RegExpExecArray => !!m).map((m) => ({ code: m[1], name: m[2].trim(), key: `crew-${m[1].toLowerCase()}` })); // MOCK-HOOK
}
const asDay = (t: string) => { const ms = Date.parse(`${t.replace(/,/g, "")} UTC`); return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null; }; // MOCK-HOOK
const DAY_IN = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}, \d{4}\b/; // MOCK-HOOK
/** MOCK-HOOK: the PRD's milestones: each row of its milestones table with a date and the feature codes it names. */
export function mkMilestones(secs: MkSec[]): { name: string; day: string; codes: string[] }[] {
  const s = findSec(secs, ["milestones"], /milestone/i); // MOCK-HOOK
  const t = s && tableOf(s.body); // MOCK-HOOK
  if (!t) return []; // MOCK-HOOK
  return t.rows.map((r) => ({ name: mdPlain(r[0]), day: asDay(r.map((c) => DAY_IN.exec(c)?.[0]).find(Boolean) ?? "") ?? "", codes: r.flatMap((c) => c.match(/\b[A-Z]{1,3}-\d+\b/g) ?? []) })).filter((m) => m.day); // MOCK-HOOK
}
const horizonOf = (day: string): "now" | "next" | "later" => (day < "2027-01-01" ? "now" : day < "2027-07-01" ? "next" : "later"); // MOCK-HOOK

/** MOCK-HOOK: the one-pager's blocks, read from the PRD's sections as Oracle's quick read takes them (no regeneration). */
export function mkOnePagerBlocks(secs: MkSec[]): { blocks: MkBlock[]; slice: MkSlice[] } {
  const lines = (key: string, texts: string[], keys: string[]) => texts.map((text, i) => ({ id: `${key}-${i + 1}`, text, keys })); // MOCK-HOOK
  const problem = findSec(secs, ["problem"], /problem/i); // MOCK-HOOK
  const who = findSec(secs, ["audience"], /who has it|users|personas|audience/i); // MOCK-HOOK
  const whoNames = who ? bulletsOf(who.body).map((b) => /^\*\*([^*]+)\*\*/.exec(b)?.[1]).filter(Boolean) : []; // MOCK-HOOK
  const feats = mkFeatures(secs); // MOCK-HOOK
  const featSec = findSec(secs, ["features"], /prioriti[sz]ed features|^features$/i); // MOCK-HOOK
  const success = findSec(secs, ["success"], /success|outcome|measure/i); // MOCK-HOOK
  const st = success && tableOf(success.body); // MOCK-HOOK
  const toCol = st ? st.head.map((h, i) => [h, i] as const).filter(([h, i]) => i > 1 && !/source|owner/i.test(h)).at(-1)?.[1] ?? 2 : 2; // MOCK-HOOK
  const metrics = st ? st.rows.slice(0, 4).map((r, i) => ({ id: `outcomes-${i + 1}`, text: `${mdPlain(r[0])} from ${r[1]} to ${r[toCol]}`, keys: [success!.key], metric: { name: mdPlain(r[0]), from: r[1], to: r[toCol] } })) : []; // MOCK-HOOK
  const non = findSec(secs, ["non-goals"], /non-goals|not doing|out of scope/i); // MOCK-HOOK
  const risks = findSec(secs, ["top-risks"], /risk/i); // MOCK-HOOK
  const riskTexts = risks ? (bulletsOf(risks.body).length ? bulletsOf(risks.body) : (tableOf(risks.body)?.rows ?? []).map((r) => r[1] ?? r[0])) : []; // MOCK-HOOK
  const blocks: MkBlock[] = [
    { key: "problem", title: "Problem and who has it", rules: "At most 60 words", kind: "text", who: whoNames.length ? whoNames.join(", ") : undefined, lines: problem ? lines("problem", sentencesOf(problem.body).slice(0, 2), [problem.key, ...(who ? [who.key] : [])]) : [] }, // MOCK-HOOK
    { key: "bets", title: "What we will build", rules: "3-5 bets", kind: "lines", lines: featSec ? lines("bets", bulletsOf(featSec.body).slice(0, 5), [featSec.key]) : [] }, // MOCK-HOOK
    { key: "outcomes", title: "Outcomes and how we measure them", rules: "2-4 metrics, from → to", kind: "metrics", lines: metrics }, // MOCK-HOOK
    { key: "not_doing", title: "Not doing", rules: "At most 5 lines", kind: "lines", lines: non ? lines("not_doing", bulletsOf(non.body).slice(0, 5), [non.key]) : [] }, // MOCK-HOOK
    { key: "risks", title: "Risks and open decisions", rules: "At most 5", kind: "lines", lines: risks ? lines("risks", riskTexts.slice(0, 5).map(mdPlain), [risks.key]) : [] }, // MOCK-HOOK
    { key: "timeline", title: "Timeline", rules: "The PRD's roadmap slice", kind: "timeline", lines: [] }, // MOCK-HOOK
  ];
  void feats; // MOCK-HOOK
  return { blocks, slice: mkSlice(secs) }; // MOCK-HOOK
}

/** MOCK-HOOK: the PRD's roadmap slice: each feature a milestone names, from the milestone before it to its date. */
function mkSlice(secs: MkSec[]): MkSlice[] {
  const feats = mkFeatures(secs); // MOCK-HOOK
  const ms = mkMilestones(secs); // MOCK-HOOK
  return ms.flatMap((m, i) => m.codes.map((code) => { const f = feats.find((x) => x.code === code); return f ? { key: f.key, title: f.name, horizon: horizonOf(m.day), start: i ? ms[i - 1].day : "2026-11-02", end: m.day, estimated: false, milestone: [m.name, m.day] as [string, string] } : null; })).filter((x): x is NonNullable<typeof x> => !!x); // MOCK-HOOK
}

/** MOCK-HOOK: the PRD's goal (its goal trace's first line): key, name, measure, target, due. */
export function mkGoal(secs: MkSec[]): { key: string; title: string; metric: string | null; target: string | null; due: string | null } | null {
  const g = findSec(secs, ["goal-trace"], /goal/i); // MOCK-HOOK
  const first = g ? mdPlain(bulletsOf(g.body)[0] ?? "") : ""; // MOCK-HOOK
  const m = /^(?:[A-Z]-\d+\s+)?([^(:;]+)/.exec(first); // MOCK-HOOK
  if (!m) return null; // MOCK-HOOK
  const title = m[1].trim(); // MOCK-HOOK
  const t = /from (\S+) to (\S+)(?: by ([A-Z][a-z]{2} \d{1,2}, \d{4}))?/.exec(first); // MOCK-HOOK
  return { key: slug(title), title, metric: /measure,\s*([^;]+)/.exec(first)?.[1]?.trim() ?? null, target: t ? `${t[1]} → ${t[2]}` : null, due: t?.[3] ? asDay(t[3]) : null }; // MOCK-HOOK
}

/** MOCK-HOOK: the PRD's features as roadmap items (its milestones date them; "Depends on F-x" links them). */
export function mkRoadmapItems(): { key: string; title: string; horizon: "now" | "next" | "later"; roadmap: string; goal?: string; confidence: "medium"; start?: number; end?: number; source?: "accepted"; depends?: string[]; milestone?: { name: string; day: number }; section: string; prd_doc: { id: string; slug: string; title: string } }[] {
  const { sections } = mkSections(); // MOCK-HOOK
  const d = withRealPrd(MK_PRD, realPrds()[0]); // MOCK-HOOK
  const feats = mkFeatures(sections); // MOCK-HOOK
  const ms = mkMilestones(sections); // MOCK-HOOK
  const goal = mkGoal(sections); // MOCK-HOOK
  const win = { now: "2026-10-01", next: "2027-01-01", later: "2027-07-01" }; // MOCK-HOOK
  const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000); // MOCK-HOOK
  return feats.map((f) => {
    const mi = ms.findIndex((m) => m.codes.includes(f.code)); // MOCK-HOOK
    const m = ms[mi]; // MOCK-HOOK
    const body = sections.find((s) => s.key === `feature-${f.code.toLowerCase()}`)?.body ?? ""; // MOCK-HOOK
    const deps = (/Depends on ([^.]+)\./.exec(body)?.[1].match(/\b[A-Z]{1,3}-\d+\b/g) ?? []).map((c) => `crew-${c.toLowerCase()}`).filter((k) => feats.some((x) => x.key === k)); // MOCK-HOOK
    const h = m ? horizonOf(m.day) : "later"; // MOCK-HOOK
    const start = m ? (mi ? ms[mi - 1].day : "2026-11-02") : undefined; // MOCK-HOOK
    return {
      key: f.key, title: f.name, horizon: h, roadmap: "crew-notes-roadmap", goal: goal?.key, confidence: "medium" as const, // MOCK-HOOK
      ...(m && start ? { start: Math.max(0, days(win[h], start < win[h] ? win[h] : start)), end: days(win[h], m.day), source: "accepted" as const, milestone: { name: m.name, day: days(win[h], m.day) } } : {}), // MOCK-HOOK
      ...(deps.length ? { depends: deps } : {}), // MOCK-HOOK
      section: f.code.toLowerCase(), prd_doc: { id: mkDocId(), slug: d.slug, title: d.title }, // MOCK-HOOK
    };
  });
}
let mkId = ""; // MOCK-HOOK
/** MOCK-HOOK: the PRD's document id once the mock has built it (server.ts sets it). */
export const mkDocId = () => mkId; // MOCK-HOOK
export const setMkDocId = (id: string) => void (mkId = id); // MOCK-HOOK
