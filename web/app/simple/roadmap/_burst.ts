"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** A pause this long in a bar's arrow presses ends the burst and sends its change (ms). */
export const BURST_MS = 600;

type Open<T> = {
  /** What was stored at the burst's first press: the change's `before`. */
  before: T;
  after: T;
  timer: number | null;
  /** The previous burst's change, still on its way when this one began: its result is this one's `before`. */
  chain: Promise<T | null> | null;
};

/**
 * The keyboard's moves, one change per burst (#723 S4 re-review): each arrow press moves
 * the bar or card locally (`pending`), and the burst becomes ONE change when the person
 * pauses for BURST_MS or the item loses focus (`flush`), with `before` = what was stored
 * at the first press. A burst that begins while the previous one's change is on its way
 * builds on that change's result, never a stale `before`. `cancel` (Escape) drops it.
 *
 * `send` makes the change and returns what is stored once it returns (its `after` when it
 * applied, its `before` when it is a proposal), or null when that is unknown (it failed).
 */
export function useKeyBurst<T>(send: (id: string, before: T, after: T) => Promise<T | null>, same: (a: T, b: T) => boolean) {
  const open = useRef(new Map<string, Open<T>>());
  const inflight = useRef(new Map<string, Promise<T | null>>());
  const [pending, setPending] = useState<Record<string, T>>({});
  const latest = useRef({ send, same });
  useEffect(() => {
    latest.current = { send, same };
  });

  const show = useCallback((id: string, v: T | null) => {
    setPending((p) => {
      if (v == null && !(id in p)) return p;
      const n = { ...p };
      if (v == null) delete n[id];
      else n[id] = v;
      return n;
    });
  }, []);

  const flush = useCallback(
    (id: string) => {
      const b = open.current.get(id);
      if (!b) return;
      open.current.delete(id);
      if (b.timer != null) clearTimeout(b.timer);
      const p = (b.chain ?? Promise.resolve(null)).then(async (stored) => {
        const before = stored ?? b.before;
        if (latest.current.same(before, b.after)) return before;
        try {
          return await latest.current.send(id, before, b.after);
        } catch {
          return null;
        }
      });
      inflight.current.set(id, p);
      void p.then(() => {
        if (inflight.current.get(id) === p) inflight.current.delete(id);
        // The roadmap reloaded with the change: the item draws from its data again.
        if (!open.current.has(id)) show(id, null);
      });
    },
    [show],
  );

  /** One press: the item's stored value now (the burst's `before` if it is the first) and where it goes. */
  const press = useCallback(
    (id: string, stored: T, after: T) => {
      let b = open.current.get(id);
      if (!b) {
        b = { before: stored, after, timer: null, chain: inflight.current.get(id) ?? null };
        open.current.set(id, b);
      }
      b.after = after;
      if (b.timer != null) clearTimeout(b.timer);
      b.timer = window.setTimeout(() => flush(id), BURST_MS);
      show(id, after);
    },
    [flush, show],
  );

  /** Escape: the burst is dropped before it is sent (true when there was one). */
  const cancel = useCallback(
    (id: string): boolean => {
      const b = open.current.get(id);
      if (!b) return false;
      open.current.delete(id);
      if (b.timer != null) clearTimeout(b.timer);
      show(id, null);
      return true;
    },
    [show],
  );

  // Leaving the page sends what is pending (nothing is lost).
  useEffect(() => {
    const bursts = open.current;
    return () => {
      for (const id of [...bursts.keys()]) flush(id);
    };
  }, [flush]);

  return useMemo(() => ({ pending, press, flush, cancel }), [pending, press, flush, cancel]);
}
