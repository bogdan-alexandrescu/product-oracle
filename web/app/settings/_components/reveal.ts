/**
 * On a phone a list's inspector sits under the whole list: a tap on a row brings it into view
 * (qa-settings-44). Wider, it sits beside the list and nothing moves.
 */
export function revealOnPhone(testId: string) {
  if (!window.matchMedia("(max-width: 600px)").matches) return;
  requestAnimationFrame(() => document.querySelector(`[data-testid="${testId}"]`)?.scrollIntoView({ block: "start" }));
}
