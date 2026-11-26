// build-shortcuts (#1795): the app's keys on the one key layer (palette/hotkeys.ts), the ? sheet
// and the rail's Keys line. j and k move one focused row (a blue bar and a light blue fill), Enter
// opens it in the one feature panel, Shift J and K move it as its drag grip's arrow keys do (a
// commenter's move becomes a proposal there), c adds, / finds, s switches Simple and Detailed,
// g then a letter goes to a page. Roles come through can() only. The rail's Keys line is ds/KeysLine.
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useAppKeys, useOpenKeys } from '@/components/palette/hotkeys';
import { useMe } from '@/lib/me';
import { usePathname, useRouter } from '@/lib/nav';

import { goKeys, sheetGroups, type Page } from './keys';
import { KeysSheet, type Changes } from './KeysSheet';
import { KeyTips, PhoneSteps } from './KeyTips';

/** List rows and timeline rows j and k move through (Simple's and Detailed's Priorities, the Roadmap timeline). */
const ROWS =
  '[data-keys-row], [data-testid=prio-row], [data-testid^="priority-row-"], [data-testid=timeline-row]';
const OPENER =
  '[data-keys-open], [data-testid=prio-title], [data-testid=timeline-row-label], a[href], button:not([aria-label^="Drag"]):not([aria-haspopup])';
const SEARCH =
  '[data-keys-search], input[type=search], input[placeholder^="Search"], input[placeholder^="Filter"]';
const ADD = '[data-keys-add], #quick-add-title';

const shown = (el: Element) => el.getClientRects().length > 0;
const first = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)].find(shown);

function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(ROWS)].filter(shown);
}

function focusRow(step: 1 | -1) {
  const list = rows();
  if (!list.length) return false;
  const at = list.findIndex((r) => r.hasAttribute('data-kfocus'));
  const n = at < 0 ? 0 : Math.max(0, Math.min(list.length - 1, at + step));
  list.forEach((r, i) =>
    i === n ? r.setAttribute('data-kfocus', '') : r.removeAttribute('data-kfocus'),
  );
  list[n].scrollIntoView({ block: 'nearest' });
  return true;
}

const focused = () => rows().find((r) => r.hasAttribute('data-kfocus'));

export function KeysHost({ pages, detailed }: { pages: Page[]; detailed: boolean }) {
  const { can } = useMe();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [g, setG] = useState(false);
  useOpenKeys(useCallback(() => setOpen(true), []));
  // A new page starts with no g waiting and no row focused.
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setG(false);
  }
  useEffect(() => {
    document.querySelectorAll('[data-kfocus]').forEach((r) => r.removeAttribute('data-kfocus'));
  }, [pathname]);

  const go = useMemo(() => goKeys(pages), [pages]);
  const changes: Changes = can('accept_simple_change')
    ? 'edits'
    : can('create_simple_change')
      ? 'suggests'
      : 'none';

  const step = (d: 1 | -1) => (e: KeyboardEvent) => {
    if (focusRow(d)) e.preventDefault();
  };
  const move = (key: 'ArrowDown' | 'ArrowUp') => (e: KeyboardEvent) => {
    const grip = focused()?.querySelector<HTMLElement>('[aria-label^="Drag"]');
    if (!grip) return;
    e.preventDefault();
    grip.focus();
    grip.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  };
  const map: Record<string, (e: KeyboardEvent) => void> = {
    '?': (e) => {
      e.preventDefault();
      setOpen((o) => !o);
    },
    g: () => setG(true),
    j: step(1),
    k: step(-1),
    ArrowDown: (e) => focused() && step(1)(e),
    ArrowUp: (e) => focused() && step(-1)(e),
    J: move('ArrowDown'),
    K: move('ArrowUp'),
    Enter: (e) => {
      const r = focused();
      const to = r?.querySelector<HTMLElement>(OPENER);
      // A focused link or button keeps its own Enter.
      const a = document.activeElement;
      if (!to || (a && a.matches('a[href], button, [role=button], summary, select'))) return;
      e.preventDefault();
      to.click();
    },
    '/': (e) => {
      const box = first(SEARCH);
      if (!box) return;
      e.preventDefault();
      box.focus();
    },
    c: (e) => {
      const box = first(ADD);
      if (!box) return;
      e.preventDefault();
      box.focus();
    },
    s: () => first(`[data-testid=mode-${detailed ? 'simple' : 'detailed'}]`)?.click(),
  };
  // While g waits, the next letter picks the page (any other key lets it go).
  const waiting: Record<string, (e: KeyboardEvent) => void> = Object.fromEntries(
    'abcdefghijklmnopqrstuvwxyz?/'.split('').map((l) => [
      l,
      (e: KeyboardEvent) => {
        setG(false);
        const to = go.find((x) => x.keys[1] === l);
        if (!to?.href) return;
        e.preventDefault();
        router.push(to.href);
      },
    ]),
  );
  useAppKeys(g ? waiting : map);

  return (
    <>
      <KeyTips go={go} />
      <PhoneSteps />
      {open && (
        <KeysSheet
          groups={sheetGroups(pathname, pages, detailed)}
          changes={changes}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
