// MOCK-HOOK: mock-up data for "Desired state and Current state" (decisions CS1..CS3). Invented
// features, people and numbers only; never merged.

export type Stage = "new" | "progress" | "exists"; // MOCK-HOOK

export type CsFeature = { // MOCK-HOOK
  id: string;
  name: string;
  area: string;
  goal: string;
  milestone: string;
  stage: Stage;
  /** Exists: when it shipped and its proof. */
  shipped?: string;
  prs?: number;
  tasks?: [number, number];
  files?: number;
  measured?: string;
  checked?: string;
  checkedDays?: number;
  stale?: boolean;
  /** In progress: how much proof is in. */
  ready?: boolean;
  owner: string;
};

export const CS_AREAS = ["Sign-up and onboarding", "Billing", "Search", "Phone app", "Reports", "Teams and sharing"]; // MOCK-HOOK
const GOALS = ["Half of new teams active in week one", "Cut failed payments to 1%", "Find anything in two tries", "Reports in under a minute"]; // MOCK-HOOK
const MILESTONES = ["Winter release", "Spring release", "Summer release"]; // MOCK-HOOK
const PEOPLE = ["Mira Okafor", "Tomas Lind", "Priya Natarajan", "Jon Abara", "Lena Fischbach"]; // MOCK-HOOK

const EXISTS: Omit<CsFeature, "id" | "stage" | "goal" | "milestone" | "owner">[] = [ // MOCK-HOOK
  { name: "Sign in with email link", area: "Sign-up and onboarding", shipped: "Mar 14", prs: 6, tasks: [9, 9], files: 14, measured: "92% sign in on first try", checked: "Nov 2", checkedDays: 1 },
  { name: "Card payments", area: "Billing", shipped: "Apr 2", prs: 11, tasks: [17, 17], files: 31, measured: "1.8% of payments fail", checked: "Nov 1", checkedDays: 2 },
  { name: "Invoices as PDF", area: "Billing", shipped: "May 20", prs: 4, tasks: [6, 6], files: 9, measured: "3,410 sent last month", checked: "Sep 23", checkedDays: 41, stale: true },
  { name: "Search by name", area: "Search", shipped: "Jun 9", prs: 5, tasks: [8, 8], files: 12, measured: "71% found in one try", checked: "Oct 31", checkedDays: 3 },
  { name: "Weekly summary email", area: "Reports", shipped: "Jun 30", prs: 3, tasks: [5, 5], files: 7, measured: "44% open it", checked: "Oct 30", checkedDays: 4 },
  { name: "Invite teammates", area: "Teams and sharing", shipped: "Jul 18", prs: 7, tasks: [10, 10], files: 18, measured: "2.4 invites per team", checked: "Nov 2", checkedDays: 1 },
  { name: "Phone sign-in", area: "Phone app", shipped: "Aug 4", prs: 4, tasks: [7, 7], files: 11, measured: "38% sign in on phone", checked: "Oct 29", checkedDays: 5 },
  { name: "Export to spreadsheet", area: "Reports", shipped: "Aug 27", prs: 2, tasks: [4, 4], files: 5, measured: "610 exports last month", checked: "Oct 28", checkedDays: 6 },
  { name: "Guided first project", area: "Sign-up and onboarding", shipped: "Sep 15", prs: 8, tasks: [12, 12], files: 22, measured: "48% finish it", checked: "Nov 1", checkedDays: 2 },
  { name: "Shared folders", area: "Teams and sharing", shipped: "Oct 6", prs: 9, tasks: [14, 14], files: 26, measured: "1,120 folders shared", checked: "Nov 3", checkedDays: 0 },
];

const PROGRESS: Omit<CsFeature, "id" | "stage" | "goal" | "milestone" | "owner">[] = [ // MOCK-HOOK
  { name: "Saved searches", area: "Search", prs: 4, tasks: [7, 7], files: 10, measured: "Used by 212 people in the test group", ready: true },
  { name: "Retry failed payments", area: "Billing", prs: 3, tasks: [6, 6], files: 8, measured: "Failed payments down to 1.3% in the test group", ready: true },
  { name: "Offline notes on phone", area: "Phone app", prs: 2, tasks: [3, 8], files: 6 },
  { name: "Team roles", area: "Teams and sharing", prs: 1, tasks: [2, 9], files: 4 },
  { name: "Report builder", area: "Reports", prs: 5, tasks: [6, 11], files: 13 },
  { name: "Welcome checklist", area: "Sign-up and onboarding", prs: 2, tasks: [4, 6], files: 5 },
];

const NEW_NAMES = [ // MOCK-HOOK
  "Sign in with a work account", "Pick a plan during sign-up", "Sample project to explore", "Import from a spreadsheet", "Welcome video", "Team setup wizard", "Skip setup for later",
  "Yearly billing", "Bank transfer payments", "Tax by country", "Usage-based plans", "Spending limits", "Coupons", "Billing contacts", "Refund requests",
  "Search in file contents", "Filters by date", "Search suggestions", "Search across teams", "Recent searches", "Typo-tolerant search", "Search by tag",
  "Phone push alerts", "Phone dark mode", "Scan a receipt", "Phone widgets", "Share from phone", "Tablet layout", "Phone quick add",
  "Scheduled reports", "Report sharing links", "Charts in reports", "Report templates", "Compare two months", "Goal tracking report", "Report comments",
  "Guest access", "Team activity feed", "Mentions", "Team calendar", "Comment threads", "Read-only links", "Team spaces", "Leave a team",
];

function build(): CsFeature[] { // MOCK-HOOK
  const out: CsFeature[] = [];
  const add = (stage: Stage, f: Omit<CsFeature, "id" | "stage" | "goal" | "milestone" | "owner">, i: number) =>
    out.push({ ...f, id: `f-${out.length + 1}`, stage, goal: GOALS[i % GOALS.length], milestone: stage === "exists" ? "Shipped" : MILESTONES[i % MILESTONES.length], owner: PEOPLE[i % PEOPLE.length] });
  EXISTS.forEach((f, i) => add("exists", f, i));
  PROGRESS.forEach((f, i) => add("progress", f, i));
  const sizes = [7, 8, 7, 7, 7, 8]; // MOCK-HOOK: the new features, in NEW_NAMES order, per area
  const areaOf = (i: number) => CS_AREAS[sizes.findIndex((_, k) => i < sizes.slice(0, k + 1).reduce((x, y) => x + y, 0))];
  NEW_NAMES.forEach((name, i) => add("new", { name, area: areaOf(i) }, i));
  return out;
}

export const CS_FEATURES: CsFeature[] = build(); // MOCK-HOOK
export const CS_STAGE_WORD: Record<Stage, string> = { new: "New", progress: "In progress", exists: "Exists" }; // MOCK-HOOK
