'use client';

import { useRef, useState } from 'react';

import { ChangeFailed, propose, undo, type ChangeResult } from '@/app/simple/roadmap/_lib';
import { useFeatureDelete } from '@/components/simple/FeatureDelete';
import { NotInGt } from '@/components/simple/FeatureName';
import {
  AddRow,
  Dates,
  Pending,
  Picked,
  RowMenu,
  SavedMark,
  Typed,
} from '@/components/simple/OnePagerFields';
import { useOpenFeature } from '@/components/simple/OpenFeature';
import { api, unwrap, type Schemas } from '@/lib/api/client';
import { errorMessage, useQuery } from '@/lib/use-query';

type Item = Schemas['SimpleRoadmapItem'];
/** What a row shows before the API answers: a value typed, a proposal waiting, a row going or added. */
type Shown = {
  title?: string;
  owner?: { id: string; name: string } | null;
  start?: string;
  end?: string;
};
type Added = { tmp: string; goal: string; title: string; pending: boolean };
type Saved = { id: string; change: string | null; pending: boolean };

const NONE = '';

/**
 * de-prd (PR2 a "Click to type", the owner's pick): the PRD's features under their goals, on its
 * one-pager. A value the reader may change (name, owner, dates) turns into its field on a click and
 * saves on Enter or a click away; Esc cancels. The row shows the change at once, a Saved mark with
 * Undo when it applied, a pending mark when it waits for who decides (the item's `can_decide`;
 * `canPropose`: the reader may file changes), and is put back with the error when refused. Each
 * goal ends with an add row (type, Enter, the next one); a row's menu moves it to Trash with Undo.
 */
export function OnePagerFeatures({
  prd,
  items,
  canPropose,
  reload,
}: {
  prd: string;
  items: Item[];
  canPropose: boolean;
  reload: () => Promise<unknown>;
}) {
  const [shown, setShown] = useState<Record<string, Shown>>({});
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState<Added[]>([]);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const open = useOpenFeature();
  const seq = useRef(0);
  const people = useQuery(`people:one-pager:${canPropose}`, () =>
    canPropose
      ? unwrap(api.GET('/v1/people', { params: { query: { limit: 200 } } }))
      : Promise.resolve([]),
  );
  const del = useFeatureDelete(reload);
  const mine = items.filter(
    (i) => i.prd?.slug === prd && i.status !== 'merged' && i.status !== 'cut' && !gone.has(i.id),
  );
  const goals = new Map<string, string>();
  mine.forEach((i) => goals.set(i.goal?.id ?? NONE, i.goal?.title ?? ''));
  added.forEach((a) => goals.set(a.goal, goals.get(a.goal) ?? ''));
  if (!mine.length && !added.length) return null;
  // Where a new feature goes: its goal's roadmap and the PRD's track, as the PRD's other features.
  const home = mine[0];
  const prdId = home?.prd?.id ?? null;

  const back = (id: string, keys: (keyof Shown)[], e: unknown) => {
    setShown((s) => {
      const next = { ...s[id] };
      keys.forEach((k) => delete next[k]);
      return { ...s, [id]: next };
    });
    setError(e instanceof ChangeFailed ? e.message : errorMessage(e));
  };

  /** One change of one item: on the screen now, through the API, then read again. */
  async function change(
    i: Item,
    show: Shown,
    body: Omit<Schemas['SimpleChangeIn'], 'target'>,
  ): Promise<void> {
    const keys = Object.keys(show) as (keyof Shown)[];
    setError(null);
    setShown((s) => ({ ...s, [i.id]: { ...s[i.id], ...show } }));
    let r: ChangeResult;
    try {
      r = await propose({ ...body, target: { item_id: i.id } });
    } catch (e) {
      back(i.id, keys, e);
      return;
    }
    const applied = r.change.status === 'applied';
    if (!applied) setPending((p) => new Set(p).add(i.id));
    setSaved({ id: i.id, change: r.change.can_undo ? r.change.id : null, pending: !applied });
    await reload();
    // Applied: the read now holds it. Proposed: the row keeps the value it had, marked pending.
    setShown((s) => {
      const next = { ...s[i.id] };
      keys.forEach((k) => delete next[k]);
      return { ...s, [i.id]: next };
    });
  }

  async function undoSaved() {
    if (!saved?.change) return;
    const id = saved.change;
    setSaved(null);
    try {
      await undo(id);
    } catch (e) {
      setError(e instanceof ChangeFailed ? e.message : errorMessage(e));
    }
    await reload();
  }

  async function add(goal: string, title: string) {
    const tmp = `new-${(seq.current += 1)}`;
    setError(null);
    setAdded((a) => [...a, { tmp, goal, title, pending: false }]);
    try {
      const r = await propose({
        op: 'add_item',
        target: {
          roadmap_id: home?.roadmap.id ?? null,
          where: goal ? { kind: 'goal', value: goal } : { kind: 'horizon', value: 'next' },
        },
        before: {},
        after: home?.track ? { title, track_id: home.track.id } : { title },
      });
      const c = r.change;
      const id = typeof c.target.item_id === 'string' ? c.target.item_id : null;
      if (c.status !== 'applied' || !id) {
        setAdded((a) => a.map((x) => (x.tmp === tmp ? { ...x, pending: true } : x)));
        return;
      }
      // The PRD's own: filed under the track's PRD; under this one when that is another.
      const now = await unwrap(api.GET('/v1/simple/roadmap', {}));
      const it = now.items.find((x) => x.id === id);
      if (it && prdId && it.prd?.slug !== prd)
        await propose({
          op: 'set_prd',
          target: { item_id: id },
          before: { prd_document_id: it.prd?.id ?? null },
          after: { prd_document_id: prdId },
        });
      setSaved({ id, change: c.can_undo ? c.id : null, pending: false });
      await reload();
      setAdded((a) => a.filter((x) => x.tmp !== tmp));
    } catch (e) {
      setAdded((a) => a.filter((x) => x.tmp !== tmp));
      setError(e instanceof ChangeFailed ? e.message : errorMessage(e));
    }
  }

  async function remove(i: Item) {
    const decides = i.can_decide;
    setError(null);
    if (decides) setGone((g) => new Set(g).add(i.id));
    else setPending((p) => new Set(p).add(i.id));
    await del({ id: i.id, title: i.title, now: decides, propose: !decides, deciders: i.deciders });
    if (decides)
      setGone((g) => {
        const next = new Set(g);
        next.delete(i.id);
        return next;
      });
  }

  const owners = [
    { value: NONE, label: 'No owner' },
    ...(people.data ?? [])
      .filter((p) => p.can_write)
      .map((p) => ({ value: p.user_id, label: p.name })),
  ];

  return (
    <section
      aria-label="Features"
      data-testid="op-features"
      className="flex flex-col gap-3 rounded-md border border-[var(--simple-rule)] bg-[var(--simple-paper)] px-6 py-5 max-[767px]:px-4"
    >
      {error && (
        <p role="alert" data-testid="op-feature-error" className="text-sm font-semibold text-crit">
          {error}
        </p>
      )}
      {[...goals.entries()].map(([goal, name]) => (
        <div key={goal || 'none'} data-testid="op-goal" className="flex flex-col gap-1.5">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-text-faint">
            {name || 'No goal'}
          </h3>
          <ul aria-label={name || 'No goal'} className="flex flex-col">
            {mine
              .filter((i) => (i.goal?.id ?? NONE) === goal)
              .map((i) => {
                const s = shown[i.id] ?? {};
                const title = s.title ?? i.title;
                const owner = s.owner !== undefined ? s.owner : (i.owner ?? null);
                const start = s.start ?? i.start.date;
                const end = s.end ?? i.end.date;
                const may = i.can_decide || canPropose;
                return (
                  <li
                    key={i.id}
                    data-testid="op-feature"
                    data-item={i.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--simple-rule)] py-1.5 first:border-t-0"
                  >
                    {i.code ? <span className="simple-code">{i.code}</span> : <NotInGt />}
                    <Typed
                      label={`Name of ${i.title}`}
                      testId="op-feature-name"
                      value={title}
                      may={may}
                      className="min-w-0 !font-bold"
                      onOpen={() => open?.({ id: i.id, code: i.code ?? '', name: i.title })}
                      save={(v) =>
                        void change(
                          i,
                          { title: v },
                          { op: 'edit_title', before: { title: i.title }, after: { title: v } },
                        )
                      }
                      onDelete={i.can_decide || canPropose ? () => void remove(i) : undefined}
                    />
                    <Picked
                      label={`Owner of ${i.title}`}
                      testId="op-feature-owner"
                      value={owner?.id ?? NONE}
                      shown={owner?.name ?? 'No owner'}
                      may={may}
                      options={owners}
                      save={(v) =>
                        void change(
                          i,
                          {
                            owner: v
                              ? { id: v, name: owners.find((o) => o.value === v)?.label ?? '' }
                              : null,
                          },
                          {
                            op: 'set_owner',
                            before: { owner_id: i.own_owner_id ?? null },
                            after: { owner_id: v || null },
                          },
                        )
                      }
                    />
                    <Dates
                      label={i.title}
                      start={start}
                      end={end}
                      may={may}
                      save={(a, b) =>
                        void change(
                          i,
                          { start: a, end: b },
                          {
                            op: 'move_dates',
                            before: { start_date: i.start.date, end_date: i.end.date },
                            after: { start_date: a, end_date: b },
                          },
                        )
                      }
                    />
                    {pending.has(i.id) && <Pending />}
                    {saved?.id === i.id && !saved.pending && (
                      <SavedMark onUndo={saved.change ? () => void undoSaved() : undefined} />
                    )}
                    {may && <RowMenu title={i.title} onRemove={() => void remove(i)} />}
                  </li>
                );
              })}
            {added
              .filter((a) => a.goal === goal)
              .map((a) => (
                <li
                  key={a.tmp}
                  data-testid="op-feature-adding"
                  className="flex flex-wrap items-center gap-x-3 border-t border-[var(--simple-rule)] py-1.5 first:border-t-0"
                >
                  <b className="font-bold">{a.title}</b>
                  {a.pending && <Pending />}
                </li>
              ))}
            {canPropose && <AddRow goal={name || 'No goal'} onAdd={(t) => void add(goal, t)} />}
          </ul>
        </div>
      ))}
    </section>
  );
}
