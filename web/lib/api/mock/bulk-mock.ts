// MOCK-HOOK (whole file): mock-up data for mk-bulk-edit (bulk edit owner, status and dates,
// decisions BE1..BE3). Invented people, tracks and names only. Never merged.

/** People a feature can be given to (invented). */ // MOCK-HOOK
export const BULK_PEOPLE = ['Rosa Lind', 'Theo Marsh', 'Priya Nand', 'Jonah Pike', 'Mei Arden']; // MOCK-HOOK

/** Tracks a feature can move to (invented, matching the mock roadmap's tracks). */ // MOCK-HOOK
export const BULK_TRACKS = ['Usage alerts track', 'Guided setup track', 'Welcome media track']; // MOCK-HOOK

export const BULK_STATUSES = ['New', 'In progress', 'Exists']; // MOCK-HOOK

/** Today's owner of each mock feature, by title (the mock rows carry none). */ // MOCK-HOOK
export const BULK_OWNER: Record<string, string> = {
  // MOCK-HOOK
  'Setup checklist': 'Theo Marsh', // MOCK-HOOK
  'Alert rules engine': 'Priya Nand', // MOCK-HOOK
  'Weekly alert digest': 'Priya Nand', // MOCK-HOOK
  'Mobile alert push': '', // MOCK-HOOK
  'Sample data import': 'Theo Marsh', // MOCK-HOOK
  'Alert history export': '', // MOCK-HOOK
  'Alert routing by team': 'Jonah Pike', // MOCK-HOOK
}; // MOCK-HOOK

/** Rights on a feature for the signed-in person in the mixed-rights case (BE3): "edit" applies at
 * once, "propose" goes to the feature's approver, "none" cannot be changed. By title. */ // MOCK-HOOK
export const BULK_RIGHTS: Record<string, 'edit' | 'propose' | 'none'> = {
  // MOCK-HOOK
  'Weekly alert digest': 'propose', // MOCK-HOOK
  'Alert routing by team': 'none', // MOCK-HOOK
}; // MOCK-HOOK

/** Why a feature cannot be changed (BE3, the tip on its lock). */ // MOCK-HOOK
export const BULK_WHY: Record<string, string> = {
  // MOCK-HOOK
  'Alert routing by team': 'Locked by Jonah Pike for the Dec 15 board meeting', // MOCK-HOOK
}; // MOCK-HOOK

/** Who approves a proposed change (BE3). */ // MOCK-HOOK
export const BULK_APPROVER = 'Avery Stone'; // MOCK-HOOK

/** Long names for the hard case (&long=1), by title. */ // MOCK-HOOK
export const BULK_LONG: Record<string, string> = {
  // MOCK-HOOK
  'Alert rules engine': 'Alert rules engine with per-team quiet hours and escalation steps', // MOCK-HOOK
  'Mobile alert push': 'Mobile alert push for iOS and Android with grouped digests at night', // MOCK-HOOK
  'Alert history export': 'Alert history export to spreadsheets, with filters kept per saved view', // MOCK-HOOK
  'Alert routing by team': 'Alert routing by team, region and on-call rota with a fallback owner', // MOCK-HOOK
}; // MOCK-HOOK
