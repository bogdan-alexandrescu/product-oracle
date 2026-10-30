"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { Button, Notice, SegmentedControl, toast as dsToast, type ToastAsk } from "@/components/ds";
import { GoalPanel, goalRows, SuggestionCard, useGoalSuggestions, type GoalBrief, type GoalPanelStart, type GoalSuggestionsApi } from "@/components/simple/GoalSuggestions";
import { StartSheet } from "@/components/simple/meetings/StartSheet";
import { Loading } from "@/components/ui";
import { getBranding, logoDataUrl } from "@/lib/api/branding";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { CARD_CHANGED_EVENT } from "@/lib/api/simple-chat";
import { displayZone, plainClock } from "@/lib/dates";
import { useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";

import { QuickAdd } from "./_add";
import { Board, boardColumns, boardLegend, HORIZONS, LEGEND_SWATCH, LegendKeys, type Horizon, type LegendEntry } from "./_board";
import { useKeyBurst } from "./_burst";
import { Callout, changeRowWords, FlagLine, FixButtons, FloatingCard, LooksLike, opWords, SuggestionPopover, type Act } from "./_card";
import { boardPicture, chartPicture, exportView, type Brand } from "./_export";
import { KeyDatesEditor } from "./_keydates";
import { Lanes, pmItem } from "./_lanes";
import {
  addDays,
  broken,
  brokenLinks,
  ChangeFailed,
  changedWords,
  closedItem,
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
} from "./_lib";
import { Chart, PHASES } from "./_timeline";

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

// fix4 qa-simple-roadmap-29: "since 7:02 PM" (its day when not today), no zone name.
const time = (at: string) => plainClock(at, displayZone());

/** fix4 qa-simple-roadmap-35: a key date's two marks: filled, and hollow while it is only in the draft. */
function keyDateEntries(data: Roadmap): LegendEntry[] {
  const kds = data.key_dates ?? [];
  const out: LegendEntry[] = [];
  if (kds.some((k) => !k.in_draft)) out.push({ key: "key", swatch: <i aria-hidden className="inline-block h-2 w-2 flex-none rotate-45 bg-accent-ink" />, words: "Key date" });
  if (kds.some((k) => k.in_draft))
    out.push({ key: "key-draft", swatch: <i aria-hidden className="inline-block h-2 w-2 flex-none rotate-45 border border-accent-ink bg-surface" />, words: "Key date in the draft" });
  return out;
}

const TODAY_ENTRY: LegendEntry = { key: "today", swatch: <i aria-hidden className="inline-block h-3.5 w-0.5 flex-none bg-crit" />, words: "Today" };

/** The Gantt's legend (roadmap-milestones D), naming only what the chart draws. fix4
 * qa-simple-roadmap-34: the Timeline's style (a swatch, then short words). */
function ganttLegend(data: Roadmap, noWork: { start: string; end: string; label?: string | null }[], pulled: number): LegendEntry[] {
  const parts: LegendEntry[] = [];
  const add = (key: string, swatch: LegendEntry["swatch"], words: string) => parts.push({ key, swatch, words });
  const sw = LEGEND_SWATCH;
  const dated = (i: Item) => i.slices.filter((x) => x.start_date && x.end_date);
  if (data.items.some((i) => dated(i).length > 1)) add("slices", <i aria-hidden className="inline-block w-[18px] flex-none border-t-2 border-dotted border-line-strong" />, "One bar per part of a feature");
  if (data.milestones.some((m) => m.start_date && m.end_date)) add("milestone", <i aria-hidden className="inline-block h-2 w-2 flex-none rotate-45 bg-accent-ink" />, "Milestone ends (dashed line)");
  // #22: the API's own label, as the Timeline says it ("Holidays year-end break").
  if (noWork.length) add("holidays", <i aria-hidden className="inline-block h-2.5 w-[18px] flex-none rounded-[2px] bg-na-bg" />, `Holidays ${noWork.map((h) => h.label ? h.label.charAt(0).toLowerCase() + h.label.slice(1) : spanWords(h.start, h.end, data.today, true)).join(", ")}`);
  if (data.items.some((i) => dated(i).some((x) => x.pm_owned || x.effort_weeks == null))) add("pm", <i aria-hidden className={`${sw} border-dashed border-line-strong`} />, "No engineering work");
  if (pulled) add("pulled", <i aria-hidden className={sw} style={{ background: "var(--warn-bg)", borderColor: "var(--warn)" }} />, "Pulled in, pending");
  const plain = data.items.filter((i) => !dated(i).length && !closedItem(i));
  if (plain.some((i) => !i.draft && !i.estimated)) add("dated", <i aria-hidden className={sw} style={{ background: "var(--accent)", borderColor: "var(--accent-ink)" }} />, "Dated");
  if (plain.some((i) => !i.draft && i.estimated))
    add("estimated", <i aria-hidden className={sw} style={{ background: "repeating-linear-gradient(135deg, var(--accent-mid) 0 2px, var(--accent-soft) 2px 5px)", borderColor: "var(--line-strong)" }} />, "Estimated");
  if (plain.some((i) => i.draft)) add("draft", <i aria-hidden className={`${sw} border-dashed border-line-strong`} />, "Draft");
  if (data.items.some((i) => i.suggestion)) add("suggestion", <i aria-hidden className={`${sw} border-dotted border-accent-ink`} />, "Dates Oracle suggests (? opens them)");
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
  const count = (id: string) => (suggestions.data?.suggestions ?? []).filter((s) => s.goal.id === id).length;
  const known = (id: string) => suggestions.data?.goals.find((g) => g.goal.id === id)?.goal;
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
    for (const g of lanes(data, "goal").groups) if (g.key !== "none") for (const id of g.item_ids) if (shown(byId.get(id))) add(g.key, g.title, byId.get(id)!);
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
    const g = known(id);
    return g ? (
      <button type="button" data-testid="goal-counter-suggestions" onClick={() => onGoal(g)} className="text-sm font-semibold text-accent-ink hover:underline">
        {/* QA2 24: no "0 suggested features": with none yet, the button says what it opens. */}
        ✦ {count(id) ? `${count(id)} suggested ${count(id) === 1 ? "feature" : "features"}` : "Suggest a feature"}
        <span className="sr-only"> for {title}</span>
      </button>
    ) : null;
  };
  return (
    <ul className="grid grid-cols-2 gap-2 min-[900px]:grid-cols-4" data-testid="goal-counters">
      {cards.slice(0, 4).map(([id, g]) => (
        <li key={id} data-testid="goal-counter" className="rounded-xl border border-line bg-surface px-3 py-2">
          <p className="truncate text-[15px] font-semibold" title={g.title}>
            {g.title}
          </p>
          {/* fix4 qa-simple-roadmap-49: the metric wraps to a second line, its full words on hover past that. */}
          <p className="line-clamp-2 text-sm break-words text-text2" title={g.metric ?? undefined} data-testid="goal-counter-metric">
            {g.metric ?? "No metric yet"}
          </p>
          <p className="mt-0.5 text-sm">
            <b className="tnum">{g.items}</b> items
            {g.broken > 0 && (
              <span className="text-crit">
                {" "}
                · <b className="tnum">{g.broken}</b> broken
              </span>
            )}
          </p>
          {open(id, g.title)}
        </li>
      ))}
      {empty.map((g) => (
        <li key={g.goal.id} data-testid="goal-counter-empty" className="rounded-xl border border-dashed border-line-strong bg-surface px-3 py-2">
          <p className="truncate text-[15px] font-semibold" title={g.goal.title}>
            {g.goal.title}
          </p>
          <p className="truncate text-sm text-text2">{g.empty ? "No items yet" : "No items in these filters"}</p>
          {open(g.goal.id, g.goal.title)}
        </li>
      ))}
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
      <select value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId} className="h-8 max-w-[11rem] rounded-lg border border-line-strong bg-surface px-2 text-sm text-text [field-sizing:content]">
        <option value="">{all}</option>
        {options.map(([v, t]) => (
          <option key={v} value={v}>
            {t}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The working-draft banner (D18 as amended: one shared draft per roadmap). */
function DraftBanner({ drafts, inReview, meId, onUndo, onSubmit, titleOf }: { drafts: Draft[]; inReview: number; meId: string | null; onUndo: (id: string) => void; onSubmit: (d: Draft[]) => void; titleOf: (id: string | null) => string | undefined }) {
  const [open, setOpen] = useState(false);
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
  const submittable = working.filter((d) => d.status === "working" && d.can_submit && d.changes > 0);
  return (
    <section data-testid="draft-banner" className="rounded-xl border border-accent-mid bg-accent-soft px-4 py-2.5 text-accent-ink">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {/* fix4 qa-simple-roadmap-19: on a phone the sentence takes its own line(s), the three buttons a row under it. */}
        <p className="min-w-0 flex-1 text-[15px] max-[640px]:basis-full" data-testid="draft-words">
          <b>Your working draft</b> · <span data-testid="draft-count">{changes}</span> {changes === 1 ? "change" : "changes"} since {time(since)} · the approved roadmap stays published until review passes
        </p>
        <Button variant="ghost" disabled={!last} onClick={() => last && onUndo(last.id)}>
          Undo
        </Button>
        <Button variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
          See changes
        </Button>
        <Button variant="solid" disabled={!submittable.length} onClick={() => onSubmit(submittable)}>
          Send for review
        </Button>
      </div>
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

/** C's "Needs a decision" tray, summarised by B's four counters. */
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
}) {
  const twins = items.filter((i) => i.can_decide && i.looks_like.length > 0);
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
  const counters: [string, number][] = [
    ["Broken links", brokenItems.length],
    ["Dates to confirm", dateRows.length],
    ["Proposals", others.length],
    ["Pulled in", pulled.length],
  ];
  const kd = (c: Change) => (c.after.key_date ?? c.before.key_date) as { name?: string } | null | undefined;
  const title = (c: Change) => (kd(c)?.name ? `Key date '${kd(c)!.name}'` : (byId.get(String(c.target.item_id))?.title ?? (typeof c.after.title === "string" ? c.after.title : "An item")));
  const row = (c: Change) => (
    <li key={c.id} className="flex flex-wrap items-center gap-2 py-1.5" data-testid="tray-proposal">
      <span className="min-w-0 flex-1 text-[15px]">
        {title(c)}: {opWords(c.op).toLowerCase()} · <span className="text-text2">{c.by_name}</span>
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
      {/* #37: what the button's count is, on screen: this view's own, not the side menu's badges. */}
      <p className="mt-1 text-sm text-text2" data-testid="tray-scope">
        {counts.total} on this roadmap view. The side menu&apos;s Decisions and Roadmap counts cover other things, so they can differ.
      </p>
      <ul className="mt-3 grid grid-cols-2 gap-2 min-[420px]:grid-cols-4" data-testid="tray-counters">
        {counters.map(([label, n]) => (
          // fix4 qa-simple-roadmap-38: equal tiles (each as tall as the tallest, its label on two
          // lines at most); a tile at 0 is muted, plain text, not something to press.
          <li key={label} data-testid="tray-counter" data-zero={n === 0 ? "true" : undefined} className={`flex flex-col items-center justify-start rounded-lg px-1 py-1.5 text-center ${n ? "border border-line" : "bg-surface2 text-text-faint"}`}>
            <b className={`tnum block text-xl ${n ? "" : "font-medium"}`}>{n}</b>
            {/* #43: every tile's label sits at the same height with tight spacing, so
             * "Dates to confirm" wrapping to two lines doesn't push its number apart from
             * the one-line labels beside it. */}
            <span className={`block min-h-[2lh] text-xs leading-tight [text-wrap:balance] ${n ? "text-text2" : ""}`}>{label}</span>
          </li>
        ))}
      </ul>
      <section className="mt-4">
        <h3 className="font-semibold">Broken links</h3>
        {brokenItems.length ? (
          <ul>
            {brokenItems.map((i) => (
              <li key={i.id} className="border-b border-line py-2" data-testid="tray-broken">
                <p className="text-[15px] font-medium">{i.title}</p>
                {broken(i).map((f) => (
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
                <p className="text-[15px] font-medium">{i.title}</p>
                {broken(i)
                  .filter((f) => !brokenLinks(i).includes(f))
                  .map((f) => (
                    <div key={`${f.kind}-${f.subject}`}>
                      <FlagLine flag={f} />
                      <FixButtons item={i} flag={f} items={byId} act={act} canChange={canChange} />
                    </div>
                  ))}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="mt-4">
        <h3 className="font-semibold">Dates to confirm</h3>
        {dateRows.length ? (
          <ul>
            {dateRows.map(({ item: i, s, parts }) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2 py-1.5" data-testid="tray-date" data-item={i.id}>
                <div className="min-w-0 flex-1 text-[15px]">
                  <span>
                    {i.title}: {shortDay(s.start_date)} – {shortDay(s.end_date)}
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
      <section className="mt-4">
        <h3 className="font-semibold">Pulled in, pending a decision</h3>
        {pulled.length ? <ul>{pulled.map(row)}</ul> : <p className="text-sm text-text2">None.</p>}
      </section>
      <section className="mt-4" data-testid="tray-twins">
        <h3 className="font-semibold">Drafts that look like an item</h3>
        {twins.length ? (
          <ul>
            {twins.map((i) => (
              <li key={i.id} className="border-b border-line py-2" data-testid="tray-twin">
                <p className="text-[15px] font-medium">{i.title}</p>
                <LooksLike item={i} act={act} canChange={canChange} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-text2">None.</p>
        )}
      </section>
      <section className="mt-4" data-testid="tray-suggested">
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
  const [exporting, setExporting] = useState(false);
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
        return d;
      }),
    { keepPrevious: true },
  );
  const proposals = useQuery("simple-proposals", () => unwrap(api.GET("/v1/simple/changes", { params: { query: { status: "proposed" } } })));
  const drafts = useQuery("simple-drafts", () => unwrap(api.GET("/v1/simple/drafts")));
  // Who may start a review is the start sheet's own per-PRD answer (meetings.may_start: an owner,
  // or a PRD's decider), not who decides this roadmap's items; the same read the sheet makes.
  const startOptions = useQuery("simple-meeting-options||", () =>
    unwrap(api.GET("/v1/simple/meetings/options", { params: { query: { prd: undefined, occurrence: undefined } } })),
  );
  const reload = useCallback(async () => {
    await Promise.all([roadmap.reload(), proposals.reload(), drafts.reload()]);
  }, [roadmap, proposals, drafts]);
  // roadmap-talk: a chat card applied, proposed, rejected or undone (the item's talk, the Ask panel) reads the roadmap again.
  useEffect(() => {
    const on = () => void reload();
    window.addEventListener(CARD_CHANGED_EVENT, on);
    return () => window.removeEventListener(CARD_CHANGED_EVENT, on);
  }, [reload]);
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
  const prefs = useQuery("me-preferences", () => unwrap(api.GET("/v1/me/preferences")));
  const [restored, setRestored] = useState(false);
  const known = roadmap.data?.roadmaps;
  if (!restored && known && (prefs.data || prefs.error)) {
    setRestored(true);
    const pick = prefs.data?.simple_roadmap;
    const kept = prefs.data?.simple_filters;
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
  const data = roadmap.data;
  // roadmap-gantt: the rows' lanes, and the plans' no-work weeks (each PRD with planned items).
  const laned = useMemo(() => (data ? lanes(data, f.group) : null), [data, f.group]);
  const planPrds = useMemo(() => [...new Set((data?.items ?? []).flatMap((i) => (i.slices.length && i.prd ? [i.prd.slug] : [])))].sort(), [data]);
  // A plan the reader cannot open (404) leaves the other plans' no-work weeks.
  const plans = useQuery(`simple-plan-no-work:${planPrds.join(",")}`, async () =>
    (await Promise.allSettled(planPrds.map((prd) => unwrap(api.GET("/v1/simple/prds/{prd}/plan", { params: { path: { prd } } }))))).flatMap((r) => (r.status === "fulfilled" ? [r.value] : [])),
  );
  const noWork = useMemo(() => [...new Map((plans.data ?? []).flatMap((p) => p.holidays).map((h) => [h.start, h])).values()], [plans.data]);
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
  const byId = useMemo(() => new Map((data?.items ?? []).map((i) => [i.id, i])), [data]);
  const canChange = can("create_simple_change");
  // The items as last loaded, for a burst sent after the render that started it.
  const latest = useRef(byId);
  useEffect(() => {
    latest.current = byId;
  });

  /** One change through the engine, its toast (with Undo when it applied) and the reload; null when it failed. */
  const run = useCallback(
    async (what: string, body: Parameters<Act>[1]): Promise<ChangeResult | null> => {
      try {
        const r = await propose(body);
        const target = latest.current.get(String(body.target?.item_id ?? ""));
        toast({
          message: resultWords(r, what, target?.deciders),
          action: r.change.status === "applied" && r.change.can_undo ? { label: "Undo", onClick: () => void undo(r.change.id).then(reload, (e) => toast({ message: String(e.message) })) } : undefined,
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
        await reload();
      }
    },
    [reload],
  );
  const act: Act = useCallback(
    async (what, body) => {
      await run(what, body);
    },
    [run],
  );

  // A move (a drag, or the keyboard's burst) is one change; what is stored after it is the
  // next burst's `before` (#723 S4 re-review: no 409 on one's own earlier move).
  const dates = useKeyBurst<Dates>(async (id, before, after) => {
    const item = latest.current.get(id);
    if (!item) return null;
    const r = await run(`Moved '${item.title}' to ${shortDay(after.start_date!)} – ${shortDay(after.end_date!)}`, { op: "move_dates", target: { item_id: id }, before, after });
    if (!r) {
      const now = fetched.current?.get(id);
      return now ? storedDates(now) : null;
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
    dates.press(item.id, storedDates(stored(item)), { start_date: start, end_date: end });
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
      dates.press(item.id, storedDates(latest.current.get(item.id) ?? item), { start_date: start, end_date: end });
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

  const anchorOf = (id: string): { left: number; top: number; above: number } => {
    const el = wrap.current?.querySelector(`[data-bar-id="${id}"]`);
    const box = wrap.current?.getBoundingClientRect();
    const r = el?.getBoundingClientRect();
    if (!r || !box) return { left: 0, top: 0, above: 0 };
    return { left: Math.max(0, Math.min(r.left - box.left, box.width - 390)), top: r.bottom - box.top + 6, above: r.top - box.top - 6 };
  };

  const onDecide = useCallback(
    async (c: Change, how: "accept" | "decline") => {
      try {
        await decide(c.id, how);
        toast({ message: how === "accept" ? "Accepted: it is in your working draft" : "Declined" });
      } catch (e) {
        toast({ message: e instanceof ChangeFailed ? e.message : "Oracle could not decide it" });
      }
      await reload();
    },
    [reload],
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
      await reload();
    },
    [reload],
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
    if (!f.roadmap && !f.prd && !f.goal && !f.track && !f.from && !f.to) parts.push("every roadmap");
    return parts.join(" · ");
  };

  const doExport = async (kind: "png" | "pdf") => {
    if (!data) return;
    const labels = wrap.current?.querySelector<HTMLElement>('[data-testid="chart-labels"]') ?? null;
    if (format !== "board" && !svg.current) return;
    setExporting(true);
    try {
      const pic = format === "board" ? boardPicture(boardColumns(data), data.today) : chartPicture(svg.current!, labels);
      const title = `Roadmap · ${FORMAT_WORDS[format]}${format === "gantt" ? ` (${unit})` : ""}`;
      await exportView(kind, pic, { title, filters: filterWords(), brand: await brandOf() }, data.today, `roadmap-${format}`);
    } catch {
      toast({ message: "The view could not be exported" });
    } finally {
      setExporting(false);
    }
  };

  if (roadmap.error && !data) return <Notice tone="error">{roadmap.error}</Notice>;
  if (!data) return <Loading />;

  const cardItem = card ? byId.get(card.id) : undefined;
  const popItem = pop ? byId.get(pop.id) : undefined;
  const allProposals = proposals.data ?? [];
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
  const waiting = decisionCounts(data.items, allProposals).total;
  const qList = quarters(data.windows.now.start, data.windows.later.end);
  // qa-shell-8: a new company's roadmap has nothing on it (no item, milestone or key date, and
  // no filter narrowing it): one line on what shows here and the next step, no empty chart and
  // no review or export of nothing.
  const blank =
    !data.items.length && !data.milestones.length && !data.key_dates?.length && !f.prd && !f.goal && !f.track && !f.from && !f.to && !data.roadmap;
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
                      return reload();
                    },
                    (e) => toast({ message: e instanceof ChangeFailed ? e.message : "Oracle could not undo it" }),
                  ),
              }
            : undefined,
        });
      // fix4 qa-simple-roadmap-21: who decides, and where the proposal shows.
      else toast({ message: `Proposed ${title} (${w.label}): it waits for ${deciderWords(undefined)} in Needs a decision` });
      await reload();
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
        // #37: this counts broken links, suggestions and proposals on THIS roadmap view,
        // not the same things the side menu's Decisions (product decisions waiting on you,
        // everywhere) or Roadmap (proposals and drafts in your inbox) badges count; the
        // label and title say so rather than let the three numbers look like one metric.
        <Button
          data-testid="needs-decision"
          title="Broken dates, date suggestions and proposals on this roadmap view (not the same count as Decisions or Roadmap in the side menu)"
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
          <Button disabled={exporting} onClick={() => void doExport("png")}>
            Export PNG
          </Button>
          <Button disabled={exporting} onClick={() => void doExport("pdf")}>
            Export PDF
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
      toast({ message: `From was after To, so they were swapped: ${quarterOf(to).label} to ${quarterOf(from).label}` });
    } else setF({ ...f, from, to });
  };
  const filtered = !!(f.prd || f.goal || f.track || f.from || f.to);
  const clearFilters = () => {
    setRestored(true);
    setF({ ...NO_FILTERS, group: f.group, roadmap: f.roadmap });
    void remember({ simple_filters: { prd: "", goal: "", track: "" } }, "Could not remember these filters for next time");
  };
  // D1: PRD, Goal, Track, From, To, Group by and the Gantt's scale on one line (each select as wide as its choice).
  const pickers = (
    <>
      {readable.length > 1 && (
        <Select label="Roadmap" all="All roadmaps" testId="filter-roadmap" value={data.roadmap?.id ?? ""} options={readable.map((r) => [r.roadmap.id, r.roadmap.title])} onChange={pickRoadmap} />
      )}
      <Select label="PRD" value={f.prd} options={seen.prd} onChange={(prd) => pickFilter("prd", prd)} />
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
      {format === "gantt" && !phone && (
        <span className="flex items-center gap-1.5 text-sm text-text2">
          Scale
          {scaleSwitch}
        </span>
      )}
      {/* timeline-overlap B2: the Group by's line says how the lanes stack. */}
      {format === "timeline" && !phone && (
        <span className="ml-auto text-[15px] text-text-faint" data-testid="lanes-hint">
          Pieces stack inside a lane when they run at once
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
  const goalCounters = <GoalCounters data={data} byGoal={f.group === "goal" || f.group === "milestone"} suggestions={suggestions} onGoal={openCounted} only={pickedGoal} />;
  const draftBanner = (
    <DraftBanner
      drafts={drafts.data ?? []}
      titleOf={(id) => (id ? byId.get(id)?.title : undefined)}
      inReview={data.changes_in_review ?? 0}
      meId={me?.user_id ?? null}
      onUndo={(id) =>
        void undo(id).then(
          () => {
            toast({ message: "Undone" });
            return reload();
          },
          (e) => toast({ message: e instanceof ChangeFailed ? e.message : "Oracle could not undo it" }),
        )
      }
      onSubmit={async (ds) => {
        for (const d of ds) {
          const r = await api.POST("/v1/simple/drafts/{draft_id}/submit", { params: { path: { draft_id: d.id } } });
          if (!r.data) toast({ message: `${d.document.title} could not be sent for review` });
        }
        toast({ message: "Sent for review: the approved roadmap stays published until it passes" });
        await reload();
      }}
    />
  );

  return (
    // A phone's page ends clear of the tab bar (#36: its filters lead the chart, not the foot).
    <div className="simple-mode space-y-3 px-4 py-4 max-[600px]:pb-[calc(var(--phone-tab-bar)+16px)] min-[641px]:px-6" data-testid="simple-roadmap" data-phone={phone ? "true" : "false"}>
      <header className={`relative flex flex-wrap items-center ${phone ? "gap-2" : "gap-3"}`}>
        {/* A phone's header bar names the page (D3): the H1 is for screen readers there. */}
        <h1 className={phone ? "sr-only" : "text-2xl font-semibold"}>Roadmap</h1>
        {data.roadmap ? (
          <span data-testid="roadmap-scope" className="rounded-full bg-accent-soft px-3 py-0.5 text-[15px] font-semibold whitespace-nowrap text-accent-ink">
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
      <StartSheet open={starting} onClose={() => setStarting(false)} origin="roadmap" prefer={reviewPrd} from={reviewFrom} />
      {draftBanner}
      {/* #36: on a phone, Roadmap/Goal/Track and Group by read before the chart, not after
       * the legend and goal cards at the page's foot. */}
      {!blank && filters}
      {blank && (
        <p className="text-[15px] text-text2" data-testid="roadmap-empty">
          {hasGoals ? (
            <>No features yet: accept one Oracle suggests under a goal, and it shows here on its dates.</>
          ) : (
            <>
              No features yet: confirm your company&rsquo;s goals in{" "}
              <Link href="/baseline" className="font-semibold text-accent-ink underline">
                Detailed › Baseline
              </Link>{" "}
              and Oracle suggests the features for them here.
            </>
          )}
        </p>
      )}
            <div ref={wrap} className={blank ? "hidden" : "relative"}>
        {filtered && !data.items.length ? (
          // fix4 qa-simple-roadmap-12: no bare axis when the filters leave nothing: say so, and a way back.
          <div data-testid="filters-empty" className="flex flex-col items-start gap-2 rounded-xl border border-dashed border-line-strong bg-surface px-4 py-6">
            <p className="text-[15px] font-semibold">Nothing matches these filters</p>
            <Button onClick={clearFilters}>Clear filters</Button>
          </div>
        ) : format === "board" ? (
          <Board
            data={data}
            phone={phone}
            canDrag={canChange}
            proposals={allProposals}
            open={card?.id ?? null}
            onOpen={(item) => {
              setPop(null);
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
          // timeline-overlap B: the Timeline is goal lanes (B2 on a desktop, B3 on a phone).
          <Lanes
            data={laned ?? data}
            lane={f.group}
            noWork={noWork}
            compact={phone}
            canDrag={canChange}
            moved={moved}
            open={card?.id ?? null}
            chartRef={(el) => {
              svg.current = el;
            }}
            dropTargets={canChange}
            onOpen={(item) => {
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
            overlay={(l, sc) =>
              data.items.flatMap((i) => {
                const y = l.y.get(i.id);
                if (y == null || closedItem(i)) return [];
                const f0 = broken(i).find((x) => x.kind === "dependency_order");
                if (!f0) return [];
                const [start, end] = moved[i.id] ?? [i.start.date, i.end.date];
                // qa-simple-roadmap-4 ("Under the lane"): on the desktop's lanes the callout takes the line under its pill.
                const under = l.under?.get(i.id);
                if (under != null) return [<Callout key={i.id} item={i} flag={f0} items={byId} act={act} canChange={canChange} x={sc.x(start)} y={under} h={l.rowH} compact={phone} maxX={sc.width} />];
                return [<Callout key={i.id} item={i} flag={f0} items={byId} act={act} canChange={canChange} x={sc.x(end) + sc.px + 14} before={sc.x(start) - 14} y={y} h={l.rowH} compact={phone} maxX={sc.width} />];
              })
            }
          />
        ) : (
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
            overlay={(l, sc) =>
              data.items.flatMap((i) => {
                const y = l.y.get(i.id);
                if (y == null || closedItem(i)) return [];
                const f0 = broken(i).find((x) => x.kind === "dependency_order");
                if (!f0) return [];
                const [start, end] = moved[i.id] ?? [i.start.date, i.end.date];
                return [<Callout key={i.id} item={i} flag={f0} items={byId} act={act} canChange={canChange} x={sc.x(end) + sc.px + 14} before={sc.x(start) - 14} y={y} h={l.rowH} compact={phone} maxX={sc.width} />];
              })
            }
          />
        )}
        {cardItem && card && (
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
             * does, its solid ink beside its hatch in the phase's own colour. */
            ...PHASES.filter((p) => (laned ?? data).items.some((i) => i.phases.some((x) => x.key === p.key))).map((p) => ({
              key: p.key,
              testId: "phase-key",
              swatch: (
                <span aria-hidden className="inline-flex h-3 w-7 flex-none overflow-hidden rounded-sm" data-ink={p.ink}>
                  <span className="h-full w-1/2" style={{ background: p.ink }} />
                  <span className="h-full w-1/2" style={{ background: `repeating-linear-gradient(45deg, ${p.soft} 0, ${p.soft} 2.6px, ${p.ink} 2.6px, ${p.ink} 5.6px)` }} />
                </span>
              ),
              words: p.label,
            })),
            { key: "solid", swatch: <i aria-hidden className={LEGEND_SWATCH} style={{ background: "var(--accent)", borderColor: "var(--accent)" }} />, words: "Dated by a milestone or gate" },
            {
              key: "hatched",
              swatch: <i aria-hidden className={LEGEND_SWATCH} style={{ background: "repeating-linear-gradient(45deg, var(--accent-soft) 0 2.6px, var(--accent) 2.6px 5.6px)", borderColor: "var(--accent)" }} />,
              words: "Estimated",
            },
            {
              key: "move",
              swatch: null,
              words: canChange ? `Drag a bar${phone ? " (press and hold first)" : ""} or use the arrow keys to move it; a dated gate stays on its day` : "A dated gate stays on its day when the item moves",
            },
            ...keyDateEntries(laned ?? data),
            TODAY_ENTRY,
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
        />
      )}
      {goalPanel && <GoalPanel goal={goalPanel} api={suggestions} start={goalStart} onClose={() => setGoalPanel(null)} />}
    </div>
  );
}
