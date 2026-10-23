"use client";

import { useMemo } from "react";

import { api, unwrap, type Schemas } from "@/lib/api/client";
import { calendarDay } from "@/lib/dates";
import { useQuery } from "@/lib/use-query";

import { horizonLabel, type Horizon, type ItemRow } from "./item-row";

export type Compare = "previous" | "approved";
export type ItemChange = Schemas["RoadmapItemChange"];
type FieldChange = Schemas["ItemFieldChange"];

/** The changes the Changed filter counts: everything but unchanged. */
export const CHANGED = new Set(["added", "dropped", "moved", "changed"]);
export const GHOST_PREFIX = "dropped:";

/** A milestone date: a calendar day, the same in every zone ("30 Nov 2026"). */
const day = (d: unknown, year = true) =>
  typeof d === "string" && d ? calendarDay(d, { day: "numeric", month: "short", year: year ? "numeric" : undefined }, "en-GB") : null;
const deps = (n: number) => `${n} ${n === 1 ? "dependency" : "dependencies"}`;

/** "v1" for a roadmap version's ref; "Approved v1" for the approved plan (E3 Screen and copy). */
export const versionOf = (ref: string) => ref.split("@").pop() ?? "";

/** The row's change chips (E3 Change column): what moved, dates, dependencies, edits. */
export function changeChips(c: ItemChange): { label: string; kind: "acc" | "warn" | "na" | "line" }[] {
  if (c.change === "added") return [{ label: "New", kind: "acc" }];
  if (c.change === "dropped") return [{ label: "Dropped", kind: "na" }];
  const out: { label: string; kind: "acc" | "warn" | "na" | "line" }[] = [];
  for (const f of c.fields) {
    if (f.field === "horizon") out.unshift({ label: `${horizonLabel(String(f.before))} → ${horizonLabel(String(f.after))}`, kind: "warn" });
    else if (f.field === "milestone_date")
      out.push({ label: !f.after ? "Date removed" : !f.before ? "Date added" : `Date ${day(f.before, false)} → ${day(f.after, false)}`, kind: "line" });
    else if (f.field === "depends_on") {
      if (f.added?.length) out.push({ label: `+${deps(f.added.length)}`, kind: "line" });
      if (f.removed?.length) out.push({ label: `−${deps(f.removed.length)}`, kind: "line" });
    } else if (f.field === "outcome") out.push({ label: "Outcome edited", kind: "line" });
    else if (f.field === "title") out.push({ label: "Title edited", kind: "line" });
    else if (f.field === "prd_section") out.push({ label: "PRD section changed", kind: "line" });
    else if (f.field === "rank") out.push({ label: `Rank ${f.before} → ${f.after}`, kind: "line" });
    else if (f.field === "item_key") out.push({ label: "Renamed", kind: "line" });
    else if (f.field === "milestone_name") out.push({ label: "Milestone renamed", kind: "line" });
  }
  return out;
}

/** One line of "What changed": "Horizon: Next → Now", "Date: 30 Nov 2026 → none", "Depends on: + Shipping step". */
export function changeLine(f: FieldChange, titles: ReadonlyMap<string, string>): string {
  const name = (k: string) => titles.get(k) ?? k;
  const v = (x: unknown) => (x == null || x === "" ? "none" : String(x));
  switch (f.field) {
    case "horizon":
      return `Horizon: ${horizonLabel(String(f.before))} → ${horizonLabel(String(f.after))}`;
    case "milestone_date":
      return `Date: ${day(f.before) ?? "none"} → ${day(f.after) ?? "none"}`;
    case "milestone_name":
      return `Milestone: ${v(f.before)} → ${v(f.after)}`;
    case "depends_on":
      return `Depends on: ${[...(f.added ?? []).map((k) => `+ ${name(k)}`), ...(f.removed ?? []).map((k) => `− ${name(k)}`)].join(", ")}`;
    case "outcome":
      return `Outcome: ${v(f.before)} → ${v(f.after)}`;
    case "title":
      return `Title: ${v(f.before)} → ${v(f.after)}`;
    case "prd_section":
      return `PRD section: ${v(f.before)} → ${v(f.after)}`;
    case "rank":
      return `Rank: ${v(f.before)} → ${v(f.after)}`;
    case "item_key":
      return `Renamed from ${v(f.before)}`;
    case "confidence":
      return `Confidence: ${v(f.before)} → ${v(f.after)}`;
    case "prd_section_text":
      return "The PRD section's text changed";
    case "date_state":
      return `Date: ${v(f.before)} → ${v(f.after)}`;
    default:
      return `${f.field}: ${v(f.before)} → ${v(f.after)}`;
  }
}

/**
 * The diff of a roadmap version's items against the previous version or the approved plan
 * (E3), with its changes by key and its dropped items as ghost rows to add to the table.
 */
export function useItemsDiff(doc: string, n: number, compare: Compare) {
  const q = useQuery(
    `roadmap-items-diff|${doc}|${n}|${compare}`,
    () => unwrap(api.GET("/v1/roadmap-items/diff", { params: { query: { head: `${doc}@${n}`, base: compare } } })),
    { keepPrevious: true },
  );
  const diff = q.data;
  const byKey = useMemo(() => {
    const m = new Map<string, ItemChange>();
    for (const c of diff?.items ?? []) m.set(c.change === "dropped" ? GHOST_PREFIX + c.item_key : c.item_key, c);
    return m;
  }, [diff]);
  // A dropped item sits right after the head item before it in the diff's order, in the
  // horizon it had: muted, its title struck.
  const ghosts = useMemo(() => {
    const out: ItemRow[] = [];
    let at = -1;
    let k = 0;
    for (const c of diff?.items ?? []) {
      if (c.change !== "dropped") {
        at = c.head_position ?? at;
        k = 0;
        continue;
      }
      k += 1;
      out.push({
        key: GHOST_PREFIX + c.item_key,
        position: at + k / 100,
        title: c.title,
        outcome: null,
        horizon: (c.base_horizon ?? "later") as Horizon,
        milestone: null,
        confidence: null,
        depends_on: [],
        prd: null,
        ghost: true,
      });
    }
    return out;
  }, [diff]);
  return { diff, error: q.error, byKey, ghosts };
}
