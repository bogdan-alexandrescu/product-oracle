// MOCK-HOOK: mk-edit-goals-prds mock-up data (throwaway branch, never merged). Invented people and text only.

// MOCK-HOOK: the people a goal's owner is picked from.
export const MK_PEOPLE = ["Maya Ortiz", "Sam Okafor", "Priya Nair", "Leo Brandt", "Ada Kim", "Tomás Reyes", "Hana Sato"]; // MOCK-HOOK

// MOCK-HOOK: each plan goal's owner (Simple shows none today).
export const MK_GOAL_OWNERS: Record<string, string> = { Reliability: "Maya Ortiz", Growth: "Sam Okafor", Activation: "Priya Nair", Revenue: "Leo Brandt", "Grow partner network": "Ada Kim" }; // MOCK-HOOK

// MOCK-HOOK: goals archived before today, for the archived lists.
export const MK_ARCHIVED_GOALS = [
  { id: "mk-arch-1", title: "Cut support tickets in half", measure: "Support tickets a week", target: "120 tickets", due: "2026-12-18", owner: "Hana Sato", archived: "Oct 14", features: 3 }, // MOCK-HOOK
  { id: "mk-arch-2", title: "Launch in two new regions", measure: "Regions live", target: "2 regions", due: "2026-11-30", owner: "Tomás Reyes", archived: "Sep 30", features: 0 }, // MOCK-HOOK
  { id: "mk-arch-3", title: "Faster first report", measure: "Minutes to first report", target: "5 min", due: "2026-10-31", owner: "Ada Kim", archived: "Aug 22", features: 1 }, // MOCK-HOOK
]; // MOCK-HOOK

// MOCK-HOOK: more PRDs for the One-pagers list, so a long list shows.
export const MK_MORE_PRDS = [
  { slug: "mk-team-invites", title: "Team invites by link", updated_at: "2026-11-02T15:10:00Z", status: "in_review" }, // MOCK-HOOK
  { slug: "mk-usage-alerts", title: "Usage alerts before plan limits", updated_at: "2026-10-29T10:00:00Z", status: "approved" }, // MOCK-HOOK
  { slug: "mk-csv-import", title: "Import customers from a CSV file", updated_at: "2026-10-27T09:30:00Z", status: "draft" }, // MOCK-HOOK
  { slug: "mk-dark-reports", title: "Printable weekly reports", updated_at: "2026-10-21T16:45:00Z", status: "approved" }, // MOCK-HOOK
  { slug: "mk-partner-portal", title: "Partner portal: listings, leads and a shared inbox for partner questions", updated_at: "2026-10-15T11:20:00Z", status: "draft" }, // MOCK-HOOK
  { slug: "mk-sso", title: "Single sign-on for larger teams", updated_at: "2026-10-08T08:00:00Z", status: "in_review" }, // MOCK-HOOK
  { slug: "mk-mobile-capture", title: "Capture notes from a phone", updated_at: "2026-09-30T13:00:00Z", status: "draft" }, // MOCK-HOOK
  { slug: "mk-billing-history", title: "Billing history page", updated_at: "2026-09-18T12:00:00Z", status: "approved" }, // MOCK-HOOK
]; // MOCK-HOOK

// MOCK-HOOK: PRDs archived before today.
export const MK_ARCHIVED_PRDS = [
  { slug: "mk-old-onboarding", title: "Onboarding checklist v1", archived: "Oct 3" }, // MOCK-HOOK
  { slug: "mk-old-referrals", title: "Referral credits", archived: "Sep 12" }, // MOCK-HOOK
]; // MOCK-HOOK

// MOCK-HOOK: the features each PRD put on the roadmap (by PRD title start), with their milestone and weeks.
export const MK_PRD_FEATURES: { code: string; name: string; ms: string; wk: number; shared?: string }[] = [
  { code: "F-01", name: "Setup checklist", ms: "M1 Prove it", wk: 2 }, // MOCK-HOOK
  { code: "F-02", name: "Sample data on first run", ms: "M1 Prove it", wk: 1.5 }, // MOCK-HOOK
  { code: "F-05", name: "Invite teammates during setup", ms: "M1 Prove it", wk: 2, shared: "Team invites by link" }, // MOCK-HOOK
  { code: "F-06", name: "Setup progress email", ms: "M2 Scale", wk: 1 }, // MOCK-HOOK
  { code: "F-09", name: "Connect a data source in setup", ms: "M2 Scale", wk: 3 }, // MOCK-HOOK
  { code: "F-12", name: "Setup for larger teams", ms: "M2 Scale", wk: 2.5 }, // MOCK-HOOK
  { code: "F-14", name: "Plan limits", ms: "M3 Grow", wk: 2 }, // MOCK-HOOK
]; // MOCK-HOOK
