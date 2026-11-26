// build-palette (#1794): the palette's hand-offs. The rail's Find opens it; "New item" hands its
// words to the roadmap's quick add, which adds it on the roadmap and track used last.
import { useEffect, useRef } from 'react';

const OPEN = 'oracle:palette-open';
const NEW_ITEM = 'oracle:palette-new-item';
const LAST = 'oracle.quick-add.last';

export const openPalette = () => window.dispatchEvent(new Event(OPEN));

export function useOpenPalette(on: () => void): void {
  useEffect(() => {
    window.addEventListener(OPEN, on);
    return () => window.removeEventListener(OPEN, on);
  }, [on]);
}

/** The open palette's Escape. Listened to before any layer's own (this module loads first), so the
 * panel or sheet under the palette never closes with it. */
let escape: (() => void) | null = null;
if (typeof window !== 'undefined')
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || !escape) return;
      e.stopImmediatePropagation();
      if (e.isComposing) return;
      e.preventDefault();
      escape();
    },
    true,
  );

export function usePaletteEscape(on: () => void): void {
  useEffect(() => {
    escape = on;
    return () => {
      if (escape === on) escape = null;
    };
  }, [on]);
}

export type NewItemAsk = { title: string; add: boolean };
let pending: NewItemAsk | null = null;

export function askNewItem(ask: NewItemAsk): void {
  pending = ask;
  window.dispatchEvent(new Event(NEW_ITEM));
}

/** The quick add takes a waiting ask once it can act on it (`ready`: its places are known). */
export function useNewItemAsk(ready: boolean, take: (ask: NewItemAsk) => void): void {
  const ref = useRef(take);
  useEffect(() => {
    ref.current = take;
  });
  useEffect(() => {
    if (!ready) return;
    const on = () => {
      const a = pending;
      pending = null;
      if (a) ref.current(a);
    };
    on();
    window.addEventListener(NEW_ITEM, on);
    return () => window.removeEventListener(NEW_ITEM, on);
  }, [ready]);
}

export type LastUsed = { roadmap?: string; track?: string };

export function lastUsed(): LastUsed {
  try {
    return (JSON.parse(localStorage.getItem(LAST) ?? '{}') as LastUsed) ?? {};
  } catch {
    return {};
  }
}

export function rememberUsed(used: LastUsed): void {
  try {
    localStorage.setItem(LAST, JSON.stringify(used));
  } catch {
    // Storage full or off: the first place next time.
  }
}
