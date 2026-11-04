/**
 * build-feature-panel: what Simple's one feature panel reads besides the item itself, as
 * api/oracle/simple/panel.py builds it from the item's own changes:
 *
 * - `override`: Oracle's dates a person replaced (kept from the first change that replaced
 *   them) and who set the dates the item has now; null once `restore_dates` puts them back.
 * - `links`: each item it depends on, who added the link (null: Oracle found it), and Oracle's
 *   links a person removed (`removed`, `removed_by`), shown struck through with Restore.
 *
 * - `goal_set` (review 2): the goal and measure a person set (set_goal) over Oracle's, Oracle's
 *   goal as the item showed it and who set it; null once `restore_goal` puts Oracle's back.
 *
 * Only written changes count: applied or accepted, and not undone.
 */
import type { Schemas } from "@/lib/api/client";

type Change = Schemas["SimpleChangeOut"];
type Values = Record<string, unknown>;
type Item = Schemas["SimpleRoadmapItem"];

const DATE_OPS = ["move_dates", "restore_dates", "accept_date_suggestion", "shift_dependents", "move_dependency"];
const LINK_OPS = ["add_link", "remove_link", "restore_link"];
export const RESTORED = ["start_date", "end_date", "date_source"];

function written(changes: Change[]): Change[] {
  const undone = new Set(changes.map((c) => c.undoes_id).filter(Boolean));
  return changes.filter((c) => (c.status === "applied" || c.status === "accepted") && !undone.has(c.id));
}

function datesOf(c: Change, item: string): [Values, Values] | null {
  if (c.op === "shift_dependents" || c.op === "move_dependency") {
    const b = c.before[item] as Values | undefined;
    const a = c.after[item] as Values | undefined;
    return b && a ? [b, a] : null;
  }
  return c.target.item_id === item ? [c.before, c.after] : null;
}

/** The item's override now: Oracle's dates and source, who set the new ones, and what Restore writes. */
export function overrideOf(changes: Change[], item: string): (Schemas["SimpleOverride"] & { restore: Values }) | null {
  let kept: (Schemas["SimpleOverride"] & { restore: Values }) | null = null;
  for (const c of written(changes)) {
    if (!DATE_OPS.includes(c.op)) continue;
    const both = datesOf(c, item);
    if (!both) continue;
    const [before, after] = both;
    if (c.op === "restore_dates" || after.date_source !== "typed") {
      kept = null;
      continue;
    }
    if (!kept) {
      let oracle = c.op === "move_dates" ? (c.target.oracle as Values | undefined) : undefined;
      if (!oracle) {
        if (before.date_source == null || before.date_source === "typed" || !before.end_date) continue;
        oracle = { start_date: before.start_date, end_date: before.end_date, source: before.date_source };
      }
      kept = {
        start_date: (oracle.start_date as string) ?? null,
        end_date: (oracle.end_date as string) ?? null,
        source: (oracle.source as string) ?? null,
        restore: Object.fromEntries(RESTORED.map((f) => [f, before[f] ?? null])),
      };
    }
    kept.by = c.by_name;
    kept.at = c.at;
  }
  return kept;
}

/** The item's goal set by a person now (api: panel.goal_sets), and the own goal Restore takes off. */
export function goalSetOf(changes: Change[], item: string): Schemas["SimpleGoalSet"] | null {
  let kept: Schemas["SimpleGoalSet"] | null = null;
  for (const c of written(changes)) {
    if (c.target.item_id !== item || (c.op !== "set_goal" && c.op !== "restore_goal")) continue;
    if (c.op === "restore_goal") {
      kept = null;
      continue;
    }
    kept ??= { oracle: (c.target.oracle as Schemas["SimpleGoalPick"] | null) ?? null };
    Object.assign(kept, { by: c.by_name, at: c.at, measure: (c.target.measure as string | null) ?? null });
  }
  return kept;
}

/** Each item's `override` and `links` (api: panel.item_panel). `unlinked` are Oracle's links
 * removed before the mock's story starts (a seed's own record of that change). */
export function withPanel(items: Item[], changes: Change[], keyOf: (id: string) => string | undefined, idOf: (key: string) => string | undefined, unlinked: (key: string) => { key: string; by: string }[] = () => []): void {
  const rows = written(changes);
  for (const i of items) {
    const typed = i.source === "typed";
    const o = typed ? overrideOf(changes, i.id) : null;
    i.override = o ? { start_date: o.start_date, end_date: o.end_date, source: o.source, by: o.by, at: o.at } : null;
    const added = new Map<string, string>();
    const removed = new Map<string, string>();
    const key = keyOf(i.id);
    for (const u of key ? unlinked(key) : []) removed.set(u.key, u.by);
    for (const c of rows) {
      if (!LINK_OPS.includes(c.op) || c.target.item_id !== i.id) continue;
      const k = String(c.target.subject_key ?? "");
      if (c.op === "add_link") {
        added.set(k, c.by_name);
        removed.delete(k);
      } else if (c.op === "remove_link") {
        if (added.has(k)) added.delete(k);
        else removed.set(k, c.by_name);
      } else removed.delete(k);
    }
    const links: Schemas["SimpleLink"][] = i.depends_on.map((d) => ({ item_id: d, by: added.get(keyOf(d) ?? "") ?? null, removed: false, removed_by: null }));
    for (const [k, by] of removed) {
      const id = idOf(k);
      if (id && !i.depends_on.includes(id)) links.push({ item_id: id, by: null, removed: true, removed_by: by });
    }
    i.links = links;
    i.goal_set = goalSetOf(changes, i.id);
  }
}

/** The new depends_on of `deps` for a link op (api: changes._link_plan), or the 422's words. */
export function linkPlan(op: string, title: string, deps: string[], depKey: string, depTitle: string, waitsOn: (from: string) => boolean): string[] | string {
  if (op === "remove_link") return deps.includes(depKey) ? deps.filter((k) => k !== depKey) : "No such link";
  if (deps.includes(depKey)) return `${title} already depends on ${depTitle}`;
  if (waitsOn(depKey)) return `${depTitle} needs ${title}: it would make a loop`;
  return [...deps, depKey];
}
