import type { Schemas } from "@/lib/api/client";
import { mockNowMs } from "./clock";
import { companyDayInWords } from "./connections";
import { MOCK_SCENARIO_KEY, stableUuid } from "./ids";

/*
 * decisions-reversed-or-trashed banner: the "decision-notes" scenario (MOCK_SCENARIO_KEY).
 * An open draft cited two decisions: one the owner reversed since (the draft carries a
 * note, as oracle.decisions.standing.note_reversed writes it) and one made about a
 * roadmap now in Trash. The roadmap and one-pager reads leave both out and name them in
 * left_out (standing.sources_entry), word for word as the API does.
 */
export const DECISION_NOTES_SCENARIO = "decision-notes";

export const REVERSED = { number: 12, title: "Cut bulk export from the first release", note: "Customers asked for exports back." };
export const TRASHED = { number: 9, title: "Ship alerts by email only" };

const on = () => typeof localStorage !== "undefined" && localStorage.getItem(MOCK_SCENARIO_KEY) === DECISION_NOTES_SCENARIO;

/** An open draft's decision_notes (standing.note_reversed's text). */
export function draftDecisionNotes(): string[] {
  // Reversed the day before "now", worded as the API words it (the company's day, month first).
  const day = companyDayInWords(new Date(mockNowMs() - 24 * 3600 * 1000));
  return on() ? [`D-${REVERSED.number} ${REVERSED.title} was reversed on ${day}: ${REVERSED.note}`] : [];
}

/** A roadmap or one-pager read's left_out (standing.sources_entry), null when none. */
export function leftOut(): Schemas["SimpleLeftOut"] | null {
  if (!on()) return null;
  const lines = [`D-${REVERSED.number} ${REVERSED.title} (reversed)`, `D-${TRASHED.number} ${TRASHED.title} (about a roadmap now in Trash)`];
  return {
    kind: "left_out",
    title: `Left out, no longer standing: ${lines.join("; ")}.`,
    decision_ids: [stableUuid(`decision/${REVERSED.number}`), stableUuid(`decision/${TRASHED.number}`)],
  };
}
