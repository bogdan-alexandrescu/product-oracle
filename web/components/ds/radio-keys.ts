import type { KeyboardEvent } from "react";

/**
 * qa-shell-7: a radio group's keys. One Tab stop (the checked radio, `tabIndex`), and the
 * arrow keys move the choice to the next or previous option, wrapping, and focus it, as a
 * radio group does. `onRadioKeys(e, values, current, choose)` on the group's keydown.
 */
export function radioTabIndex(on: boolean): 0 | -1 {
  return on ? 0 : -1;
}

export function onRadioKeys<V extends string>(e: KeyboardEvent<HTMLElement>, values: V[], current: V, choose: (v: V) => void): void {
  const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
  if (!step) return;
  e.preventDefault();
  const at = Math.max(0, values.indexOf(current));
  const next = values[(at + step + values.length) % values.length];
  const radios = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')];
  radios[values.indexOf(next)]?.focus();
  choose(next);
}
