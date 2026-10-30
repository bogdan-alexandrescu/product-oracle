/**
 * Up to 1100 px (where Split stacks) a list's inspector sits under the whole list: a tap on a
 * row brings it into view (qa-settings-44). Wider, it sits beside the list and nothing moves.
 */
export function revealOnPhone(testId: string) {
  if (!window.matchMedia("(max-width: 1100px)").matches) return;
  requestAnimationFrame(() => document.querySelector(`[data-testid="${testId}"]`)?.scrollIntoView({ block: "start" }));
}
