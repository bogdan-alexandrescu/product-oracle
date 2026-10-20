/**
 * A section's review state as a mark that differs in SHAPE as well as colour, so it reads
 * without colour too: a filled disc with a check (approved), a diamond with ! (changes
 * requested), a filled square with a cross (rejected), a ring (not reviewed), a lock
 * (locked: the version's review is closed). Only "approved" ever draws a check.
 */
export type MarkState = "approved" | "changes_requested" | "rejected" | "none" | "locked";

export const MARK_LABEL: Record<MarkState, string> = {
  approved: "Approved",
  changes_requested: "Changes requested",
  rejected: "Rejected",
  none: "Not reviewed",
  locked: "Locked",
};

const TONE: Record<MarkState, string> = {
  approved: "text-pass",
  changes_requested: "text-warn",
  rejected: "text-crit",
  none: "text-line-strong",
  locked: "text-text2",
};

export function StatusMark({
  state,
  size = 16,
  label = true,
  className = "",
}: {
  state: MarkState;
  size?: 16 | 20;
  /** Say the state to screen readers (off when the row already says it). */
  label?: boolean;
  className?: string;
}) {
  return (
    <span data-testid="status-mark" data-state={state} className={`inline-flex flex-none ${TONE[state]} ${className}`} title={MARK_LABEL[state]}>
      <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
        {state === "approved" && (
          <>
            <circle cx="8" cy="8" r="7" fill="currentColor" />
            <path d="M4.8 8.2l2.1 2.1 4.3-4.6" fill="none" stroke="var(--surface)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </>
        )}
        {state === "changes_requested" && (
          <>
            <path d="M8 0.9L15.1 8 8 15.1 0.9 8z" fill="currentColor" />
            <path d="M8 4.6v4.2" stroke="var(--surface)" strokeWidth="1.8" strokeLinecap="round" />
            <circle cx="8" cy="11.3" r="1" fill="var(--surface)" />
          </>
        )}
        {state === "rejected" && (
          <>
            <rect x="1.5" y="1.5" width="13" height="13" rx="2.5" fill="currentColor" />
            <path d="M5.3 5.3l5.4 5.4M10.7 5.3l-5.4 5.4" stroke="var(--surface)" strokeWidth="1.8" strokeLinecap="round" />
          </>
        )}
        {state === "none" && <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.8" />}
        {state === "locked" && (
          <>
            <rect x="3" y="7" width="10" height="7.5" rx="1.6" fill="currentColor" />
            <path d="M5.2 7V5.1a2.8 2.8 0 015.6 0V7" fill="none" stroke="currentColor" strokeWidth="1.7" />
          </>
        )}
      </svg>
      {label && <span className="sr-only">{MARK_LABEL[state]}</span>}
    </span>
  );
}
