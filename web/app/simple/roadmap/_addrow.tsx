'use client';

import { useState, type MouseEvent as ReactMouseEvent } from 'react';

import { Button } from '@/components/ds';

import { addDays, ms, shortDay } from './_lib';

/** de-r1 (RE1 A, Click the spot): a new bar is six weeks long until it is stretched. */
export const ADD_WEEKS = 6;

/** The Monday of a day's week (the add rows and the drags snap to weeks). */
export const mondayOf = (day: string): string =>
  addDays(day, -((new Date(ms(day)).getUTCDay() + 6) % 7));

/** de-r1: the six-week span a new bar takes from the week clicked. */
export const addSpan = (start: string): [string, string] => [
  start,
  addDays(start, ADD_WEEKS * 7 - 1),
];

/** de-fix: an add someone proposed in the lane, drawn faint until its decider decides. */
export type WaitingAdd = { id: string; title: string; start?: string; end?: string };

export type AddAt = (title: string, start: string, end: string) => Promise<boolean>;

/**
 * de-r1 (RE1 A): the faint "+ Add" row that ends a lane of the Timeline. A click at a week puts a
 * six-week bar there with its title field on it; Enter adds the feature in the lane at those
 * dates (and opens the field again a row down, for the next), Escape or an empty blur cancels.
 * The bar stays drawn while the add is sent; a refused add keeps the title and says why (the page's note).
 */
export function AddRow({
  lane,
  label,
  labelW,
  trackW,
  height,
  dayAt,
  x,
  today,
  onAdd,
  waiting,
}: {
  lane: string;
  label: string;
  labelW: number;
  trackW: number;
  height: number;
  /** The day under a point `px` from the track's left edge. */
  dayAt: (px: number) => string;
  x: (day: string) => number;
  today: string;
  onAdd: AddAt;
  waiting?: WaitingAdd[];
}) {
  const [start, setStart] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const span = start ? addSpan(start) : null;
  const place = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (start) return;
    const r = e.currentTarget.getBoundingClientRect();
    setStart(mondayOf(dayAt(e.clientX - r.left)));
  };
  const cancel = () => {
    setStart(null);
    setTitle('');
  };
  const send = async () => {
    const t = title.trim();
    if (!t || !span || busy) return;
    setBusy(true);
    const ok = await onAdd(t, span[0], span[1]);
    setBusy(false);
    if (ok) setTitle('');
  };
  return (
    <div
      data-testid="add-row"
      data-lane={lane}
      className="pointer-events-auto relative z-[11] flex border-b border-line/60"
      style={{ height }}
    >
      <Button
        variant="ghost"
        aria-label={`Add to ${label}`}
        data-testid="add-row-button"
        onClick={() => setStart((s) => s ?? mondayOf(today))}
        className="sticky left-0 z-[12] h-full! flex-none justify-start! rounded-none! border-r border-line bg-surface px-3! font-normal opacity-70 hover:opacity-100"
        style={{ width: labelW }}
      >
        + Add
      </Button>
      <div
        data-testid="add-row-weeks"
        className="relative cursor-copy hover:bg-surface2/50"
        style={{ width: trackW }}
        onClick={place}
      >
        {waiting?.map((w) => {
          const [from, to] = w.start && w.end ? [w.start, w.end] : addSpan(mondayOf(today));
          return (
            <div
              key={w.id}
              data-testid="pending-add"
              title="Pending decision"
              className="pointer-events-none absolute top-1 bottom-1 flex items-center truncate rounded-md border border-dashed border-line-strong bg-surface2 px-2 text-sm text-text2 opacity-60"
              style={{ left: x(from), width: Math.max(80, x(to) - x(from)) }}
            >
              {w.title}
            </div>
          );
        })}
        {span && (
          <div
            data-testid="add-row-bar"
            data-start={span[0]}
            data-end={span[1]}
            className="absolute top-1 bottom-1 flex items-center rounded-md border border-accent bg-accent-soft px-1"
            style={{ left: x(span[0]), width: Math.max(120, x(span[1]) - x(span[0])) }}
            title={`${shortDay(span[0])} – ${shortDay(span[1])}`}
          >
            <input
              autoFocus
              data-testid="add-row-title"
              aria-label={`Title, ${shortDay(span[0])} – ${shortDay(span[1])}`}
              value={title}
              disabled={busy}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void send();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  cancel();
                }
              }}
              onBlur={() => {
                if (!title.trim() && !busy) cancel();
              }}
              className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none"
            />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * de-r1 (RE1 A): the "+ Add" that ends a Now / Next / Later column: a card with the title field;
 * Enter adds the feature in that column and leaves the field open for the next, Escape or an
 * empty blur closes it.
 */
export function AddCard({
  label,
  onAdd,
}: {
  label: string;
  onAdd: (title: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    const ok = await onAdd(t);
    setBusy(false);
    if (ok) setTitle('');
  };
  if (!open)
    return (
      <Button
        variant="ghost"
        data-testid="add-card-button"
        aria-label={`Add to ${label}`}
        onClick={() => setOpen(true)}
        className="mt-1 w-full justify-start! font-normal opacity-70 hover:bg-surface hover:opacity-100"
      >
        + Add
      </Button>
    );
  return (
    <div
      data-testid="add-card"
      className="mt-1 rounded-lg border border-accent bg-surface px-2 py-1.5"
    >
      <input
        autoFocus
        data-testid="add-card-title"
        aria-label={`Title, ${label}`}
        value={title}
        disabled={busy}
        maxLength={200}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void send();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            setTitle('');
            setOpen(false);
          }
        }}
        onBlur={() => {
          if (!title.trim() && !busy) setOpen(false);
        }}
        className="w-full bg-transparent text-sm outline-none"
      />
    </div>
  );
}
