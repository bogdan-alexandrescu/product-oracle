// build-shortcuts (#1795): the one place that decides who gets a key. The palette's keys come first
// (Ctrl or ⌘ K, and its own Escape in events.ts, which loads before this module); then a field being
// typed in (every key types; Esc in the feature panel's field leaves the field first, KS3 A); then
// an open dialog (only its own keys work); then the page's keys (the version viewer's), and last
// the app's keys (KeysHost: j, k, Enter, Shift J and K, c, /, ?, s, g then a letter).
import { useEffect, useRef } from 'react';

import './events';

export type KeyMap = Record<string, (e: KeyboardEvent) => void>;

const OPEN_KEYS = 'oracle:keys-open';
/** The rail's Keys line: opens the ? sheet. */
export const openKeys = () => window.dispatchEvent(new Event(OPEN_KEYS));
export function useOpenKeys(on: () => void): void {
  useEffect(() => {
    window.addEventListener(OPEN_KEYS, on);
    return () => window.removeEventListener(OPEN_KEYS, on);
  }, [on]);
}

let palette: { open: boolean; toggle: () => void } | null = null;
const pages: { current: KeyMap }[] = [];
let app: { current: KeyMap } | null = null;

/** Where a person is typing: every key goes into the field. */
export function isTyping(el: EventTarget | null): boolean {
  const a = el as HTMLElement | null;
  if (!a || !a.tagName) return false;
  return (
    a.tagName === 'INPUT' ||
    a.tagName === 'TEXTAREA' ||
    a.tagName === 'SELECT' ||
    a.isContentEditable
  );
}

const DIALOG = '[role=dialog]:not([data-keys-sheet]), [role=alertdialog], dialog[open]';

/** A dialog is open (or has the focus): nothing behind it moves. */
function inDialog(target: EventTarget | null): boolean {
  if ((target as HTMLElement | null)?.closest?.(DIALOG)) return true;
  return [...document.querySelectorAll<HTMLElement>('[aria-modal=true]')].some(
    (d) => !d.closest('[data-keys-sheet]') && d.getClientRects().length > 0,
  );
}

/** The name a key goes by in a map: "j", "J" (Shift J), "Enter", "?", "Shift+ArrowLeft". */
function nameOf(e: KeyboardEvent): string {
  if (e.key.length > 1 && e.shiftKey && e.key.startsWith('Arrow')) return `Shift+${e.key}`;
  return e.key;
}

function onKey(e: KeyboardEvent) {
  // A key a script sends (Shift J's arrow to a row's grip) is the grip's alone.
  if (!e.isTrusted || e.isComposing) return;
  // Ctrl or ⌘ K opens the palette even when another handler has already prevented its default.
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k' && palette) {
    e.preventDefault();
    palette.toggle();
    return;
  }
  if (e.defaultPrevented) return;
  if (palette?.open) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (isTyping(e.target)) return;
  if ((e.target as HTMLElement | null)?.closest?.('[data-keys-sheet]')) return;
  if (inDialog(e.target)) return;
  const name = nameOf(e);
  const page = pages[pages.length - 1];
  if (page?.current[name]) return page.current[name](e);
  app?.current[name]?.(e);
}

/** KS3 A: Esc in the feature panel's field leaves the field (its Save and Cancel keep what was
 * typed); a second Esc closes the panel. Captured, so the panel's own Escape never sees the first. */
function onEscape(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.defaultPrevented || palette?.open) return;
  const a = document.activeElement as HTMLElement | null;
  if (!a || !(a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) return;
  const panel = a.closest('[data-testid=item-panel]');
  // The panel's own card is a dialog; a dialog around the panel (or a field outside it) is not ours.
  if (!panel || a.closest(DIALOG)?.contains(panel)) return;
  e.stopImmediatePropagation();
  e.preventDefault();
  a.blur();
}

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', onEscape, true);
  window.addEventListener('keydown', onKey);
}

/** The palette's own: Ctrl or ⌘ K opens and closes it, and while it is open no other key acts. */
export function usePaletteKeys(open: boolean, toggle: () => void): void {
  useEffect(() => {
    const mine = { open, toggle };
    palette = mine;
    return () => {
      if (palette === mine) palette = null;
    };
  }, [open, toggle]);
}

/** A page's keys (the version viewer's): they win over the app's while the page is shown. Returns
 * the undo, for an effect's cleanup. */
export function addPageKeys(map: KeyMap): () => void {
  const mine = { current: map };
  pages.push(mine);
  return () => {
    const i = pages.lastIndexOf(mine);
    if (i >= 0) pages.splice(i, 1);
  };
}

/** The app's keys, set once by KeysHost. */
export function useAppKeys(map: KeyMap): void {
  const ref = useRef(map);
  useEffect(() => {
    ref.current = map;
  });
  useEffect(() => {
    app = ref;
    return () => {
      if (app === ref) app = null;
    };
  }, []);
}
