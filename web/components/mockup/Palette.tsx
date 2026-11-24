// MOCK-HOOK: whole file. mk-palette mock-ups (#1794): the ⌘K palette's proposals, switched by the
// URL: ?cp1=a|b|c (how it opens and looks), ?cp2=a|b|c (what it finds and does), ?cp3=a|b|c (the
// entry without a keyboard), &many=1 (many long names), &cost=1 (the cost note). Never merged.
'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Icon } from '@/components/ds/Icon';
import { askWith } from '@/components/hop/open-state';
import { usePhone } from '@/components/simple/PrdTimeline';
import { FeaturePanel, type PanelFeature } from '@/app/simple/roadmap/_panel';
import { api, unwrap } from '@/lib/api/client';
import {
  PALETTE_MANY,
  PALETTE_RECENT,
  PALETTE_SEED,
  type PaletteKind,
} from '@/lib/api/mock/palette';
import { useCanStartPrd } from '@/components/simple/NewPrd';
import { useMe } from '@/lib/me';
import { usePathname, useRouter } from '@/lib/nav';
import { useQuery } from '@/lib/use-query';

type Hit = {
  key: string;
  kind: PaletteKind | 'Action' | 'Page';
  code?: string;
  name: string;
  where: string;
  href?: string;
  feature?: PanelFeature;
  run?: () => void;
};

const KEYS = ['cp1', 'cp2', 'cp3', 'many', 'cost'] as const;
/** The switches stay for the tab (sessionStorage), so moving to another page keeps the proposal. */
function sw(k: (typeof KEYS)[number]): string {
  if (typeof window === 'undefined') return '';
  const v = new URLSearchParams(window.location.search).get(k);
  if (v !== null) sessionStorage.setItem(`mk-${k}`, v);
  return v ?? sessionStorage.getItem(`mk-${k}`) ?? '';
}
export function usePaletteSwitches() {
  const pathname = usePathname();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(
    () => ({
      cp1: sw('cp1') || 'a',
      cp2: sw('cp2') || 'b',
      cp3: sw('cp3') || 'a',
      many: sw('many') === '1',
      cost: sw('cost'),
    }),
    [pathname],
  );
}

export const openPalette = () => window.dispatchEvent(new Event('mk-palette-open'));

const PAGES: { name: string; href: string; detailed: string }[] = [
  { name: 'Home', href: '/simple', detailed: '/home' },
  { name: 'Roadmap', href: '/simple/roadmap', detailed: '/plan' },
  { name: 'Goal map', href: '/simple/goals', detailed: '/plan/outcomes' },
  { name: 'Priorities', href: '/simple/priorities', detailed: '/priorities' },
  { name: 'Decisions', href: '/simple/decisions', detailed: '/inbox' },
  { name: 'Inbox', href: '/simple/inbox', detailed: '/inbox' },
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9$ ]/g, '');
function matches(h: Hit, q: string): boolean {
  const n = norm(q).trim();
  if (!n) return true;
  const code = (h.code ?? '').toLowerCase().replace('-', '');
  const qc = n.replace(/ /g, '');
  if (code && (code === qc || code === `f${qc}` || code.startsWith(qc))) return true;
  const hay = norm(`${h.code ?? ''} ${h.name} ${h.kind}`);
  return n.split(/\s+/).every((w) => hay.includes(w));
}

/** Fill the roadmap's "Add an item" title box once it shows (the New item action's result). */
function fillAddItem(title: string, tries = 40, add = false) {
  const el = document.querySelector<HTMLInputElement>('input[placeholder^="Type a title"]');
  if (!el) {
    if (tries > 0) setTimeout(() => fillAddItem(title, tries - 1, add), 150);
    return;
  }
  // CP2 b: the roadmap and track used last (the mock: the first of each), then the item is added at once.
  const pick = (sel: string) => {
    const box = document.querySelector<HTMLSelectElement>(sel);
    if (!box || box.value || box.options.length < 2) return;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(
      box,
      box.options[1].value,
    );
    box.dispatchEvent(new Event('change', { bubbles: true }));
  };
  if (add) pick('[data-testid="quick-add-roadmap"]');
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  set.call(el, title);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.focus();
  el.scrollIntoView({ block: 'center' });
  if (!add) return;
  setTimeout(() => {
    pick('[data-testid="quick-add-track"]');
    setTimeout(() => {
      const t = document.querySelector<HTMLInputElement>('input[placeholder^="Type a title"]');
      t?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      setTimeout(() => {
        const row = [...document.querySelectorAll<HTMLElement>('main *')].find(
          (n) => n.childElementCount === 0 && n.textContent?.trim() === title,
        );
        row?.scrollIntoView({ block: 'center' });
        const card = row?.closest<HTMLElement>('[class*="rounded"]');
        if (card) card.style.outline = '3px solid var(--accent)';
      }, 900);
    }, 300);
  }, 300);
}
/** After going to a goal's or key result's page, pick it out there. */
function pickOut(name: string, href: string, tries = 40) {
  const here = window.location.pathname === href;
  const el = !here
    ? undefined
    : [...document.querySelectorAll<HTMLElement>('main *')].find(
        (n) => n.childElementCount === 0 && n.textContent?.trim() === name,
      );
  if (!el) {
    if (tries > 0) setTimeout(() => pickOut(name, href, tries - 1), 150);
    return;
  }
  const card = el.closest<HTMLElement>('[class*="rounded"]') ?? el;
  card.style.outline = '3px solid var(--accent)';
  card.style.outlineOffset = '2px';
  card.scrollIntoView({ block: 'center' });
}
function clickNewPrd(tries = 40) {
  const b = [...document.querySelectorAll<HTMLButtonElement>('main button')].find(
    (x) => x.textContent?.trim() === 'New PRD',
  );
  if (!b) {
    if (tries > 0) setTimeout(() => clickNewPrd(tries - 1), 150);
    return;
  }
  b.click();
}

const kbd = 'rounded border border-line bg-bg px-1.5 font-mono text-xs text-text-faint';

export function CommandPalette() {
  const { me } = useMe();
  return me ? <PaletteInner /> : null;
}

function PaletteInner() {
  const s = usePaletteSwitches();
  const { me, can } = useMe();
  const router = useRouter();
  const pathname = usePathname();
  const phone = usePhone();
  const simple = pathname.startsWith('/simple');
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [sub, setSub] = useState<Hit | null>(null);
  const [panel, setPanel] = useState<PanelFeature | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const roadmap = useQuery('simple-roadmap:{}', () => unwrap(api.GET('/v1/simple/roadmap', {})));

  const proposes = can('create_simple_change');
  const decides = can('accept_simple_change');
  const startsPrd = useCanStartPrd();
  const close = useCallback(() => {
    setOpen(false);
    setQ('');
    setSel(0);
    setSub(null);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('mk-palette-open', onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mk-palette-open', onOpen);
    };
  }, []);
  useEffect(() => {
    if (open) setTimeout(() => input.current?.focus(), 0);
    document.documentElement.toggleAttribute('data-mk-open', open);
  }, [open]);

  const features: Hit[] = useMemo(() => {
    const items = (roadmap.data?.items ?? []) as unknown as Record<string, unknown>[];
    const out: Hit[] = items
      .filter((i) => typeof i.title === 'string' && i.code)
      .map((i) => {
        const prd = i.prd as { id: string; slug: string; title?: string } | null | undefined;
        const track = (i.track_name ??
          (i.track as { name?: string } | undefined)?.name ??
          '') as string;
        const status = (i.status_label ?? i.status ?? '') as string;
        return {
          key: `f-${i.id}`,
          kind: 'Feature' as const,
          code: String(i.code),
          name: String(i.title),
          where: [
            track || prd?.title || 'Roadmap',
            typeof status === 'string' && status
              ? status[0].toUpperCase() + status.slice(1).replace(/_/g, ' ')
              : '',
          ]
            .filter(Boolean)
            .join(' · '),
          feature: {
            id: String(i.id),
            code: String(i.code),
            name: String(i.title),
            prd: prd ?? null,
          },
        };
      });
    const extra = s.many
      ? PALETTE_MANY.map((m) => ({
          ...m,
          key: `m-${m.code}`,
          feature: { code: m.code!, name: m.name },
        }))
      : [];
    return [...out, ...extra];
  }, [roadmap.data, s.many]);

  const seeds: Hit[] = PALETTE_SEED.map((p) => ({ ...p, key: `s-${p.kind}-${p.name}` }));
  const pages: Hit[] = PAGES.map((p) => ({
    key: `p-${p.name}`,
    kind: 'Page',
    name: p.name,
    where: simple ? 'Simple' : 'Detailed',
    href: simple ? p.href : p.detailed,
  }));
  const title = q.replace(/^new( item)?:?\s*/i, '').trim();
  const typedNew = /^new\b/i.test(q.trim());
  const actions: Hit[] =
    s.cp2 === 'b'
      ? [
          ...(proposes
            ? [
                {
                  key: 'a-item',
                  kind: 'Action' as const,
                  name:
                    typedNew && title
                      ? `${decides ? 'New item' : 'Propose a new item'}: ${title}`
                      : decides
                        ? 'New item'
                        : 'Propose a new item',
                  where: decides
                    ? 'Roadmap · last track used'
                    : 'Roadmap · an approver decides',
                  run: () => {
                    router.push('/simple/roadmap');
                    fillAddItem(title, 40, decides && !!title);
                  },
                },
              ]
            : []),
          ...(startsPrd
            ? [
                {
                  key: 'a-prd',
                  kind: 'Action' as const,
                  name: 'New PRD',
                  where: 'Home',
                  run: () => {
                    router.push('/simple');
                    clickNewPrd();
                  },
                },
              ]
            : []),
          {
            key: 'a-ask',
            kind: 'Action' as const,
            name: q.trim() && !typedNew ? `Ask Oracle: ${q.trim()}` : 'Ask Oracle',
            where: 'Opens beside the page',
            run: () => askWith(typedNew ? '' : q.trim()),
          },
        ]
      : [];

  const all = [...features, ...seeds];
  const recent = PALETTE_RECENT.map((n) => all.find((h) => h.name === n)).filter(Boolean) as Hit[];
  const found = q.trim() ? all.filter((h) => matches(h, q)) : [];
  const cap = s.cp1 === 'c' ? 8 : 5;
  const groups: { label: string; hits: Hit[]; more: number }[] = [];
  if (!q.trim()) {
    if (s.cp2 !== 'c') groups.push({ label: 'Recent', hits: recent, more: 0 });
    if (s.cp2 === 'b') groups.push({ label: 'Do', hits: actions, more: 0 });
    groups.push({ label: 'Go to', hits: pages.slice(0, s.cp2 === 'c' ? 6 : 4), more: 0 });
  } else if (typedNew && s.cp2 === 'b') {
    groups.push({ label: 'Do', hits: actions.filter((a) => a.key !== 'a-ask'), more: 0 });
  } else {
    const kinds: Hit['kind'][] = ['Feature', 'PRD', 'Goal', 'Key result', 'Milestone'];
    for (const k of kinds) {
      const hits = found.filter((h) => h.kind === k);
      if (hits.length)
        groups.push({
          label: k === 'Feature' ? 'Features' : k === 'Key result' ? 'Key results' : `${k}s`,
          hits: hits.slice(0, cap),
          more: Math.max(0, hits.length - cap),
        });
    }
    const pg = pages.filter((p) => matches(p, q));
    if (pg.length) groups.push({ label: 'Go to', hits: pg, more: 0 });
    if (s.cp2 === 'b') groups.push({ label: 'Do', hits: actions, more: 0 });
  }
  const flat = sub ? subActions(sub) : groups.flatMap((g) => g.hits);
  const none = !!q.trim() && found.length === 0 && !typedNew;
  const roleLine = !proposes
    ? 'As a viewer you can find and open anything; you cannot add or change.'
    : !decides
      ? 'As a commenter you can open any panel and propose changes there.'
      : '';

  function subActions(h: Hit): Hit[] {
    return [
      {
        key: 'x-open',
        kind: 'Action',
        name: 'Open its panel',
        where: 'Here, over this page',
        run: () => setPanel(h.feature!),
      },
      {
        key: 'x-road',
        kind: 'Action',
        name: 'Show it on the Roadmap',
        where: 'Roadmap',
        run: () => {
          router.push('/simple/roadmap');
          setPanel(h.feature!);
        },
      },
      {
        key: 'x-ask',
        kind: 'Action',
        name: `Ask Oracle about ${h.code} ${h.name}`,
        where: 'Opens beside the page',
        run: () => askWith(`Tell me about ${h.code} ${h.name}`),
      },
    ];
  }

  function go(h: Hit | undefined) {
    if (!h) return;
    close();
    if (h.run) return h.run();
    if (h.feature) {
      if (s.cp2 === 'c') router.push(simple ? '/simple/roadmap' : '/plan');
      setPanel(h.feature);
      return;
    }
    if (h.href) {
      router.push(h.href);
      if (h.kind === 'Goal' || h.kind === 'Key result') pickOut(h.name, h.href);
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (sub) setSub(null);
      else close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((i) => Math.min(flat.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (none && s.cp2 !== 'a') {
        close();
        if (proposes && s.cp2 === 'b') {
          router.push('/simple/roadmap');
          fillAddItem(q.trim());
        } else askWith(q.trim());
        return;
      }
      go(flat[sel]);
    } else if (
      (e.key === 'Tab' || e.key === 'ArrowRight') &&
      s.cp2 === 'b' &&
      !sub &&
      flat[sel]?.feature
    ) {
      e.preventDefault();
      setSub(flat[sel]);
      setSel(0);
    }
  };

  const look = s.cp1;
  const row = (h: Hit, i: number) => {
    const on = i === sel;
    const two = look === 'c';
    return (
      <li key={h.key} role="option" aria-selected={on} id={`mk-opt-${i}`}>
        <button
          type="button"
          tabIndex={-1}
          onMouseEnter={() => setSel(i)}
          onClick={() => (sub ? go(h) : go(h))}
          className={`flex w-full items-center gap-3 rounded-lg px-3 text-left ${two ? 'py-2' : 'py-2'} ${on ? 'bg-accent-soft' : 'hover:bg-bg'}`}
        >
          <span className="flex size-7 flex-none items-center justify-center rounded-md border border-line bg-surface text-text-faint">
            <Icon
              size={16}
              name={
                h.kind === 'Feature'
                  ? 'roadmap'
                  : h.kind === 'PRD'
                    ? 'doc'
                    : h.kind === 'Goal' || h.kind === 'Key result'
                      ? 'target'
                      : h.kind === 'Milestone'
                        ? 'clock'
                        : h.kind === 'Action'
                          ? h.key.includes('ask')
                            ? 'ask'
                            : 'more'
                          : 'link'
              }
            />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-baseline gap-2">
              {h.code && (
                <span className="flex-none font-mono text-sm text-text-faint">{h.code}</span>
              )}
              <span
                className={`min-w-0 text-base text-text ${two ? 'line-clamp-2 [text-wrap:pretty]' : 'truncate'} ${on ? 'font-semibold' : 'font-medium'}`}
              >
                {h.name}
              </span>
            </span>
            {two && (
              <span className="flex items-start gap-2 text-sm text-text-faint">
                {/* MOCK-HOOK: each part between dots stays whole, so no single word sits alone on the next line */}
                <span className="min-w-0 flex-1 break-words [text-wrap:pretty]">
                  {[h.kind, ...h.where.split(' · ')].map((part, i) => (
                    <Fragment key={i}>
                      {i > 0 && ' · '}
                      <span className="whitespace-nowrap">{part}</span>
                    </Fragment>
                  ))}
                </span>
                {on && !phone && h.feature && s.cp2 === 'b' && !sub && (
                  <span className={kbd}>Tab</span>
                )}
                {on && !phone && <span className={kbd}>↵</span>}
              </span>
            )}
          </span>
          {!two && (
            <span className="max-w-[45%] flex-none truncate text-sm text-text-faint max-[600px]:hidden">
              {look === 'b'
                ? h.where
                : `${h.kind === 'Page' || h.kind === 'Action' ? '' : `${h.kind} · `}${h.where}`}
            </span>
          )}
          {on && !phone && !two && h.feature && s.cp2 === 'b' && !sub && (
            <span className={kbd}>Tab</span>
          )}
          {on && !phone && !two && <span className={kbd}>↵</span>}
        </button>
      </li>
    );
  };

  let idx = 0;
  const list = (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" data-testid="mk-palette-list">
      {roleLine && (
        <p
          data-testid="mk-role"
          className="mx-3 mt-3 flex items-center gap-2 rounded-lg bg-bg px-3 py-2 text-sm text-text2"
        >
          <Icon name={proposes ? 'comment' : 'lock'} size={16} /> {roleLine}
        </p>
      )}
      {sub ? (
        <>
          <p className="px-3 pt-3 pb-1 text-xs font-semibold text-text-faint">
            {sub.code} {sub.name}
          </p>
          <ul role="listbox">{flat.map((h) => row(h, idx++))}</ul>
        </>
      ) : none ? (
        <div className="px-3 py-6 text-center" data-testid="mk-palette-none">
          <p className="text-base font-semibold text-text">Nothing matches “{q.trim()}”</p>
          {s.cp2 === 'a' ? (
            <p className="mt-1 text-sm text-text-faint">
              Try a code like F-79, or a word from the name.
            </p>
          ) : (
            <div className="mt-3 flex flex-wrap justify-center gap-2">
              {s.cp2 === 'b' && proposes && (
                <button
                  type="button"
                  className="simple-button simple-button-primary"
                  onClick={() => {
                    close();
                    router.push('/simple/roadmap');
                    fillAddItem(q.trim());
                  }}
                >
                  {decides ? 'Add' : 'Propose'} “{q.trim()}” as an item{' '}
                  <span className="ml-1 opacity-70">↵</span>
                </button>
              )}
              <button
                type="button"
                className={`simple-button ${s.cp2 === 'c' || !proposes ? 'simple-button-primary' : ''}`}
                onClick={() => {
                  close();
                  askWith(q.trim());
                }}
              >
                Ask Oracle{' '}
                {s.cp2 === 'c' || !proposes ? <span className="ml-1 opacity-70">↵</span> : null}
              </button>
            </div>
          )}
        </div>
      ) : (
        groups.map((g) =>
          g.hits.length ? (
            <div key={g.label}>
              <p className="px-3 pt-3 pb-1 text-xs font-semibold text-text-faint">{g.label}</p>
              <ul role="listbox">{g.hits.map((h) => row(h, idx++))}</ul>
              {g.more > 0 && (
                <p className="px-3 py-1 text-sm text-accent-ink">
                  {g.more} more {g.label.toLowerCase()} ↓
                </p>
              )}
            </div>
          ) : null,
        )
      )}
    </div>
  );

  const field = (
    <div
      className={`flex items-center gap-2 ${look === 'b' ? 'px-3' : 'border-b border-line px-4'} h-14 flex-none`}
    >
      <Icon name="search" />
      <input
        ref={input}
        data-testid="mk-palette-input"
        aria-label="Find a feature, PRD or goal"
        role="combobox"
        aria-expanded
        aria-activedescendant={`mk-opt-${sel}`}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setSel(0);
          setSub(null);
        }}
        onKeyDown={onKeyDown}
        placeholder={
          phone
            ? s.cp2 === 'b'
              ? 'Find or do'
              : 'Find'
            : s.cp2 === 'b'
              ? 'Find or do: a code, a name, “new …”'
              : 'Find a feature, PRD or goal'
        }
        className="min-w-0 flex-1 bg-transparent text-lg text-text outline-none placeholder:text-text-faint"
      />
      {phone ? (
        <button
          type="button"
          onClick={close}
          data-testid="mk-palette-close"
          className="simple-button h-9 flex-none"
        >
          Close
        </button>
      ) : (
        <span className={kbd}>Esc</span>
      )}
    </div>
  );

  const costNote = s.cost && (
    <>
      {/* The page gives up a strip at the foot for the note, so the note covers nothing. */}
      <style>{`.h-dvh{height:calc(100dvh - 48px)!important}.min-h-dvh{min-height:calc(100dvh - 48px)!important}body{padding-bottom:48px}.pointer-events-none.fixed.bottom-4{bottom:64px!important}[data-testid=item-panel]{max-height:calc(100dvh - 72px)!important}[data-testid=mk-entry].fixed{bottom:72px!important}`}</style>
      <div
        data-testid="mk-cost"
        className="fixed inset-x-0 bottom-0 z-[80] flex h-12 items-center gap-2 border-t-2 border-dashed border-accent bg-surface px-6 text-sm text-text"
      >
        <b>Cost:</b> <span className="truncate">{s.cost}</span>
      </div>
    </>
  );

  const panelEl = panel && (
    <FeaturePanel
      key={`${panel.code}|${panel.name}`}
      feature={panel}
      phone={phone}
      canChange={can('create_simple_change')}
      onClose={() => setPanel(null)}
    />
  );

  if (!me) return null;
  if (!open)
    return (
      <>
        {panelEl}
        {costNote}
      </>
    );

  const box =
    look === 'b' ? (
      <div
        className="fixed inset-0 z-[70]"
        onMouseDown={(e) => e.target === e.currentTarget && close()}
        data-testid="mk-palette"
      >
        <div
          className={`absolute ${phone ? 'inset-x-2 top-2' : 'top-3 left-[calc(50%+var(--mk-rail,0px)/2)] w-[min(680px,calc(100vw-360px))] -translate-x-1/2'} flex max-h-[min(70vh,620px)] flex-col overflow-hidden rounded-xl border-2 border-accent bg-surface shadow-tip`}
        >
          {field}
          <div className="border-t border-line" />
          {list}
        </div>
      </div>
    ) : look === 'c' ? (
      <div
        className="fixed inset-0 z-[70] bg-[rgba(0,0,0,0.25)] [html[data-theme=dark]_&]:bg-[rgba(0,0,0,0.55)]"
        onMouseDown={(e) => e.target === e.currentTarget && close()}
        data-testid="mk-palette"
      >
        <div
          className={`absolute flex flex-col bg-surface shadow-tip ${phone ? 'inset-x-0 bottom-0 h-[85dvh] rounded-t-2xl' : 'top-0 right-0 h-dvh w-[460px] border-l border-line'}`}
        >
          {phone && <span className="mx-auto mt-2 h-1 w-10 rounded-full bg-line-strong" />}
          {field}
          {list}
        </div>
      </div>
    ) : (
      <div
        className="fixed inset-0 z-[70] bg-[rgba(0,0,0,0.3)] [html[data-theme=dark]_&]:bg-[rgba(0,0,0,0.55)]"
        onMouseDown={(e) => e.target === e.currentTarget && close()}
        data-testid="mk-palette"
      >
        <div
          className={`absolute flex flex-col overflow-hidden bg-surface shadow-tip ${phone ? 'inset-0' : 'top-[12vh] left-1/2 max-h-[64vh] w-[640px] -translate-x-1/2 rounded-2xl border border-line'}`}
        >
          {field}
          {list}
          {!phone && (
            <div className="flex flex-none gap-4 border-t border-line px-4 py-2 text-xs text-text-faint">
              <span>
                <span className={kbd}>↑↓</span> move
              </span>
              <span>
                <span className={kbd}>↵</span> open
              </span>
              {s.cp2 === 'b' && flat[sel]?.feature && !sub && (
                <span>
                  <span className={kbd}>Tab</span> more for a feature
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    );
  return (
    <>
      {panelEl}
      {box}
      {costNote}
    </>
  );
}

/** CP3: the entry a person without a keyboard taps. `where` is the shell slot it is drawn in. */
export function PaletteEntry({
  where,
}: {
  where: 'simple-rail' | 'detailed-rail' | 'phone-header' | 'top' | 'float';
}) {
  const s = usePaletteSwitches();
  const { me } = useMe();
  if (!me) return null;
  const v = s.cp3;
  if (where === 'simple-rail' && v === 'a')
    return (
      <button
        type="button"
        onClick={openPalette}
        data-testid="mk-entry"
        className="mb-1 flex h-12 w-full items-center gap-3 rounded-xl border border-rail-sep px-3 text-left text-[length:var(--simple-rail-label)] font-medium text-rail-text hover:bg-rail-hover hover:text-rail-active-text"
      >
        <Icon name="search" stroke={1.7} />
        <span className="flex-1">Find</span>
        <span className="rounded border border-rail-sep px-1.5 font-mono text-xs">⌘K</span>
      </button>
    );
  if (where === 'detailed-rail' && v === 'a')
    return (
      <button
        type="button"
        onClick={openPalette}
        data-testid="mk-entry"
        className="flex w-[72px] flex-none flex-col items-center gap-0.5 rounded-xl py-1.5 text-sm text-rail-text hover:bg-rail-hover hover:text-rail-active-text"
      >
        <Icon name="search" />
        Find
      </button>
    );
  if (where === 'phone-header' && v === 'a')
    return (
      <button
        type="button"
        onClick={openPalette}
        aria-label="Find"
        data-testid="mk-entry-phone"
        className="hidden size-10 flex-none items-center justify-center rounded-full text-rail-active-text max-[600px]:flex"
      >
        <Icon name="search" />
      </button>
    );
  if (where === 'top' && v === 'b')
    return (
      <div className="sticky top-0 z-30 flex h-12 items-center justify-end [html[data-mk-open]_&]:invisible border-b border-line bg-surface px-6 max-[600px]:px-3 max-[600px]:top-[var(--phone-top-bar)]">
        <button
          type="button"
          onClick={openPalette}
          data-testid="mk-entry"
          className="flex h-9 w-[min(420px,100%)] items-center gap-2 rounded-lg border border-line bg-bg px-3 text-left text-base text-text-faint hover:border-line-strong"
        >
          <Icon name="search" size={18} />
          <span className="flex-1 truncate">Find a feature, PRD or goal</span>
          <span className={`${kbd} max-[600px]:hidden`}>⌘K</span>
        </button>
      </div>
    );
  if (where === 'float' && v === 'c')
    return (
      <button
        type="button"
        onClick={openPalette}
        aria-label="Find"
        data-testid="mk-entry"
        className="fixed right-6 bottom-6 z-[45] flex h-14 items-center gap-2 rounded-full bg-accent px-5 text-base font-semibold text-on-accent shadow-tip max-[600px]:right-4 max-[600px]:bottom-[calc(var(--tab-bar,64px)+16px)] max-[600px]:size-14 max-[600px]:justify-center max-[600px]:px-0"
      >
        <Icon name="search" />
        <span className="max-[600px]:hidden">Find</span>
      </button>
    );
  return null;
}
