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

const PHONE = "(max-width: 600px)";

function subscribePhone(l: () => void) {
  const mq = window.matchMedia(PHONE);
  mq.addEventListener("change", l);
  return () => mq.removeEventListener("change", l);
}

/** Whether the window is phone-sized; false on the server and until hydration. */
export const usePhone = () => useSyncExternalStore(subscribePhone, () => window.matchMedia(PHONE).matches, () => false);

/**
 * The page's info tip in one place only (no tip, and no test id, drawn twice): after the H1
 * on a wider window, handed to the phone header on a phone.
 */
export function PageInfo({ info }: { info: ReactNode }) {
  const phone = usePhone();
  return phone ? <PublishPageInfo info={info} /> : <span className="-ml-1 flex flex-none items-center">{info}</span>;
}

/** Publishes the page's info tip while the header that draws it is mounted. */
function PublishPageInfo({ info }: { info: ReactNode }) {
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
