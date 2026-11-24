// MOCK-HOOK (whole file): mk-bulk-edit BE1 A (boxes on hover, Shift-click a run) on the Now / Next /
// Later board. Local-only switch ?be1=a (with &format board). Never merged.
'use client';

import { useState } from 'react';

import { useSearchParams } from '@/lib/nav';

export type BoardPick = {
  picked: Set<string>;
  hover: string | null;
  setHover: (id: string | null) => void;
  pick: (id: string, order: string[], shift: boolean) => void;
  clear: () => void;
  setAll: (ids: string[]) => void;
};

export function useBoardPick(): BoardPick | null {
  const on = useSearchParams().get('be1') === 'a';
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [hover, setHover] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<string | null>(null);
  if (!on) return null;
  return {
    picked,
    hover,
    setHover,
    clear: () => setPicked(new Set()),
    setAll: (ids) => setPicked(new Set(ids)),
    pick: (id, order, shift) => {
      const next = new Set(picked);
      if (shift && anchor) {
        const [a, b] = [order.indexOf(anchor), order.indexOf(id)].sort((x, y) => x - y);
        order.slice(a, b + 1).forEach((x) => next.add(x));
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      setAnchor(id);
      setPicked(next);
    },
  };
}

/** The box in a card's top-right corner: shown on hover, on every card once one is picked. */
export function BoardBox({ bp, id, name, order }: { bp: BoardPick | null; id: string; name: string; order: string[] }) {
  if (!bp) return null;
  const on = bp.picked.has(id);
  const show = on || bp.picked.size > 0 || bp.hover === id;
  return (
    <input
      type="checkbox"
      data-testid="board-box"
      aria-label={`Pick ${name}`}
      className={`absolute top-2 right-2 h-5 w-5 cursor-pointer accent-[var(--color-accent)] ${show ? '' : 'opacity-0 max-sm:opacity-100'}`}
      checked={on}
      onChange={() => undefined}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        bp.pick(id, order, e.shiftKey);
      }}
    />
  );
}

export function BoardBar({ bp, dock }: { bp: BoardPick | null; dock?: boolean }) {
  if (!bp || !bp.picked.size) return null;
  const btn =
    'rounded-md border border-line bg-surface px-3 py-1.5 text-sm font-medium hover:bg-surface2 max-sm:w-full max-sm:px-1';
  return (
    <>
    {/* Room under the list, so its last row can end above the bar. */}
    {!dock && <div aria-hidden className="h-28" />}
    {/* The whole row is tinted, not its cells: on a phone the cells are separate blocks. */}
    <style>{'tr[data-bulk-picked="true"], li[data-bulk-picked="true"] { background: var(--color-accent-soft); } tr[data-bulk-picked="true"] > td { background: transparent; }'}</style>
    <div
      data-testid="bulk-dock"
      className={dock ? 'fixed inset-x-0 bottom-0 z-40 border-t border-line bg-bg px-3 pt-2 pb-3 max-[600px]:bottom-[var(--phone-tab-bar)] max-[600px]:pb-2 md:left-[232px] md:px-9' : 'fixed inset-x-3 bottom-4 z-40 max-[600px]:inset-x-0 max-[600px]:bottom-[var(--phone-tab-bar)] max-[600px]:border-t max-[600px]:border-line max-[600px]:bg-bg max-[600px]:px-3 max-[600px]:py-2 md:left-[calc(240px+1rem)]'}
    >
    <div
      data-testid="bulk-bar"
      className="mx-auto flex max-w-4xl flex-wrap items-center gap-2 whitespace-nowrap rounded-[var(--simple-card-radius)] border border-line bg-surface px-4 py-3 text-sm shadow-lg max-sm:grid max-sm:grid-cols-4 max-sm:px-3"
    >
      <span className="font-semibold max-sm:col-span-2">{bp.picked.size} picked</span>
      <button type="button" className="text-accent underline max-sm:col-span-2 max-sm:text-right" onClick={bp.clear}>
        Clear
      </button>
      <span className="mx-1 h-6 w-px bg-line max-sm:hidden" aria-hidden />
      {['Owner', 'Status', 'Dates', 'Track'].map((f) => (
        <button key={f} type="button" className={btn}>
          {f} ▾
        </button>
      ))}
    </div>
    </div>
    </>
  );
}
