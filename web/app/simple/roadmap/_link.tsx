'use client';
// panel-ux (#1796, #1747): the feature panel's link and its outside click.
// - A shown panel writes ?feature=<code, else id> to the address; closing it takes it off; Back
//   closes it again, Forward opens it again. Loading the address opens the panel on any Simple
//   page (_panel.tsx's LinkedFeature, mounted by the Simple layout).
// - A side panel (one that dims nothing) closes on a click in the page's empty space; a click on
//   anything that does something (another feature, a button, a field) is left to it.

import { createContext, useContext, useEffect, useRef, type RefObject } from 'react';

import { useRouter } from '@/lib/nav';

type Linked = { id: string; code?: string | null; key?: string | null };

/** The address's word for a feature: its code, else its id. */
export const featureLink = (f: Linked): string => f.code || f.id;

/** Whether ?feature=<value> names this feature (its code in any case, its id or its key). */
export function namesFeature(value: string, f: Linked): boolean {
  const v = value.toLowerCase();
  return f.id === value || f.key === value || (!!f.code && f.code.toLowerCase() === v);
}

/** The address that opens this feature's panel on the page shown now. */
export function featureHref(f: Linked): string {
  const url = new URL(window.location.href);
  url.searchParams.set('feature', featureLink(f));
  return url.toString();
}

// The panels shown now, and the feature the address should name once they settle (a panel
// switching to another feature unmounts one and mounts the next: one address change, not two).
const shown = new Set<Linked>();
let want: string | null = null;
let swap = false;
let timer = 0;
function settle(go: (href: string, replace: boolean) => void) {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    const replace = swap;
    swap = false;
    const url = new URL(window.location.href);
    if (url.searchParams.get('feature') === want) return;
    if (want) url.searchParams.set('feature', want);
    else url.searchParams.delete('feature');
    go(`${url.pathname}${url.search}${url.hash}`, replace);
  }, 0);
}

/** True inside the panel a link opened (LinkedFeature's); a page's own panel then takes its place. */
export const InLinked = createContext(false);
const pageOpens = new Set<() => void>();
/** `run` whenever a page opens its own panel (not the link's); returns the unsubscribe. */
export function onPageOpen(run: () => void): () => void {
  pageOpens.add(run);
  return () => void pageOpens.delete(run);
}

/** A feature panel's address: written while it shows; Back (the address losing it) closes it. */
export function useFeatureUrl(f: Linked, onClose: () => void): void {
  const router = useRouter();
  const linked = useContext(InLinked);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  const { id, code, key } = f;
  const last = useRef<string | null>(null);
  useEffect(() => {
    const me = { id, code, key };
    const link = featureLink(me);
    const go = (href: string, replace: boolean) =>
      replace ? router.replace(href, { scroll: false }) : router.push(href, { scroll: false });
    // The same feature with a new code: its address follows, with no new Back step.
    if (last.current === id) swap = true;
    else if (!linked) pageOpens.forEach((run) => run());
    last.current = id;
    shown.add(me);
    want = link;
    settle(go);
    return () => {
      shown.delete(me);
      // Another panel showing the same feature (a page's own, opened over the link's) keeps it.
      if (want === link && ![...shown].some((s) => featureLink(s) === link)) want = null;
      settle(go);
    };
  }, [id, code, key, router, linked]);
  // Back or Forward to an address that names another feature, or none, closes it (never its own
  // code changing, nor a page's own address change: only the browser's history moves).
  useEffect(() => {
    const moved = () => {
      const v = new URL(window.location.href).searchParams.get('feature');
      if (!v || !namesFeature(v, { id, code, key })) close.current();
    };
    window.addEventListener('popstate', moved);
    return () => window.removeEventListener('popstate', moved);
  }, [id, code, key]);
}

/** Whether a panel shown now names ?feature=<value>. */
export const featureShown = (value: string): boolean =>
  [...shown].some((s) => namesFeature(value, s));

// Clicks that are not on empty space: anything that does something, or sits over the page.
const BUSY = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'label',
  'summary',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="menu"]',
  '[role="menuitem"]',
  '[role="listbox"]',
  '[role="option"]',
  '[role="dialog"]',
  '[role="tooltip"]',
  '[role="status"]',
  '[role="alert"]',
  '[data-testid="toasts"]',
  '[data-item]',
  '[data-bar-id]',
  '[draggable="true"]',
].join(', ');

/** #1747: a click in the page's empty space, outside the panel, closes it (`on`: a side panel). */
export function useOutsideClose(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  on: boolean,
): void {
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    if (!on) return;
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || !(e.target instanceof Element) || !e.target.isConnected) return;
      if (ref.current?.contains(e.target)) return;
      if (e.target.closest(BUSY)) return;
      close.current();
    };
    document.addEventListener('pointerdown', down);
    return () => document.removeEventListener('pointerdown', down);
  }, [ref, on]);
}
