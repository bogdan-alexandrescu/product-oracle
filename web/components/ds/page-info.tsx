"use client";

import { useId, useLayoutEffect, useSyncExternalStore, type ReactNode } from "react";

/*
 * qa-shell-22: a PageHeader's info tip (`info`). On a phone the H1 is for screen readers only,
 * so the phone header draws the tip beside its title instead of leaving it alone on a row.
 * The open page's header publishes it here; the last one mounted wins.
 */
const infos = new Map<string, ReactNode>();
let current: ReactNode = null;
const listeners = new Set<() => void>();

function changed() {
  current = [...infos.values()].at(-1) ?? null;
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Publishes the page's info tip while the header that draws it is mounted. */
export function PublishPageInfo({ info }: { info: ReactNode }) {
  const id = useId();
  useLayoutEffect(() => {
    infos.set(id, info);
    changed();
  }, [id, info]);
  useLayoutEffect(
    () => () => {
      infos.delete(id);
      changed();
    },
    [id],
  );
  return null;
}

/** The open page's info tip, for the phone header. */
export function usePageInfo(): ReactNode {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}
