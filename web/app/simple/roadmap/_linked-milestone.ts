// build-palette (#1794): /simple/roadmap?milestone=<id> opens that milestone's own card, once per
// link (the palette's Enter on a milestone); the card closed, the address drops it, so a reload
// does not open it again and the same link opens it anew.
import { useEffect, useRef } from 'react';

import { useSearchParams } from '@/lib/nav';

import type { MsCtl } from './_milestones';

export function useLinkedMilestone(
  ms: MsCtl | null,
  /** The roadmap as its picks narrow it has been read. */
  ready: boolean,
  /** Any pick that hides the linked milestone is put aside. */
  widen: () => void,
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
    if (m) {
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
