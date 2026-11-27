// build-palette (#1794): the ⌘K palette's open sheet, as the owner picked it (CP1 a, Centered
// sheet; CP2 b, Find and do): the box at the top, one line per result in groups, the key strip at
// the foot; on a phone it fills the screen. Roles come through can() only.
import { useCallback, useRef, useState, type KeyboardEvent } from 'react';

import { Button } from '@/components/ds/Button';
import { Icon } from '@/components/ds/Icon';
import { useCanStartPrd } from '@/components/simple/NewPrd';
import { useMe } from '@/lib/me';
import { useRouter } from '@/lib/nav';

import { actionsFor, featureActions, noMatchChoices, roleLineOf, type Rights } from './actions';
import { askNewItem, usePaletteEscape } from './events';
import { buildGroups, moreOf, rowsOf, type Group } from './groups';
import { featureHits, indexHits, recentKeys, rememberOpened, type Hit, type HitKind } from './hits';
import { palettePages } from './pages';
import { NoMatch, ReadFailed, Reading } from './PaletteParts';
import { KBD, PaletteMoreRow, PaletteRow } from './PaletteRow';
import { usePaletteReads } from './reads';

/** What Tab reaches inside the sheet (its options are walked with the arrow keys). */
const TAB_STOPS = 'input, button:not([tabindex="-1"]):not([disabled])';

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
  const { can, simpleMode } = useMe();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [picked, setSel] = useState(0);
  const [sub, setSub] = useState<Hit | null>(null);
  const [whole, setWhole] = useState<HitKind[]>([]);
  const list = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLInputElement>(null);
  const { roadmap, index, ready, failed, retry } = usePaletteReads();
  const rights: Rights = {
    proposes: can('create_simple_change'),
    // As the roadmap's own add: an owner, or one who decides an item there (its can_decide).
    decides: can('accept_simple_change') || (roadmap?.items ?? []).some((i) => i.can_decide),
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
    all: [...featureHits(roadmap?.items ?? []), ...indexHits(index)],
    pages: palettePages(simple, { can, simpleMode }),
    actions,
    recent: recentKeys(),
    whole,
    ready,
  });
  const choices = noMatchChoices(words, rights, newItem);
  const flat = sub ? featureActions(sub, onPanel) : none ? choices : rowsOf(groups);
  // A read that answers may shorten the list under the selection.
  const last = Math.max(0, flat.length - 1);
  const sel = Math.min(picked, last);
  const roleLine = roleLineOf(rights);
  const tabbable = !sub && !!flat[sel]?.feature;

  const go = (h: Hit | undefined) => {
    if (!h) return;
    if (h.more) {
      // The rest of the kind, the selection on the first row it adds.
      setWhole([...whole, h.more]);
      return;
    }
    onClose();
    if (h.kind !== 'Action' && h.kind !== 'Page') rememberOpened(h.key);
    if (h.run) h.run();
    else if (h.feature) onPanel(h);
    else if (h.href) router.push(h.href);
  };
  const move = (to: number) => {
    setSel(to);
    list.current?.querySelector(`#palette-opt-${to}`)?.scrollIntoView?.({ block: 'nearest' });
  };
  const more = () => {
    box.current?.focus();
    setSub(flat[sel]);
    setSel(0);
  };
  usePaletteEscape(useCallback(() => (sub ? setSub(null) : onClose()), [sub, onClose]));
  // Tab opens a feature's actions; elsewhere it walks the sheet's own controls and stays inside it.
  const walk = (back: boolean) => {
    const els = [...(sheet.current?.querySelectorAll<HTMLElement>(TAB_STOPS) ?? [])];
    const at = els.indexOf(document.activeElement as HTMLElement);
    els[(at + (back ? -1 : 1) + els.length) % els.length]?.focus();
  };
  const onTab = (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    if (tabbable && !e.shiftKey && document.activeElement === box.current) more();
    else walk(e.shiftKey);
  };
  const keys: Record<string, (() => void) | undefined> = {
    ArrowDown: () => move(Math.min(last, sel + 1)),
    ArrowUp: () => move(Math.max(0, sel - 1)),
    Enter: () => go(flat[sel]),
    ArrowRight: tabbable ? more : undefined,
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const k = keys[e.key];
    if (!k) return;
    e.preventDefault();
    k();
  };
  let idx = 0;
  const moreRow = (h: Hit, i: number) => (
    <PaletteMoreRow
      hit={h}
      index={i}
      on={i === sel}
      onPoint={() => setSel(i)}
      onPick={() => go(h)}
    />
  );
  const rows = (hits: Hit[], label?: string, rest?: Hit) => (
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
      {rest && moreRow(rest, idx++)}
    </ul>
  );
  const group = (g: Group) =>
    g.hits.length ? (
      <div key={g.label}>
        <p className="px-3 pt-3 pb-1 text-xs font-semibold text-text-faint">{g.label}</p>
        {rows(g.hits, g.label, moreOf(g))}
      </div>
    ) : null;

  return (
    <div
      className="fixed inset-0 z-[70] bg-[rgba(0,0,0,0.3)] [html[data-theme=dark]_&]:bg-[rgba(0,0,0,0.55)]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      data-testid="palette"
    >
      <div
        ref={sheet}
        onKeyDown={onTab}
        role="dialog"
        aria-modal="true"
        aria-label="Find"
        className={`absolute flex flex-col overflow-hidden bg-surface shadow-tip ${phone ? 'inset-0' : 'top-[12vh] left-1/2 max-h-[64vh] w-[640px] -translate-x-1/2 rounded-2xl border border-line'}`}
      >
        <div className="flex h-14 flex-none items-center gap-2 border-b border-line px-4">
          <Icon name="search" />
          <input
            ref={box}
            autoFocus
            data-testid="palette-input"
            aria-label="Find a feature, PRD or goal"
            role="combobox"
            aria-expanded
            aria-controls="palette-list"
            aria-activedescendant={flat.length ? `palette-opt-${sel}` : undefined}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
              setSub(null);
              setWhole([]);
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
          {!sub && none && (
            <NoMatch words={words} choices={choices} sel={sel} onPoint={setSel} onPick={go} />
          )}
          {!sub && !none && groups.map(group)}
          {!sub && failed && (
            <ReadFailed
              error={failed}
              onAgain={() => {
                retry();
                box.current?.focus();
              }}
            />
          )}
          {!sub && !ready && !failed && words && <Reading />}
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
