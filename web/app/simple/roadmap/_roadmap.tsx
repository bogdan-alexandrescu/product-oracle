"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent } from "react";

import { Button, clearToast, Icon, Notice, SegmentedControl, toast as dsToast, type ToastAsk } from "@/components/ds";
import { GoalPanel, goalRows, SuggestionCard, useGoalSuggestions, type GoalBrief, type GoalPanelStart, type GoalSuggestionsApi } from "@/components/simple/GoalSuggestions";
import { DecisionNotes, LeftOutLine } from "@/components/simple/DecisionNotes";
import { GoalNum, GoalNumbers } from "@/components/simple/GoalOrder";
import { StartSheet } from "@/components/simple/meetings/StartSheet";
import { Loading } from "@/components/ui";
import { getBranding, logoDataUrl } from "@/lib/api/branding";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { draftNext } from "@/lib/simple-home";
import { invalidateWaiting, reloadWaiting, waitingChanged } from "@/lib/simple-waiting";
import { CARD_CHANGED_EVENT } from "@/lib/api/simple-chat";
import { displayZone, formatInZone } from "@/lib/dates";
import { formatDate } from "@/lib/format";
import { goalNumbers } from "@/lib/goal-tree";
import { useMe } from "@/lib/me";
import { byPrdOrderOf, usePrdOrder } from "@/lib/prd-order";
import { useQuery } from "@/lib/use-query";

import { QuickAdd } from "./_add";
import { RemovedButton } from "./_removed";
import { TracksButton } from "./_tracks";
import { MsCard, MsKey, MsLayer, MsProvider, MsToast, useMilestones, type MsLane, type MsRow } from "./_milestones";
import { Board, boardColumns, boardLegend, HORIZONS, LEGEND_SWATCH, LegendKeys, MARK_WORDS, PM_LANE, type Horizon, type LegendEntry } from "./_board";
import { useKeyBurst } from "./_burst";
import { FeatureContextMenu, useFeatureDelete } from "@/components/simple/FeatureDelete";
import { changeRowWords, FlagLine, FixButtons, FloatingCard, LooksLike, OpenItem, opWords, ProposedFixes, SuggestionPopover, type Act } from "./_card";
import { boardPicture, chartPicture, exportView, TooLarge, zoomPicture, type Brand } from "./_export";
import { DraftLayer, DraftPrdsRead, useShowDrafts, type DraftItem, type DraftPrd } from "./_drafts";
import { KeyDatesEditor } from "./_keydates";
import { FeaturePanel } from "./_panel";
import { Lanes, pmItem } from "./_lanes";
import {
  addDays,
  broken,
  brokenLinks,
  ChangeFailed,
  changedWords,
  closedItem,
  partsTree,
  decide,
  decisionCounts,
  deciderWords,
  lanes,
  nearWords,
  nextQuarter,
  propose,
  quarterOf,
  quarters,
  quarterValue,
  resultWords,
  shortDay,
  spanWords,
  shownDates,
  storedDates,
  suggestion,
  undo,
  type Change,
  type ChangeResult,
  type Draft,
  type Format,
  type GanttUnit,
  type Item,
  type Lane,
  type Roadmap,
  type Where,
  setRoadmapToday,
  yearSpan,
  drawnKeyDates,
  type Scale as ChartScale,
} from "./_lib";
import { Chart, PHASES, type Layout } from "./_timeline";
import { ConflictPanel, ZoomTimeline } from "./_zoom";

/** #34: the Roadmap's toasts sit in the bottom-right corner on a desktop, clear of the chart. */
const toast = (ask: ToastAsk) => dsToast({ place: "corner", ...ask });

const FORMAT_WORDS: Record<Format, string> = { timeline: "Timeline", gantt: "Gantt", board: "Now / Next / Later", waterfall: "Waterfall" };

/** The company's branding for an export (its logo for the theme on screen); none when it
 * cannot be read. */
async function brandOf(): Promise<Brand | null> {
  try {
    const b = await getBranding();
    const root = document.documentElement.dataset.theme;
    const dark = root === "dark" || (root !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    const logo = (dark && b.logo_dark) || b.logo;
    return { name: b.display_name, logo: logo ? await logoDataUrl(logo).catch(() => null) : null, accent: b.accent, disclaimer: b.public_disclaimer, mark: b.oracle_mark };
  } catch {
    return null;
  }
}

type Filters = { group: Lane; roadmap: string; prd: string; goal: string; track: string; from: string; to: string };
const NO_FILTERS: Filters = { group: "goal", roadmap: "", prd: "", goal: "", track: "", from: "", to: "" };
type Picks = Record<"prd" | "goal" | "track", Set<string>>;
const PICKS = ["prd", "goal", "track"] as const;
/** roadmap-stale-filters: the PRDs, goals and tracks a roadmap's items are on (what its filters may pick). */
/** RP2: no draft PRDs, one shared empty list (memoised reads keep their identity). */
const NO_DRAFTS: DraftPrd[] = [];
const picksOf = (items: Roadmap["items"]): Picks => ({
  prd: new Set(items.flatMap((i) => (i.prd ? [i.prd.slug] : []))),
  goal: new Set(items.flatMap((i) => (i.goal ? [i.goal.key] : []))),
  track: new Set(items.flatMap((i) => (i.track ? [i.track.id] : []))),
});
/** Saved picks with those `gone` says left blank. */
const without = (saved: Schemas["SimpleFilters"], gone: (k: (typeof PICKS)[number], v: string) => boolean): Schemas["SimpleFilters"] =>
  Object.fromEntries(PICKS.map((k) => [k, saved[k] && !gone(k, saved[k]) ? saved[k] : ""])) as Schemas["SimpleFilters"];

const PHONE = "(max-width: 640px)";
function usePhone(): boolean {
  return useSyncExternalStore(
    (on) => {
      const m = window.matchMedia(PHONE);
      m.addEventListener("change", on);
      return () => m.removeEventListener("change", on);
    },
    () => window.matchMedia(PHONE).matches,
    () => false,
  );
}

type Dates = ReturnType<typeof storedDates>;
const sameDates = (a: Dates, b: Dates) => a.start_date === b.start_date && a.end_date === b.end_date;
const sameHorizon = (a: Horizon, b: Horizon) => a === b;

// pre-demo QA Demo 8: a draft's time with its day, month first, in the company zone, as the rest of
// the app writes one ("Nov 6, 2026, 4:43 AM PST"), never a bare "4:43 AM".
const time = (at: string) => formatInZone(at, displayZone(), { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).replace(/ at /, ", ");

/** fix4 qa-simple-roadmap-35: a key date's two marks: filled, and hollow while it is only in the draft. */
function keyDateEntries(data: Roadmap): LegendEntry[] {
  const kds = drawnKeyDates(data);
  const out: LegendEntry[] = [];
  if (kds.some((k) => !k.in_draft)) out.push({ key: "key", swatch: <i aria-hidden className="inline-block h-2 w-2 flex-none rotate-45 bg-accent-ink" />, words: "Key date" });
  if (kds.some((k) => k.in_draft))
    out.push({ key: "key-draft", swatch: <i aria-hidden className="inline-block h-2 w-2 flex-none rotate-45 border border-accent-ink bg-surface" />, words: "Key date in the draft" });
  return out;
}

/** qa4-simple-roadmap-8: one count per group in every view and on the goal cards: an item sits
 * in its first group only, and grouped by goal its PM-owned work leaves the goal for a lane of
 * its own after the goals, as the Timeline draws it (the Gantt, the Waterfall and Now / Next /
 * Later read these same groups). */
function oneLane(data: Roadmap, group: Lane): Roadmap {
  const byId = new Map(data.items.map((i) => [i.id, i]));
  const seen = new Set<string>();
  const pm: string[] = [];
  const groups = data.groups.flatMap((g) => {
    const ids = g.item_ids.filter((id) => byId.has(id) && !seen.has(id));
    for (const id of ids) seen.add(id);
    const own: string[] = [];
    for (const id of ids) {
      const i = byId.get(id)!;
      if (group === "goal" && !closedItem(i) && pmItem(i)) pm.push(id);
      else own.push(id);
    }
    return own.length ? [{ ...g, item_ids: own }] : [];
  });
  if (pm.length) groups.push({ key: PM_LANE, title: "PM-owned", item_ids: pm });
  // feature-parts: every live part, at any depth, sits under its live parent in its top
  // parent's group (partsTree); one whose parent is not shown keeps its own place.
  const tree = partsTree(groups.map((g) => g.item_ids), byId);
  const placed = groups.map((g, n) => ({ ...g, item_ids: tree[n].map((x) => x.id) })).filter((g) => g.item_ids.length);
  return { ...data, groups: placed };
}

const TODAY_ENTRY: LegendEntry = { key: "today", swatch: <i aria-hidden className="inline-block h-3.5 w-0.5 flex-none bg-crit" />, words: "Today" };

/** qa4-simple-roadmap-31: a labelled group of legend entries ("Phases: Discover · Build · …"), read as one. */
function legendGroup(key: string, label: string, entries: LegendEntry[]): LegendEntry {
  return {
    key,
    testId: "legend-group",
    swatch: null,
    words: (
      <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1" data-group={key}>
        <span className="font-semibold text-text2">{label}</span>
        {entries.map((e) => (
          <span key={e.key} className="inline-flex items-center gap-1.5" data-testid={e.testId ?? "legend-item"} data-key={e.key}>
            {e.swatch}
            {e.words}
          </span>
        ))}
      </span>
    ),
  };
}

/** The Gantt's legend (roadmap-milestones D), naming only what the chart draws. fix4
 * qa-simple-roadmap-34: the Timeline's style (a swatch, then short words). */
function ganttLegend(data: Roadmap, noWork: { start: string; end: string; label?: string | null }[], pulled: number): LegendEntry[] {
  const parts: LegendEntry[] = [];
  const add = (key: string, swatch: LegendEntry["swatch"], words: string) => parts.push({ key, swatch, words });
  const sw = LEGEND_SWATCH;
  const dated = (i: Item) => i.slices.filter((x) => x.start_date && x.end_date);
  if (data.items.some((i) => dated(i).length > 1)) add("slices", <i aria-hidden className="inline-block w-[18px] flex-none border-t-2 border-dotted border-line-strong" />, MARK_WORDS.slices);
  if (data.milestones.some((m) => m.start_date && m.end_date)) add("milestone", <i aria-hidden className="inline-block h-2 w-2 flex-none rotate-45 bg-accent-ink" />, "Milestone ends (dashed line)");
  // #22: the API's own label, as the Timeline says it ("Holidays year-end break").
  if (noWork.length) add("holidays", <i aria-hidden className="inline-block h-2.5 w-[18px] flex-none rounded-[2px] bg-na-bg" />, `Holidays ${noWork.map((h) => h.label ? h.label.charAt(0).toLowerCase() + h.label.slice(1) : spanWords(h.start, h.end, data.today, true)).join(", ")}`);
  if (data.items.some((i) => dated(i).some((x) => x.pm_owned || x.effort_weeks == null))) add("pm", <i aria-hidden className={`${sw} border-dashed border-line-strong`} />, MARK_WORDS.pm);
  if (pulled) add("pulled", <i aria-hidden className={sw} style={{ background: "var(--warn-bg)", borderColor: "var(--warn)" }} />, "Pulled in, pending");
  const plain = data.items.filter((i) => !dated(i).length && !closedItem(i));
  if (plain.some((i) => !i.draft && !i.estimated)) add("dated", <i aria-hidden className={sw} style={{ background: "var(--accent)", borderColor: "var(--accent-ink)" }} />, "Dated");
  if (plain.some((i) => !i.draft && i.estimated))
    add("estimated", <i aria-hidden className={sw} style={{ background: "repeating-linear-gradient(135deg, var(--accent-mid) 0 2px, var(--accent-soft) 2px 5px)", borderColor: "var(--line-strong)" }} />, MARK_WORDS.estimated);
  if (plain.some((i) => i.draft)) add("draft", <i aria-hidden className={`${sw} border-dashed border-line-strong`} />, "Draft");
  if (data.items.some((i) => i.suggestion)) add("suggestion", <i aria-hidden className={`${sw} border-dotted border-accent-ink`} />, MARK_WORDS.suggestion);
  if (data.milestones.some((m) => m.date && !(m.start_date && m.end_date))) add("track", <i aria-hidden className="inline-block h-2 w-2 flex-none rotate-45 bg-warn" />, "A track’s milestone");
  parts.push(...keyDateEntries(data));
  // The Gantt's bar draws every red flag red: the words name the ones shown.
  const links = data.items.some((i) => brokenLinks(i).length > 0);
  const other = data.items.some((i) => broken(i).length > brokenLinks(i).length);
  if (links || other)
    add("broken", <i aria-hidden className={sw} style={{ borderColor: "var(--crit)", borderWidth: 2 }} />, links && other ? "A broken link, or a problem to fix" : links ? "A broken link" : "A problem to fix");
  parts.push(TODAY_ENTRY);
  return parts;
}

/** The goal counters (each goal's metric line): items, and how many need a decision. S7:
 * each goal's suggested features open its panel; a goal with no items yet has its own tile.
 * QA2 cld-1: a goal's tile counts the items its lane shows: the chart's goal grouping (lanes(),
 * an item with no goal of its own under the goal its plan moves), live work only, PM-owned
 * work in its own lane as the chart draws it. */
function GoalCounters({ data, byGoal, suggestions, onGoal, only }: { data: Roadmap; byGoal: boolean; suggestions: GoalSuggestionsApi; onGoal: (g: GoalBrief) => void; only: { key: string; title: string } | null }) {
  const numbers = useContext(GoalNumbers);
  // pre-demo QA G-8: asking for suggestions is a commenter's and up (the API refuses a viewer); reading them is anyone's.
  const suggests = useMe().can("create_goal_suggestion");
  const count = (id: string) => (suggestions.data?.suggestions ?? []).filter((s) => s.goal.id === id).length;
  // qa4-simple-roadmap-10: a goal its plan names (no id of its own here) is found by its title.
  const known = (id: string, title?: string) => suggestions.data?.goals.find((g) => g.goal.id === id || (!!title && g.goal.title === title))?.goal;
  const byId = new Map(data.items.map((i) => [i.id, i]));
  const shown = (i: Item | undefined): i is Item => !!i && !closedItem(i) && !pmItem(i);
  const goals = new Map<string, { title: string; metric: string | null; items: number; broken: number }>();
  const add = (key: string, title: string, i: Item) => {
    const g = goals.get(key) ?? { title, metric: i.goal?.metric ?? null, items: 0, broken: 0 };
    g.items += 1;
    // fix4 qa-simple-roadmap-8: "broken" is a broken link only (a draft with no owner is not one).
    if (brokenLinks(i).length) g.broken += 1;
    goals.set(key, g);
  };
  if (byGoal) {
    // qa4-simple-roadmap-8: the very groups every view draws (oneLane), so a card's count is its lane's.
    for (const g of oneLane(lanes(data, "goal"), "goal").groups) if (g.key !== "none" && g.key !== PM_LANE) for (const id of g.item_ids) if (shown(byId.get(id))) add(g.key, g.title, byId.get(id)!);
  } else
    for (const i of data.items) {
      if (!shown(i)) continue;
      const planGoal = i.slices.find((x) => x.goal)?.goal;
      if (i.goal) add(i.goal.id, i.goal.title, i);
      else if (planGoal) add(suggestions.data?.goals.find((g) => g.goal.title === planGoal)?.goal.id ?? `plan-goal:${planGoal}`, planGoal, i);
    }
  const titles = new Set([...goals.values()].map((g) => g.title));
  // fix4 qa-simple-roadmap-13: with a Goal filter, only that goal's card shows (an empty card
  // when the other filters leave it no items), never another goal's.
  const picked = (id: string, title: string, key?: string) => !only || title === only.title || key === only.key || id === only.key;
  const empty = (suggestions.data?.goals ?? []).filter((g) => (g.empty || only) && !goals.has(g.goal.id) && !titles.has(g.goal.title) && picked(g.goal.id, g.goal.title, g.goal.key));
  // fix4 qa-simple-roadmap-33: one order whatever the grouping: the company's goal order, then by title.
  const rank = (id: string, title: string) => {
    const n = (suggestions.data?.goals ?? []).findIndex((g) => g.goal.id === id || g.goal.title === title);
    return n < 0 ? Number.MAX_SAFE_INTEGER : n;
  };
  const cards = [...goals.entries()].filter(([id, g]) => picked(id, g.title)).sort(([a, x], [b, y]) => rank(a, x.title) - rank(b, y.title) || x.title.localeCompare(y.title));
  const filteredOut = only && !cards.length && !empty.length;
  if (!cards.length && !empty.length && !filteredOut) return null;
  const open = (id: string, title: string) => {
    const g = known(id, title);
    return g && (count(id) > 0 || suggests) ? (
      <button type="button" data-testid="goal-counter-suggestions" onClick={() => onGoal(g)} className="text-sm font-semibold text-accent-ink hover:underline">
        {/* QA2 24: no "0 suggested features": with none yet, the button says what it opens. */}
        ✦ {count(id) ? `${count(id)} suggested ${count(id) === 1 ? "feature" : "features"}` : "Suggest a feature"}
        <span className="sr-only"> for {title}</span>
      </button>
    ) : null;
  };
  const numberOf = (id: string, title: string) => numbers.get(id) ?? numbers.get(title) ?? null;
  const counterCard = (id: string, g: (typeof cards)[number][1]) => (
    <li key={id} data-testid="goal-counter" className="rounded-xl border border-line bg-surface px-3 py-2">
      <p className="truncate text-[15px] font-semibold" title={g.title}>
        <GoalNum n={numberOf(id, g.title)} />
        {g.title}
      </p>
      {/* fix4 qa-simple-roadmap-49: the metric wraps to a second line, its full words on hover past that. */}
      <p className="line-clamp-2 text-sm break-words text-text2" title={g.metric ?? undefined} data-testid="goal-counter-metric">
        {g.metric ?? "No metric yet"}
      </p>
      <p className="mt-0.5 text-sm">
        <b className="tnum">{g.items}</b> {g.items === 1 ? "item" : "items"}
        {g.broken > 0 && (
          <span className="text-crit">
            {" "}
            · <b className="tnum">{g.broken}</b> broken
          </span>
        )}
      </p>
      {open(id, g.title)}
    </li>
  );
  const emptyCard = (g: (typeof empty)[number]) => (
    <li key={g.goal.id} data-testid="goal-counter-empty" className="rounded-xl border border-dashed border-line-strong bg-surface px-3 py-2">
      <p className="truncate text-[15px] font-semibold" title={g.goal.title}>
        <GoalNum n={numberOf(g.goal.id, g.goal.title)} />
        {g.goal.title}
      </p>
      <p className="truncate text-sm text-text2">{g.empty ? "No items yet" : "No items in these filters"}</p>
      {open(g.goal.id, g.goal.title)}
    </li>
  );
  return (
    <ul className="grid grid-cols-2 gap-2 min-[900px]:grid-cols-4" data-testid="goal-counters">
      {/* qa4-simple-roadmap-10: a card for every goal with a lane (the grid wraps past four). */}
      {/* goal-order: every card in the one goal order, goals with no items among the others. */}
      {[...cards.map(([id, g]) => ({ id, title: g.title, card: g, empty: null })), ...empty.map((g) => ({ id: g.goal.id, title: g.goal.title, card: null, empty: g }))]
        .sort((a, b) => rank(a.id, a.title) - rank(b.id, b.title) || a.title.localeCompare(b.title))
        .map((t) => (t.card ? counterCard(t.id, t.card) : emptyCard(t.empty!)))}
      {filteredOut && (
        <li data-testid="goal-counter-empty" className="rounded-xl border border-dashed border-line-strong bg-surface px-3 py-2">
          <p className="truncate text-[15px] font-semibold" title={only?.title}>
            {only?.title}
          </p>
          <p className="truncate text-sm text-text2">No items in these filters</p>
        </li>
      )}
    </ul>
  );
}

function Select({ label, value, options, onChange, all = "All", testId }: { label: string; value: string; options: [string, string][]; onChange: (v: string) => void; all?: string; testId?: string }) {
  return (
    <label className="flex items-center gap-1.5 text-sm text-text2">
      {label}
      {/* D1: as wide as its choice ("All"), so the filters sit on one line. */}
      {/* qa4-simple-roadmap-46: named by its label's word alone, not every option's text. */}
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId} className="h-8 max-w-[11rem] rounded-lg border border-line-strong bg-surface px-2 text-sm text-text [field-sizing:content]">
        <option value="">{all}</option>
        {/* roadmap-stale-filters: a pick it has no choice for is named, never shown as "All". */}
        {value && !options.some(([v]) => v === value) && <option value={value}>Not on this roadmap</option>}
        {options.map(([v, t]) => (
          <option key={v} value={v}>
            {t}
          </option>
        ))}
      </select>
    </label>
  );
}

/** approved-prd-roadmap: "2 items and 2 key dates came from Visit reminders (version 1)". */
function prdWords(p: { prd: { title: string }; version?: number | null; items: number; key_dates: number }): string {
  const parts = [p.items ? `${p.items} ${p.items === 1 ? "item" : "items"}` : "", p.key_dates ? `${p.key_dates} ${p.key_dates === 1 ? "key date" : "key dates"}` : ""].filter(Boolean);
  return `${parts.join(" and ")} came from ${p.prd.title}${p.version ? ` (version ${p.version})` : ""}`;
}

/** Where an item's card or Oracle's dates open: under its bar in the chart (`wrap`), above it when there is no room. */
function barAnchor(wrap: HTMLElement | null, id: string): { left: number; top: number; above: number } {
  const el = wrap?.querySelector(`[data-bar-id="${id}"]`);
  const box = wrap?.getBoundingClientRect();
  const r = el?.getBoundingClientRect();
  if (!r || !box) return { left: 0, top: 0, above: 0 };
  return { left: Math.max(0, Math.min(r.left - box.left, box.width - 390)), top: r.bottom - box.top + 6, above: r.top - box.top - 6 };
}

/** The working-draft banner (D18 as amended: one shared draft per roadmap). */
function DraftBanner({ drafts, inReview, meId, onUndo, onSubmit, onApprove, onReview, titleOf, nameOf, personOf, focus }: { drafts: Draft[]; inReview: number; meId: string | null; onUndo: (id: string) => void; onSubmit: (d: Draft[]) => void; onApprove: (d: Draft[]) => void; onReview: (prdSlug: string) => void; titleOf: (id: string | null) => string | undefined; nameOf?: (id: string) => string; personOf?: (id: string) => string | undefined; focus?: string | null }) {
  const [open, setOpen] = useState(false);
  const byPrd = byPrdOrderOf(usePrdOrder());
  // Review: Home's "Open draft to approve" (?draft=<id>) lands on that draft: in sight, its button focused, once.
  const focused = useRef(false);
  const onFocus = useCallback((el: HTMLElement | null) => {
    if (!el || focused.current) return;
    focused.current = true;
    el.scrollIntoView({ block: "center" });
    el.querySelector<HTMLButtonElement>("[data-step]")?.focus();
  }, []);
  const working = drafts.filter((d) => d.status === "working" || d.status === "submitted");
  if (!working.length) {
    if (!inReview) return null;
    return (
      <Notice tone="info" testId="in-review-banner">
        {inReview} {inReview === 1 ? "change is" : "changes are"} in review: you see the approved roadmap until review passes.
      </Notice>
    );
  }
  const changes = working.reduce((n, d) => n + d.changes, 0);
  const since = working.map((d) => d.created_at).sort()[0];
  const log = working.flatMap((d) => d.change_log).sort((a, b) => (a.at < b.at ? -1 : 1));
  const last = [...log].reverse().find((c) => c.by === meId);
  const ready = (d: Draft) => d.status === "working" && (d.changes > 0 || !!d.from_prds?.length);
  // roadmap-decide (owner, Nov 4: draft, shown live): the decider approves and publishes in place; others send it for review.
  const publishable = working.filter((d) => ready(d) && d.can_publish);
  const submittable = working.filter((d) => ready(d) && d.can_submit && !d.can_publish);
  // approved-prd-roadmap: what each approved PRD put in the draft, in the company PRD order (prd-order).
  const fromPrds = working.flatMap((d) => d.from_prds ?? []).sort((a, b) => byPrd(a.prd, b.prd));
  // walkb-roadmap review 5a: a roadmap built from a PRD and not approved yet has no approved roadmap to keep published.
  const published = working.every((d) => d.published);
  // roadmap-decide: what happens next and who acts, with that person's button (Send for review, or the decider's Approve).
  const next = draftNext({ ...working[0], published }, nameOf);
  const approvable = working.filter((d) => d.status === "submitted" && d.can_approve);
  const many = working.length > 1;
  // Review: with several working drafts, one line each: its roadmap, its own next step, its own button.
  const step = (d: Draft) =>
    ready(d) && d.can_publish ? (
      <Button variant="solid" data-step className="max-[640px]:px-2.5" data-testid="draft-publish" onClick={() => onApprove([d])}>
        Approve and publish
      </Button>
    ) : ready(d) && d.can_submit ? (
      <Button variant="solid" data-step onClick={() => onSubmit([d])}>
        Send for review
      </Button>
    ) : d.status === "submitted" && d.can_approve ? (
      <Button variant="solid" data-step data-testid="draft-approve" onClick={() => onApprove([d])}>
        Approve
      </Button>
    ) : null;
  const mine = focus ? working.find((d) => d.id === focus) : undefined;
  // Review minor: whose draft it is, named by the draft itself, so it is right from the first paint.
  const author = (d: Draft) => d.created_by_name ?? personOf?.(d.created_by);
  return (
    <section
      data-testid="draft-banner"
      ref={mine && !many ? onFocus : undefined}
      data-focused={mine && !many ? "true" : undefined}
      className="rounded-xl border border-accent-mid bg-accent-soft px-4 py-2.5 text-accent-ink"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 max-[640px]:gap-x-1.5">
        {/* fix4 qa-simple-roadmap-19: on a phone the sentence takes its own line(s), the three buttons a row under it. */}
        <p className="min-w-0 flex-1 text-[15px] max-[640px]:basis-full" data-testid="draft-words">
          {many ? (
            <>
              <b>Your working drafts</b> · {working.length} roadmaps · <span data-testid="draft-count">{changes}</span> {changes === 1 ? "change" : "changes"} since {time(since)}
            </>
          ) : (
            <>
              {/* Review: another person's draft (the decider reading the owner's) names whose it is and its roadmap. */}
              <b>{working[0].created_by === meId || !meId ? "Your working draft" : author(working[0]) ? `${author(working[0])}'s working draft of the ${working[0].document.title}` : `The working draft of the ${working[0].document.title}`}</b> · <span data-testid="draft-count">{changes}</span> {changes === 1 ? "change" : "changes"} since {time(since)} · <span data-testid="draft-next">{next.words}</span>
            </>
          )}
        </p>
        {/* roadmap-decide: a hair tighter on a phone, so Approve and publish keeps the row. */}
        <Button variant="ghost" className="max-[640px]:px-1.5" disabled={!last} onClick={() => last && onUndo(last.id)}>
          Undo
        </Button>
        <Button variant="ghost" className="max-[640px]:px-1.5" aria-expanded={open} onClick={() => setOpen(!open)}>
          See changes
        </Button>
        {/* Review: each draft's own next step: Approve and publish for the decider's, Send for review for the others. */}
        {!many && publishable.length > 0 && (
          <Button variant="solid" data-step className="max-[640px]:px-2.5" data-testid="draft-publish" onClick={() => onApprove(publishable)}>
            Approve and publish
          </Button>
        )}
        {/* Review: only while something can be sent: the decider of a draft sent already sees Approve alone. */}
        {!many && submittable.length > 0 && (
          <Button variant="solid" data-step onClick={() => onSubmit(submittable)}>
            Send for review
          </Button>
        )}
      </div>
      {many && (
        <ul className="mt-1.5 space-y-1.5">
          {working.map((d) => (
            <li
              key={d.id}
              data-testid="draft-line"
              ref={d.id === focus ? onFocus : undefined}
              data-focused={d.id === focus ? "true" : undefined}
              className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border-t border-accent-mid pt-1.5 text-[15px] ${d.id === focus ? "bg-surface px-2 pb-1.5 ring-2 ring-accent-mid" : ""}`}
            >
              <span className="min-w-0 flex-1">
                <b>{d.document.title}</b> · {d.changes} {d.changes === 1 ? "change" : "changes"} · <span data-testid="draft-next">{draftNext(d, nameOf).words}</span>
              </span>
              {step(d)}
            </li>
          ))}
        </ul>
      )}
      {/* inbox-meeting-proposals fix: a version sent for review that I may approve (a required reviewer, the decider);
          its line holds the draft's one Approve. With several drafts each line's own step is the Approve. */}
      {!many &&
        approvable.map((d) => (
          <p key={d.id} tabIndex={-1} className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded text-sm focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-accent" data-testid="draft-approval" data-draft-id={d.id}>
            <span className="min-w-0">
              {d.document.title}
              {d.version ? ` version ${d.version}` : ""} is waiting for your approval
            </span>
            <Button variant="solid" data-step data-testid="draft-approve" onClick={() => onApprove([d])}>
              Approve
            </Button>
          </p>
        ))}
      {fromPrds.length > 0 && (
        <ul className="mt-1.5 space-y-1 text-sm" data-testid="draft-from-prds">
          {fromPrds.map((p) => (
            <li key={p.prd.id} className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="draft-from-prd">
              <span className="min-w-0">{prdWords(p)}</span>
              <Button variant="ghost" aria-label={`Review the items from ${p.prd.title}`} onClick={() => onReview(p.prd.slug)}>
                Review
              </Button>
            </li>
          ))}
        </ul>
      )}
      {/* decisions-reversed-or-trashed: a decision the draft cited was reversed since. */}
      <DecisionNotes notes={working.flatMap((d) => d.decision_notes ?? [])} className="mt-1.5 text-sm" />
      {open && (
        <ol className="mt-2 space-y-1 text-sm text-text" data-testid="draft-changes">
          {log.map((c) => (
            <li key={c.id}>
              {changeRowWords(c, titleOf(c.item_id))} · {c.by_name} · {time(c.at)}
              {c.in_meeting && " · in a meeting"}
            </li>
          ))}
          {!log.length && <li>No changes yet.</li>}
        </ol>
      )}
    </section>
  );
}

/**
 * approved-roadmap-to-simple: one line per shown roadmap whose approved version was applied:
 * it matches that version (with a link to it), or what differs, with "Apply version N again"
 * for an approver and up (the line's own can_apply).
 */
/** roadmap-done: the items done (shipped), off the plan, kept for history in a collapsed list; each opens the item. */
function DoneItems({ items, open, reveal, onOpen }: { items: Item[]; open: string | null; reveal?: string | null; onOpen: (item: Item) => void }) {
  const [shown, setShown] = useState(false);
  // A link to a done item (?item=): the list opens, then its panel opens at its row, once.
  const revealed = useRef<string | null>(null);
  useEffect(() => {
    const item = items.find((i) => i.id === reveal);
    if (!item || revealed.current === item.id) return;
    if (!shown) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setShown(true);
      return;
    }
    revealed.current = item.id;
    onOpen(item);
  }, [items, reveal, shown, onOpen]);
  if (!items.length) return null;
  return (
    <section data-testid="done-items" className="mt-3 rounded-xl border border-line bg-surface px-3 py-2">
      <button
        type="button"
        data-testid="done-items-toggle"
        aria-expanded={shown}
        aria-controls="roadmap-done-items"
        onClick={() => setShown((v) => !v)}
        className="inline-flex min-h-9 items-center gap-1.5 text-[14px] font-semibold text-text2 hover:text-text"
      >
        <span aria-hidden className={`inline-flex transition-transform ${shown ? "" : "-rotate-90"}`}>
          <Icon name="chevron-down" size={16} />
        </span>
        Done · {items.length}
      </button>
      {shown && (
        <ul id="roadmap-done-items" className="mt-1 flex flex-col gap-0.5 pb-1">
          {items.map((i) => (
            <li key={i.id} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
              <button
                type="button"
                data-testid="done-item"
                data-bar-id={i.id}
                aria-pressed={open === i.id}
                onClick={() => onOpen(i)}
                className="min-h-9 truncate text-left text-[14px] font-medium text-text underline-offset-2 hover:underline"
              >
                {i.title}
              </button>
              {i.goal && <span className="truncate text-[13px] text-text2">{i.goal.title}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AppliedVersions({ lines, onApply }: { lines: Schemas["SimpleAppliedVersion"][]; onApply: (line: Schemas["SimpleAppliedVersion"]) => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  if (!lines.length) return null;
  const link = (l: Schemas["SimpleAppliedVersion"]) => (
    <Link href={l.href} className="font-semibold text-accent-ink underline">
      roadmap version {l.version}
    </Link>
  );
  return (
    <div className="space-y-1 text-sm text-text2">
      {lines.map((l) => (
        <div key={l.roadmap.id} data-testid="applied-version" data-matches={l.matches ? "true" : "false"}>
          {(l.shipped.length > 0 || l.moved_out.length > 0) && (
            <p data-testid="applied-off-plan">
              {l.shipped.length > 0 && `Shipped, off the plan: ${l.shipped.join(", ")}. `}
              {l.moved_out.length > 0 && `Moved to the next PRD: ${l.moved_out.join(", ")}.`}
            </p>
          )}
          {l.matches ? (
            <p>
              {lines.length > 1 && `${l.roadmap.title}: `}Matches {link(l)}, approved {formatDate(l.approved_at)}
            </p>
          ) : (
            <>
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span>
                  {lines.length > 1 && `${l.roadmap.title}: `}Differs from {link(l)}, approved {formatDate(l.approved_at)}:
                </span>
                {l.can_apply && (
                  <Button
                    variant="ghost"
                    disabled={busy === l.roadmap.id}
                    onClick={() => {
                      setBusy(l.roadmap.id);
                      void onApply(l).finally(() => setBusy(null));
                    }}
                  >
                    Apply version {l.version} again
                  </Button>
                )}
              </p>
              <ul className="list-disc pl-5" data-testid="applied-differences">
                {l.differences.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

/** A tray tile's number over its label. */
function TileWords({ n, label }: { n: number; label: string }) {
  return (
    <>
      <b className={`tnum block text-xl ${n ? "" : "font-medium"}`}>{n}</b>
      {/* #43: every tile's label sits at the same height with tight spacing, so
       * "Dates to confirm" wrapping to two lines doesn't push its number apart from
       * the one-line labels beside it. */}
      <span className={`block min-h-[2lh] text-xs leading-tight [text-wrap:balance] ${n ? "text-text2" : ""}`}>{label}</span>
    </>
  );
}

/** C's "Needs a decision" tray, summarised by B's five counters. */
function DecisionTray({
  items,
  byId,
  proposals,
  act,
  canChange,
  onDecide,
  onSuggestion,
  onClose,
  phone,
  suggestions,
  top,
  allLinks,
  allDates,
  oneRoadmap,
  waitsFor,
  onAll,
}: {
  items: Item[];
  byId: Map<string, Item>;
  proposals: Change[];
  act: Act;
  canChange: boolean;
  onDecide: (c: Change, how: "accept" | "decline") => void;
  onSuggestion: (i: Item, how: "accept" | "dismiss", id?: string) => void;
  onClose: () => void;
  phone: boolean;
  suggestions: GoalSuggestionsApi;
  /** Where the desktop panel starts: under the toolbar's button. */
  top: number;
  /** Review: under a filter, the whole roadmap's broken links, and how to clear the filters. */
  allLinks?: number;
  /** Review: under a filter, the whole roadmap's dates to confirm (the same basis as allLinks). */
  allDates?: number;
  /** Review: the whole count is one chosen roadmap's ("in all"), else every roadmap the reader sees. */
  oneRoadmap?: boolean;
  /** Review: whom a proposed Remove the dependency waits for ("you" to that person). */
  waitsFor?: (c: Change) => string;
  onAll?: () => void;
}) {
  const twins = items.filter((i) => i.can_decide && i.looks_like.length > 0);
  // pre-demo QA S-6: every item the tray names opens its feature panel (the tray closes for it).
  const openItem = useContext(OpenItem);
  const open1 = (id: string) => {
    onClose();
    openItem?.(id);
  };
  const named = (i: Item, className = "") => (
    <button type="button" data-testid="tray-item" data-item={i.key} className={`text-left hover:underline ${className}`} onClick={() => open1(i.id)}>
      {i.title}
    </button>
  );
  // qa4-simple-roadmap-14: Escape closes the drawer, focus back on its button.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // qa4-simple-roadmap: Escape in a dialog opened over the drawer (Reject a suggested
      // feature) is that dialog's, never the drawer's too.
      const over = (e.target as Element | null)?.closest?.('[role="dialog"], [role="alertdialog"]');
      if (over && over.getAttribute("data-testid") !== "decision-tray") return;
      onClose();
      document.querySelector<HTMLElement>('[data-testid="needs-decision"]')?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  // qa-simple-home-14: Home's "All proposals" (?review=proposals) lands on the Proposals part.
  const proposalsRef = useRef<HTMLElement>(null);
  const atProposals = useSearchParams().get("review") === "proposals";
  useEffect(() => {
    if (atProposals) proposalsRef.current?.scrollIntoView({ block: "start" });
  }, [atProposals]);
  const suggested = (suggestions.data?.suggestions ?? []).filter((s) => s.can_accept || s.can_reject);
  // fix4 qa-simple-roadmap-8: the same counts the toolbar button reads (decisionCounts).
  const counts = decisionCounts(items, proposals);
  const brokenItems = counts.broken;
  // The other red flags (a draft with no owner, an end past its milestone): listed, not broken links.
  const flagged = items.filter((i) => i.can_decide && broken(i).some((f) => !brokenLinks(i).includes(f)));
  const dates = counts.dates;
  // One row per item (BGD, 2026-10-28): its suggestion (for a planned item, the span of its open slices, which Accept applies
  // whole), with a muted line per slice inside its milestone, from the open per-slice suggestions.
  const open = useQuery(`simple-date-suggestions:${dates.map((i) => i.suggestion!.id).join(",")}`, () =>
    dates.some((i) => i.suggestion!.slice_code) ? unwrap(api.GET("/v1/simple/roadmap/date-suggestions", { params: { query: { status: "open" } } })) : Promise.resolve([]),
  );
  const dateRows = dates.map((i) => {
    const sliced = (open.data ?? []).filter((x) => x.item_id === i.id && x.slice_code).sort((a, b) => (a.start_date < b.start_date ? -1 : 1));
    const parts = sliced.flatMap((x) => {
      const sl = i.slices.find((y) => y.code === x.slice_code);
      return sl ? [{ code: sl.code, start: x.start_date, end: x.end_date, milestone: `${sl.milestone} ${sl.milestone_name}` }] : [];
    });
    return { item: i, s: i.suggestion!, parts: parts.length > 1 ? parts : [] };
  });
  const pulled = counts.pulled;
  const others = counts.proposals;
  // pre-demo QA S-6: the suggested features it lists count too, as on its button.
  const here = counts.total + suggested.length;
  const whole = here - counts.links - counts.dates.length + (allLinks ?? counts.links) + (allDates ?? counts.dates.length);
  // Review: each tile leads to the items it counts, the suggested features too, so the tiles add up to the button.
  const counters: [string, number, string][] = [
    ["Broken links", allLinks ?? counts.links, "tray-broken-links"],
    ["Dates to confirm", allDates ?? dateRows.length, "tray-dates"],
    ["Proposals", others.length, "review-proposals"],
    ["Pulled in", pulled.length, "tray-pulled"],
    ["Suggested features", suggested.length, "tray-suggested-features"],
  ];
  const kd = (c: Change) => (c.after.key_date ?? c.before.key_date) as { name?: string } | null | undefined;
  // roadmap-decide: a change the roadmap asked of a PRD names its milestone.
  const asked = (c: Change) => (c.op === "edit_goal_milestone" && !("milestone" in c.before) ? `PRD milestone ‘${String(c.target.name ?? "")}’` : null);
  // milestone-rights: a goal milestone's proposal names the milestone and says change or remove.
  const ms = (c: Change) => c.op === "edit_goal_milestone" && typeof c.target.name === "string" && !asked(c);
  const title = (c: Change) => asked(c) ?? (ms(c) ? `Milestone '${String(c.target.name)}'` : kd(c)?.name ? `Key date '${kd(c)!.name}'` : (byId.get(String(c.target.item_id))?.title ?? (typeof c.after.title === "string" ? c.after.title : "An item")));
  const asks = (c: Change) => (ms(c) ? ("milestone" in c.before && c.after.milestone === null ? "remove it" : "change it") : opWords(c.op).toLowerCase());
  const row = (c: Change) => (
    <li key={c.id} className="flex flex-wrap items-center gap-2 py-1.5" data-testid="tray-proposal">
      <span className="min-w-0 flex-1 text-[15px]">
        {!asked(c) && !ms(c) && !kd(c)?.name && byId.get(String(c.target.item_id)) ? named(byId.get(String(c.target.item_id))!) : title(c)}: {asks(c)} · <span className="text-text2">{c.by_name}</span>
        {c.op === "remove_dependency" && waitsFor && waitsFor(c) && <span className="text-text2"> · waits for {waitsFor(c)}</span>}
        {c.from_meeting && <span className="block text-sm text-text2" data-testid="proposal-from-meeting">Asked for by the meeting {c.from_meeting.title}</span>}
      </span>
      <Button onClick={() => onDecide(c, "accept")}>Accept</Button>
      <Button variant="ghost" onClick={() => onDecide(c, "decline")}>
        Decline
      </Button>
    </li>
  );
  return (
    <aside
      role="dialog"
      aria-label="Needs a decision"
      data-testid="decision-tray"
      data-sheet={phone ? "bottom" : "side"}
      // fix4 qa-simple-roadmap-37: on a desktop the panel opens below its button, not over it.
      style={phone ? undefined : { top }}
      className={`${phone ? "fixed inset-x-0 bottom-0 z-50 max-h-[85dvh] rounded-t-2xl border-t border-line" : "fixed right-0 bottom-0 z-50 w-[440px] rounded-tl-xl border-t border-l border-line"} overflow-y-auto bg-surface p-4 shadow-tip`}
    >
      {phone && <div aria-hidden className="mx-auto -mt-1 mb-2 h-1 w-10 rounded-full bg-line-strong" />}
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-lg font-semibold">Needs a decision</h2>
        <button type="button" aria-label="Close" onClick={onClose} className="h-8 w-8 rounded text-text2 hover:bg-surface2">
          ×
        </button>
      </div>
      {/* roadmap-decide: what the button's count is, said in words; the broken links are the same ones Home and the side menu count. */}
      <p className="mt-1 text-sm text-text2" data-testid="tray-scope">
        {/* Review: under a filter, every kind on one basis: what these filters show, and the whole roadmap's. */}
        {/* Review: "this roadmap's" only when one roadmap is chosen; else every roadmap's draft is counted. */}
        {whole !== here ? `${here} here, ${whole} in all` : whole} to decide {oneRoadmap ? "in this roadmap's working draft" : "in your roadmaps' working drafts"}: broken links, dates to confirm, proposals, items pulled in and suggested features.
        {allLinks !== undefined && allLinks !== counts.links && (
          <span data-testid="tray-links-here">
            {" "}
            {counts.links} of the {allLinks} broken {allLinks === 1 ? "link" : "links"} {counts.links === 1 ? "is" : "are"} in these filters.{" "}
            <button type="button" onClick={onAll} className="font-semibold text-accent-ink hover:underline">
              Clear filters
            </button>
          </span>
        )}
      </p>
      <ul className="mt-3 grid grid-cols-3 gap-2 min-[420px]:grid-cols-5" data-testid="tray-counters">
        {counters.map(([label, n, to]) => (
          // fix4 qa-simple-roadmap-38: equal tiles (each as tall as the tallest, its label on two
          // lines at most); a tile at 0 is muted, plain text, not something to press.
          <li key={label} data-testid="tray-counter" data-zero={n === 0 ? "true" : undefined} className={`flex rounded-lg text-center ${n ? "border border-line" : "bg-surface2 text-text-faint"}`}>
            {n ? (
              <button type="button" onClick={() => document.getElementById(to)?.scrollIntoView({ block: "start" })} className="flex flex-1 flex-col items-center justify-start rounded-lg px-1 py-1.5 hover:bg-surface2">
                <TileWords n={n} label={label} />
              </button>
            ) : (
              <span className="flex flex-1 flex-col items-center justify-start px-1 py-1.5">
                <TileWords n={n} label={label} />
              </span>
            )}
          </li>
        ))}
      </ul>
      <section id="tray-broken-links" className="mt-4 scroll-mt-4">
        <h3 className="font-semibold">Broken links</h3>
        {brokenItems.length ? (
          <ul>
            {brokenItems.map((i) => (
              <li key={i.id} className="border-b border-line py-2" data-testid="tray-broken">
                <p className="text-[15px] font-medium">{named(i)}</p>
                {/* qa4-simple-roadmap-38: its broken links only; its other flags are listed once, under Other flags. */}
                {brokenLinks(i).map((f) => (
                  <div key={`${f.kind}-${f.subject}`}>
                    <FlagLine flag={f} />
                    <FixButtons item={i} flag={f} items={byId} act={act} canChange={canChange} />
                  </div>
                ))}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-text2">Nothing broken.</p>
        )}
      </section>
      {flagged.length > 0 && (
        <section className="mt-4" data-testid="tray-flagged">
          <h3 className="font-semibold">Other flags</h3>
          <ul>
            {flagged.map((i) => (
              <li key={i.id} className="border-b border-line py-2" data-testid="tray-flag">
                <p className="text-[15px] font-medium">{named(i)}</p>
                {broken(i)
                  .filter((f) => !brokenLinks(i).includes(f))
                  .map((f) => (
                    <div key={`${f.kind}-${f.subject}`}>
                      <FlagLine flag={f} />
                      <FixButtons item={i} flag={f} items={byId} act={act} canChange={canChange} />
                      {/* pre-demo QA S-6: a draft with no owner is resolved in its panel, where its owner is picked. */}
                      {f.kind === "draft_without_owner" && canChange && (
                        <div className="mt-1 flex flex-wrap gap-1.5" data-testid="fixes">
                          <Button data-testid="pick-owner" onClick={() => open1(i.id)}>
                            Pick an owner
                          </Button>
                        </div>
                      )}
                    </div>
                  ))}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section id="tray-dates" className="mt-4 scroll-mt-4">
        <h3 className="font-semibold">Dates to confirm</h3>
        {dateRows.length ? (
          <ul>
            {dateRows.map(({ item: i, s, parts }) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2 py-1.5" data-testid="tray-date" data-item={i.id}>
                <div className="min-w-0 flex-1 text-[15px]">
                  <span>
                    {named(i)}: {yearSpan(s.start_date, s.end_date)}
                  </span>
                  {parts.length > 0 && (
                    <span className="block" data-testid="tray-date-slices">
                      {parts.map((x) => (
                        <span key={x.code} className="block text-sm text-text2" data-testid="tray-date-slice" data-slice={x.code}>
                          {x.code} {shortDay(x.start)} – {shortDay(x.end)} · {x.milestone}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
                <Button onClick={() => onSuggestion(i, "accept", s.id)}>Accept</Button>
                <Button variant="ghost" onClick={() => onSuggestion(i, "dismiss", s.id)}>
                  Dismiss
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-text2">No dates waiting.</p>
        )}
      </section>
      <section id="review-proposals" ref={proposalsRef} className="mt-4 scroll-mt-4">
        <h3 className="font-semibold">Proposals waiting</h3>
        {others.length ? <ul>{others.map(row)}</ul> : <p className="text-sm text-text2">None waiting.</p>}
      </section>
      <section id="tray-pulled" className="mt-4 scroll-mt-4">
        <h3 className="font-semibold">Pulled in, pending a decision</h3>
        {pulled.length ? <ul>{pulled.map(row)}</ul> : <p className="text-sm text-text2">None.</p>}
      </section>
      <section className="mt-4" data-testid="tray-twins">
        <h3 className="font-semibold">Drafts that look like an item</h3>
        {twins.length ? (
          <ul>
            {twins.map((i) => (
              <li key={i.id} className="border-b border-line py-2" data-testid="tray-twin">
                <p className="text-[15px] font-medium">{named(i)}</p>
                <LooksLike item={i} act={act} canChange={canChange} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-text2">None.</p>
        )}
      </section>
      <section id="tray-suggested-features" className="mt-4 scroll-mt-4" data-testid="tray-suggested">
        <h3 className="font-semibold">Suggested features</h3>
        {(suggestions.data?.goals ?? []).some((g) => g.pending) && (
          <p role="status" className="text-sm text-accent-ink" data-testid="suggest-pending">
            Oracle is suggesting features…
          </p>
        )}
        {suggested.length ? (
          <ul className="mt-2 flex flex-col gap-2">
            {suggested.map((s) => (
              <SuggestionCard key={s.id} s={s} api={suggestions} />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-text2">None waiting.</p>
        )}
      </section>
    </aside>
  );
}

export function SimpleRoadmap() {
  const { me, can } = useMe();
  const phone = usePhone();
  // A link may open the roadmap filtered to one PRD (the plan strip's rows: ?prd=<slug>)
  // or to one roadmap (?roadmap=<id or slug>).
  const params = useSearchParams();
  const [f, setF] = useState<Filters>(() => ({ ...NO_FILTERS, prd: params.get("prd") ?? "", roadmap: params.get("roadmap") ?? "", goal: params.get("goal") ?? "" }));
  const [format, setFormat] = useState<Format>("timeline");
  const [unit, setUnit] = useState<GanttUnit>("week");
  const [card, setCard] = useState<{ id: string; left: number; top: number } | null>(null);
  const [pop, setPop] = useState<{ id: string; left: number; top: number; above: number } | null>(null);
  // Home's "All proposals" opens the roadmap with its Needs-a-decision tray open (?review=1).
  // qa-simple-home-14: ?review=proposals opens it at its Proposals part.
  const [tray, setTray] = useState(() => params.get("review") === "1" || params.get("review") === "proposals");
  // fix4 qa-simple-roadmap-37: the desktop tray starts under its toolbar button (measured as it opens).
  const [trayTop, setTrayTop] = useState(0);
  useEffect(() => {
    if (!tray) return;
    const id = requestAnimationFrame(() => {
      const r = document.querySelector('[data-testid="needs-decision"]')?.getBoundingClientRect();
      setTrayTop(r ? Math.max(0, Math.round(r.bottom + 8)) : 0);
    });
    return () => cancelAnimationFrame(id);
  }, [tray]);
  const [keyDates, setKeyDates] = useState(false);
  const [exporting, setExporting] = useState<"png" | "pdf" | null>(null);
  // qa-shell-24: a phone's pickers sit behind one Filters button.
  const [pickersOpen, setPickersOpen] = useState(false);
  // As the sheets beside it: Escape (focus back on Filters) or a tap outside closes the pickers.
  useEffect(() => {
    if (!pickersOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setPickersOpen(false);
      document.querySelector<HTMLElement>("[data-filters-toggle]")?.focus();
    };
    const onDown = (e: PointerEvent) => {
      if (!(e.target as Element | null)?.closest?.("[data-filters-toggle], #roadmap-pickers")) setPickersOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [pickersOpen]);
  const [starting, setStarting] = useState(false);
  // D3: on a phone, the milestone whose end the weeks hide to the right ("Swipe sideways for M3").
  const [offscreen, setOffscreen] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const swapped = useRef<string | null>(null);
  const svg = useRef<SVGSVGElement | null>(null);

  const qs = useMemo(() => {
    // Group by Milestone reads the goal grouping and regroups by the items' slices (lanes()).
    const q: Record<string, string> = { group: f.group === "milestone" ? "goal" : f.group };
    for (const k of ["roadmap", "prd", "goal", "track", "from", "to"] as const) if (f[k]) q[k] = f[k];
    return q;
  }, [f]);
  // The items as last fetched, set when the call returns (before React draws them): a
  // burst whose earlier change failed takes its `before` from the reload that followed.
  const fetched = useRef<Map<string, Item> | null>(null);
  const roadmap = useQuery(
    `simple-roadmap:${JSON.stringify(qs)}`,
    () =>
      unwrap(api.GET("/v1/simple/roadmap", { params: { query: qs as never } })).then((d) => {
        fetched.current = new Map(d.items.map((i) => [i.id, i]));
        setRoadmapToday(d.today);
        return d;
      }),
    { keepPrevious: true },
  );
  // build-goal-order-control: each goal's number (1 to n, Home's order) on its card and its lane.
  const goalList = useQuery("simple-roadmap-goal-order", () => unwrap(api.GET("/v1/baseline/entities", { params: { query: { type: "goal" } } })));
  const numbers = useMemo(() => goalNumbers(goalList.data ?? []), [goalList.data]);
  const proposals = useQuery("simple-proposals", () => unwrap(api.GET("/v1/simple/changes", { params: { query: { status: "proposed" } } })));
  // A working draft belongs to one roadmap: a chosen roadmap's page lists its own drafts only.
  const drafts = useQuery(`simple-drafts:${f.roadmap ?? ""}`, () =>
    unwrap(api.GET("/v1/simple/drafts", { params: { query: f.roadmap ? { roadmap: f.roadmap } : {} } })),
  );
  // Who may start a review is the start sheet's own per-PRD answer (meetings.may_start: an owner,
  // or a PRD's decider), not who decides this roadmap's items; the same read the sheet makes.
  const startOptions = useQuery("simple-meeting-options||", () =>
    unwrap(api.GET("/v1/simple/meetings/options", { params: { query: { prd: undefined, occurrence: undefined } } })),
  );
  // Review: the whole roadmap's broken links (the side menu's light count), whatever the filters.
  // Review: a chosen roadmap's count is that roadmap's ("in all"), else every roadmap the reader sees ("in all your roadmaps").
  const wholeLinks = useQuery(`simple-roadmap-waiting:${f.roadmap ?? ""}`, () =>
    unwrap(api.GET("/v1/simple/roadmap/waiting", { params: { query: f.roadmap ? { roadmap: f.roadmap } : {} } })),
  );
  // RP2 'Draft layer on roadmap': the PRDs whose run dated items not approved yet, read by
  // <DraftPrdsRead> off the chart's first draw (./_drafts.tsx); no draft PRD changes nothing here.
  const [draftPrds, setDraftPrds] = useState<{ data?: DraftPrd[]; error: boolean }>({ error: false });
  const draftReload = useRef<(() => Promise<unknown>) | null>(null);
  // Review: the people a draft's next step names (who it waits on, who reviews it after the decider).
  // A proposed fix names whom it waits for too.
  const asked = (proposals.data ?? []).filter((c) => c.op === "remove_dependency");
  // Review: and whose draft it is, when it is not the reader's.
  const draftIds = [...new Set([...(drafts.data ?? []).flatMap((d) => [...d.waiting_on, ...(d.required_reviewers ?? []), d.created_by]), ...asked.flatMap((c) => c.routed_to)])].sort();
  const draftPeople = useQuery(
    `people|${draftIds.join(",")}`,
    () => (draftIds.length ? unwrap(api.GET("/v1/people", { params: { query: { ids: draftIds } } })) : Promise.resolve([] as Schemas["PersonOut"][])),
    { keepPrevious: true },
  );
  // Review: whom a proposal waits for, by name; "you" to that person.
  const myId = me?.user_id;
  const waitsFor = useCallback(
    (c: Change) => {
      if (myId && c.routed_to.includes(myId)) return "you";
      // Review minor: held ("") until every name is known, never "its decider" for a moment.
      const who = c.routed_to.map((id) => draftPeople.data?.find((p) => p.user_id === id)?.name);
      return who.every(Boolean) ? who.join(", ") || "its decider" : "";
    },
    [myId, draftPeople.data],
  );
  // Review: a Remove the dependency proposed already says whom it waits for, and is not offered again.
  const proposedFix = useCallback(
    (op: string, itemId: string, subject: string) => {
      const c = asked.find((x) => x.op === op && String(x.target.item_id) === itemId && String(x.target.subject) === subject);
      return c ? waitsFor(c) : null;
    },
    [asked, waitsFor],
  );
  // home-waiting-one-list: every action reloads through here, and each may change what waits
  // on me (a date, a proposal, a broken link, a draft), so the rail and Home read again too;
  // roadmap-decide: with the whole roadmap's light count.
  const reload = useCallback(async () => {
    invalidateWaiting();
    const done = Promise.all([roadmap.reload(), proposals.reload(), drafts.reload(), wholeLinks.reload(), draftReload.current?.()]);
    waitingChanged();
    await done;
  }, [roadmap, proposals, drafts, wholeLinks]);
  // After an action that may change what waits on someone (a move, an add, an undo, a version
  // sent or applied): the page and the rail's and More's Inbox counts read again at once.
  const reloadAfter = useCallback(() => reloadWaiting(reload), [reload]);
  // roadmap-talk: a chat card applied, proposed, rejected or undone (the item's talk, the Ask panel) reads the roadmap again.
  useEffect(() => {
    const on = () => void reloadAfter();
    window.addEventListener(CARD_CHANGED_EVENT, on);
    return () => window.removeEventListener(CARD_CHANGED_EVENT, on);
  }, [reloadAfter]);
  // S7: Oracle's suggested features by goal; an accept (or its undo) changes the roadmap.
  const suggestions = useGoalSuggestions(reload);
  const [goalPanel, setGoalPanel] = useState<GoalBrief | null>(null);
  const [goalStart, setGoalStart] = useState<GoalPanelStart | undefined>(undefined);
  // S7: while Oracle drafts a quick-added item, the roadmap reads again until it is done.
  const drafting = !!roadmap.data?.items.some((i) => i.drafting);
  const { reload: reloadRoadmap } = roadmap;
  useEffect(() => {
    if (!drafting) return;
    const t = window.setTimeout(() => void reloadRoadmap(), 800);
    return () => window.clearTimeout(t);
  }, [drafting, roadmap.data, reloadRoadmap]);

  // The Roadmap filter: landing without ?roadmap=, the person's remembered pick (preferences)
  // once the roadmaps they may read are known (a roadmap they no longer read is dropped);
  // their PRD (unless a link names one), Goal and Track picks come back with it.
  // roadmap-stale-filters: a saved pick no longer on the roadmap (its PRD in Trash, its goal
  // archived) is dropped, as the roadmap is read without the link's filters, and the cleaned
  // picks are saved back once, quietly.
  const prefs = useQuery("me-preferences", () => unwrap(api.GET("/v1/me/preferences")));
  const [restored, setRestored] = useState(false);
  const [cleaned, setCleaned] = useState<Schemas["SimpleFilters"] | null>(null);
  const known = roadmap.data?.roadmaps;
  const savedPicks = !restored && known && (prefs.data || prefs.error) ? prefs.data?.simple_filters : undefined;
  const onRoadmap = savedPicks && !f.prd && !f.goal && !f.track ? picksOf(roadmap.data!.items) : null;
  // RP2: only a saved PRD pick the roadmap does not hold waits for the draft layer's read (it may be a draft PRD's).
  if (!restored && known && (prefs.data || prefs.error) && (draftPrds.data || draftPrds.error || !(savedPicks?.prd && onRoadmap && !onRoadmap.prd.has(savedPicks.prd)))) {
    setRestored(true);
    const pick = prefs.data?.simple_roadmap;
    // RP2: a saved pick of a draft PRD stays (it has nothing on the roadmap yet).
    const kept = savedPicks && onRoadmap ? without(savedPicks, (k, v) => !onRoadmap[k].has(v) && !(k === "prd" && draftPrds.data?.some((d) => d.prd.slug === v))) : savedPicks;
    if (savedPicks && kept && PICKS.some((k) => kept[k] !== (savedPicks[k] ?? ""))) setCleaned(kept);
    const next = { ...f, goal: params.get("goal") || kept?.goal || f.goal, track: kept?.track || f.track };
    if (!params.get("prd")) next.prd = kept?.prd || f.prd;
    if (!params.get("roadmap") && pick && pick !== "all" && known.some((r) => r.roadmap.id === pick)) next.roadmap = pick;
    if (next.roadmap !== f.roadmap || next.prd !== f.prd || next.goal !== f.goal || next.track !== f.track) setF(next);
  }
  // A pick is saved for next time; one the server could not save says so.
  const remember = async (body: Schemas["PreferencesUpdate"], failed: string) => {
    try {
      const saved = await unwrap(api.PATCH("/v1/me/preferences", { body }));
      prefs.setData(() => saved);
    } catch {
      toast({ message: failed });
    }
  };
  const sent = useRef<Schemas["SimpleFilters"] | null>(null);
  useEffect(() => {
    if (!cleaned || sent.current === cleaned) return;
    sent.current = cleaned;
    api
      .PATCH("/v1/me/preferences", { body: { simple_filters: cleaned } })
      .then((r) => r.data && prefs.setData(() => r.data))
      .catch(() => undefined);
  }, [cleaned, prefs]);
  // Narrowed to nothing by a PRD, goal or track: the roadmap without them says which picks it
  // no longer has; a saved one is dropped (and saved back), a link's one is said so.
  const emptied = restored && !!(f.prd || f.goal || f.track) && !!roadmap.data && !roadmap.loading && !roadmap.data.items.length;
  const wideQs = useMemo(() => ({ group: qs.group, ...(qs.roadmap ? { roadmap: qs.roadmap } : {}) }), [qs]);
  const wide = useQuery(`simple-roadmap-picks:${emptied ? JSON.stringify(wideQs) : ""}`, () =>
    emptied ? unwrap(api.GET("/v1/simple/roadmap", { params: { query: wideQs as never } })).then((d) => picksOf(d.items)) : Promise.resolve(null),
  );
  // RP2: a draft PRD has nothing on the roadmap yet; its pick stays (the draft layer shows it).
  const isDraftPrd = (k: string, v: string) => k === "prd" && !!draftPrds.data?.some((d) => d.prd.slug === v);
  const gone = emptied && wide.data && !wide.loading && (draftPrds.data || draftPrds.error || !f.prd) ? PICKS.filter((k) => f[k] && !wide.data![k].has(f[k]) && !isDraftPrd(k, f[k])) : [];
  const linked = gone.filter((k) => k !== "track" && params.get(k) === f[k]);
  const dropped = gone.filter((k) => !linked.includes(k));
  // roadmap-stale-filters review: Clear takes the link's picks out of the address too (Next
  // keeps useSearchParams in step), so a reload does not bring the note back.
  const clearLinked = () => {
    setF({ ...f, ...Object.fromEntries(linked.map((k) => [k, ""])) });
    const next = new URLSearchParams(window.location.search);
    for (const k of linked) next.delete(k);
    const s = next.toString();
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${s ? `?${s}` : ""}${window.location.hash}`);
  };
  if (dropped.length) {
    const next = { ...f };
    for (const k of dropped) next[k] = "";
    setF(next);
    const saved = prefs.data?.simple_filters;
    if (saved && dropped.some((k) => saved[k] === f[k])) setCleaned(without(saved, (k, v) => dropped.includes(k) && v === f[k]));
  }
  const pickRoadmap = (id: string) => {
    setRestored(true);
    setCard(null);
    setPop(null);
    setF({ ...f, roadmap: id });
    void remember({ simple_roadmap: id || "all" }, "Could not remember this roadmap for next time");
  };
  const pickFilter = (k: "prd" | "goal" | "track", v: string) => {
    setRestored(true);
    const next = { ...f, [k]: v };
    setF(next);
    void remember({ simple_filters: { prd: next.prd, goal: next.goal, track: next.track } }, "Could not remember these filters for next time");
  };

  // The filters' choices: every PRD, goal and track seen, so narrowing keeps the others.
  // roadmap-done (owner, Nov 4): a done (shipped) item leaves the plan: no view draws it and no
  // count reads it (the API checks it no more); it is kept under the Done list, which opens it.
  const all = roadmap.data;
  const data = useMemo(() => (all ? { ...all, items: all.items.filter((i) => i.status !== "done") } : undefined), [all]);
  const doneItems = useMemo(() => (all?.items ?? []).filter((i) => i.status === "done"), [all]);
  // roadmap-gantt: the rows' lanes, and the plans' no-work weeks (each PRD with planned items).
  const laned = useMemo(() => (data ? oneLane(lanes(data, f.group), f.group) : null), [data, f.group]);
  // The Timeline always draws goal lanes, the same groups the goal cards count.
  const goalLaned = useMemo(() => (data ? oneLane(lanes(data, "goal"), "goal") : null), [data]);
  const planPrds = useMemo(() => [...new Set((data?.items ?? []).flatMap((i) => (i.slices.length && i.prd ? [i.prd.slug] : [])))].sort(), [data]);
  // A plan the reader cannot open (404) leaves the other plans' no-work weeks.
  const plans = useQuery(`simple-plan-no-work:${planPrds.join(",")}`, async () =>
    (await Promise.allSettled(planPrds.map((prd) => unwrap(api.GET("/v1/simple/prds/{prd}/plan", { params: { path: { prd } } }))))).flatMap((r) => (r.status === "fulfilled" ? [r.value] : [])),
  );
  const noWork = useMemo(() => [...new Map((plans.data ?? []).flatMap((p) => p.holidays).map((h) => [h.start, h])).values()], [plans.data]);
  const byPrd = byPrdOrderOf(usePrdOrder());
  const [seen, setSeen] = useState<{ of: Roadmap | null; prd: [string, string][]; goal: [string, string][]; track: [string, string][] }>({ of: null, prd: [], goal: [], track: [] });
  if (data && seen.of !== data) {
    const add = (list: [string, string][], pairs: [string, string][]) => [...new Map([...list, ...pairs])];
    setSeen({
      of: data,
      prd: add(seen.prd, data.items.flatMap((i) => (i.prd ? [[i.prd.slug, i.prd.title] as [string, string]] : []))),
      goal: add(seen.goal, data.items.flatMap((i) => (i.goal ? [[i.goal.key, i.goal.title] as [string, string]] : []))),
      track: add(seen.track, data.items.flatMap((i) => (i.track ? [[i.track.id, i.track.title] as [string, string]] : []))),
    });
  }
  // RP2: the draft PRDs the layer shows, and the PRD filter's "(draft)" entries for those not on the roadmap.
  const [showDrafts, setShowDrafts] = useShowDrafts(me?.user_id ?? me?.email);
  const draftList = useMemo(() => draftPrds.data ?? NO_DRAFTS, [draftPrds.data]);
  const draftOnly = useMemo(() => draftList.filter((d) => !seen.prd.some(([slug]) => slug === d.prd.slug)), [draftList, seen.prd]);
  const pickedDraft = f.prd ? (draftOnly.find((d) => d.prd.slug === f.prd) ?? null) : null;
  const shownDrafts = useMemo(() => (f.goal || f.track ? NO_DRAFTS : f.prd ? draftList.filter((d) => d.prd.slug === f.prd) : draftList), [draftList, f.prd, f.goal, f.track]);
  const [draftOpen, setDraftOpen] = useState<string | null>(null);
  const openDraft = useMemo(() => (draftOpen ? (draftList.flatMap((d) => d.items.filter((i) => i.id === draftOpen).map((item) => ({ item, prd: d })))[0] ?? null) : null), [draftList, draftOpen]);
  // The draft item's panel starts under the toolbar, as the Needs-a-decision tray (measured as it opens).
  const [draftTop, setDraftTop] = useState(0);
  useEffect(() => {
    if (!draftOpen) return;
    const id = requestAnimationFrame(() => {
      const r = document.querySelector('[data-testid="roadmap-actions"]')?.getBoundingClientRect();
      setDraftTop(r ? Math.max(12, Math.round(r.bottom + 8)) : 0);
    });
    return () => cancelAnimationFrame(id);
  }, [draftOpen]);
  // One panel at a time: a roadmap item's card closes a draft item's panel.
  if (card && draftOpen) setDraftOpen(null);
  const byId = useMemo(() => new Map((all?.items ?? []).map((i) => [i.id, i])), [all]);
  // The Inbox's Open on a version waiting for my approval (?draft=<id>): once the roadmap and
  // its drafts are read, the banner's line for that draft comes into sight, focused, with its
  // Approve; with no such line (approved since, or not mine to approve), the banner itself.
  const draftLinked = useRef(false);
  useEffect(() => {
    const id = params.get("draft");
    if (draftLinked.current || !id || !all || !drafts.data) return;
    draftLinked.current = true;
    requestAnimationFrame(() => {
      const line = document.querySelector<HTMLElement>(`[data-testid="draft-approval"][data-draft-id="${CSS.escape(id)}"]`);
      const el = line ?? document.querySelector<HTMLElement>('[data-testid="draft-banner"]');
      el?.scrollIntoView({ block: "center" });
      line?.focus({ preventScroll: true });
    });
  }, [params, all, drafts.data]);
  const goalLinked = useRef(false);
  useEffect(() => {
    const asked = params.get("suggestions");
    const g = asked ? suggestions.data?.goals.find((x) => x.goal.id === asked || x.goal.key === asked) : undefined;
    if (goalLinked.current || !g) return;
    goalLinked.current = true;
    setGoalPanel(g.goal);
  }, [params, suggestions.data]);
  const titleOf = useCallback((id: string | null) => (id ? byId.get(id)?.title : undefined), [byId]);
  const canChange = can("create_simple_change");
  // build-milestones-on-roadmap: the milestones per goal, added on the time axis.
  const ms = useMilestones({ data, phone, canChange, reload, openItem: (id) => setCard({ id, ...anchorOf(id) }) });
  // The items as last loaded, for a burst sent after the render that started it.
  const latest = useRef(byId);
  useEffect(() => {
    latest.current = byId;
  });

  /** One change through the engine, its toast (with Undo when it applied) and the reload; null when it failed. */
  const run = useCallback(
    async (what: Parameters<Act>[0], body: Parameters<Act>[1], note?: string): Promise<ChangeResult | null> => {
      try {
        const r = await propose(body);
        const target = latest.current.get(String(body.target?.item_id ?? ""));
        // Review minor: the message keeps clear of the flag it was acted on (its fixes and the proposed line).
        const keys = [target?.key, latest.current.get(String(body.target?.subject ?? ""))?.key].filter(Boolean);
        toast({
          avoid: keys.length ? keys.map((k) => `[data-testid="conflict"][data-item="${k}"]`).join(", ") : undefined,
          message: resultWords(r, what, target?.deciders, note),
          action: r.change.status === "applied" && r.change.can_undo ? { label: "Undo", onClick: () => void undo(r.change.id).then(reloadAfter, (e) => toast({ message: String(e.message) })) } : undefined,
        });
        return r;
      } catch (e) {
        // fix4 qa-simple-roadmap-21: someone else's change since the page read it: what changed,
        // and Reload (the latest is read again either way).
        if (e instanceof ChangeFailed && e.status === 409) {
          const what = changedWords(e.changed);
          toast({ message: `${e.message}${what.length ? ` (its ${what.join(" and ")})` : ""}. Reload to see the latest, then try again.`, action: { label: "Reload", onClick: () => void reload() } });
        } else toast({ message: e instanceof ChangeFailed ? e.message : "Oracle could not make this change" });
        return null;
      } finally {
        await reloadAfter();
      }
    },
    [reload, reloadAfter],
  );
  const act: Act = useCallback(
    async (what, body, note) => {
      await run(what, body, note);
    },
    [run],
  );
  // trash-features-goals: a Gantt or Timeline row's context menu (a right-click, or the menu
  // key on a focused bar) offers Delete feature to who decides on it (its own can_decide), and
  // Propose: delete to others who may change (panel-menu: as the feature panel's menu).
  const [rowMenu, setRowMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const removeFeature = useFeatureDelete(reload, toast, (id) => setCard((c) => (c?.id === id ? null : c)));
  const onRowMenu = (e: ReactMouseEvent) => {
    const el = (e.target as Element).closest("[data-bar-id],[data-item-id]");
    const it = el ? byId.get(el.getAttribute("data-bar-id") ?? el.getAttribute("data-item-id") ?? "") : undefined;
    // panel-menu: who decides deletes; who may change proposes it, as in the feature panel.
    if (!el || !it || !(it.can_decide || canChange)) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    // The menu key fires it with no pointer: the menu opens under the row.
    setRowMenu(e.clientX || e.clientY ? { id: it.id, x: e.clientX, y: e.clientY } : { id: it.id, x: r.left, y: r.bottom });
  };
  const rowMenuItem = rowMenu ? byId.get(rowMenu.id) : undefined;

  // A move (a drag, or the keyboard's burst) is one change; what is stored after it is the
  // next burst's `before` (#723 S4 re-review: no 409 on one's own earlier move).
  const dates = useKeyBurst<Dates>(async (id, before, after) => {
    const item = latest.current.get(id);
    if (!item) return null;
    const r = await run(`Moved '${item.title}' to ${shortDay(after.start_date!)} – ${shortDay(after.end_date!)}`, { op: "move_dates", target: { item_id: id }, before, after });
    if (!r) {
      const now = fetched.current?.get(id);
      return now ? shownDates(now) : null;
    }
    return r.change.status === "applied" ? after : before;
  }, sameDates);
  const horizons = useKeyBurst<Horizon>(async (id, before, after) => {
    const item = latest.current.get(id);
    if (!item) return null;
    const r = await run(`Moved '${item.title}' to ${HORIZONS.find((h) => h.key === after)!.label}`, { op: "change_horizon", target: { item_id: id }, before: { horizon: before }, after: { horizon: after } });
    if (!r) return fetched.current?.get(id)?.horizon ?? null;
    return r.change.status === "applied" ? after : before;
  }, sameHorizon);
  const moved = useMemo(() => Object.fromEntries(Object.entries(dates.pending).map(([id, d]) => [id, [d.start_date!, d.end_date!] as [string, string]])), [dates.pending]);

  // What a screen reader hears while a burst waits: its dates, then that it was cancelled.
  const [said, setSaid] = useState("");
  const stored = (item: Item) => latest.current.get(item.id) ?? item;
  const onKeyMove = (item: Item, start: string, end: string) => {
    setCard(null);
    dates.press(item.id, shownDates(stored(item)), { start_date: start, end_date: end });
    setSaid(`${item.title}: ${shortDay(start)} – ${shortDay(end)}, not sent yet. Pause to send it; Escape cancels.`);
  };
  const onKeyHorizon = (item: Item, horizon: Horizon) => {
    setCard(null);
    horizons.press(item.id, stored(item).horizon, horizon);
    setSaid(`${item.title}: ${HORIZONS.find((h) => h.key === horizon)!.label}, not sent yet. Pause to send it; Escape cancels.`);
  };
  const onKeyCancel = (burst: typeof dates | typeof horizons) => (item: Item) => {
    if (burst.cancel(item.id)) setSaid(`${item.title}: the move is cancelled.`);
  };

  // A drag is a burst of one, sent at once (after any burst of the bar still on its way).
  const onMove = useCallback(
    (item: Item, start: string, end: string) => {
      setCard(null);
      dates.press(item.id, shownDates(latest.current.get(item.id) ?? item), { start_date: start, end_date: end });
      dates.flush(item.id);
    },
    [dates],
  );

  const onHorizon = useCallback(
    (item: Item, horizon: Horizon) => {
      setCard(null);
      horizons.press(item.id, (latest.current.get(item.id) ?? item).horizon, horizon);
      horizons.flush(item.id);
    },
    [horizons],
  );

  const anchorOf = (id: string) => barAnchor(wrap.current, id);
  // Review: an item's name in a fix's line opens its feature panel, as its bar does.
  const openCard = (id: string) => setCard({ id, ...anchorOf(id) });

  // home-waiting-one-list, inbox-meeting-proposals fix: a link (a "waiting for you" row, the
  // Inbox) opens one item's feature panel (?item=<id>) or Oracle's dates for one item
  // (?dates=<item id>), once per link, on what waits there, its actions in view. A done item's
  // panel opens at its row in the Done list, which opens for it (DoneItems `reveal`).
  const linkedItem = params.get("item");
  const linkedDates = params.get("dates");
  const [opened, setOpened] = useState<string | null>(null);
  const [reveal, setReveal] = useState<string | null>(null);
  useEffect(() => {
    const link = linkedItem ? `item:${linkedItem}` : linkedDates ? `dates:${linkedDates}` : null;
    const it = linkedItem ? byId.get(linkedItem) : undefined;
    const dated = !linkedItem && linkedDates ? byId.get(linkedDates) : undefined;
    if (!link || opened === link || (!it && !dated?.suggestion)) return;
    // Once the roadmap that holds it is read (the link is the outside system here).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpened(link);
    setPop(null);
    if (it?.status === "done") return void setReveal(it.id);
    // The bars are drawn by the next frame.
    requestAnimationFrame(() => {
      if (it) setCard({ id: it.id, ...anchorOf(it.id) });
      else if (dated) setPop({ id: dated.id, ...anchorOf(dated.id) });
    });
  }, [linkedItem, linkedDates, opened, byId]);

  const onDecide = useCallback(
    async (c: Change, how: "accept" | "decline") => {
      try {
        await decide(c.id, how);
        toast({ message: how === "accept" ? (c.op === "edit_goal_milestone" ? "Accepted" : "Accepted: it is in your working draft") : "Declined" });
      } catch (e) {
        toast({ message: e instanceof ChangeFailed ? e.message : "Oracle could not decide it" });
      }
      // The rail's and More's counts read again at once (a decided proposal leaves the Inbox).
      await reloadAfter();
    },
    [reloadAfter],
  );

  const onSuggestion = useCallback(
    async (i: Item, how: "accept" | "edit" | "dismiss", dates?: { start_date: string; end_date: string }, id?: string) => {
      if (!i.suggestion) return;
      try {
        await suggestion(id ?? i.suggestion.id, how, dates);
        const words = how === "dismiss" ? "Dismissed Oracle's dates" : i.suggestion.can_decide ? "Dates accepted in your working draft" : `Dates proposed: they wait for ${deciderWords(i.deciders)} in Needs a decision`;
        toast({ message: words });
      } catch (e) {
        toast({ message: e instanceof ChangeFailed ? e.message : "Oracle could not do that" });
      }
      setPop(null);
      // As a decided proposal: Oracle's dates leave the Inbox, and the counts read again at once.
      await reloadAfter();
    },
    [reloadAfter],
  );

  /** The filters in words, for the export's header. */
  const filterWords = (): string => {
    const named = (list: [string, string][], v: string) => list.find(([k]) => k === v)?.[1] ?? v;
    const qName = (v: string) => (data ? quarters(data.windows.now.start, data.windows.later.end).find((q) => q.start === v || q.end === v)?.label : null) ?? shortDay(v);
    const parts = [`Grouped by ${f.group === "prd" ? "PRD" : f.group}`];
    if (f.prd) parts.push(`PRD: ${named(seen.prd, f.prd)}`);
    if (f.goal) parts.push(`Goal: ${named(seen.goal, f.goal)}`);
    if (f.track) parts.push(`Track: ${named(seen.track, f.track)}`);
    if (f.from) parts.push(`From ${qName(f.from)}`);
    if (f.to) parts.push(`To ${qName(f.to)}`);
    if (data?.roadmap) parts.push(`Roadmap: ${data.roadmap.title}`);
    if (!f.roadmap && !f.prd && !f.goal && !f.track && !f.from && !f.to) parts.push("All roadmaps"); // qa4-simple-roadmap-48
    return parts.join(" · ");
  };

  const doExport = async (kind: "png" | "pdf") => {
    if (!data) return;
    // E-7: the buttons say it is busy (and stay so) until the file is saved.
    setExporting(kind);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    // E-1: the Timeline's picture is the zoom shown (its window and header); a phone's quarter
    // list has none, so its picture is the goal lanes, laid out off screen once exporting is set.
    const zoomed = format === "timeline" ? (wrap.current?.querySelector<HTMLElement>('[data-testid="timeline-scroll"]') ?? null) : null;
    const labels = wrap.current?.querySelector<HTMLElement>('[data-testid="chart-labels"]') ?? null;
    if (format !== "board" && !zoomed && !svg.current) return setExporting(null);
    try {
      const shown = laned ?? data;
      // The return queue's order, as the Gantt numbers its rows below the line.
      const queue = shown.groups.flatMap((g) => g.item_ids).filter((id) => shown.items.some((i) => i.id === id && closedItem(i)));
      const pic = format === "board" ? boardPicture(boardColumns(shown), data.today, queue) : zoomed ? zoomPicture(zoomed, data.today) : chartPicture(svg.current!, labels);
      const title = `Roadmap · ${FORMAT_WORDS[format]}${format === "gantt" ? ` (${unit})` : ""}`;
      await exportView(kind, pic, { title, filters: filterWords(), brand: await brandOf() }, data.today, `roadmap-${format}`);
    } catch (e) {
      toast({ message: e instanceof TooLarge ? e.message : "The view could not be exported" });
    } finally {
      setExporting(null);
    }
  };

  if (roadmap.error && !data) return <Notice tone="error">{roadmap.error}</Notice>;
  if (!data) return <Loading />;

  const cardItem = card ? byId.get(card.id) : undefined;
  const popItem = pop ? byId.get(pop.id) : undefined;
  // A feature ask on no roadmap is decided in its Inbox row only (it is filed in Requests, on no
  // roadmap): no roadmap's Needs a decision lists or counts it.
  const allProposals = (proposals.data ?? []).filter((c) => !(c.op === "add_feature_ask" && !c.document_id));
  const decides = can("accept_simple_change") || data.items.some((i) => i.can_decide);
  // #13: viewers and commenters never start a review (the PRD's own decider or an owner
  // does, per_item "owner" on start_simple_meeting); gate the button here too, not only
  // inside the sheet, so it reads as disabled rather than silently failing once opened.
  // Below an owner, deciding an item on this view is the item answer.
  const mayStartReview = can("start_simple_meeting", !!startOptions.data?.prds.some((p) => p.can_start));
  // fix4 qa-simple-roadmap-22: someone who may not start one (a viewer; a commenter who decides
  // no PRD) sees no Start review at all, once the start options say so (busy until then).
  const startsReviews = mayStartReview || (!startOptions.data && !startOptions.error);
  // fix4 qa-simple-roadmap-8: the tray's own counts (one helper), so the button and its tiles agree.
  // Review: under a filter, Needs a decision counts the whole roadmap's broken links and dates to
  // confirm, as the side menu does.
  const counted = decisionCounts(data.items, allProposals);
  const anyFilter = !!(f.prd || f.goal || f.track || f.from || f.to || f.roadmap);
  const allLinks = anyFilter ? wholeLinks.data?.broken_links : undefined;
  const allDates = anyFilter ? wholeLinks.data?.dates_to_confirm : undefined;
  // pre-demo QA S-6: the suggested features the tray lists for a decision count on its button too.
  const suggestedWaiting = (suggestions.data?.suggestions ?? []).filter((s) => s.can_accept || s.can_reject).length;
  const waiting = counted.total + suggestedWaiting - counted.links - counted.dates.length + (allLinks ?? counted.links) + (allDates ?? counted.dates.length);
  const qList = quarters(data.windows.now.start, data.windows.later.end);
  // qa-shell-8: a new company's roadmap has nothing on it (no item, milestone or key date, and
  // no filter narrowing it): one line on what shows here and the next step, no empty chart and
  // no review or export of nothing.
  const blank =
    !data.items.length && !doneItems.length && !data.milestones.length && !data.key_dates?.length && !f.prd && !f.goal && !f.track && !f.from && !f.to && !data.roadmap;
  const hasGoals = (suggestions.data?.goals.length ?? 0) > 0;

  // S7 quick add: where an item may go, and whether the caller's add applies there (an item
  // of that roadmap the caller decides) or is proposed.
  const goalsKnown = new Map<string, string>();
  for (const i of data.items) if (i.goal) goalsKnown.set(i.goal.id, i.goal.title);
  for (const g of suggestions.data?.goals ?? []) goalsKnown.set(g.goal.id, g.goal.title);
  const addOptions: Where[] = [
    ...qList.filter((q) => q.end >= data.today).map((q) => ({ kind: "quarter" as const, value: quarterValue(q.start), label: q.label })),
    ...HORIZONS.map((h) => ({ kind: "horizon" as const, value: h.key, label: h.label })),
    ...[...goalsKnown].map(([id, title]) => ({ kind: "goal" as const, value: id, label: title })),
  ];
  // The Roadmap filter: one roadmap chosen (or the only one there is) is where an item goes;
  // with all roadmaps and more than one, quick add asks which (never a guess).
  const readable = data.roadmaps ?? [];
  const addable = readable.filter((r) => r.can_change);
  const target = data.roadmap ?? (addable.length === 1 ? addable[0].roadmap : null);
  const askRoadmap = !target && addable.length > 1;
  const roadmapFor = (w: Where): string | undefined =>
    target?.id ??
    (w.kind === "goal" ? data.items.find((i) => i.goal_ids.includes(w.value) || i.goal?.id === w.value)?.roadmap.id : undefined) ??
    data.items.find((i) => i.can_decide)?.roadmap.id ??
    data.items[0]?.roadmap.id;
  const addVerb = (w: Where, rmId?: string): "Add" | "Propose" => {
    const rm = rmId ?? roadmapFor(w);
    const known = readable.find((r) => r.roadmap.id === rm);
    if (known) return known.applies ? "Add" : "Propose";
    return data.items.some((i) => i.roadmap.id === rm && i.can_decide) ? "Add" : "Propose";
  };
  const onAdd = async (title: string, w: Where, rmId?: string): Promise<boolean> => {
    try {
      const r = await propose({ op: "add_item", target: { roadmap_id: rmId ?? target?.id ?? null, where: { kind: w.kind, value: w.value } }, before: {}, after: { title } });
      const c = r.change;
      if (c.status === "applied")
        toast({
          message: `Added ${title} as a draft`,
          action: c.can_undo
            ? {
                label: "Undo",
                onClick: () =>
                  void undo(c.id).then(
                    () => {
                      toast({ message: "Undone" });
                      return reloadAfter();
                    },
                    (e) => toast({ message: e instanceof ChangeFailed ? e.message : "Oracle could not undo it" }),
                  ),
              }
            : undefined,
        });
      // fix4 qa-simple-roadmap-21: who decides, and where the proposal shows.
      else toast({ message: `Proposed ${title} (${w.label}): it waits for ${deciderWords(undefined)} in Needs a decision` });
      await reloadAfter();
      // one-feature-panel: the added item opens its panel, to fill in the rest.
      const added = c.status === "applied" ? c.target.item_id : null;
      if (typeof added === "string") setCard({ id: added, ...anchorOf(added) });
      return true;
    } catch (e) {
      toast({ message: e instanceof ChangeFailed ? e.message : "Oracle could not add it" });
      return false;
    }
  };
  // fix4 qa-simple-roadmap-23: Start review opens on the working draft: the PRD of the items it
  // changed (when the reader may start that one), named in the sheet.
  const workingDrafts = (drafts.data ?? []).filter((d) => d.status === "working" && d.changes > 0);
  const draftItems = workingDrafts.flatMap((d) => d.change_log.flatMap((c) => (c.item_id ? [byId.get(c.item_id)] : [])));
  const reviewPrd = draftItems.find((i) => i?.prd)?.prd?.slug;
  // meeting-changes-only-its-agenda: a review started on one roadmap reviews that roadmap.
  const reviewRoadmap = data.roadmap ? { id: data.roadmap.id, prds: [...new Set(data.items.flatMap((i) => (i.roadmap.id === data.roadmap?.id && i.prd ? [i.prd.slug] : [])))] } : undefined;
  const draftChanges = workingDrafts.reduce((n, d) => n + d.changes, 0);
  const reviewFrom = workingDrafts.length ? `Your roadmap's working draft · ${draftChanges} ${draftChanges === 1 ? "change" : "changes"}` : undefined;
  const goalCounts = new Map<string, number>();
  for (const s of suggestions.data?.suggestions ?? []) goalCounts.set(s.goal.id, (goalCounts.get(s.goal.id) ?? 0) + 1);
  const openGoal = (id: string, title: string) => openCounted(suggestions.data?.goals.find((g) => g.goal.id === id)?.goal ?? { id, key: id, title });

  // D: the items a change waiting for its decider pulls into another horizon ("pending").
  const pulledIn = new Set(allProposals.filter((c) => c.op === "change_horizon" && c.target.item_id).map((c) => String(c.target.item_id)));
  // roadmap-milestones D: the header's actions (D1: on the header's right, wrapping under the switch).
  const actions = (
    <div className={`flex flex-wrap items-center gap-2 ${phone ? "" : "ml-auto justify-end"}`} data-testid="roadmap-actions">
      {phone && canChange && addable.length > 0 && <QuickAdd phone options={addOptions} verb={addVerb} onAdd={onAdd} target={target?.title ?? null} roadmaps={askRoadmap ? addable.map((r) => r.roadmap) : []} />}
      {decides && !blank && (
        // roadmap-decide: broken links (the same ones Home and the side menu count), dates to
        // confirm, proposals and items pulled in, in the chosen roadmap's working draft (else every roadmap's).
        <Button
          data-testid="needs-decision"
          title={`Broken links, dates to confirm, proposals, items pulled in and suggested features, ${f.roadmap ? "in this roadmap's working draft" : "in your roadmaps' working drafts"}`}
          onClick={() => setTray(true)}
          data-zero={waiting ? undefined : "true"}
          // fix4 qa-simple-roadmap-38: at 0 the button is muted (nothing waits), still opens the tray.
          className={waiting ? "border-warn" : "border-line text-text2"}
        >
          Needs a decision · {waiting}
        </Button>
      )}
      <Button
        data-testid="key-dates-open"
        aria-expanded={keyDates}
        onClick={() => {
          setCard(null);
          setPop(null);
          setKeyDates(!keyDates);
        }}
      >
        Key dates · {data.key_dates?.length ?? 0}
      </Button>
      {/* fix4 qa-simple-roadmap-22 (was #13's disabled button with a reason): shown only to whom
       * may start one; busy, disabled, until the start options answer. */}
      {startsReviews && !blank && (
        <Button
          data-testid="start-review"
          disabled={!mayStartReview}
          // Busy until the start options say who may start (an owner's answer needs no wait).
          aria-busy={!startOptions.data && !startOptions.error && !can("start_simple_meeting") ? true : undefined}
          onClick={() => setStarting(true)}
        >
          Start review
        </Button>
      )}
      {!blank && (
        <>
          <Button disabled={!!exporting} aria-busy={exporting === "png" || undefined} onClick={() => void doExport("png")}>
            {exporting === "png" ? "Exporting PNG…" : "Export PNG"}
          </Button>
          <Button disabled={!!exporting} aria-busy={exporting === "pdf" || undefined} onClick={() => void doExport("pdf")}>
            {exporting === "pdf" ? "Exporting PDF…" : "Export PDF"}
          </Button>
        </>
      )}
    </div>
  );
  const scaleSwitch = (
    <SegmentedControl<GanttUnit>
      label="Scale"
      size="sm"
      value={unit}
      onChange={setUnit}
      items={[
        { value: "day", label: "Day", testId: "unit-day" },
        { value: "week", label: "Week", testId: "unit-week" },
      ]}
    />
  );
  // fix4 qa-simple-roadmap-12: a From after the To swaps them (the quarters the two name, in
  // order), said in a toast, never an inverted range drawn as an empty chart.
  const setRange = (from: string, to: string) => {
    if (from && to && from > to) {
      setF({ ...f, from: quarterOf(to).start, to: addDays(nextQuarter(quarterOf(from).start), -1) });
      swapped.current = `From was after To, so they were swapped: ${quarterOf(to).label} to ${quarterOf(from).label}`;
      toast({ message: swapped.current });
    } else {
      // qa4-simple-roadmap-43: the swap's message goes once the range changes again.
      if (swapped.current) clearToast(swapped.current);
      swapped.current = null;
      setF({ ...f, from, to });
    }
  };
  const filtered = !!(f.prd || f.goal || f.track || f.from || f.to);
  const clearFilters = () => {
    setRestored(true);
    setF({ ...NO_FILTERS, group: f.group, roadmap: f.roadmap });
    void remember({ simple_filters: { prd: "", goal: "", track: "" } }, "Could not remember these filters for next time");
  };
  // Review: the strip's and the tray's Clear filters show every broken link (all roadmaps too).
  const showAllLinks = () => {
    clearFilters();
    if (f.roadmap) setF({ ...NO_FILTERS, group: f.group });
  };
  // D1: PRD, Goal, Track, From, To, Group by and the Gantt's scale on one line (each select as wide as its choice).
  const pickers = (
    <>
      {readable.length > 1 && (
        <Select label="Roadmap" all="All roadmaps" testId="filter-roadmap" value={data.roadmap?.id ?? ""} options={readable.map((r) => [r.roadmap.id, r.roadmap.title])} onChange={pickRoadmap} />
      )}
      <Select
        label="PRD"
        value={f.prd}
        options={[...[...seen.prd].sort(([a, at], [b, bt]) => byPrd({ slug: a, title: at }, { slug: b, title: bt })), ...draftOnly.map((d) => [d.prd.slug, `${d.prd.title} (draft)`] as [string, string])]}
        onChange={(prd) => pickFilter("prd", prd)}
      />
      <Select label="Goal" value={f.goal} options={seen.goal} onChange={(goal) => pickFilter("goal", goal)} />
      <Select label="Track" value={f.track} options={seen.track} onChange={(track) => pickFilter("track", track)} />
      <Select label="From" value={f.from} options={qList.map((q) => [q.start, q.label])} onChange={(from) => setRange(from, f.to)} testId="filter-from" />
      <Select label="To" value={f.to} options={qList.map((q) => [q.end, q.label])} onChange={(to) => setRange(f.from, to)} testId="filter-to" />
    </>
  );
  // How many pickers narrow the view, on a phone's Filters button.
  const narrowed = [data.roadmap ? "roadmap" : "", f.prd, f.goal, f.track, f.from, f.to].filter(Boolean).length;
  const filters = (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2" data-testid="filters">
      <RemovedButton items={data.items} canChange={canChange} onOpen={(id) => (setPop(null), openCard(id))} onChanged={reload} />
      {phone ? (
        <Button data-filters-toggle="" data-testid="filters-toggle" aria-expanded={pickersOpen} aria-controls="roadmap-pickers" onClick={() => setPickersOpen(!pickersOpen)}>
          {narrowed ? `Filters · ${narrowed}` : "Filters"}
        </Button>
      ) : (
        pickers
      )}
      {phone && pickersOpen && (
        <div id="roadmap-pickers" data-testid="filter-pickers" className="order-last flex w-full flex-col items-start gap-2">
          {pickers}
        </div>
      )}
      {/* removed-tracks: a button, apart from the Track filter by its border and the rule before it. */}
      <span className="flex items-center gap-x-4">
        {!phone && <span aria-hidden className="h-6 border-l border-line" />}
        <TracksButton items={data.items} canChange={canChange} onChanged={reload} />
      </span>
      {/* The Timeline always draws its rows under their goal (rowsOf), so it offers no Group by. */}
      {format !== "timeline" && (
      <span className="flex max-w-full min-w-0 flex-wrap items-center gap-1.5 text-sm text-text2">
        Group by
        <SegmentedControl<Lane>
          label="Group by"
          size="sm"
          value={f.group}
          onChange={(group) => setF({ ...f, group })}
          items={[
            { value: "goal", label: "Goal", testId: "group-goal" },
            { value: "track", label: "Track", testId: "group-track" },
            { value: "prd", label: "PRD", testId: "group-prd" },
            { value: "milestone", label: "Milestone", testId: "group-milestone" },
          ]}
        />
      </span>
      )}
      {format === "gantt" && !phone && (
        <span className="flex items-center gap-1.5 text-sm text-text2">
          Scale
          {scaleSwitch}
        </span>
      )}
    </div>
  );
  const pickedGoal = f.goal ? { key: f.goal, title: seen.goal.find(([k]) => k === f.goal)?.[1] ?? f.goal } : null;
  // fix4 qa-simple-roadmap-17: a card's "N suggested features" opens the drawer on the tab that holds them.
  const openCounted = (g: GoalBrief) => {
    const { people, oracle } = goalRows(suggestions, g);
    setGoalStart(!people.length && oracle.length ? "oracle" : undefined);
    setGoalPanel(g);
  };
  // RP2: a draft PRD alone has nothing on the roadmap yet, so no goal tiles.
  const goalCounters = pickedDraft ? null : <GoalCounters data={data} byGoal={f.group === "goal" || f.group === "milestone"} suggestions={suggestions} onGoal={openCounted} only={pickedGoal} />;
  const draftBanner = (
    <DraftBanner
      drafts={drafts.data ?? []}
      focus={params.get("draft")}
      titleOf={titleOf}
      nameOf={(id) => draftPeople.data?.find((p) => p.user_id === id)?.name ?? "a reviewer"}
      personOf={(id) => draftPeople.data?.find((p) => p.user_id === id)?.name}
      onReview={(slug) => pickFilter("prd", slug)}
      inReview={data.changes_in_review ?? 0}
      meId={me?.user_id ?? null}
      onUndo={(id) =>
        void undo(id).then(
          () => {
            toast({ place: "top", message: "Undone" });
            return reloadAfter();
          },
          (e) => toast({ place: "top", message: e instanceof ChangeFailed ? e.message : "Oracle could not undo it" }),
        )
      }
      onSubmit={async (ds) => {
        for (const d of ds) {
          const r = await api.POST("/v1/simple/drafts/{draft_id}/submit", { params: { path: { draft_id: d.id } } });
          if (!r.data) toast({ place: "top", message: `${d.document.title} could not be sent for review` });
        }
        toast({ place: "top", message: ds.every((d) => d.published) ? "Sent for review: the approved roadmap stays published until it passes" : "Sent for review: the roadmap is published once it passes" });
        // A version sent for review waits on its reviewers and decider, the sender among them when they decide.
        await reloadAfter();
      }}
      onApprove={async (ds) => {
        for (const d of ds) {
          const r = await api.POST("/v1/simple/drafts/{draft_id}/approve", { params: { path: { draft_id: d.id } } });
          const left = r.data?.waiting_on.length ?? 0;
          toast({
            place: "top",
            message: !r.data
              ? `${d.document.title} could not be approved`
              : r.data.status === "approved"
                ? `Approved: ${d.document.title} is published`
                : !r.data.decider_approved && r.data.decider
                  ? `Approved: ${d.document.title} waits for ${r.data.decider.name} to decide`
                  : left
                  ? `Approved: ${d.document.title} waits for ${left} more ${left === 1 ? "reviewer" : "reviewers"}`
                  : "Approved: it waits for the other approvals",
          });
        }
        // The rail's and More's counts read again at once (the approval leaves the Inbox).
        await reloadAfter();
      }}
    />
  );

  return (
    <GoalNumbers.Provider value={numbers}>
    <ProposedFixes.Provider value={proposedFix}>
    <OpenItem.Provider value={openCard}>
    <MsProvider value={ms!}>
    {/* A phone's page ends clear of the tab bar (#36: its filters lead the chart, not the foot). */}
    <div className="simple-mode space-y-3 px-4 py-4 max-[600px]:pb-[calc(var(--phone-tab-bar)+16px)] min-[641px]:px-6" data-testid="simple-roadmap" data-phone={phone ? "true" : "false"}>
      <header className={`relative flex flex-wrap items-center ${phone ? "gap-2" : "gap-3"}`}>
        {/* A phone's header bar names the page (D3): the H1 is for screen readers there. */}
        <h1 className={phone ? "sr-only" : "text-2xl font-semibold"}>Roadmap</h1>
        {data.roadmap ? (
          // walkb-roadmap review 5f: a long name (a PRD's) wraps inside the page, never cut off; a
          // one-line chip stays a pill (its radius is over half its height).
          <span data-testid="roadmap-scope" className="max-w-full rounded-2xl bg-accent-soft px-3 py-0.5 text-[15px] font-semibold break-words text-accent-ink">
            {data.roadmap.title}
          </span>
        ) : (
          readable.length > 1 && (
            <span data-testid="roadmap-scope" className="text-[15px] text-text2">
              All roadmaps
            </span>
          )
        )}
        <div className={phone ? "w-full" : ""} data-testid="format-switch">
          <SegmentedControl<Format>
            label="Format"
            size="sm"
            fill={phone}
            value={format}
            onChange={(v) => {
              setCard(null);
              setPop(null);
              setFormat(v);
            }}
            items={[
              { value: "timeline", label: "Timeline", testId: "format-timeline" },
              { value: "gantt", label: "Gantt", testId: "format-gantt" },
              { value: "board", label: phone ? "Now/Next/Later" : "Now / Next / Later", testId: "format-board" },
              { value: "waterfall", label: "Waterfall", testId: "format-waterfall" },
            ]}
          />
        </div>
        {!phone && actions}
        {keyDates && <KeyDatesEditor key={data.roadmap?.id ?? "all"} data={data} act={act} mayChange={canChange} phone={phone} onClose={() => setKeyDates(false)} />}
      </header>
      <DraftPrdsRead needed={(!restored && !!(savedPicks?.prd && onRoadmap && !onRoadmap.prd.has(savedPicks.prd))) || (emptied && !!f.prd)} onRead={setDraftPrds} reloadRef={draftReload} />
      <DraftLayer
        drafts={shownDrafts}
        phone={phone}
        show={showDrafts}
        onShow={setShowDrafts}
        onlyPrd={pickedDraft && !data.items.length ? pickedDraft : null}
        picked={openDraft?.item.id ?? null}
        onOpen={(i: DraftItem) => {
          setCard(null);
          setPop(null);
          setDraftOpen(i.id);
        }}
      />
      {openDraft && (
        <FeaturePanel
          key={openDraft.item.id}
          feature={{ code: openDraft.item.key, name: openDraft.item.title, prd: openDraft.prd.prd }}
          phone={phone}
          canChange={openDraft.prd.can_change}
          onClose={() => setDraftOpen(null)}
          top={draftTop}
          draft={{
            item: openDraft.item,
            prd: openDraft.prd,
            onChanged: async (words: string) => {
              await reload();
              toast({ message: words });
            },
          }}
        />
      )}
      <p role="status" aria-live="polite" className="sr-only" data-testid="key-pending">
        {said}
      </p>
      {/* D3: a phone's Gantt shows its scale, and which milestone the weeks hide, over the chart. */}
      {phone && format === "gantt" && (
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-text2" data-testid="phone-scale">
          <span className="flex items-center gap-1.5">
            Scale
            {scaleSwitch}
          </span>
          {offscreen &&
            (() => {
              // #20: the hint named only the milestone's code ("M2"); write its name too.
              const full = (data.milestones.find((m) => m.name.split(/[\s·]/)[0] === offscreen)?.name ?? offscreen).replace(" · ", " ");
              return (
                <span data-testid="swipe-hint" className="whitespace-normal break-words">
                  Swipe sideways for {full}
                </span>
              );
            })()}
        </div>
      )}
      {/* fix4 qa-simple-roadmap-44: a phone's page actions sit near the top, as a desktop's do. */}
      {phone && actions}
      {!phone && canChange && addable.length > 0 && <QuickAdd phone={false} options={addOptions} verb={addVerb} onAdd={onAdd} target={target?.title ?? null} roadmaps={askRoadmap ? addable.map((r) => r.roadmap) : []} />}
      {!phone && goalCounters}
      <StartSheet open={starting} onClose={() => setStarting(false)} origin="roadmap" prefer={reviewPrd} from={reviewFrom} roadmap={reviewRoadmap} />
      {draftBanner}
      {/* The items' decisions left out as no longer standing, one quiet line under the banner. */}
      <LeftOutLine leftOut={data.left_out} className="px-1 text-sm text-text-faint" />
      <AppliedVersions
        lines={data.applied_versions ?? []}
        onApply={async (l) => {
          const r = await api.POST("/v1/simple/roadmap/apply-approved", { params: { query: { roadmap: l.roadmap.id } } });
          toast({ message: r.data ? `Applied version ${l.version} of ${l.roadmap.title}` : `Version ${l.version} could not be applied` });
          await reloadAfter();
        }}
      />
      {/* #36: on a phone, Roadmap/Goal/Track and Group by read before the chart, not after
       * the legend and goal cards at the page's foot. */}
      {!blank && filters}
      {!blank && <MsKey />}
      {blank && (
        <p className="text-[15px] text-text2" data-testid="roadmap-empty">
          {hasGoals ? (
            <>No features yet: accept one Oracle suggests under a goal, and it shows here on its dates.</>
          ) : (
            <>
              No features yet: confirm your company&rsquo;s goals in{" "}
              <Link href="/ground-truth" className="font-semibold text-accent-ink underline">
                Detailed › Ground Truth
              </Link>{" "}
              and Oracle suggests the features for them here.
            </>
          )}
        </p>
      )}
      <div ref={wrap} className={blank ? "hidden" : "relative"} onContextMenu={onRowMenu}>
        {rowMenu && rowMenuItem && (
          <FeatureContextMenu
            at={rowMenu}
            title={rowMenuItem.title}
            propose={!rowMenuItem.can_decide}
            onClose={() => setRowMenu(null)}
            onDelete={() => {
              void removeFeature(rowMenuItem);
            }}
          />
        )}
        {linked.length ? (
          <div data-testid="filters-gone" className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-line-strong bg-surface px-4 py-3">
            <p className="text-[15px] font-semibold">
              {linked.length > 1 ? "That PRD and goal are no longer on this roadmap" : linked[0] === "prd" ? "That PRD is no longer on this roadmap" : "That goal is no longer on this roadmap"}
            </p>
            <Button onClick={clearLinked}>Clear</Button>
          </div>
        ) : filtered && !data.items.length ? (
          // fix4 qa-simple-roadmap-12: no bare axis when the filters leave nothing: say so, and a way back.
          <div data-testid="filters-empty" className="flex flex-col items-start gap-2 rounded-xl border border-dashed border-line-strong bg-surface px-4 py-6">
            <p className="text-[15px] font-semibold">Nothing matches these filters</p>
            <Button onClick={clearFilters}>Clear filters</Button>
          </div>
        ) : format === "board" ? (
          <Board
            data={laned ?? data}
            phone={phone}
            canDrag={canChange}
            proposals={allProposals}
            open={card?.id ?? null}
            onOpen={(item) => {
              setPop(null);
              if (ms?.pick(item.id)) return;
              setCard({ id: item.id, ...anchorOf(item.id) });
            }}
            onMove={onHorizon}
            pending={horizons.pending}
            onKeyMove={onKeyHorizon}
            onKeyEnd={(item) => horizons.flush(item.id)}
            onKeyCancel={onKeyCancel(horizons)}
            dropTargets={canChange}
            goalSuggestions={goalCounts}
            onGoal={openGoal}
          />
        ) : format === "timeline" ? (
          // mk-qa4-roadmap QR1 A..QR4 A: six months around today, the key and the broken links
          // above, an open item in a panel at the right (a sheet on a phone).
          <ZoomTimeline
            data={goalLaned ?? data}
            all={allLinks}
            onAll={showAllLinks}
            phone={phone}
            act={act}
            canChange={canChange}
            byId={byId}
            moved={moved}
            onMove={onMove}
            onKeyMove={onKeyMove}
            onKeyEnd={(item) => dates.flush(item.id)}
            onKeyCancel={onKeyCancel(dates)}
            openKey={cardItem?.key ?? null}
            onOpen={(k) => {
              const it = k ? data.items.find((x) => x.key === k) : undefined;
              if (it && ms?.pick(it.id)) return;
              setPop(null);
              setCard(it ? { id: it.id, left: 0, top: 0 } : null);
            }}
            card={(it, style, sheet, onClose) => (
              <FloatingCard
                key={it.id}
                item={it}
                items={byId}
                proposals={allProposals.filter((c) => c.target.item_id === it.id)}
                phone={sheet}
                style={style}
                act={act}
                canChange={canChange}
                onDecide={(c, how) => void onDecide(c, how)}
                onClose={onClose}
                near={nearWords(it, data.key_dates ?? [])}
                onOpen={(id) => setCard({ id, left: 0, top: 0 })}
                onSuggestion={(how, d) => void onSuggestion(it, how, d)}
                focus={it.id === linkedItem}
              />
            )}
          />
        ) : (
          <>
          {/* mk-qa4-roadmap QR3 A: the broken links sit in the panel above the chart, never over a bar. */}
          <ConflictPanel
            data={laned ?? data}
            all={allLinks}
            onAll={showAllLinks}
            phone={phone}
            act={act}
            canChange={canChange}
            byId={byId}
            onShow={(k) => {
              const it = data.items.find((x) => x.key === k);
              if (!it) return;
              setPop(null);
              setCard({ id: it.id, ...anchorOf(it.id) });
            }}
          />
          <Chart
            data={laned ?? data}
            lane={f.group}
            noWork={noWork}
            format={format}
            unit={unit}
            compact={phone}
            canDrag={canChange}
            moved={moved}
            open={card?.id ?? null}
            chartRef={(el) => {
              svg.current = el;
            }}
            dropTargets={canChange}
            onOffscreen={setOffscreen}
            pulled={pulledIn}
            onOpen={(item) => {
              if (ms?.pick(item.id)) return;
              setPop(null);
              setCard({ id: item.id, ...anchorOf(item.id) });
            }}
            onMove={onMove}
            onKeyMove={onKeyMove}
            onKeyEnd={(item) => dates.flush(item.id)}
            onKeyCancel={onKeyCancel(dates)}
            onSuggestion={(item) => {
              setCard(null);
              setPop({ id: item.id, ...anchorOf(item.id) });
            }}
            overlay={(l, sc, keepOff) => <GanttMilestones l={l} sc={sc} data={laned ?? data} phone={phone} keepOff={keepOff} />}
          />
          </>
        )}
        {/* The Timeline's export draws its picture from the goal lanes, laid out off screen while it
            saves, with a row naming each quarter over its months. Off screen, not hidden: the names
            column is read as text (a hidden element has none). */}
        {format === "timeline" && exporting && (
          <div aria-hidden inert className="pointer-events-none fixed top-0 left-[-20000px] w-[1400px]">
            <Lanes
              quarterAxis
              data={laned ?? data}
              lane={f.group}
              noWork={noWork}
              compact={false}
              canDrag={false}
              moved={moved}
              open={null}
              chartRef={(el) => {
                svg.current = el;
              }}
              dropTargets={false}
              onOpen={() => undefined}
              onMove={onMove}
              onKeyMove={onKeyMove}
              onKeyEnd={() => undefined}
              onKeyCancel={onKeyCancel(dates)}
              onSuggestion={() => undefined}
            />
          </div>
        )}
        <DoneItems
          items={doneItems}
          open={card?.id ?? null}
          reveal={reveal}
          onOpen={(item) => {
            setPop(null);
            setCard({ id: item.id, ...anchorOf(item.id) });
          }}
        />
        {/* The Timeline opens its own items in its panel; a done item, off it, opens here. */}
        {(format !== "timeline" || cardItem?.status === "done") && cardItem && card && (
          <FloatingCard
            key={cardItem.id}
            item={cardItem}
            items={byId}
            proposals={allProposals.filter((c) => c.target.item_id === cardItem.id)}
            phone={phone}
            style={{ left: card.left, top: card.top }}
            act={act}
            canChange={canChange}
            onDecide={(c, how) => void onDecide(c, how)}
            onClose={() => setCard(null)}
            near={nearWords(cardItem, data.key_dates ?? [])}
            onOpen={(id) => setCard({ id, ...anchorOf(id) })}
            onSuggestion={(how, d) => void onSuggestion(cardItem, how, d)}
            focus={cardItem.id === linkedItem}
            onHorizon={format === "board" && canChange && !closedItem(cardItem) ? (h) => onHorizon(cardItem, h) : undefined}
          />
        )}
        {popItem?.suggestion && pop && (
          <SuggestionPopover
            key={popItem.suggestion.id}
            item={popItem}
            canAct={can("accept_date_suggestion")}
            style={{ left: pop.left, top: pop.top }}
            above={pop.above}
            onAccept={() => void onSuggestion(popItem, "accept")}
            onEdit={(s, e) => void onSuggestion(popItem, "edit", { start_date: s, end_date: e })}
            onDismiss={() => void onSuggestion(popItem, "dismiss")}
            onClose={() => setPop(null)}
          />
        )}
      </div>
      {/* fix4 qa-simple-roadmap-7/34/35: every format's legend in the Timeline's style (a
       * swatch drawn as the mark is, then short words), naming only the marks shown. */}
      {blank ? null : format === "waterfall" ? (
        <LegendKeys
          entries={[
            /* #23: only the phases a bar actually draws get a key (no Discover key when
             * nothing is in discovery). #41, qa-simple-roadmap-23/41: the key draws what a bar
             * does, its solid ink beside its hatch in the phase's own colour. qa4-simple-roadmap-31:
             * under a "Phases" label, Beta named "Beta phase" (a key date may be called Beta). */
            legendGroup("phases", "Phases", PHASES.filter((p) => (laned ?? data).items.some((i) => i.phases.some((x) => x.key === p.key))).map((p) => ({
              key: p.key,
              testId: "phase-key",
              swatch: (
                <span aria-hidden className="inline-flex h-3 w-7 flex-none overflow-hidden rounded-sm" data-ink={p.ink}>
                  <span className="h-full w-1/2" style={{ background: p.ink }} />
                  <span className="h-full w-1/2" style={{ background: `repeating-linear-gradient(45deg, ${p.soft} 0, ${p.soft} 2.6px, ${p.ink} 2.6px, ${p.ink} 5.6px)` }} />
                </span>
              ),
              words: p.key === "beta" ? "Beta phase" : p.label,
            }))),
            { key: "solid", swatch: <i aria-hidden className={LEGEND_SWATCH} style={{ background: "var(--accent)", borderColor: "var(--accent)" }} />, words: "Dated" },
            {
              key: "hatched",
              swatch: <i aria-hidden className={LEGEND_SWATCH} style={{ background: "repeating-linear-gradient(45deg, var(--accent-soft) 0 2.6px, var(--accent) 2.6px 5.6px)", borderColor: "var(--accent)" }} />,
              words: MARK_WORDS.estimated,
            },
            {
              key: "move",
              swatch: null,
              words: canChange ? `Drag a bar${phone ? " (press and hold first)" : ""} or use the arrow keys to move it; a dated gate stays on its day` : "A dated gate stays on its day when the item moves",
            },
            // qa4-simple-roadmap-31: Today with the key dates, under a "Marks" label (not on its own).
            legendGroup("marks", "Marks", [...keyDateEntries(laned ?? data), TODAY_ENTRY]),
          ]}
        />
      ) : format === "board" ? (
        <LegendKeys entries={boardLegend(data, phone, canChange)} />
      ) : format === "gantt" ? (
        <LegendKeys entries={ganttLegend(laned ?? data, noWork, pulledIn.size)} />
      ) : null}
      {/* D3: on a phone the chart's own filters lead (#36); the goals follow it. */}
      {phone && goalCounters}
      {tray && (
        <DecisionTray
          items={data.items}
          byId={byId}
          proposals={allProposals}
          act={act}
          canChange={canChange}
          onDecide={(c, how) => void onDecide(c, how)}
          onSuggestion={(i, how, id) => void onSuggestion(i, how, undefined, id)}
          onClose={() => setTray(false)}
          phone={phone}
          suggestions={suggestions}
          top={trayTop}
          allLinks={allLinks}
          allDates={allDates}
          oneRoadmap={!!f.roadmap}
          waitsFor={waitsFor}
          onAll={showAllLinks}
        />
      )}
      {goalPanel && <GoalPanel goal={goalPanel} api={suggestions} start={goalStart} onClose={() => setGoalPanel(null)} />}
    </div>
      <MsCard />
      <MsToast />
    </MsProvider>
    </OpenItem.Provider>
    </ProposedFixes.Provider>
    </GoalNumbers.Provider>
  );
}

/** build-milestones-on-roadmap: the milestone layer over the Gantt, in the chart's pixels. */
function GanttMilestones({ l, sc, data, phone, keepOff }: { l: Layout; sc: ChartScale; data: Roadmap; phone: boolean; keepOff?: [number, number][] }) {
  const byId = new Map(data.items.map((i) => [i.id, i]));
  const rows: MsRow[] = [];
  const lanes: MsLane[] = [];
  for (const g of data.groups) {
    const ys = g.item_ids.map((id) => l.y.get(id)).filter((y): y is number => y != null);
    if (ys.length) lanes.push({ key: g.key, title: g.title, y0: Math.min(...ys) - l.rowH, y1: Math.max(...ys) + l.rowH });
    for (const id of g.item_ids) {
      const i = byId.get(id);
      const y = l.y.get(id);
      if (i && y != null) rows.push({ id: i.id, title: i.title, lane: g.key, y, h: l.rowH, start: i.start.date, end: i.end.date });
    }
  }
  // pre-demo QA S-12: "+ Milestone" steps past the key dates' and milestones' names over the axis.
  return <MsLayer view="gantt" x={(d) => sc.x(d) + sc.px / 2} top={l.top} axisY={l.top - 2} height={l.height} width={sc.width} rows={rows} lanes={lanes} phone={phone} keepOff={keepOff} />;
}
