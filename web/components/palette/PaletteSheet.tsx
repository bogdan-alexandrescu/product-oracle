// build-palette (#1794): the ⌘K palette's open sheet, as the owner picked it (CP1 a, Centered
// sheet; CP2 b, Find and do): the box at the top, one line per result in groups, the key strip at
// the foot; on a phone it fills the screen. Roles come through can() only.
import { useRef, useState, type KeyboardEvent } from 'react';

import { Button } from '@/components/ds/Button';
import { Icon } from '@/components/ds/Icon';
import { askWith } from '@/components/hop/open-state';
import { useCanStartPrd } from '@/components/simple/NewPrd';
import { api, unwrap } from '@/lib/api/client';
import { useMe } from '@/lib/me';
import { useRouter } from '@/lib/nav';
import { useQuery } from '@/lib/use-query';

import { askNewItem } from './events';
import { buildGroups, newTitle, type Group } from './groups';
import {
  featureHits,
  indexHits,
  pageHits,
  recentKeys,
  rememberOpened,
  type Hit,
  type HitKind,
} from './hits';
import { KBD, PaletteRow } from './PaletteRow';

type Rights = { proposes: boolean; decides: boolean; edits: boolean; startsPrd: boolean };

function actionsFor(
  words: string,
  { proposes, decides, startsPrd }: Rights,
  run: { newItem: (title: string, add: boolean) => void; newPrd: () => void },
): Hit[] {
  const { typedNew, title } = newTitle(words);
  const itemWord = decides ? 'New item' : 'Propose a new item';
  const out: Hit[] = [];
  if (proposes)
    out.push({
      key: 'a-item',
      kind: 'Action',
      name: typedNew && title ? `${itemWord}: ${title}` : itemWord,
      where: decides ? 'Roadmap · last track used' : 'Roadmap · an approver decides',
      run: () => run.newItem(title, decides && !!title),
    });
  if (startsPrd)
    out.push({ key: 'a-prd', kind: 'Action', name: 'New PRD', where: 'Home', run: run.newPrd });
  out.push({
    key: 'a-ask',
    kind: 'Action',
    name: words && !typedNew ? `Ask Oracle: ${words}` : 'Ask Oracle',
    where: 'Opens beside the page',
    run: () => askWith(typedNew ? '' : words),
  });
  return out;
}

/** Tab on a feature: its own actions. */
function featureActions(h: Hit, onPanel: (h: Hit, onRoadmap?: boolean) => void): Hit[] {
  return [
    {
      key: 'x-open',
      kind: 'Action',
      name: 'Open its panel',
      where: 'Here, over this page',
      run: () => onPanel(h),
    },
    {
      key: 'x-road',
      kind: 'Action',
      name: 'Show it on the Roadmap',
      where: 'Roadmap',
      run: () => onPanel(h, true),
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

function roleLineOf({ proposes, edits }: Rights): string {
  if (!proposes) return 'As a viewer you can find and open anything; you cannot add or change.';
  if (!edits) return 'As a commenter you can open any panel and propose changes there.';
  return '';
}

export function PaletteSheet({
  phone,
  simple,
  onClose,
  onPanel,
  onNewPrd,
}: {
  phone: boolean;
  simple: boolean;
  onClose: () => void;
  onPanel: (h: Hit, onRoadmap?: boolean) => void;
  onNewPrd: () => void;
}) {
  const { can } = useMe();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [sub, setSub] = useState<Hit | null>(null);
  const [whole, setWhole] = useState<HitKind | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const roadmap = useQuery('simple-roadmap:{}', () => unwrap(api.GET('/v1/simple/roadmap', {})));
  const index = useQuery('simple-palette', () => unwrap(api.GET('/v1/simple/palette')));
  const rights: Rights = {
    proposes: can('create_simple_change'),
    // As the roadmap's own add: an owner, or one who decides an item there (its can_decide).
    decides: can('accept_simple_change') || (roadmap.data?.items ?? []).some((i) => i.can_decide),
    // Approver and up (one who edits a PRD's sections): no line about proposing.
    edits: can('edit_document_section'),
    startsPrd: useCanStartPrd(),
  };

  const words = q.trim();
  const newItem = (title: string, add: boolean) => {
    router.push('/simple/roadmap');
    askNewItem({ title, add });
  };
  const actions = actionsFor(words, rights, { newItem, newPrd: onNewPrd });
  const { groups, none } = buildGroups({
    words,
    all: [...featureHits(roadmap.data?.items ?? []), ...indexHits(index.data)],
    pages: pageHits(simple),
    actions,
    recent: recentKeys(),
    whole,
  });
  const flat = sub ? featureActions(sub, onPanel) : groups.flatMap((g) => g.hits);
  const roleLine = roleLineOf(rights);
  const tabbable = !sub && !!flat[sel]?.feature;

  const go = (h: Hit | undefined) => {
    if (!h) return;
    onClose();
    if (h.kind !== 'Action' && h.kind !== 'Page') rememberOpened(h.key);
    if (h.run) h.run();
    else if (h.feature) onPanel(h);
    else if (h.href) router.push(h.href);
  };
  /** Nothing matches: Enter adds the words as an item (or proposes it), else asks Oracle. */
  const noMatch = (add: boolean) => {
    onClose();
    if (add) newItem(words, false);
    else askWith(words);
  };
  const move = (to: number) => {
    setSel(to);
    list.current?.querySelector(`#palette-opt-${to}`)?.scrollIntoView?.({ block: 'nearest' });
  };
  const more = () => {
    setSub(flat[sel]);
    setSel(0);
  };
  const keys: Record<string, (() => void) | undefined> = {
    Escape: () => (sub ? setSub(null) : onClose()),
    ArrowDown: () => move(Math.min(flat.length - 1, sel + 1)),
    ArrowUp: () => move(Math.max(0, sel - 1)),
    Enter: () => (none ? noMatch(rights.proposes) : go(flat[sel])),
    // The box keeps the focus while the sheet is open: Tab only opens a feature's actions.
    Tab: () => tabbable && more(),
    ArrowRight: tabbable ? more : undefined,
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const k = keys[e.key];
    if (!k) return;
    e.preventDefault();
    k();
  };

  let idx = 0;
  const rows = (hits: Hit[], label?: string) => (
    <ul role="listbox" aria-label={label}>
      {hits.map((h) => {
        const i = idx++;
        return (
          <PaletteRow
            key={h.key}
            hit={h}
            index={i}
            on={i === sel}
            keys={!phone}
            tab={!!h.feature && !sub}
            onPoint={() => setSel(i)}
            onPick={() => go(h)}
          />
        );
      })}
    </ul>
  );
  const group = (g: Group) =>
    g.hits.length ? (
      <div key={g.label}>
        <p className="px-3 pt-3 pb-1 text-xs font-semibold text-text-faint">{g.label}</p>
        {rows(g.hits, g.label)}
        {g.more > 0 && (
          <Button
            variant="ghost"
            className="mx-1 text-accent-ink"
            onClick={() => setWhole(g.kind ?? null)}
          >
            {g.more} more {g.label.toLowerCase()} ↓
          </Button>
        )}
      </div>
    ) : null;

  return (
    <div
      className="fixed inset-0 z-[70] bg-[rgba(0,0,0,0.3)] [html[data-theme=dark]_&]:bg-[rgba(0,0,0,0.55)]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      data-testid="palette"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Find"
        className={`absolute flex flex-col overflow-hidden bg-surface shadow-tip ${phone ? 'inset-0' : 'top-[12vh] left-1/2 max-h-[64vh] w-[640px] -translate-x-1/2 rounded-2xl border border-line'}`}
      >
        <div className="flex h-14 flex-none items-center gap-2 border-b border-line px-4">
          <Icon name="search" />
          <input
            autoFocus
            data-testid="palette-input"
            aria-label="Find a feature, PRD or goal"
            role="combobox"
            aria-expanded
            aria-controls="palette-list"
            aria-activedescendant={flat.length && !none ? `palette-opt-${sel}` : undefined}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
              setSub(null);
              setWhole(null);
            }}
            onKeyDown={onKeyDown}
            placeholder={phone ? 'Find or do' : 'Find or do: a code, a name, “new …”'}
            className="min-w-0 flex-1 bg-transparent text-lg text-text outline-none placeholder:text-text-faint"
          />
          {phone ? (
            <Button onClick={onClose} data-testid="palette-close" className="h-9 flex-none">
              Close
            </Button>
          ) : (
            <span className={KBD}>Esc</span>
          )}
        </div>
        <div
          ref={list}
          id="palette-list"
          className="min-h-0 flex-1 overflow-y-auto px-2 pb-2"
          data-testid="palette-list"
        >
          {roleLine && (
            <p
              data-testid="palette-role"
              className="mx-3 mt-3 flex items-center gap-2 rounded-lg bg-bg px-3 py-2 text-sm text-text2"
            >
              <Icon name={rights.proposes ? 'comment' : 'lock'} size={16} /> {roleLine}
            </p>
          )}
          {sub && (
            <>
              <p className="px-3 pt-3 pb-1 text-xs font-semibold text-text-faint">
                {sub.code} {sub.name}
              </p>
              {rows(flat)}
            </>
          )}
          {!sub && none && <NoMatch words={words} rights={rights} onPick={noMatch} />}
          {!sub && !none && groups.map(group)}
        </div>
        {!phone && (
          <div className="flex flex-none gap-4 border-t border-line px-4 py-2 text-xs text-text-faint">
            <span>
              <span className={KBD}>↑↓</span> move
            </span>
            <span>
              <span className={KBD}>↵</span> open
            </span>
            {tabbable && (
              <span>
                <span className={KBD}>Tab</span> more for a feature
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function NoMatch({
  words,
  rights,
  onPick,
}: {
  words: string;
  rights: Rights;
  onPick: (add: boolean) => void;
}) {
  return (
    <div className="px-3 py-6 text-center" data-testid="palette-none">
      <p className="text-base font-semibold text-text">Nothing matches “{words}”</p>
      <div className="mt-3 flex flex-wrap justify-center gap-2">
        {rights.proposes && (
          <Button variant="solid" onClick={() => onPick(true)}>
            {rights.decides ? 'Add' : 'Propose'} “{words}” as an item
            <span className="ml-1 opacity-70">↵</span>
          </Button>
        )}
        <Button variant={rights.proposes ? 'secondary' : 'solid'} onClick={() => onPick(false)}>
          Ask Oracle {rights.proposes ? null : <span className="ml-1 opacity-70">↵</span>}
        </Button>
      </div>
    </div>
  );
}
