import type { KeyboardEvent } from "react";

/**
 * qa-shell-7: a radio group's keys. One Tab stop (the checked radio, `tabIndex`), and the
 * arrow keys move the choice to the next or previous option, wrapping, and focus it, as a
 * radio group does. `onRadioKeys(e, values, current, choose)` on the group's keydown.
 */
export function radioTabIndex(on: boolean): 0 | -1 {
  return on ? 0 : -1;
}

export function onRadioKeys<V extends string>(
  e: KeyboardEvent<HTMLElement>,
  values: V[],
  current: V,
  choose: (v: V) => void,
  { follow = true }: { follow?: boolean } = {},
): void {
  const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
  if (!step) return;
  e.preventDefault();
  const radios = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')];
  // follow: false (a choice that opens another page) moves focus only, from the focused radio;
  // Enter or Space chooses, so one arrow press never takes the person off the group.
  const focused = radios.indexOf(document.activeElement as HTMLElement);
  const at = !follow && focused >= 0 ? focused : Math.max(0, values.indexOf(current));
  const next = values[(at + step + values.length) % values.length];
  radios[values.indexOf(next)]?.focus();
  if (follow) choose(next);
}
