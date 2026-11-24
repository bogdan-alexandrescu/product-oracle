// MOCK-HOOK: whole file. Mock-up variants for '@mentions and the activity history in the feature
// panel' (mk-mentions). URL switches: ?ma1=a|b|c|d (layout) &ma2=a|b|c (mention) &ma3=a|b|c|d (history
// line), states &open=1 &phase=mid|done &hard=1 &learn=1. Never merged.
import { useState, type ReactNode } from 'react';

import {
  MK_EVENTS,
  MK_PEOPLE,
  MK_WAITING,
  mkManyEvents,
  type MkEvent,
} from '@/lib/api/mock/mk-mentions';

const qs = () => new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search); // MOCK-HOOK
export const mkParam = (k: string): string | null => qs().get(k); // MOCK-HOOK
export const mkOn = (): boolean => ['ma1', 'ma2', 'ma3'].some((k) => qs().has(k)); // MOCK-HOOK

const fmt = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'UTC',
});
const fmtDay = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const when = (iso: string) => fmt.format(new Date(iso));
const day = (iso: string) => fmtDay.format(new Date(iso));

const LINK = 'font-semibold text-accent-ink hover:underline';
const CHIP_ON = 'border-accent bg-accent-soft text-accent-ink';
const CHIP = 'inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs font-semibold';
const BTN =
  'inline-flex h-8 items-center rounded-lg border border-line-strong bg-surface px-3 text-sm font-semibold hover:bg-surface2';
const BTN_ACC =
  'inline-flex h-8 items-center rounded-lg border border-accent bg-accent px-3 text-sm font-semibold text-on-accent';

function Avatar({ name, size = 24 }: { name: string; size?: number }) {
  const ini = name === 'Oracle' ? 'O' : name.split(/[\s-]+/).slice(0, 2).map((w) => w[0]).join('');
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-surface2 text-xs font-semibold text-text2"
    >
      {ini}
    </span>
  );
}

/** A comment body: @[Name] tokens read per MA2's pick. */
function Body({ text, ma2 }: { text: string; ma2: string }) {
  const raw = text.split(/@\[([^\]]+)\]/g);
  const named = raw.filter((_, i) => i % 2);
  // b: names move to the To line; the text keeps the rest.
  const parts = ma2 === 'b' ? [text.replace(/@\[[^\]]+\]\s*/g, '').replace(/\s+/g, ' ').trim()] : raw;
  return (
    <span data-user-content className="whitespace-pre-wrap break-words">
      {ma2 === 'b' && named.length > 0 && (
        <span data-testid="mk-mention" className="mb-0.5 block text-xs text-text2">
          To {named.join(', ')}
        </span>
      )}
      {parts.map((p, i) =>
        i % 2 === 0 ? (
          p
        ) : ma2 === 'b' ? null : ma2 === 'c' ? (
          <b key={i} data-testid="mk-mention" className="font-semibold">
            @{p}
          </b>
        ) : (
          <span
            key={i}
            data-testid="mk-mention"
            className="rounded bg-accent-soft px-1 font-semibold text-accent-ink"
          >
            {p}
          </span>
        ),
      )}
    </span>
  );
}

function Comment({ e, ma2 }: { e: MkEvent; ma2: string }) {
  return (
    <li data-testid="mk-comment" className="flex gap-2 text-sm">
      <Avatar name={e.who} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold">{e.who}</span>
          <span className="text-xs text-text2">{when(e.at)}</span>
        </div>
        <Body text={e.body ?? ''} ma2={ma2} />
      </div>
    </li>
  );
}

function Undo({ id, open, busy, label = 'Undo' }: { id: string; open?: boolean; busy?: boolean; label?: string }) {
  if ((id !== 'e2' && id !== 'Dates') || mkParam('role') === 'commenter') return null;
  return (
    <>
      <button type="button" className="h-6 shrink-0 self-start rounded px-1.5 text-xs font-semibold text-accent-ink hover:bg-surface2">
        {busy ? 'Undoing…' : label}
      </button>
      {open && (
        <div className="absolute top-7 right-0 z-10 w-64 rounded-lg border border-line bg-surface p-3 shadow-tip">
          <p className="text-sm">
            Put Dates back to <b className="font-semibold">Oct 31 – Dec 10</b>?
          </p>
          <div className="mt-2 flex gap-2">
            <button type="button" className={BTN_ACC}>
              Undo
            </button>
            <button type="button" className={BTN}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}

const Arrow = () => <span className="px-1 text-text2">→</span>;

/** One history line, per MA3's pick. */
function Change({
  e,
  ma3,
  undoOpen,
  undoBusy,
  nested,
}: {
  e: MkEvent;
  ma3: string;
  undoOpen?: boolean;
  undoBusy?: boolean;
  nested?: boolean;
}) {
  const by = e.oracle ? 'Oracle' : e.who;
  const prop = e.proposal;
  const tail = prop ? (
    prop.state === 'waiting' ? (
      <span className="ml-1 rounded bg-warn-bg px-1 text-xs font-semibold text-warn">Waiting</span>
    ) : (
      <span className="text-xs text-text2"> · accepted by {prop.by}</span>
    )
  ) : null;
  if (e.kind === 'added')
    return (
      <li data-testid="mk-change" className="flex gap-2 text-sm text-text2">
        <Avatar name={e.who} />
        <span>
          <b className="font-semibold text-text">{e.who}</b> added it to {e.after}
          <span className="ml-2 text-xs">{when(e.at)}</span>
        </span>
      </li>
    );
  if (ma3 === 'b')
    return (
      <li data-testid="mk-change" className="relative flex gap-2 text-sm">
        <Avatar name={by} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="font-semibold">{by}</span>
            <span className="text-xs text-text2">{when(e.at)}</span>
            {prop && <span className="text-xs text-text2">{prop.state === 'waiting' ? 'proposed' : `proposed · accepted by ${prop.by}`}</span>}
          </div>
          <div className="mt-1 grid grid-cols-[88px_1fr] gap-x-2 rounded-lg bg-surface2 px-2 py-1">
            <span className="text-text2">{e.field}</span>
            <span>
              <s className="text-text2">{e.before}</s>
              <Arrow />
              {e.after}
            </span>
          </div>
        </div>
        <Undo id={e.id} open={undoOpen} busy={undoBusy} />
      </li>
    );
  if (ma3 === 'c')
    return (
      <li data-testid="mk-change" className="relative grid grid-cols-[84px_1fr_auto] gap-x-2 text-sm">
        <span className="font-semibold text-text2">{e.field}</span>
        <span className="min-w-0">
          <span className="text-text2">{e.before}</span>
          <Arrow />
          <span className="font-semibold">{e.after}</span>
          <span className="block text-xs text-text2">
            {by} · {when(e.at)}
            {prop && (prop.state === 'waiting' ? ' · waiting' : ` · accepted by ${prop.by}`)}
          </span>
        </span>
        {nested ? <span /> : <Undo id={e.id} open={undoOpen} busy={undoBusy} />}
      </li>
    );
  // a: one sentence
  return (
    <li data-testid="mk-change" className="relative flex gap-2 text-sm">
      <Avatar name={by} />
      <div className="min-w-0 flex-1">
        <span>
          <b className="font-semibold">{by}</b>{' '}
          {e.undo ? 'put back' : prop ? 'proposed' : 'changed'} {e.field} <span className="text-text2">{e.before}</span>
          <Arrow />
          <b className="font-semibold">{e.after}</b>
        </span>
        {tail}
        <span className="block text-xs text-text2">{when(e.at)}</span>
      </div>
      <Undo id={e.id} open={undoOpen} busy={undoBusy} />
    </li>
  );
}

/** The comment field, with MA2's mention picker. */
function Field({ text, picker, query, ma2, hard }: { text: string; picker: boolean; query: string; ma2: string; hard: boolean }) {
  const pool = hard ? MK_PEOPLE.filter((p) => /sam/i.test(p.name)) : MK_PEOPLE;
  const list = pool.filter((p) => p.name.toLowerCase().includes(query.toLowerCase())).slice(0, 6);
  const [v, setV] = useState(text);
  return (
    <div className="relative">
      {ma2 === 'b' && (
        <div className="mb-1 flex flex-wrap items-center gap-1.5">
          {text.includes('Priya') || mkParam('phase') === 'mid' ? (
            <span className={`${CHIP} ${CHIP_ON}`}>Priya Raman ×</span>
          ) : null}
          <button type="button" data-testid="mk-notify" className={`${CHIP} border-line-strong text-text2`}>
            + Notify
          </button>
        </div>
      )}
      <textarea
        aria-label="Add a comment"
        placeholder={ma2 === 'b' ? 'Add a comment' : 'Add a comment, @ to mention'}
        rows={2}
        value={v}
        onChange={(e) => setV(e.target.value)}
        className="w-full resize-y rounded-lg border border-line-strong bg-surface px-2 py-1.5 text-sm"
      />
      {picker && (
        <div
          data-testid="mk-picker"
          role="listbox"
          className={`z-20 w-72 rounded-lg border border-line bg-surface p-1 shadow-tip ${ma2 === 'b' ? 'absolute top-8 left-0' : 'absolute top-full left-2 mt-1'}`}
        >
          {ma2 === 'b' && (
            <input
              aria-label="Find a person"
              placeholder="Find a person"
              defaultValue={query}
              className="mb-1 h-8 w-full rounded border border-line-strong px-2 text-sm"
            />
          )}
          {list.map((p, i) => (
            <div
              key={p.id}
              role="option"
              aria-selected={i === 0}
              className={`flex items-center gap-2 rounded px-2 py-1.5 text-sm ${i === 0 ? 'bg-accent-soft' : ''}`}
            >
              <Avatar name={p.name} size={22} />
              <span className="min-w-0 flex-1 truncate font-semibold">{p.name}</span>
              <span className="text-xs text-text2">{p.role}</span>
            </div>
          ))}
          {hard && <div className="px-2 py-1 text-xs text-text2">{pool.length} people match</div>}
        </div>
      )}
    </div>
  );
}

function sel(on: boolean) {
  return `${CHIP} ${on ? CHIP_ON : 'border-line-strong text-text2'}`;
}

/** MA3 d: the latest change per field, the full list one click away. */
function PerField({ events, open, undoOpen }: { events: MkEvent[]; open: boolean; undoOpen?: boolean }) {
  const seen = new Map<string, { e: MkEvent; n: number }>();
  for (const e of events) {
    if (e.kind !== 'change' || !e.field) continue;
    const s = seen.get(e.field);
    if (s) s.n += 1;
    else seen.set(e.field, { e, n: 1 });
  }
  return (
    <ul className="mt-2 space-y-1.5">
      {[...seen.values()].map(({ e, n }) => (
        <li key={e.field} data-testid="mk-change" className="relative grid grid-cols-[88px_1fr_auto_auto] gap-x-1 text-sm">
          <span className="text-text2">{e.field}</span>
          <span className="min-w-0">
            {e.after}
            <span className="block text-xs text-text2">
              was {e.before} · {e.oracle ? 'Oracle' : e.who}, {day(e.at)}
            </span>
          </span>
          <button type="button" className="h-6 self-start rounded px-1 text-xs font-semibold text-accent-ink">
            {open && e.field === 'Dates' ? 'Hide' : `All ${n}`}
          </button>
          {e.field === 'Dates' && !e.undo ? <Undo id="Dates" open={undoOpen} label="Put back" /> : <span />}
        </li>
      ))}
    </ul>
  );
}

/** The panel's Activity, in every variant. */
export function MkActivity({ phone }: { phone: boolean }) {
  const ma1 = mkParam('ma1') ?? 'a';
  const ma2 = mkParam('ma2') ?? 'a';
  const ma3 = mkParam('ma3') ?? 'a';
  const open = mkParam('open') === '1';
  const phase = mkParam('phase');
  const hard = mkParam('hard') === '1';
  const focus = mkParam('ma2') ? 'ma2' : mkParam('ma3') ? 'ma3' : 'ma1';
  const role = mkParam('role');

  let events: MkEvent[] = hard && focus !== 'ma2' ? mkManyEvents() : [...MK_EVENTS];
  if (role === 'commenter') events = [MK_WAITING, ...events];
  // The story's result: MA1 posts a comment, MA2 posts one with a mention, MA3 undoes Priya's date change.
  if (phase === 'done' && focus === 'ma1')
    events = [{ id: 'n1', kind: 'comment', who: 'Avery Stone', at: '2026-11-24T09:41:00Z', body: 'Can we keep Dec 18 for the pilot?' }, ...events];
  if (phase === 'done' && focus === 'ma2')
    events = [{ id: 'n2', kind: 'comment', who: 'Avery Stone', at: '2026-11-24T09:41:00Z', body: 'Thanks, @[Priya Raman] can you confirm Monday mornings with support?' }, ...events];
  if (phase === 'done' && focus === 'ma3')
    events = [{ id: 'n3', kind: 'change', who: 'Avery Stone', at: '2026-11-24T09:41:00Z', field: 'Dates', before: 'Oct 31 – Dec 18', after: 'Oct 31 – Dec 10', undo: true, mine: true }, ...events];

  const comments = events.filter((e) => e.kind === 'comment');
  const changes = events.filter((e) => e.kind !== 'comment');

  // The field's text and picker per story state.
  let text = '';
  let picker = false;
  let query = '';
  if (focus === 'ma1' && phase === 'mid') text = 'Can we keep Dec 18 for the pilot?';
  if (focus === 'ma2' && (open || phase === 'mid')) {
    picker = true;
    query = phase === 'mid' ? (hard ? 'Sam' : 'pri') : '';
    text = ma2 === 'b' ? 'Thanks, can you confirm Monday mornings with support?' : `Thanks, @${query}`;
    if (hard && ma2 !== 'b') text = 'Can someone from support take this? @Sam';
  }

  // MA1 filter / tab / fold state.
  const [filter, setFilter] = useState<'all' | 'comments' | 'changes'>(
    focus === 'ma1' && open && ma1 === 'a' ? 'changes' : focus === 'ma3' && ma3 === 'c' && open ? 'changes' : 'all',
  );
  const [tab, setTab] = useState<'comments' | 'history'>(
    focus === 'ma1' && open && ma1 === 'b' ? 'history' : 'comments',
  );
  const [folded, setFolded] = useState(!(focus === 'ma1' && open && ma1 === 'c'));
  const [side, setSide] = useState(focus === 'ma1' && ma1 === 'd' && (open || !!phase || hard));

  const limit = hard ? 20 : 999;
  const undoOpen =
    focus === 'ma3' && (['a', 'b'].includes(ma3) ? open && !phase : ma3 === 'c' && phase === 'mid');
  const undoBusy = focus === 'ma3' && ['a', 'b'].includes(ma3) && phase === 'mid';

  const line = (e: MkEvent) =>
    e.kind === 'comment' ? (
      <Comment key={e.id} e={e} ma2={ma2} />
    ) : (
      <Change key={e.id} e={e} ma3={ma3} undoOpen={undoOpen && e.id === 'e2'} undoBusy={undoBusy && e.id === 'e2'} />
    );

  const withDays = (list: MkEvent[]) => {
    const out: ReactNode[] = [];
    let last = '';
    for (const e of list.slice(0, limit)) {
      const d = day(e.at);
      if (hard && d !== last) {
        out.push(
          <li key={`d-${e.id}`} className="pt-1 text-xs font-semibold text-text2">
            {d}
          </li>,
        );
        last = d;
      }
      out.push(line(e));
    }
    return out;
  };

  const more = (n: number) =>
    hard && n > limit ? (
      <div className="mt-3 flex items-center justify-between">
        <span className="text-xs text-text2">
          {limit} of {n}
        </span>
        <button type="button" data-testid="mk-more" className={BTN}>
          Show 20 more
        </button>
      </div>
    ) : null;

  const field = <Field text={text} picker={picker} query={query} ma2={ma2} hard={hard} />;

  // MA3 c: filter by field, with counts.
  const fieldChips =
    ma3 === 'c' ? (
      <div className="mt-2 flex flex-wrap gap-1.5">
        {['All', 'Dates', 'Status', 'Owner', 'Other'].map((f) => {
          const n = f === 'All' ? changes.length : changes.filter((e) => (f === 'Other' ? !['Dates', 'Status', 'Owner'].includes(e.field ?? '') : e.field === f)).length;
          return (
            <button key={f} type="button" className={sel(focus === 'ma3' && (open || phase === 'mid') && ma3 === 'c' ? f === 'Dates' : f === 'All')}>
              {f} {n}
            </button>
          );
        })}
      </div>
    ) : null;
  const shownChanges =
    ma3 === 'c' && focus === 'ma3' && (open || phase === 'mid') ? changes.filter((e) => e.field === 'Dates') : changes;

  // MA3 b: a person's changes within an hour fold into one entry.
  const history = (list: MkEvent[]) =>
    ma3 === 'd' ? (
      <PerField events={list} open={focus === 'ma3' && open && !phase} undoOpen={focus === 'ma3' && phase === 'mid'} />
    ) : (
      <>
        {fieldChips}
        <ul className="mt-2 space-y-3">{withDays(ma3 === 'c' ? list.filter((e) => shownChanges.includes(e) || e.kind === 'comment') : list)}</ul>
        {more(list.length)}
      </>
    );

  let inner: ReactNode;
  if (ma1 === 'b') {
    inner = (
      <>
        <div role="tablist" className="flex gap-4 border-b border-line">
          {(['comments', 'history'] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              type="button"
              onClick={() => setTab(t)}
              className={`-mb-px border-b-2 pb-1.5 text-sm font-semibold ${tab === t ? 'border-accent text-text' : 'border-transparent text-text2'}`}
            >
              {t === 'comments' ? 'Comments' : 'History'} <span className="text-xs text-text2">{t === 'comments' ? comments.length : changes.length}</span>
            </button>
          ))}
        </div>
        {tab === 'comments' ? (
          <>
            <ul className="mt-3 space-y-3">{[...comments].reverse().slice(-limit).map(line)}</ul>
            <div className="mt-2">{field}</div>
          </>
        ) : (
          history(changes)
        )}
      </>
    );
  } else if (ma1 === 'c') {
    inner = (
      <>
        <h3 className="text-sm font-semibold text-text2">Comments</h3>
        <ul className="mt-2 space-y-3">{[...comments].reverse().slice(-limit).map(line)}</ul>
        <div className="mt-2">{field}</div>
        <button
          type="button"
          aria-expanded={!folded}
          onClick={() => setFolded(!folded)}
          className="mt-3 flex items-center gap-1 text-sm font-semibold text-accent-ink"
        >
          <span aria-hidden>{folded ? '▸' : '▾'}</span>
          {folded ? `Show ${changes.length} changes` : `Hide ${changes.length} changes`}
        </button>
        {!folded && history(changes)}
      </>
    );
  } else {
    const list = filter === 'comments' ? comments : filter === 'changes' ? changes : events;
    inner = (
      <>
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-text2">Activity</h3>
          <div className="ml-auto flex gap-1.5">
            {(
              [
                ['all', 'All', events.length],
                ['comments', 'Comments', comments.length],
                ['changes', 'Changes', changes.length],
              ] as const
            ).map(([k, label, n]) => (
              <button key={k} type="button" onClick={() => setFilter(k)} className={sel(filter === k)}>
                {label} {k === 'all' ? '' : n}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-2">{field}</div>
        {filter === 'comments' || ma3 === 'a' || ma3 === 'b' || ma3 === 'c' ? (
          <>
            {ma3 === 'c' && filter !== 'comments' && fieldChips}
            <ul className="mt-3 space-y-3">{withDays(ma3 === 'c' && filter !== 'comments' ? list.filter((e) => e.kind === 'comment' || shownChanges.includes(e)) : list)}</ul>
            {more(list.length)}
          </>
        ) : (
          <>
            <h4 className="mt-3 text-xs font-semibold text-text2">Latest change to each</h4>
            <PerField events={changes} open={focus === 'ma3' && open && !phase} undoOpen={focus === 'ma3' && phase === 'mid'} />
            {focus === 'ma3' && open && !phase && (
              <ul className="mt-2 space-y-2 border-l-2 border-line pl-3">
                {changes.filter((e) => e.field === 'Dates').map((e) => (
                  <Change key={e.id} e={e} ma3="c" nested />
                ))}
              </ul>
            )}
            <ul className="mt-4 space-y-3">{withDays(comments)}</ul>
            {more(comments.length)}
          </>
        )}
      </>
    );
  }

  if (ma1 === 'd') {
    return (
      <>
        <section data-testid="mk-activity" className="mt-4 border-t border-line pt-3">
          <button type="button" onClick={() => setSide(!side)} className={side ? `${BTN} ${CHIP_ON}` : BTN}>
            Activity <span className="ml-1.5 text-xs text-text2">{events.length}</span>
            {comments.length > 0 && <span className="ml-1.5 text-xs text-text2">· {comments.length} comments</span>}
          </button>
        </section>
        {side && (
          <aside
            data-testid="mk-activity-side"
            aria-label="Activity"
            className={
              phone
                ? 'fixed inset-x-0 bottom-0 z-50 h-[70dvh] overflow-y-auto rounded-t-xl border border-line bg-surface p-4 shadow-tip'
                : 'fixed top-3 right-[424px] z-40 max-h-[calc(100dvh-24px)] w-[380px] overflow-y-auto rounded-xl border border-line bg-surface p-4 shadow-tip'
            }
          >
            <div className="mb-3 flex items-center gap-2">
              <span className="text-base font-semibold">F-79 Weekly alert digest</span>
              <button type="button" aria-label="Close" onClick={() => setSide(false)} className="ml-auto text-text2">
                ×
              </button>
            </div>
            {inner}
          </aside>
        )}
      </>
    );
  }
  return (
    <section data-testid="mk-activity" className="mt-4 min-h-[85dvh] border-t border-line pt-3">
      {inner}
    </section>
  );
}

/** MA2: how the mentioned person learns of it (Priya's Inbox, or the bell). */
export function MkInboxMention() {
  const ma2 = mkParam('ma2');
  if (!ma2) return null;
  if (ma2 === 'c') return <MkBell />;
  return (
    <section data-testid="mk-inbox-mention" className="mb-4 rounded-xl border border-line bg-surface p-4">
      <h2 className="text-base font-semibold">{ma2 === 'b' ? 'Sent to you' : 'Mentions'} <span className="text-xs text-text2">1</span></h2>
      <div className="mt-3 flex gap-3 text-sm">
        <Avatar name="Avery Stone" size={28} />
        <div className="min-w-0 flex-1">
          <div>
            <b className="font-semibold">Avery Stone</b> {ma2 === 'b' ? 'asked you on' : 'mentioned you on'}{' '}
            <a className={LINK} href="#">F-79 Weekly alert digest</a>
            <span className="ml-2 text-xs text-text2">Nov 24, 9:41 AM</span>
          </div>
          <p className="mt-1 border-l-2 border-line pl-2 text-text2">Thanks, can you confirm Monday mornings with support?</p>
          <div className="mt-2 flex gap-2">
            <button type="button" className={BTN_ACC}>Reply</button>
            <button type="button" className={BTN}>Done</button>
          </div>
        </div>
      </div>
    </section>
  );
}

/** MA2 c: a bell in the page's corner, with its list open. */
export function MkBell() {
  if (mkParam('ma2') !== 'c') return null;
  return (
    <div className="fixed top-3 right-3 z-50 w-80">
      <div className="flex justify-end">
        <span className="relative inline-flex h-9 w-9 items-center justify-center rounded-full border border-line bg-surface">
          <svg aria-hidden width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" />
          </svg>
          <span className="absolute -top-1 -right-1 rounded-full bg-accent px-1.5 text-xs font-semibold text-on-accent">2</span>
        </span>
      </div>
      <ul className="mt-2 space-y-2 rounded-xl border border-line bg-surface p-3 text-sm shadow-tip">
        <li>
          <b className="font-semibold">Avery Stone</b> mentioned you on <span className={LINK}>F-79 Weekly alert digest</span>
          <span className="block text-xs text-text2">Nov 24, 9:41 AM</span>
        </li>
        <li className="border-t border-line pt-2">
          <b className="font-semibold">Jun Park</b> mentioned you on <span className={LINK}>F-01 Setup checklist</span>
          <span className="block text-xs text-text2">Nov 23, 4:02 PM</span>
        </li>
      </ul>
    </div>
  );
}
