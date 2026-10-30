/**
 * A page with typed work holds leaving (NewDraft's useLeaveGuard): a button that navigates
 * with the router (the mode switch, Sign out) calls `leave(go)`, and the page asks "Discard
 * your changes?" first, running `go` on Discard. With no page holding, `go` runs at once.
 */
type Hold = (go: () => void) => boolean;

let hold: Hold | null = null;

/** Set by the page with typed work; `null` when it goes. `hold` returns true when it asks. */
export function holdLeaving(next: Hold | null) {
  hold = next;
}

export function leave(go: () => void) {
  if (!hold?.(go)) go();
}
