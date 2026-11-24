// MOCK-HOOK: this whole file is a mock-up switch for issue #1795 (app-wide keyboard shortcuts),
// MOCK-HOOK: never merged. URL switches: ks1=a|b|c|d (key grammar and help sheet), ks2=a|b|c|d (teaching in
// MOCK-HOOK: place, row focus), ks3=a|b|c (typing, dialogs, phone); state: open=1 row=N hover=N tip=rail|row|close|grip
// MOCK-HOOK: g=1 q=... trail=g,r today=... nudge=1 bar=1 paused=1 swipe=1 long=1.
/* eslint-disable */
import { useEffect, useState, type ReactNode } from 'react';

import { usePathname, useRouter, useSearchParams } from '@/lib/nav';

type Key = { keys: string[]; label: string; then?: boolean; alt?: string[]; href?: string };
type Group = { name: string; keys: Key[]; open?: boolean };

const K = ({ children, on }: { children: ReactNode; on?: boolean }) => (
  <kbd
    className={`inline-flex min-w-[1.5rem] items-center justify-center rounded border px-1.5 font-mono text-sm leading-6 ${
      on ? 'border-accent bg-accent text-on-accent' : 'border-line-strong bg-surface2 text-text'
    }`}
  >
    {children}
  </kbd>
);

function Keys({ k, on }: { k: Key; on?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1">
      {k.keys.map((x, i) => (
        <span key={i} className="inline-flex items-center gap-1">
          {i > 0 && <span className="text-xs text-text-faint">{k.then ? 'then' : '+'}</span>}
          <K on={on}>{x}</K>
        </span>
      ))}
      {k.alt && <span className="text-xs text-text-faint">or</span>}
      {k.alt?.map((x) => <K key={x}>{x}</K>)}
    </span>
  );
}

/** The rail's pages as they are today (Simple or Detailed), read from the nav. */
function railPages(): { name: string; href: string }[] {
  const out: { name: string; href: string }[] = [];
  document.querySelectorAll('nav a[href]').forEach((a) => {
    const name = (a.textContent || '').replace(/\d+$/, '').trim();
    const href = a.getAttribute('href') || '';
    if (name && name !== 'Product Oracle' && href.startsWith('/') && !out.some((o) => o.href === href) && name.length < 24)
      out.push({ name, href });
  });
  return out.slice(0, 26);
}

function letters(pages: { name: string }[]) {
  const pref: Record<string, string> = {
    Home: 'h', 'One-pagers': 'o', Roadmap: 'r', 'Goal map': 'm', Priorities: 'p', Meetings: 'e', Decisions: 'd',
    Inbox: 'i', Requests: 'q', 'Ground Truth': 't', PRDs: 'f', Plan: 'l', Runs: 'u', Company: 'c', Settings: 's',
  };
  const used = new Set<string>(pages.map((p) => pref[p.name]).filter(Boolean));
  return pages.map((p) => {
    if (pref[p.name]) return pref[p.name];
    const ws = p.name.toLowerCase().replace(/[^a-z]/g, '');
    const l = ws.split('').find((c) => !used.has(c)) || '·';
    used.add(l);
    return l;
  });
}

function pageName(path: string) {
  const m: Record<string, string> = {
    '/simple/priorities': 'Priorities',
    '/priorities': 'Priorities',
    '/simple/roadmap': 'Roadmap',
    '/simple': 'Home',
  };
  return m[path] || 'This page';
}

function grammar(ks1: string, pages: { name: string; href: string }[], detailed: boolean) {
  const mod = ks1 === 'c';
  const page: Key[] = mod
    ? [
        { keys: ['Alt', '↓'], label: 'Next row' },
        { keys: ['Alt', '↑'], label: 'Previous row' },
        { keys: ['Alt', 'Enter'], label: 'Open the feature' },
        { keys: ['Alt', 'Shift', '↓'], label: 'Move the row down' },
        { keys: ['Alt', 'Shift', '↑'], label: 'Move the row up' },
      ]
    : [
        { keys: ['j'], label: 'Next row', alt: ['↓'] },
        { keys: ['k'], label: 'Previous row', alt: ['↑'] },
        { keys: ['Enter'], label: 'Open the feature' },
        { keys: ['Shift', 'J'], label: 'Move the row down' },
        { keys: ['Shift', 'K'], label: 'Move the row up' },
      ];
  const ls = letters(pages);
  const go: Key[] = pages.map((p, i) =>
    ks1 === 'b'
      ? { keys: ['g', ls[i]], label: p.name, then: true, href: p.href }
      : mod
        ? { keys: ['Ctrl', 'Alt', i < 9 ? String(i + 1) : '–'], label: p.name, href: p.href }
        : { keys: [i < 9 ? String(i + 1) : '–'], label: p.name, href: p.href },
  );
  const every: Key[] = [
    { keys: mod ? ['Ctrl', '/'] : ['?'], label: 'Show the keys' },
    { keys: mod ? ['Ctrl', 'F'] : ['/'], label: 'Search or filter' },
    { keys: ['Esc'], label: 'Close the top panel' },
    { keys: mod ? ['Alt', 'N'] : ['c'], label: 'Add on this page' },
    { keys: mod ? ['Alt', 'D'] : ['s'], label: detailed ? 'Switch to Simple' : 'Switch to Detailed' },
  ];
  const others: Group[] = [
    {
      name: 'Roadmap',
      keys: mod
        ? [
            { keys: ['Alt', '→'], label: 'Next item on the timeline' },
            { keys: ['Alt', 'N'], label: 'Add an item' },
          ]
        : [
            { keys: ['j'], label: 'Next item on the timeline' },
            { keys: ['c'], label: 'Add an item' },
            { keys: ['t'], label: 'Back to today' },
          ],
    },
    {
      name: 'Goal map',
      keys: [
        { keys: mod ? ['Ctrl', 'F'] : ['/'], label: 'Search the roadmap' },
        { keys: mod ? ['Alt', 'Enter'] : ['Enter'], label: 'Open the goal' },
      ],
    },
    { name: 'Decisions', keys: [{ keys: mod ? ['Alt', 'Enter'] : ['Enter'], label: 'Open the decision' }] },
    {
      name: 'Documents',
      keys: [
        { keys: mod ? ['Alt', ']'] : [']'], label: 'Next change' },
        { keys: mod ? ['Alt', '['] : ['['], label: 'Previous change' },
        { keys: mod ? ['Alt', 'C'] : ['c'], label: 'Comment' },
      ],
    },
  ];
  return { page, go, every, others };
}

function useTick() {
  const [, set] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => set((n) => n + 1), 400);
    return () => window.clearInterval(id);
  }, []);
}

function rectOf(el: Element | null | undefined) {
  return el ? el.getBoundingClientRect() : null;
}

export function KeysMock() {
  const pathname = usePathname();
  const router = useRouter();
  const goTo = (href: string) => router.push(href + window.location.search);
  const sp = useSearchParams();
  const p = (k: string) => sp.get(k) ?? '';
  const ks1 = p('ks1') || (p('ks2') || p('ks3') ? 'b' : '');
  const ks2 = p('ks2') || (ks1 || p('ks3') ? 'a' : '');
  const ks3 = p('ks3') || (ks1 || ks2 ? 'a' : '');
  const on = !!(ks1 || ks2 || ks3);
  const [open, setOpen] = useState(p('open') === '1');
  const [row, setRow] = useState<number>(p('row') ? Number(p('row')) : -1);
  const [pending, setPending] = useState(p('g') === '1');
  const [trail, setTrail] = useState<string[]>(p('trail') ? p('trail').split(',') : []);
  const [q, setQ] = useState(p('q'));
  const [sel, setSel] = useState(0);
  const [nudge, setNudge] = useState(p('nudge') === '1');
  const [typing, setTyping] = useState(false);
  const detailed = !pathname.startsWith('/simple');
  useTick();

  useEffect(() => {
    setOpen(p('open') === '1');
    setRow(p('row') ? Number(p('row')) : -1);
    setPending(p('g') === '1');
    setTrail(p('trail') ? p('trail').split(',') : []);
    setQ(p('q'));
    setNudge(p('nudge') === '1');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sp.toString()]);

  useEffect(() => {
    if (!on) return;
    document.documentElement.dataset.ks2 = ks2;
    if (p('long') === '1') {
      // MOCK-HOOK: the hard case's long names (invented), written over the first rows.
      const long = [
        'Setup checklist for teams that join from a partner workspace',
        'Alert rules engine with per-team quiet hours and escalation paths',
        'Weekly alert digest for managers across every connected workspace',
      ];
      document.querySelectorAll('[data-testid=prio-title]').forEach((t, i) => {
        if (long[i] && !t.textContent?.startsWith(long[i])) t.textContent = long[i];
      });
    }
  });

  const rows = typeof document === 'undefined' ? [] : [...document.querySelectorAll('[data-testid=prio-row]')];
  useEffect(() => {
    rows.forEach((r, i) => {
      if (i === row) r.setAttribute('data-kfocus', '1');
      else r.removeAttribute('data-kfocus');
    });
  });

  const pages = typeof document === 'undefined' ? [] : railPages();
  const g = grammar(ks1, pages, detailed);

  useEffect(() => {
    if (!on) return;
    const onFocus = () => {
      const a = document.activeElement as HTMLElement | null;
      setTyping(!!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable) && !a.closest('[data-keys-sheet]'));
    };
    document.addEventListener('focusin', onFocus);
    document.addEventListener('focusout', () => setTimeout(onFocus, 0));
    const onKey = (e: KeyboardEvent) => {
      if (!e.isTrusted) return;
      const a = document.activeElement as HTMLElement | null;
      const inField = !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
      const inDialog = !!a?.closest('[role=dialog],[role=alertdialog]') && !a?.closest('[data-keys-sheet]');
      const list = [...document.querySelectorAll('[data-testid=prio-row]')];
      if (ks3 === 'b' && inField && (e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        // KS3 b: Ctrl+Enter saves the field (as forms do today) and goes on to the next feature.
        const box = a!.closest('[data-testid=item-panel],[role=dialog]');
        const save = [...(box?.querySelectorAll('button') ?? [])].find((x) => /^(Save|Move|Propose|Send)/.test((x.textContent || '').trim()));
        if (!save) return;
        e.preventDefault();
        save.click();
        setTrail((t) => [...t, 'Ctrl', 'Enter'].slice(-8));
        if (box?.closest('[data-testid=item-panel]'))
          window.setTimeout(() => {
            const now = [...document.querySelectorAll('[data-testid=prio-row]')];
            const at = now.findIndex((x) => x.hasAttribute('data-kfocus'));
            const n = Math.min(now.length - 1, at + 1);
            setRow(n);
            (now[n]?.querySelector('[data-testid=prio-title]') as HTMLElement | null)?.click();
          }, 700);
        return;
      }
      const mod = ks1 === 'c';
      const nice: Record<string, string> = { ArrowDown: '↓', ArrowUp: '↑' };
      const push = (k: string) => setTrail((t) => [...t, (e.altKey ? 'Alt ' : '') + (nice[k] || k)].slice(-8));
      if (inField) return;
      if ((e.ctrlKey || e.metaKey) && !(ks1 === 'c' && (e.key === '/' || e.altKey))) return;
      if (open && document.activeElement?.closest('[data-keys-sheet]')) {
        if (e.key === 'Escape') setOpen(false);
        return;
      }
      if (inDialog && !(ks3 === 'c' && e.key === '?')) return;
      if ((ks1 === 'a' || ks1 === 'd') && /^[1-9]$/.test(e.key) && pages[Number(e.key) - 1]) {
        push(e.key);
        goTo(pages[Number(e.key) - 1].href);
        return;
      }
      if (mod && e.ctrlKey && e.altKey && /^[1-9]$/.test(e.key) && pages[Number(e.key) - 1]) {
        setTrail(['Ctrl', 'Alt', e.key]);
        goTo(pages[Number(e.key) - 1].href);
        return;
      }
      if (pending) {
        setPending(false);
        const i = letters(pages).indexOf(e.key);
        if (i >= 0) {
          push(e.key);
          goTo(pages[i].href);
        }
        return;
      }
      if ((!mod && e.key === '?') || (mod && e.ctrlKey && e.key === '/')) {
        e.preventDefault();
        if (mod) setTrail(['Ctrl', '/']);
        setOpen((o) => !o);
        return;
      }
      if (ks1 === 'b' && e.key === 'g') {
        push('g');
        setPending(true);
        return;
      }
      const next = mod ? !e.shiftKey && e.altKey && e.key === 'ArrowDown' : e.key === 'j' || e.key === 'ArrowDown';
      const prev = mod ? !e.shiftKey && e.altKey && e.key === 'ArrowUp' : e.key === 'k' || e.key === 'ArrowUp';
      if (next || prev) {
        if (!list.length) return;
        e.preventDefault();
        push(e.key);
        setNudge((n) => n);
        setRow((r) => {
          const n = Math.max(0, Math.min(list.length - 1, r < 0 ? 0 : r + (next ? 1 : -1)));
          list[n]?.scrollIntoView({ block: 'nearest' });
          return n;
        });
        return;
      }
      if (e.shiftKey && (mod ? e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp') : e.key === 'J' || e.key === 'K')) {
        const r = list.find((x) => x.hasAttribute('data-kfocus'));
        const grip = r?.querySelector('[aria-label^="Drag"]') as HTMLElement | null;
        if (!grip) return;
        e.preventDefault();
        setTrail((t) => [...t, 'Shift', mod ? (e.key === 'ArrowDown' ? '↓' : '↑') : e.key].slice(-8));
        const down = e.key === 'J' || e.key === 'ArrowDown';
        grip.focus();
        grip.dispatchEvent(new KeyboardEvent('keydown', { key: down ? 'ArrowDown' : 'ArrowUp', bubbles: true }));
        return;
      }
      if (e.key === 'Enter' && (!mod || e.altKey)) {
        const r = list.find((x) => x.hasAttribute('data-kfocus'));
        if (r) {
          push('Enter');
          (r.querySelector('[data-testid=prio-title]') as HTMLElement | null)?.click();
        }
      }
    };
    // KS3 a and c: Esc in a field leaves the field first; the panel stays (today it closes the panel).
    const onEsc = (e: KeyboardEvent) => {
      const a = document.activeElement as HTMLElement | null;
      if (e.key !== 'Escape' || ks3 === 'b' || !a || !(a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) return;
      if (!a.closest('[data-testid=item-panel]')) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      a.blur();
      setTrail((t) => [...t, 'Esc'].slice(-8));
    };
    window.addEventListener('keydown', onEsc, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onEsc, true);
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', onFocus);
    };
  }, [on, ks1, ks3, open, pending, pages]);

  if (!on) return null;
  const phone = typeof window !== 'undefined' && window.innerWidth <= 600;
  const here = pageName(pathname);
  const today = p('today');
  const tip = p('tip');
  const hover = p('hover') ? Number(p('hover')) : -1;

  const navLink = (name: string) =>
    [...document.querySelectorAll('nav a[href]')].find((a) => (a.textContent || '').trim().startsWith(name)) || null;
  const goKey = (name: string) => {
    const i = pages.findIndex((x) => x.name === name);
    return i >= 0 ? g.go[i] : null;
  };

  // ---------- the tooltip with its key (KS2 a, and the rail tip every proposal of KS1 shares)
  let tipEl: ReactNode = null;
  const tipAt = (r: DOMRect | null, label: string, k: Key | null, side: 'right' | 'below' | 'left' = 'right') => {
    if (!r) return null;
    const style =
      side === 'right'
        ? { left: r.right + 8, top: r.top + r.height / 2 - 16 }
        : side === 'left'
          ? { right: window.innerWidth - r.left + 8, top: r.top + r.height / 2 - 16 }
          : { left: r.left, top: r.bottom + 6 };
    return (
      <div
        role="tooltip"
        className="pointer-events-none fixed z-[70] flex items-center gap-2 rounded-lg bg-tip px-2.5 py-1 text-sm text-tip-text shadow-tip"
        style={style}
      >
        <span>{label}</span>
        {k && <Keys k={k} />}
      </div>
    );
  };
  if (!phone && (ks2 === 'a' || p('tip'))) {
    if (tip === 'rail') {
      tipEl = tipAt(rectOf(navLink('Roadmap')), 'Roadmap', goKey('Roadmap'));
    } else if (tip === 'row' && rows[hover]) {
      tipEl = tipAt(rectOf(rows[hover].querySelector('[data-testid=prio-title]')), 'Open', { keys: ['Enter'], label: '' }, 'below');
    } else if (tip === 'close') {
      tipEl = tipAt(rectOf(document.querySelector('[data-testid=item-panel] button[aria-label=Close]')), 'Close', { keys: ['Esc'], label: '' }, 'left');
    } else if (tip === 'grip' && rows[hover]) {
      tipEl = tipAt(rectOf(rows[hover].querySelector('button, [draggable]')), 'Suggest a move', { keys: ['Shift', 'J'], label: '', alt: ['Shift K'] }, 'below');
    }
  }

  // ---------- KS2 b: key chips on the hovered row
  let chips: ReactNode = null;
  if (ks2 === 'b' && !phone && rows[hover]) {
    const r = rows[hover].getBoundingClientRect();
    chips = (
      <div className="pointer-events-none fixed z-[60] flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1 shadow-tip" style={{ right: window.innerWidth - r.right + 44, top: r.top + r.height / 2 - 16 }}>
        <K>Enter</K>
        <span className="text-sm text-text2">open</span>
        <K>Shift J</K>
        <K>Shift K</K>
        <span className="text-sm text-text2">move</span>
      </div>
    );
  }

  // ---------- KS2 c: the first-use nudge
  const nudgeEl =
    ks2 === 'c' && nudge && !phone ? (
      <div data-testid="keys-nudge" className="fixed right-6 bottom-6 z-[60] w-[300px] rounded-xl border border-line bg-surface p-3 shadow-tip">
        <div className="flex items-center gap-2">
          <span aria-hidden className="text-accent">⌨</span>
          <span className="font-semibold text-text">Try the keys</span>
        </div>
        <div className="mt-2 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 text-sm text-text2">
          <span className="inline-flex gap-1"><K on={trail.includes('j')}>j</K><K>k</K></span><span>Next, previous row</span>
          <K>Enter</K><span>Open</span>
          <K>?</K><span>All keys</span>
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" className="rounded-button px-2.5 py-1 text-sm text-text2 hover:bg-surface2" onClick={() => setNudge(false)}>Not now</button>
          <button type="button" className="rounded-button bg-accent px-2.5 py-1 text-sm font-semibold text-on-accent" onClick={() => setNudge(false)}>Got it</button>
        </div>
      </div>
    ) : null;

  // ---------- KS2 d: the key bar at the bottom
  const panelOpen = !!document.querySelector('[data-testid=item-panel]');
  const barKeys: Key[] = panelOpen
    ? [
        { keys: ['Esc'], label: 'Close' },
        { keys: ['j'], label: 'Next feature' },
        { keys: ['k'], label: 'Previous' },
        { keys: ['?'], label: 'All keys' },
      ]
    : [
        { keys: ['j'], label: 'Next' },
        { keys: ['k'], label: 'Previous' },
        { keys: ['Enter'], label: 'Open' },
        { keys: ['Shift', 'J'], label: 'Move down' },
        { keys: ['g', 'r'], label: 'Roadmap', then: true },
        { keys: ['?'], label: 'All keys' },
      ];
  const bar =
    ks2 === 'd' && !phone ? (
      <div data-testid="keys-bar" className="fixed right-0 bottom-0 left-[232px] z-[45] flex items-center gap-5 border-t border-line bg-surface px-6 py-2 text-sm text-text2">
        {barKeys.map((k) => (
          <span key={k.label} className="inline-flex items-center gap-1.5">
            <Keys k={k} on={trail.length > 0 && k.keys[0] === trail[trail.length - 1]} />
            {k.label}
          </span>
        ))}
        <button type="button" aria-label="Hide the keys" className="ml-auto text-text-faint">✕</button>
      </div>
    ) : null;

  // ---------- KS3: typing, dialogs, phone
  let typingEl: ReactNode = null;
  const field = document.activeElement as HTMLElement | null;
  if (ks3 === 'c' && (typing || p('paused') === '1') && field) {
    const r = field.getBoundingClientRect();
    typingEl = (
      <div role="status" className="pointer-events-none fixed z-[70] inline-flex items-center gap-1.5 rounded-full border border-line bg-surface2 px-2 py-0.5 text-xs text-text2" style={{ right: window.innerWidth - r.right + 18, top: r.bottom - 28 }}>
        <span aria-hidden>⌨</span>Keys off while typing
      </div>
    );
  }
  let phoneEl: ReactNode = null;
  const panel = document.querySelector('[data-testid=item-panel]');
  const close = [...document.querySelectorAll('button[aria-label=Close]')].find((x) => x.getBoundingClientRect().width > 0);
  if (phone && panel && close && ks3 !== 'b') {
    const r = close.getBoundingClientRect();
    if (ks3 === 'a') {
      phoneEl = (
        <div className="fixed z-[70] flex items-center gap-1" style={{ right: window.innerWidth - r.left + 40, top: r.top + r.height / 2 - 18 }}>
          <button type="button" aria-label="Previous feature" className="grid size-9 place-items-center rounded-button border border-line bg-surface text-lg text-text">‹</button>
          <button type="button" aria-label="Next feature" className="grid size-9 place-items-center rounded-button border border-line bg-surface text-lg text-text">›</button>
        </div>
      );
    } else if (ks3 === 'c' && p('swipe') === '1') {
      phoneEl = (
        <div className="pointer-events-none fixed inset-x-0 z-[70] flex items-center justify-center" style={{ top: r.top + 230 }}>
          <div className="flex items-center gap-2 rounded-full bg-tip px-3 py-1.5 text-sm text-tip-text shadow-tip">
            <span aria-hidden>←</span> Next feature <span aria-hidden>→</span>
          </div>
        </div>
      );
    }
  }

  // ---------- KS1: the help sheet
  const match = (k: Key) => !q || k.label.toLowerCase().includes(q.toLowerCase()) || k.keys.join(' ').includes(q);
  const groups: Group[] = [
    { name: `This page · ${here}`, keys: g.page, open: true },
    { name: 'Go to', keys: g.go, open: true },
    { name: 'Everywhere', keys: g.every, open: true },
    ...g.others.map((o) => ({ ...o, open: ks1 === 'c' || !!q })),
  ];
  const Row = ({ k, active }: { k: Key; active?: boolean }) => (
    <li className={`flex items-center justify-between gap-3 rounded-lg px-2 py-1 ${active ? 'bg-accent-soft' : ''}`}>
      <span className="text-text">{k.label}</span>
      <Keys k={k} />
    </li>
  );
  const dialogKeys: Key[] = [
    { keys: ['Enter'], label: 'Confirm' },
    { keys: ['Esc'], label: 'Cancel' },
    { keys: ['Tab'], label: 'Next button' },
  ];
  const inDialogNow = !!document.querySelector('[role=alertdialog],[role=dialog]:not([data-keys-sheet])');
  let sheet: ReactNode = null;
  if (open && !phone) {
    if (ks3 === 'c' && inDialogNow) {
      sheet = (
        <div data-keys-sheet role="dialog" aria-label="Keys" className="fixed top-1/2 left-1/2 z-[80] w-[360px] -translate-x-1/2 translate-y-[120px] rounded-xl border border-line bg-surface p-4 shadow-tip">
          <h2 className="mb-2 font-semibold text-text">Keys · this box</h2>
          <ul className="text-sm">{dialogKeys.map((k) => <Row key={k.label} k={k} />)}</ul>
        </div>
      );
    } else if (ks1 === 'a') {
      sheet = (
        <div className="fixed inset-0 z-[80] grid place-items-center bg-black/30">
          <div data-keys-sheet role="dialog" aria-label="Keys" className="w-[620px] rounded-xl border border-line bg-surface p-5 shadow-tip">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-text">Keys</h2>
              <button type="button" aria-label="Close" className="text-text2">✕</button>
            </div>
            <div className="grid grid-cols-2 gap-6 text-sm">
              <section>
                <h3 className="mb-1 font-semibold text-text2">{groups[0].name}</h3>
                <ul>{g.page.map((k) => <Row key={k.label} k={k} />)}</ul>
                <h3 className="mt-3 mb-1 font-semibold text-text2">Everywhere</h3>
                <ul>{g.every.map((k) => <Row key={k.label} k={k} />)}</ul>
              </section>
              <section>
                <h3 className="mb-1 font-semibold text-text2">Go to</h3>
                <ul>{g.go.map((k) => <Row key={k.label} k={k} />)}</ul>
              </section>
            </div>
          </div>
        </div>
      );
    } else if (ks1 === 'b') {
      sheet = (
        <div data-keys-sheet role="dialog" aria-label="Keys" className="fixed top-3 right-3 bottom-3 z-[80] flex w-[400px] flex-col rounded-xl border border-line bg-surface shadow-tip">
          <div className="flex items-center justify-between px-4 pt-4">
            <h2 className="text-lg font-semibold text-text">Keys</h2>
            <button type="button" aria-label="Close" className="text-text2" onClick={() => setOpen(false)}>✕</button>
          </div>
          <div className="px-4 pt-3">
            <input autoFocus aria-label="Find a key" placeholder="Find a key" value={q} onChange={(e) => setQ(e.target.value)} className="w-full rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 text-base text-text" />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-4 text-sm">
            {groups.map((gr) => {
              const ks = gr.keys.filter(match);
              if (!ks.length) return null;
              return (
                <section key={gr.name} className="mt-2">
                  <h3 className="flex items-center justify-between px-2 py-1 font-semibold text-text2">
                    <span>{gr.name}</span>
                    {!gr.open && <span className="text-text-faint">{ks.length} ›</span>}
                  </h3>
                  {gr.open && <ul>{ks.map((k) => <Row key={gr.name + k.label} k={k} />)}</ul>}
                </section>
              );
            })}
          </div>
        </div>
      );
    } else if (ks1 === 'c') {
      sheet = (
        <div className="fixed inset-0 z-[80] grid place-items-center bg-black/30">
          <div data-keys-sheet role="dialog" aria-label="Keys" className="max-h-[86vh] w-[960px] overflow-y-auto rounded-xl border border-line bg-surface p-5 shadow-tip">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-text">Keys</h2>
              <button type="button" aria-label="Close" className="text-text2">✕</button>
            </div>
            <div className="columns-3 gap-6 text-sm">
              {groups.map((gr) => (
                <section key={gr.name} className="mb-4 break-inside-avoid">
                  <h3 className="mb-1 font-semibold text-text2">{gr.name}</h3>
                  <ul>{gr.keys.map((k) => <Row key={gr.name + k.label} k={k} />)}</ul>
                </section>
              ))}
            </div>
          </div>
        </div>
      );
    } else {
      const all = groups.flatMap((gr) => gr.keys.map((k) => ({ ...k, label: gr.name === 'Go to' ? `Go to ${k.label}` : k.label, group: gr.name })));
      const seen = new Set<string>();
      const hits = all.filter((k) => match(k) && !seen.has(k.label) && seen.add(k.label)).slice(0, 12);
      sheet = (
        <div className="fixed inset-0 z-[80] bg-black/30">
          <div data-keys-sheet role="dialog" aria-label="Keys" className="mx-auto mt-[12vh] w-[640px] rounded-xl border border-line bg-surface shadow-tip">
            <input autoFocus aria-label="Find a key or an action" placeholder="Find a key or an action" value={q} onChange={(e) => { setQ(e.target.value); setSel(0); }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') setSel((x) => Math.min(hits.length - 1, x + 1));
                if (e.key === 'ArrowUp') setSel((x) => Math.max(0, x - 1));
                if (e.key === 'Enter' && hits[sel]) {
                  e.nativeEvent.stopPropagation();
                  setTrail(['?', ...q.split(''), 'Enter']);
                  setOpen(false);
                  if (hits[sel].href) goTo(hits[sel].href!);
                }
              }} className="w-full rounded-t-xl border-b border-line bg-surface px-4 py-3 text-lg text-text outline-none" />
            <ul className="max-h-[56vh] overflow-y-auto p-2 text-base">
              {hits.map((k, i) => (
                <li key={k.label} className={`flex items-center justify-between gap-3 rounded-lg px-3 py-2 ${i === sel ? 'bg-accent-soft' : ''}`} onMouseEnter={() => setSel(i)}>
                  <span className="text-text">{k.label}<span className="ml-2 text-sm text-text-faint">{k.group.replace('This page · ', '')}</span></span>
                  <Keys k={k} />
                </li>
              ))}
            </ul>
          </div>
        </div>
      );
    }
  }

  // ---------- KS1 b: the waiting "g"
  const pendingEl =
    pending && ks1 === 'b' && !phone ? (
      <div className="fixed bottom-6 left-[256px] z-[80] w-[260px] rounded-xl border border-line bg-surface p-3 shadow-tip">
        <div className="mb-2 flex items-center gap-2 text-sm text-text2"><K on>g</K><span>then</span></div>
        <ul className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
          {g.go.slice(0, 10).map((k) => (
            <li key={k.label} className="flex items-center gap-1.5"><K>{k.keys[1]}</K><span className="truncate text-text">{k.label}</span></li>
          ))}
        </ul>
      </div>
    ) : null;

  // ---------- the rail's way in to the sheet (every KS1 proposal)
  const ask = [...document.querySelectorAll('nav a, nav button')].find((a) => (a.textContent || '').trim() === 'Ask Oracle');
  const ar = rectOf(ask);
  const railKey =
    ks1 && ar && !phone && ks2 !== 'd' ? (
      <button type="button" onClick={() => setOpen(true)} className="fixed z-[46] flex items-center gap-2 rounded-button px-3 py-1 text-sm text-text2 hover:bg-surface2" style={{ left: ar.left, top: ar.top - 40, width: ar.width }}>
        <span aria-hidden>⌨</span>
        <span>Keys</span>
        <span className="ml-auto"><K>{ks1 === 'c' ? 'Ctrl /' : '?'}</K></span>
      </button>
    ) : null;

  // ---------- the cost strip (a mock-up note, not product UI)
  const cost =
    trail.length > 0 || today ? (
      <div data-mock-note className="fixed bottom-3 left-1/2 z-[90] flex -translate-x-1/2 items-center gap-2 rounded-full border-2 border-dashed border-accent bg-surface px-3 py-1 text-sm text-text shadow-tip">
        <span className="font-semibold">Cost</span>
        {trail.map((t, i) => <K key={i} on>{t}</K>)}
        <span>{trail.length} {trail.length === 1 ? 'key' : 'keys'}</span>
        {today && <span className="text-text2">· today: {today}</span>}
      </div>
    ) : null;

  return (
    <>
      {railKey}
      {tipEl}
      {chips}
      {nudgeEl}
      {bar}
      {typingEl}
      {phoneEl}
      {pendingEl}
      {sheet}
      {cost}
    </>
  );
}
