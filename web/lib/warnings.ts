import type { Schemas } from "@/lib/api/client";

type Warning = Pick<Schemas["VersionWarning"], "code" | "refs" | "message">;

/** The older stored wording of a note answered in full, before ``declined`` was in its refs: "(2 addressed, 0 declined)". */
const OLD_ALL_ADDRESSED = /\(\d+ addressed, 0 declined\)/;

/**
 * A version's notice that reads as done, not as a warning: a send-back note whose every point
 * the draft addressed (api/oracle/docs/service.py, note_answered with no declined point). An
 * older stored one has no ``declined`` list: its words say "0 declined".
 */
export function isDoneNotice(w: Warning): boolean {
  if (w.code !== "note_answered") return false;
  const declined = w.refs?.declined;
  if (Array.isArray(declined)) return declined.length === 0;
  return declined == null && OLD_ALL_ADDRESSED.test(w.message);
}

/** A version's real warnings: its notices that read as done left out. */
export const realWarnings = <T extends Warning>(warnings: T[]): T[] =>
  warnings.filter((w) => !isDoneNotice(w));

/** A warning as shown, wherever it is: the API words it lowercase, a person reads a sentence. */
export const warningSentence = (message: string): string => message.charAt(0).toUpperCase() + message.slice(1);
