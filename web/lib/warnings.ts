import type { Schemas } from "@/lib/api/client";

type Warning = Pick<Schemas["VersionWarning"], "code" | "refs">;

/** A version's notice that reads as done, not as a warning: a send-back note whose every point the draft addressed (api/oracle/docs/service.py, note_answered with no declined point). */
export function isDoneNotice(w: Warning): boolean {
  const declined = w.refs?.declined;
  return (
    w.code === "note_answered" &&
    Array.isArray(declined) &&
    declined.length === 0
  );
}

/** A version's real warnings: its notices that read as done left out. */
export const realWarnings = <T extends Warning>(warnings: T[]): T[] =>
  warnings.filter((w) => !isDoneNotice(w));
