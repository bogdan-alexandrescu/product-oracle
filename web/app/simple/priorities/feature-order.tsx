'use client';

import { useState, type KeyboardEvent } from 'react';

import { api, type Schemas } from '@/lib/api/client';

import { nextNoteId, type Note } from './goal-buckets';

type Row = Schemas['SimplePriorityRow'];
type Out = Schemas['SimplePrioritiesOut'];

/** Stored with the pin as its one-line why: the drag says no more. */
const REASON = 'Reordered in place';

/** The API's reason for a refusal: its detail, or its detail's message. */
function refusal(error: unknown, response: Response): string {
  const detail = (error as { detail?: unknown } | undefined)?.detail;
  return typeof detail === 'string'
    ? detail
    : detail && typeof detail === 'object' && 'message' in detail
      ? String((detail as { message: unknown }).message)
      : response.statusText || 'Could not move it';
}

/**
 * prioritize: a feature moved up or down among its neighbours (a bucket's rows, a cell's chips)
 * takes the place of the one it lands on in the one feature order, Priorities' rank, through the
 * same override_priority change the Priorities list writes. A decider's move shows at once and is
 * final (Undo in the note); a refusal puts it back with the reason. A proposer's move is filed and
 * its row carries a pending mark (`pending`). Rights are the rows' own can_reorder and applies.
 */
export function useFeatureOrder({
  data,
  reload,
  setNote,
  setError,
}: {
  data: Out;
  reload: () => Promise<void> | void;
  setNote: (n: Note | null) => void;
  setError: (e: string | null) => void;
}) {
  const [local, setLocal] = useState<{ key: string; codes: string[] } | null>(null);
  const rowOf = (code: string): Row | undefined =>
    data.rows.find((r) => r.code === code) ??
    data.rows.find((r) => !!r.short_code && r.short_code === code);
  const pending = (code: string): boolean => {
    const r = rowOf(code);
    return (
      !!r &&
      data.proposals.some((p) => p.feature_id === r.feature_id && p.op === 'override_priority')
    );
  };
  /** The codes as shown: a move in flight first, else as given. */
  const arrange = (key: string, codes: string[]): string[] =>
    local?.key === key &&
    local.codes.length === codes.length &&
    codes.every((c) => local.codes.includes(c))
      ? local.codes
      : codes;
  const may = (code: string) => !!rowOf(code)?.can_reorder;
  /** The codes in rank order; a code with no ranked row keeps its place after the ranked. */
  const sorted = (codes: string[]): string[] => {
    const rank = (c: string) => rowOf(c)?.rank ?? Infinity;
    return codes
      .map((c, i) => ({ c, i }))
      .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
      .map((x) => x.c);
  };

  /** Moves `code` to the place of `onto` in `codes` (the list as shown under `key`). */
  async function move(key: string, codes: string[], code: string, over: string) {
    const shown = arrange(key, codes);
    const r = rowOf(code);
    const t = rowOf(over);
    // The row under a pointer names it by its shown code: the list's own entry for that row.
    const onto = shown.find((c) => rowOf(c) === t) ?? over;
    if (!r || !t || code === onto || !r.can_reorder || !shown.includes(onto)) return;
    const next = shown.filter((c) => c !== code);
    const at = next.indexOf(onto) + (shown.indexOf(code) < shown.indexOf(onto) ? 1 : 0);
    next.splice(at, 0, code);
    if (r.applies) setLocal({ key, codes: next });
    const position = t.rank;
    const target = r.item_id ? { item_id: r.item_id } : { feature_id: r.feature_id };
    try {
      const {
        data: out,
        error,
        response,
      } = await api.POST('/v1/simple/changes', {
        body: {
          op: 'override_priority',
          target,
          before: { override: r.before_override ?? null },
          after: { position, reason: REASON },
          reason: REASON,
        },
      });
      if (!response.ok || !out) throw new Error(refusal(error, response));
      setError(null);
      await reload();
      setNote({
        id: nextNoteId(),
        text: (
          <>
            {r.applies ? 'Moved' : 'Proposed moving'} {r.title} to rank {position}
          </>
        ),
        changes: r.applies ? [out.change.id] : undefined,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setLocal(null);
  }

  /** Alt+ArrowUp / Alt+ArrowDown on a focused row moves it one place among `codes`. */
  const keys = (key: string, codes: string[], code: string) => (e: KeyboardEvent) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || !may(code)) return;
    e.preventDefault();
    e.stopPropagation();
    const shown = arrange(key, codes);
    const onto = shown[shown.indexOf(code) + (e.key === 'ArrowUp' ? -1 : 1)];
    if (onto) void move(key, codes, code, onto);
  };

  return { arrange, move, keys, may, pending, sorted };
}

/** The small mark on a feature whose move waits for a decider. */
export function PendingMark() {
  return (
    <span
      data-testid="order-pending"
      title="Your move waits for a decider"
      aria-label="Move pending"
      className="ml-1.5 inline-block h-2 w-2 rounded-full bg-warn align-middle"
    />
  );
}

/** The feature row's code under a point. */
export function rowAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-testid=plan-feature]');
  return el?.dataset.code ?? null;
}
