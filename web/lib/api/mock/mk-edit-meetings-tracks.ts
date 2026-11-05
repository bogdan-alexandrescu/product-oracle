// MOCK-HOOK: mk-edit-meetings-tracks. Invented agenda items, tracks and PRDs for the owner's mock-up frames only.

/** MOCK-HOOK: one agenda item: a feature of the meeting's PRD or a topic typed by a person. */
export type MkAgendaItem = { id: string; title: string; kind: "feature" | "topic"; state: "done" | "now" | "next" | "skipped"; mins: number; by?: string }; // MOCK-HOOK

export const MK_AGENDA: MkAgendaItem[] = [ // MOCK-HOOK
  { id: "ag-1", title: "Alert rules engine", kind: "feature", state: "done", mins: 10 }, // MOCK-HOOK
  { id: "ag-2", title: "Weekly alert digest", kind: "feature", state: "now", mins: 15 }, // MOCK-HOOK
  { id: "ag-3", title: "Mobile alert push", kind: "feature", state: "next", mins: 10 }, // MOCK-HOOK
  { id: "ag-4", title: "Quiet hours for muted teams", kind: "topic", state: "next", mins: 5, by: "Dana Whitfield" }, // MOCK-HOOK
  { id: "ag-5", title: "Alert history export", kind: "feature", state: "skipped", mins: 10 }, // MOCK-HOOK
]; // MOCK-HOOK

/** MOCK-HOOK: the hard case: a long agenda with long names (overflow). */
export const MK_AGENDA_MANY: MkAgendaItem[] = [ // MOCK-HOOK
  ...MK_AGENDA, // MOCK-HOOK
  { id: "ag-6", title: "Alert routing by team, with a fallback person when nobody on the team is on call", kind: "feature", state: "next", mins: 10 }, // MOCK-HOOK
  { id: "ag-7", title: "Free plan alert limit", kind: "topic", state: "next", mins: 5, by: "Marco Ilves" }, // MOCK-HOOK
  { id: "ag-8", title: "Digest wording for admins", kind: "topic", state: "next", mins: 5, by: "Priya Raman" }, // MOCK-HOOK
  { id: "ag-9", title: "Webhook alerts for chat tools", kind: "feature", state: "next", mins: 10 }, // MOCK-HOOK
  { id: "ag-10", title: "Snooze an alert for a day", kind: "feature", state: "next", mins: 5 }, // MOCK-HOOK
  { id: "ag-11", title: "Who signs off the beta date", kind: "topic", state: "next", mins: 5, by: "Dana Whitfield" }, // MOCK-HOOK
  { id: "ag-12", title: "Alert sounds on desktop", kind: "feature", state: "skipped", mins: 5 }, // MOCK-HOOK
  { id: "ag-13", title: "Open questions from support", kind: "topic", state: "next", mins: 10, by: "Leo Brandt" }, // MOCK-HOOK
]; // MOCK-HOOK

/** MOCK-HOOK: features of the PRD not on the agenda yet (the add picker). */
export const MK_AGENDA_ADDABLE = ["Alert routing by team", "Webhook alerts for chat tools", "Snooze an alert for a day", "Alert sounds on desktop"]; // MOCK-HOOK

/** MOCK-HOOK: one track of the company roadmap. */
export type MkTrack = { id: string; title: string; owner: string | null; state: "active" | "paused" | "closed"; items: number; prd: string }; // MOCK-HOOK

export const MK_TRACKS: MkTrack[] = [ // MOCK-HOOK
  { id: "tr-alerts", title: "Usage alerts track", owner: "Dana Whitfield", state: "active", items: 5, prd: "Usage alerts" }, // MOCK-HOOK
  { id: "tr-onboarding", title: "Guided setup track", owner: "Marco Ilves", state: "active", items: 4, prd: "Guided setup" }, // MOCK-HOOK
  { id: "tr-pricing", title: "Welcome media track", owner: null, state: "paused", items: 1, prd: "Guided setup" }, // MOCK-HOOK
]; // MOCK-HOOK

/** MOCK-HOOK: the hard case: many tracks, long names, paused and closed ones. */
export const MK_TRACKS_MANY: MkTrack[] = [ // MOCK-HOOK
  ...MK_TRACKS, // MOCK-HOOK
  { id: "tr-mobile", title: "Mobile apps", owner: "Priya Raman", state: "active", items: 7, prd: "Usage alerts" }, // MOCK-HOOK
  { id: "tr-admin", title: "Admin console and team settings for large accounts", owner: "Leo Brandt", state: "active", items: 6, prd: "Guided setup" }, // MOCK-HOOK
  { id: "tr-billing", title: "Billing", owner: "Ana Sousa", state: "active", items: 3, prd: "Plan changes" }, // MOCK-HOOK
  { id: "tr-reports", title: "Reports", owner: "Tom Becker", state: "paused", items: 2, prd: "Usage alerts" }, // MOCK-HOOK
  { id: "tr-api", title: "Public API", owner: "Dana Whitfield", state: "active", items: 4, prd: "Guided setup" }, // MOCK-HOOK
  { id: "tr-legacy", title: "Old importer", owner: "Marco Ilves", state: "closed", items: 0, prd: "Guided setup" }, // MOCK-HOOK
  { id: "tr-search", title: "Search", owner: null, state: "active", items: 2, prd: "Usage alerts" }, // MOCK-HOOK
]; // MOCK-HOOK

/** MOCK-HOOK: the roadmap's PRDs, each with its tracks (moving a feature stays within the one roadmap). */
export const MK_PRDS: { title: string; tracks: string[] }[] = [ // MOCK-HOOK
  { title: "Usage alerts", tracks: ["Usage alerts track", "Mobile apps", "Reports", "Search"] }, // MOCK-HOOK
  { title: "Guided setup", tracks: ["Guided setup track", "Welcome media track", "Admin console and team settings for large accounts", "Public API"] }, // MOCK-HOOK
  { title: "Plan changes", tracks: ["Billing"] }, // MOCK-HOOK
]; // MOCK-HOOK

export const MK_PEOPLE = ["Dana Whitfield", "Marco Ilves", "Priya Raman", "Leo Brandt", "Ana Sousa", "Tom Becker"]; // MOCK-HOOK
