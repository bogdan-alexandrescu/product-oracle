// build-palette (#1794): /simple/roadmap?milestone=<id> opens that milestone's own card, once per
// link (the palette's Enter on a milestone); the card closed, the address drops it, so a reload
// does not open it again and the same link opens it anew. A track's milestone: the link brings its
// mark into view and opens its card where the chart has one (else puts the focus on the mark),
// then drops from the address.
import { useEffect, useRef } from 'react';

import { useSearchParams } from '@/lib/nav';

import type { MsCtl } from './_milestones';

export function useLinkedMilestone(
  ms: MsCtl | null,
  /** The roadmap as its picks narrow it has been read. */
  ready: boolean,
  /** Any pick that hides the linked milestone is put aside. */
  widen: () => void,
  /** The roadmap's track milestones (each drawn as a mark with its id). */
  tracks: { id: string }[] = [],
): void {
  const asked = useSearchParams().get('milestone');
  const opened = useRef<string | null>(null);
  const widened = useRef<string | null>(null);
  const shown = useRef(false);
  const on = ms?.draft?.id ?? null;
  useEffect(() => {
    if (!asked) {
      opened.current = null;
      widened.current = null;
      return;
    }
    if (!ms || !ready || opened.current === asked) return;
    const m = ms.list.find((x) => x.id === asked);
    const mark = tracks.some((t) => t.id === asked)
      ? document.querySelector<HTMLElement | SVGElement>(`[data-track-milestone="${asked}"]`)
      : null;
    if (mark) {
      opened.current = asked;
      mark.scrollIntoView({ block: 'center', inline: 'center' });
      if (mark instanceof HTMLButtonElement) mark.click();
      else mark.focus();
      const next = new URL(window.location.href);
      next.searchParams.delete('milestone');
      window.history.replaceState(window.history.state, '', next);
    } else if (m) {
      opened.current = asked;
      shown.current = false;
      ms.edit(m);
    } else if (widened.current !== asked) {
      widened.current = asked;
      widen();
    }
  });
  useEffect(() => {
    if (!asked || opened.current !== asked) return;
    if (on === asked) {
      shown.current = true;
      return;
    }
    if (!shown.current) return;
    shown.current = false;
    const next = new URL(window.location.href);
    next.searchParams.delete('milestone');
    window.history.replaceState(window.history.state, '', next);
  }, [on, asked]);
}
