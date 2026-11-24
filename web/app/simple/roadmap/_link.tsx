'use client';
// panel-ux (#1796, #1747): the feature panel's link and its outside click.
// - A shown panel writes ?feature=<code, else id> to the address; closing it takes it off; Back
//   closes it again, Forward opens it again. Loading the address opens the panel on any Simple
//   page (_panel.tsx's LinkedFeature, mounted by the Simple layout).
// - A side panel (one that dims nothing) closes on a click in the page's empty space; a click on
//   anything that does something (another feature, a button, a field) is left to it.

import { useEffect, useRef, type RefObject } from 'react';

import { useRouter, useSearchParams } from '@/lib/nav';

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
let timer = 0;
function settle(push: (href: string) => void) {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get('feature') === want) return;
    if (want) url.searchParams.set('feature', want);
    else url.searchParams.delete('feature');
    push(`${url.pathname}${url.search}${url.hash}`);
  }, 0);
}

/** A feature panel's address: written while it shows; Back (the address losing it) closes it. */
export function useFeatureUrl(f: Linked, onClose: () => void): void {
  const router = useRouter();
  const param = useSearchParams().get('feature');
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  const { id, code, key } = f;
  useEffect(() => {
    const me = { id, code, key };
    const link = featureLink(me);
    const push = (href: string) => router.push(href, { scroll: false });
    shown.add(me);
    want = link;
    settle(push);
    return () => {
      shown.delete(me);
      if (want === link) want = null;
      settle(push);
    };
  }, [id, code, key, router]);
  const named = useRef(false);
  useEffect(() => {
    if (param && namesFeature(param, { id, code, key })) named.current = true;
    else if (named.current) {
      named.current = false;
      close.current();
    }
  }, [param, id, code, key]);
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
