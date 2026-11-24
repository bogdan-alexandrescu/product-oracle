'use client';
// MOCK-HOOK: the whole file. Mock-ups for "My work: what I own or decide" (#1798), decisions
// MW1 (where it lives), MW2 (what it groups, in what order) and MW3 (empty, forty, viewer).
// URL switches: ?mw1=a|b|c &mw2=a|b|c &mw3=a|b|c &case=none|forty|one &act=open|mid|done
// &pick=open|mid|done &more=1 &tile=<kind> &hot=<id> &panel=<id> &page=2 &q=<text>. Never merged.

import { useMemo, useState, type ReactNode } from 'react';

import { Icon, InfoTip, Page, PageHeader, type IconName } from '@/components/ds';
import { usePhone } from '@/components/simple/PrdTimeline';
import { SimplePage } from '@/components/simple/SimplePage';
import { FeaturePanel } from '@/app/simple/roadmap/_panel';
import { OpenFeatureContext, useOpenFeature } from '@/components/simple/OpenFeature';
import { MW_FORTY, MW_ITEMS, MW_UNOWNED, type MwItem, type MwKind } from '@/lib/api/mock/my-work';
import { Link } from '@/lib/nav';
import { mw } from '@/components/simple/my-work-switch'; // MOCK-HOOK
import { useMe } from '@/lib/me';

const KIND_ICON: Record<MwKind, IconName> = {
  feature: 'roadmap', // MOCK-HOOK
  decision: 'flag', // MOCK-HOOK
  proposal: 'doc', // MOCK-HOOK
  milestone: 'clock', // MOCK-HOOK
};
const KIND_WORDS: Record<MwKind, string> = {
  feature: 'Feature you own', // MOCK-HOOK
  decision: 'You decide', // MOCK-HOOK
  proposal: 'Your proposal', // MOCK-HOOK
  milestone: 'Milestone you own', // MOCK-HOOK
};
const WHEN_WORDS = ['Late or at risk', 'This week', 'Next week', 'Later', 'No date']; // MOCK-HOOK
const ROLE_GROUPS: [MwKind, string][] = [
  ['decision', 'Waiting for your decision'], // MOCK-HOOK
  ['feature', 'Features you own'], // MOCK-HOOK
  ['milestone', 'Milestones coming up'], // MOCK-HOOK
  ['proposal', 'Proposals you made'], // MOCK-HOOK
];
const TILE_WORDS: Record<MwKind, string> = {
  decision: 'decisions to make', // MOCK-HOOK
  feature: 'features you own', // MOCK-HOOK
  milestone: 'milestones coming up', // MOCK-HOOK
  proposal: 'proposals you made', // MOCK-HOOK
};

const rank = (i: MwItem) => (i.when === 0 || i.risk ? 0 : i.when); // MOCK-HOOK
const sorted = (xs: MwItem[]) => [...xs].sort((a, b) => rank(a) - rank(b)); // MOCK-HOOK

/** MOCK-HOOK: one row of My work; a feature opens the one feature panel. */
function Row({
  item,
  compact,
  canAct,
  act,
  decided,
  onDecide,
}: {
  item: MwItem;
  compact?: boolean;
  canAct: boolean;
  act: string | null;
  decided?: string;
  onDecide?: (answer: string) => void;
}) {
  const open = useOpenFeature(); // MOCK-HOOK
  const [another, setAnother] = useState(act === 'open' || act === 'mid'); // MOCK-HOOK
  const [chosen, setChosen] = useState<string | null>(act === 'mid' ? (item.options?.[0] ?? null) : null); // MOCK-HOOK
  const hot = mw('hot') === item.id; // MOCK-HOOK
  const late = item.when === 0; // MOCK-HOOK
  const title = (
    <>
      {item.code && <span className="simple-code mr-1.5">{item.code}</span>}
      {item.name}
    </>
  ); // MOCK-HOOK
  const opens = item.code && item.kind !== 'proposal'; // MOCK-HOOK
  const status = late ? (
    <span className="simple-status simple-status-risk">Late</span>
  ) : item.risk ? (
    <span className="simple-status simple-status-risk">At risk</span>
  ) : null; // MOCK-HOOK
  if (compact)
    return (
      <li
        className={`flex items-center gap-3 border-t border-line py-2 first:border-t-0 ${hot ? 'bg-accent-soft' : ''}`}
        data-testid="mw-row"
      >
        <Icon name={KIND_ICON[item.kind]} size={16} stroke={1.7} />
        {opens ? (
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left text-base font-[650] hover:underline"
            onClick={() => open?.({ code: item.code!, name: item.name })}
          >
            {title}
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate text-base font-[650]">{title}</span>
        )}
        {status}
        <span className="simple-meta tnum w-20 text-right">{item.due ?? 'No date'}</span>
      </li>
    ); // MOCK-HOOK
  return (
    <li className={`simple-row ${hot ? 'rounded-xl bg-accent-soft' : ''}`} data-testid="mw-row">
      <span className={`simple-ico ${decided ? 'simple-ico-done' : ''}`}>
        <Icon name={decided ? 'check' : KIND_ICON[item.kind]} size={18} stroke={1.7} />
      </span>
      <div className="simple-rb">
        {opens ? (
          <button
            type="button"
            className="text-left font-[650] hover:underline"
            data-testid="mw-open"
            onClick={() => open?.({ code: item.code!, name: item.name })}
          >
            {title}
          </button>
        ) : (
          <span className="font-[650]">{title}</span>
        )}
        <span className="simple-meta">
          {KIND_WORDS[item.kind]} · {item.track}
          {item.due ? ` · due ${item.due}` : ''}
          {item.blocks ? ` · Blocks ${item.blocks}` : ''}
          {item.waits ? ` · waits on ${item.waits}` : ''} {status}
        </span>
        {item.rec && !decided && (
          <span className="simple-rec">
            <span className="simple-rec-label">Recommended:</span>
            {item.rec}
          </span>
        )}
        {decided && (
          <span className="simple-rec" role="status">
            <span className="simple-rec-label">Decided:</span>
            {decided} ·{' '}
            <button type="button" className="simple-link">
              Undo
            </button>
          </span>
        )}
        {another && !decided && item.options && (
          <span className="simple-chips" role="group" aria-label="Another answer">
            {item.options.map((o) => (
              <button
                key={o}
                type="button"
                aria-pressed={chosen === o}
                className={`simple-chip ${chosen === o ? 'border-accent! bg-accent-soft! text-accent-ink!' : ''}`}
                onClick={() => setChosen(o)}
              >
                {o}
              </button>
            ))}
          </span>
        )}
      </div>
      {canAct && !decided && (
        <div className="simple-actions">
          {item.kind === 'decision' ? (
            another ? (
              <>
                <button
                  type="button"
                  className="simple-button simple-button-primary"
                  disabled={!chosen}
                  onClick={() => chosen && onDecide?.(chosen)}
                >
                  Decide
                </button>
                <button type="button" className="simple-button" onClick={() => setAnother(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="simple-button simple-button-primary"
                  onClick={() => onDecide?.(item.rec!)}
                >
                  Decide as recommended
                </button>
                <button type="button" className="simple-button" onClick={() => setAnother(true)}>
                  Another answer
                </button>
              </>
            )
          ) : item.kind === 'proposal' ? (
            <Link href="/simple/inbox" className="simple-button">
              See replies
            </Link>
          ) : item.kind === 'milestone' ? (
            <Link href="/simple/roadmap" className="simple-button">
              On the Roadmap
            </Link>
          ) : (
            <button
              type="button"
              className="simple-button"
              onClick={() => open?.({ code: item.code!, name: item.name })}
            >
              Open
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function Group({ title, n, children, id }: { title: string; n: number; children: ReactNode; id: string }) {
  return (
    <section className="flex flex-col gap-3" aria-label={title} data-testid={`mw-group-${id}`}>
      <h3 className="text-lg font-semibold">
        {title} <span className="simple-meta tnum">· {n}</span>
      </h3>
      {children}
    </section>
  ); // MOCK-HOOK
}

/** MOCK-HOOK: MW3 empty states (a: pick unowned, b: Oracle suggests, c: plain line). */
function Empty({ canAct, onTaken }: { canAct: boolean; onTaken: (xs: MwItem[]) => void }) {
  const v = mw('mw3') ?? 'a'; // MOCK-HOOK
  const pick = mw('pick'); // MOCK-HOOK
  const [shown, setShown] = useState(pick === 'open' || pick === 'mid'); // MOCK-HOOK
  const [taken, setTaken] = useState<string[]>(pick === 'mid' ? ['u1', 'u3'] : []); // MOCK-HOOK
  const list = v === 'b' ? MW_UNOWNED.slice(0, 3) : MW_UNOWNED; // MOCK-HOOK
  const why: Record<string, string> = {
    u1: 'You wrote its one-pager', // MOCK-HOOK
    u2: 'You decided its last two questions', // MOCK-HOOK
    u3: 'It is in the Usage alerts track, which you run', // MOCK-HOOK
  };
  return (
    <div className="flex flex-col gap-4" data-testid="mw-empty">
      <p className="simple-small flex items-center gap-2">
        Nothing is yours yet.
        {v === 'c' && canAct && (
          <Link href="/simple/roadmap" className="simple-link">
            Set owners on the Roadmap
          </Link>
        )}
        <InfoTip label="Nothing is yours yet" align="start">
          {canAct
            ? 'Features and milestones you own, decisions you make and proposals you made show here.'
            : 'You can read every page. An owner or approver can make you the owner of a feature.'}
        </InfoTip>
      </p>
      {canAct && v !== 'c' && !shown && (
        <div>
          <button
            type="button"
            className="simple-button simple-button-primary"
            data-testid="mw-pick"
            onClick={() => setShown(true)}
          >
            {v === 'b' ? '✦ Suggest what I could own' : 'Pick features to own'}
          </button>
        </div>
      )}
      {canAct && v !== 'c' && shown && (
        <section className="simple-card" aria-label="No owner yet" data-testid="mw-pick-list">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="simple-h2">{v === 'b' ? '✦ Oracle suggests' : 'No owner yet'}</h2>
            <span className="simple-meta tnum">
              {v === 'b' ? `${list.length} for you` : `${list.length} features`}
            </span>
          </div>
          <ul className="mt-3">
            {list.map((i) => {
              const mine = taken.includes(i.id); // MOCK-HOOK
              return (
                <li key={i.id} className="simple-row">
                  <span className={`simple-ico ${mine ? 'simple-ico-done' : ''}`}>
                    <Icon name={mine ? 'check' : 'roadmap'} size={18} stroke={1.7} />
                  </span>
                  <div className="simple-rb">
                    <span className="font-[650]">
                      <span className="simple-code mr-1.5">{i.code}</span>
                      {i.name}
                    </span>
                    <span className="simple-meta">
                      {v === 'b' ? why[i.id] : `${i.track}${i.due ? ` · due ${i.due}` : ''}`}
                    </span>
                  </div>
                  <div className="simple-actions">
                    {mine ? (
                      <span className="simple-status simple-status-ok self-start">Yours</span>
                    ) : v === 'b' ? (
                      <div className="flex gap-2">
                        <button
                          type="button"
                          className="simple-button simple-button-primary"
                          onClick={() => setTaken([...taken, i.id])}
                        >
                          Confirm
                        </button>
                        <button type="button" className="simple-button">
                          Not this
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="simple-button"
                        onClick={() => setTaken([...taken, i.id])}
                      >
                        Take it
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              className="simple-button simple-button-primary"
              disabled={!taken.length}
              data-testid="mw-pick-done"
              onClick={() => onTaken(MW_UNOWNED.filter((x) => taken.includes(x.id)))}
            >
              Done{taken.length ? ` · ${taken.length} taken` : ''}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * MOCK-HOOK: My work's body. `place`: its own page (MW1 a), a Home section (b) or the
 * Roadmap's Mine filter (c).
 */
export function MyWorkBody({ place = 'page' }: { place?: 'page' | 'home' | 'roadmap' }) {
  const { can } = useMe(); // MOCK-HOOK
  const canAct = can('create_simple_change'); // MOCK-HOOK
  const c = mw('case'); // MOCK-HOOK
  const v2 = mw('mw2') ?? 'a'; // MOCK-HOOK
  const v3 = mw('mw3') ?? 'a'; // MOCK-HOOK
  const act = mw('act'); // MOCK-HOOK
  const base = useMemo(
    () =>
      c === 'forty'
        ? MW_FORTY
        : c === 'none'
          ? []
          : c === 'one'
            ? [MW_UNOWNED[0]]
            : mw('pick') === 'done'
              ? MW_UNOWNED.filter((x) => x.id === 'u1' || x.id === 'u3')
              : MW_ITEMS,
    [c],
  ); // MOCK-HOOK
  const [taken, setTaken] = useState<MwItem[] | null>(null); // MOCK-HOOK
  const [decided, setDecided] = useState<Record<string, string>>(
    act === 'done' ? { d1: '8:00 for everyone' } : {},
  ); // MOCK-HOOK
  const [tile, setTile] = useState<MwKind | null>((mw('tile') as MwKind) ?? (act ? 'decision' : null)); // MOCK-HOOK
  const [more, setMore] = useState(mw('more') === '1'); // MOCK-HOOK
  const [page, setPage] = useState(Number(mw('page') ?? 1)); // MOCK-HOOK
  const [q, setQ] = useState(mw('q') ?? ''); // MOCK-HOOK
  let items = taken ?? base; // MOCK-HOOK
  if (place === 'roadmap') items = items.filter((i) => i.kind === 'feature' || i.kind === 'milestone'); // MOCK-HOOK
  if (place === 'home') items = items.filter((i) => i.kind !== 'decision'); // MOCK-HOOK
  const open = items.filter((i) => !decided[i.id] || act === 'done'); // MOCK-HOOK
  const left = items.filter((i) => !decided[i.id]); // MOCK-HOOK
  const forty = items.length > 20; // MOCK-HOOK
  const compact = forty && v3 === 'b'; // MOCK-HOOK
  const row = (i: MwItem) => (
    <Row
      key={i.id}
      item={i}
      compact={compact}
      canAct={canAct}
      act={i.id === 'd1' ? act : null}
      decided={decided[i.id]}
      onDecide={(a) => setDecided({ ...decided, [i.id]: a })}
    />
  ); // MOCK-HOOK
  if (items.length === 0) return <Empty canAct={canAct} onTaken={setTaken} />; // MOCK-HOOK

  // MW3: forty items. a: five per group then "Show N more"; b: one line each and a find box; c: ten a page.
  const cap = (xs: MwItem[]) => (forty && v3 === 'a' && !more ? xs.slice(0, 5) : xs); // MOCK-HOOK
  const moreLine = (xs: MwItem[]) =>
    forty && v3 === 'a' && !more && xs.length > 5 ? (
      <button type="button" className="simple-more" onClick={() => setMore(true)}>
        Show {xs.length - 5} more
      </button>
    ) : null; // MOCK-HOOK
  const found = q ? open.filter((i) => i.name.toLowerCase().includes(q.toLowerCase())) : open; // MOCK-HOOK
  const paged =
    forty && v3 === 'c' ? sorted(found).slice((page - 1) * 10, page * 10) : sorted(found); // MOCK-HOOK

  const summary = (
    <p className="simple-meta tnum" data-testid="mw-summary">
      {left.length} {left.length === 1 ? 'item' : 'items'} ·{' '}
      {left.filter((i) => i.when === 0).length} late ·{' '}
      {left.filter((i) => i.risk).length} at risk
    </p>
  ); // MOCK-HOOK

  const findBox = compact && (
    <input
      className="simple-select w-full max-w-md"
      placeholder="Find in my work"
      aria-label="Find in my work"
      value={q}
      onChange={(e) => setQ(e.target.value)}
    />
  ); // MOCK-HOOK
  const pager = forty && v3 === 'c' && (
    <div className="flex items-center gap-3">
      <span className="simple-meta tnum">
        {(page - 1) * 10 + 1}–{Math.min(page * 10, found.length)} of {found.length}
      </span>
      <button type="button" className="simple-button" disabled={page === 1} onClick={() => setPage(page - 1)}>
        Back
      </button>
      <button
        type="button"
        className="simple-button"
        disabled={page * 10 >= found.length}
        onClick={() => setPage(page + 1)}
      >
        Next 10
      </button>
    </div>
  ); // MOCK-HOOK

  let body: ReactNode; // MOCK-HOOK
  if (forty && v3 === 'c') {
    body = <ul>{paged.map(row)}</ul>; // MOCK-HOOK
  } else if (v2 === 'b') {
    body = ROLE_GROUPS.map(([k, t]) => {
      const xs = sorted(found.filter((i) => i.kind === k)); // MOCK-HOOK
      if (!xs.length) return null; // MOCK-HOOK
      return (
        <Group key={k} id={k} title={t} n={xs.filter((i) => !decided[i.id]).length}>
          <ul>{cap(xs).map(row)}</ul>
          {moreLine(xs)}
        </Group>
      ); // MOCK-HOOK
    });
  } else if (v2 === 'c') {
    const kinds = ROLE_GROUPS.map(([k]) => k).filter((k) => items.some((i) => i.kind === k)); // MOCK-HOOK
    const xs = tile ? sorted(found.filter((i) => i.kind === tile)) : []; // MOCK-HOOK
    body = (
      <>
        <ul
          className="grid gap-3 max-[600px]:gap-2"
          style={{ gridTemplateColumns: `repeat(${kinds.length}, minmax(0, 1fr))` }}
        >
          {kinds.map((k) => (
            <li key={k}>
              <button
                type="button"
                aria-pressed={tile === k}
                data-testid={`mw-tile-${k}`}
                onClick={() => setTile(tile === k ? null : k)}
                className={`flex h-full w-full flex-col rounded-xl px-4 py-3 text-left max-[600px]:px-2.5 max-[600px]:py-2 ${tile === k ? 'bg-accent-soft ring-2 ring-accent' : 'bg-surface2 hover:bg-accent-soft'}`}
              >
                <span className="simple-number tnum max-[600px]:text-xl! max-[600px]:leading-7!">
                  {left.filter((i) => i.kind === k).length}
                </span>
                <span className="simple-small max-[600px]:text-sm! max-[600px]:leading-4">
                  {TILE_WORDS[k]}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {tile && (
          <Group id={tile} title={TILE_WORDS[tile][0].toUpperCase() + TILE_WORDS[tile].slice(1)} n={xs.filter((i) => !decided[i.id]).length}>
            <ul>{cap(xs).map(row)}</ul>
            {moreLine(xs)}
          </Group>
        )}
      </>
    ); // MOCK-HOOK
  } else {
    body = [0, 1, 2, 3, 4].map((w) => {
      const xs = sorted(found.filter((i) => rank(i) === w)); // MOCK-HOOK
      if (!xs.length) return null; // MOCK-HOOK
      return (
        <Group key={w} id={`when-${w}`} title={WHEN_WORDS[w]} n={xs.filter((i) => !decided[i.id]).length}>
          <ul>{cap(xs).map(row)}</ul>
          {moreLine(xs)}
        </Group>
      ); // MOCK-HOOK
    });
  }

  if (place === 'home') {
    const top = sorted(open).slice(0, more ? 99 : 4); // MOCK-HOOK
    return (
      <section className="simple-card" aria-label="Yours" data-testid="mw-home">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="simple-h2">Yours</h2>
          {summary}
        </div>
        <ul className="mt-3">{top.map(row)}</ul>
        {!more && open.length > 4 && (
          <button type="button" className="simple-more" data-testid="mw-home-more" onClick={() => setMore(true)}>
            Show {open.length - 4} more
          </button>
        )}
      </section>
    ); // MOCK-HOOK
  }
  return (
    <div className={`flex flex-col gap-6 ${place === 'roadmap' ? '' : 'simple-card'}`} data-testid="mw-body">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {summary}
        {pager}
      </div>
      {findBox}
      {body}
      {pager && <div className="self-end">{pager}</div>}
    </div>
  ); // MOCK-HOOK
}

/** MOCK-HOOK: the My work page (MW1 a), Simple and Detailed, with the one feature panel. */
export function MyWorkPage({ detailed }: { detailed?: boolean }) {
  const pre = mw('panel') ? MW_ITEMS.find((i) => i.id === mw('panel')) : null; // MOCK-HOOK
  const [feature, setFeature] = useState<{ code: string; name: string } | null>(
    pre?.code ? { code: pre.code, name: pre.name } : null,
  ); // MOCK-HOOK
  const phone = usePhone(); // MOCK-HOOK
  const { can } = useMe(); // MOCK-HOOK
  const info =
    'Features and milestones you own, decisions you make and proposals you made. Late and at risk first.'; // MOCK-HOOK
  const inner = (
    <OpenFeatureContext.Provider value={setFeature}>
      {feature && (
        <FeaturePanel
          key={feature.code}
          feature={feature}
          phone={phone}
          canChange={can('create_simple_change')}
          onClose={() => setFeature(null)}
        />
      )}
      <MyWorkBody />
    </OpenFeatureContext.Provider>
  ); // MOCK-HOOK
  if (detailed)
    return (
      <Page>
        <PageHeader title="My work" info={info} />
        <div data-mode="simple" className="simple-mode">{inner}</div>
      </Page>
    ); // MOCK-HOOK
  return (
    <SimplePage title="My work" info={info}>
      {inner}
    </SimplePage>
  ); // MOCK-HOOK
}

/** MOCK-HOOK: Home's "Yours" section (MW1 b) with the one feature panel. */
export function MyWorkHome() {
  const [feature, setFeature] = useState<{ code: string; name: string } | null>(
    mw('panel') ? { code: 'F-101', name: 'One-tap sign-up link' } : null,
  ); // MOCK-HOOK
  const phone = usePhone(); // MOCK-HOOK
  const { can } = useMe(); // MOCK-HOOK
  return (
    <OpenFeatureContext.Provider value={setFeature}>
      {feature && (
        <FeaturePanel
          key={feature.code}
          feature={feature}
          phone={phone}
          canChange={can('create_simple_change')}
          onClose={() => setFeature(null)}
        />
      )}
      <MyWorkBody place="home" />
    </OpenFeatureContext.Provider>
  ); // MOCK-HOOK
}
