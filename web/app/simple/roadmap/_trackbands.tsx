"use client";
// MOCK-HOOK: this whole file is mock-up code for ?tb=a|b|c|d (every line in it is a MOCK-HOOK line).

// Track bands mock-up (?tb=a|b|c|d): invented tracks, goals, milestones and items, and each
// proposal's band header. Temporary: the owner's decision "Track bands on the Roadmap".
import { InfoTip } from "@/components/ds";

import type { Item, Roadmap } from "./_lib";

export type Tb = "a" | "b" | "c" | "d";
export function tbOf(): Tb | null {
  if (typeof window === "undefined") return null;
  const v = new URLSearchParams(window.location.search).get("tb");
  return v === "a" || v === "b" || v === "c" || v === "d" ? v : null;
}
const longName = () => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("tblong") === "1";

type Health = { kind: "ok" | "risk" | "stale"; why: string };
type Track = { key: string; name: string; goal: string | null; owner: string | null; prd: string | null; health: Health | null };
const TRACKS: Track[] = [
  { key: "tb-scale", name: "Scale", goal: "40 replies a day", owner: "Avery Stone", prd: "Reply engine", health: { kind: "ok", why: "On track: every feature ends before its milestone" } },
  { key: "tb-safety", name: "Safety", goal: "0 blocked accounts", owner: "Jordan Lee", prd: "Account safety", health: { kind: "risk", why: "At risk: Block alerts ends Feb 11, after M7 Block alerts on Feb 4" } },
  { key: "tb-conv", name: "Conversions", goal: "30 signups a day", owner: "Sam Ortiz", prd: "Signup flow", health: { kind: "stale", why: "Not checked since Oct 20: check it to see where it stands" } },
  { key: "tb-growth", name: "Growth & Revenue", goal: "$10k revenue a day", owner: "Riley Chen", prd: "Paid plans", health: { kind: "ok", why: "On track: every feature ends before its milestone" } },
  { key: "tb-am", name: "Account Management", goal: null, owner: "Morgan Blake", prd: null, health: { kind: "ok", why: "On track: nothing late" } },
];
export const NO_TRACK = "tb-none";
const trackOf = (key: string): Track | undefined => {
  const t = TRACKS.find((x) => x.key === key);
  return t && t.key === "tb-growth" && longName() ? { ...t, name: "Growth, Revenue and Partner Marketplace Listings" } : t;
};

// [track, title, start (days from Dec 1), weeks]
const ITEMS: [string, string, number, number][] = [
  ["tb-scale", "Reply queue", -20, 5],
  ["tb-scale", "Bulk sends", 20, 7],
  ["tb-scale", "Send scheduler", 50, 6],
  ["tb-safety", "Account warm-up", -10, 4],
  ["tb-safety", "Block alerts", 35, 7],
  ["tb-safety", "Rate limit guard", 62, 5],
  ["tb-conv", "Signup page refresh", -6, 3],
  ["tb-conv", "Trial nudges", 30, 5],
  ["tb-growth", "Paid plans", 5, 6],
  ["tb-growth", "Upgrade prompts", 48, 5],
  ["tb-growth", "Invoice emails", 70, 4],
  ["tb-am", "Customer check-ins", -15, 8],
  ["tb-am", "Renewal reviews", 40, 6],
  [NO_TRACK, "Help center search", 12, 4],
  [NO_TRACK, "Team invites", 55, 3],
];
// [name, day from Dec 1, track, a goal's milestone]
const MILESTONES: [string, number, string, boolean][] = [
  ["Reply queue live", 2, "tb-scale", false],
  ["Warm-up on", 16, "tb-safety", false],
  ["New signup page", 16, "tb-conv", false],
  ["Paid plans open", 44, "tb-growth", false],
  ["Bulk sends", 51, "tb-scale", false],
  ["0 blocked accounts", 58, "tb-safety", true],
  ["Block alerts", 65, "tb-safety", false],
  ["30 signups a day", 79, "tb-conv", true],
  ["40 replies a day", 86, "tb-scale", true],
];

const day = (from: string, n: number) => new Date(Date.parse(from + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

/** The roadmap with the invented tracks: one group per track, in order, then No track. */
export function tbData(data: Roadmap): Roadmap {
  const base = data.items.find((i) => i.status !== "cut" && i.status !== "merged" && i.status !== "done") ?? data.items[0];
  if (!base) return data;
  const dec1 = `${data.today.slice(0, 4)}-12-01`;
  const mk = (n: number, track: string, title: string, s: number, w: number, status = base.status): Item => {
    const t = TRACKS.find((x) => x.key === track);
    return {
      ...base,
      id: `tb-item-${n}`,
      key: `TB-${n}`,
      code: null,
      title,
      status,
      draft: false,
      estimated: false,
      estimate_pending: false,
      suggestion: null,
      start: { ...base.start, date: day(dec1, s) },
      end: { ...base.end, date: day(dec1, s + w * 7) },
      track: t ? { ...(base.track ?? {}), id: t.key, title: t.name } as Item["track"] : null,
      goal: t?.goal ? { ...(base.goal ?? {}), id: `goal-${t.key}`, title: t.goal, metric: null } as Item["goal"] : null,
      prd: t?.prd ? { ...(base.prd ?? base.roadmap), id: `prd-${t.key}`, slug: `prd-${t.key}`, title: t.prd } as Item["prd"] : null,
      milestone: null,
      phases: [],
      depends_on: [],
      needed_by: [],
      depends_keys: [],
      depends_key_of: {},
      depends_keys_of: {},
      suggested_depends: [],
      flags: [],
      parent_key: null,
      part_of: null,
      part_path: [],
      parts: [],
      slices: [],
      milestones: [],
      goal_ids: [],
      merged_into: null,
    } as Item;
  };
  const items = ITEMS.map(([track, title, s, w], n) => mk(n + 1, track, title, s, w));
  const cut = mk(99, "tb-growth", "Gift cards", 30, 4, "cut");
  const groups = [...TRACKS.map((t) => t.key), NO_TRACK].map((key) => ({
    key,
    title: key === NO_TRACK ? "No track" : trackOf(key)!.name,
    item_ids: items.filter((i) => (i.track?.id ?? NO_TRACK) === key).map((i) => i.id).concat(key === "tb-growth" ? [cut.id] : []),
  }));
  // The Roadmap's one Milestones band (goal milestones, one code each by date); three are goals' targets.
  const goal_milestones = MILESTONES.map(([name, d, track, isGoal], n) => {
    const t = TRACKS.find((x) => x.key === track)!;
    return {
      id: `tb-ms-${n + 1}`,
      roadmap_id: base.roadmap.id,
      code: `M${n + 1}`,
      roadmap_code: `M${n + 1}`,
      name,
      date: day(dec1, d),
      goal_id: isGoal ? `goal-${t.key}` : null,
      item_ids: [],
      counts_when: "Holds 7 days in a row",
      progress: null,
      prd: null,
      prd_owner: null,
      pending: null,
      can_change: false,
      can_propose: false,
      carried_from: null,
    };
  }) as unknown as Roadmap["goal_milestones"];
  return { ...data, group: "track", groups, items: [...items, cut], milestones: [], goal_milestones, key_dates: [], drafts: [] as unknown as Roadmap["drafts"] };
}

/** A track's initials ("Avery Stone": "AS"). */
const initials = (name: string) => name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

function Mark({ h }: { h: Health }) {
  return h.kind === "ok" ? (
    <span aria-hidden className="font-bold text-pass">✓</span>
  ) : (
    <span aria-hidden className="font-bold text-warn">⚠</span>
  );
}

/** A band's header for the proposal `tb` (`stack`: the Gantt's two lines, the goal under the name). */
export function TbHead({ tb, laneKey, title, stack = false }: { tb: Tb; laneKey: string; title: string; stack?: boolean }) {
  const t = trackOf(laneKey);
  if (!t) return <span className={`truncate font-semibold ${stack ? "text-[15px] leading-[18px]" : ""}`}>{title}</span>;
  const goal = t.goal && tb !== "d" ? t.goal : null;
  const name = <span className="truncate font-semibold">{t.name}</span>;
  const nameTip =
    tb === "c" ? (
      <InfoTip label={t.name} align="start" side="bottom" testId="tb-name-tip" trigger={name}>
        <span className="block font-semibold">{t.name}</span>
        <span className="block">Owner: {t.owner ?? "none"}</span>
        <span className="block">PRD: {t.prd ?? "none"}</span>
      </InfoTip>
    ) : tb === "a" || tb === "b" ? (
      <InfoTip label={t.name} align="start" side="bottom" testId="tb-name-tip" trigger={name}>
        <span className="block">{t.goal ? `${t.name} · Goal: ${t.goal}` : `${t.name} · No goal`}</span>
      </InfoTip>
    ) : (
      name
    );
  const extra = (
    <>
      {tb === "b" && t.owner && (
        <InfoTip label={t.owner} align="start" side="bottom" testId="tb-owner" trigger={<span className="inline-flex h-5 min-w-6 items-center justify-center rounded-full border border-line bg-surface px-1.5 text-[11px] font-semibold text-text2">{initials(t.owner)}</span>}>
          Owner: {t.owner}
        </InfoTip>
      )}
      {tb === "c" && t.health && (
        <InfoTip label={t.health.kind === "ok" ? "On track" : "Needs a look"} align="start" side="bottom" testId="tb-health" trigger={<Mark h={t.health} />}>
          {t.health.why}
        </InfoTip>
      )}
      {tb === "d" && (
        <InfoTip label={t.name} align="start" side="bottom" testId="tb-info">
          <span className="block font-semibold">{t.name}</span>
          <span className="block">Goal: {t.goal ?? "none"}</span>
          <span className="block">Owner: {t.owner ?? "none"}</span>
          <span className="block">PRD: {t.prd ?? "none"}</span>
          {t.health && <span className="block">{t.health.why}</span>}
        </InfoTip>
      )}
    </>
  );
  if (stack)
    return (
      <>
        <span className="pointer-events-auto flex min-w-0 items-center gap-1.5 text-[15px] leading-[18px]">
          {nameTip}
          {extra}
        </span>
        {goal && <span className="truncate text-xs leading-[15px] text-text2">{goal}</span>}
      </>
    );
  return (
    <span className="pointer-events-auto inline-flex items-center gap-1.5">
      {nameTip}
      {goal && <span className="font-normal text-text2">· {goal}</span>}
      {extra}
    </span>
  );
}

/** The phone's list: an item's band (its track's place, No track, then Below the line). */
export function tbRank(data: Roadmap, i: Item): number {
  if (i.status === "cut" || i.status === "merged") return 99;
  const n = data.groups.findIndex((g) => g.item_ids.includes(i.id));
  return n < 0 ? 98 : n;
}
export function tbBand(data: Roadmap, i: Item): { key: string; title: string; below: boolean } | null {
  if (i.status === "cut" || i.status === "merged") return { key: "below", title: "Below the line", below: true };
  const g = data.groups.find((x) => x.item_ids.includes(i.id));
  return g ? { key: g.key, title: g.title, below: false } : null;
}
