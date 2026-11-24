import type { Schemas } from '@/lib/api/client';

type Out = Schemas['SimplePrioritiesOut'];
type Row = Schemas['SimplePriorityRow'];
/** A row as the page shows it: `rank` its place in the list, `pin_at` the API's rank a move to that place writes. */
export type Placed = Row & { pin_at?: number };

/**
 * prio-ux (#1738, #1776): the rows' ranks as places in the list read (1, 2, 3…), so no number skips where the API
 * leaves finished work out; Oracle's rank likewise among the rows shown. Each row keeps the API's rank as `pin_at`.
 */
export function placed(data: Out | undefined): Out | undefined {
  if (!data) return data;
  const byOracle = data.rows
    .filter((r) => r.oracle_rank != null)
    .sort((a, b) => a.oracle_rank! - b.oracle_rank!);
  const oracle = new Map(byOracle.map((r, i) => [r.feature_id, i + 1]));
  const rows = [...data.rows].sort((a, b) => a.rank - b.rank);
  return {
    ...data,
    rows: rows.map((r, i): Placed => ({
      ...r,
      rank: i + 1,
      oracle_rank: r.oracle_rank == null ? null : oracle.get(r.feature_id)!,
      pin_at: (r as Placed).pin_at ?? r.rank,
    })),
  };
}

/** The API's rank a move to `place` (a place in `rows`, from 1) writes: the rank of the row now there. */
export const pinAt = (rows: Row[], place: number): number =>
  (rows[place - 1] as Placed | undefined)?.pin_at ?? place;

/** The API's rank of `row` (its own, before the page's renumbering). */
export const pinOf = (row: Row): number => (row as Placed).pin_at ?? row.rank;
