"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { Button, Notice, SegmentedControl, toast } from "@/components/ds";
import { GoalPanel, SuggestionCard, useGoalSuggestions, type GoalBrief, type GoalSuggestionsApi } from "@/components/simple/GoalSuggestions";
import { StartSheet } from "@/components/simple/meetings/StartSheet";
import { Loading } from "@/components/ui";
import { getBranding, logoDataUrl } from "@/lib/api/branding";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { CARD_CHANGED_EVENT } from "@/lib/api/simple-chat";
import { shownDay } from "@/lib/dates";
import { useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";

import { QuickAdd } from "./_add";
import { Board, boardColumns, HORIZONS, type Horizon } from "./_board";
import { useKeyBurst } from "./_burst";
import { Callout, FlagLine, FixButtons, FloatingCard, LooksLike, opWords, SuggestionPopover, type Act } from "./_card";
import { boardPicture, chartPicture, exportView, type Brand } from "./_export";
import { KeyDatesEditor } from "./_keydates";
import {
  broken,
  ChangeFailed,
  closedItem,
  decide,
  lanes,
  nearWords,
  propose,
  quarters,
  quarterValue,
  resultWords,
  shortDay,
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

const time = (at: string) => shownDay(at, { hour: "numeric", minute: "2-digit" });

/** The Gantt's legend (roadmap-milestones D), naming only what the chart draws. */
function ganttLegend(data: Roadmap, noWork: { start: string; end: string; label?: string | null }[], pulled: number): string {
  const parts: string[] = [];
  const dated = (i: Item) => i.slices.filter((x) => x.start_date && x.end_date);
  const split = data.items.find((i) => dated(i).length > 1);
  if (split) {
    const codes = dated(split).map((x) => x.code);
    parts.push(`One bar per slice (${codes.slice(0, 2).join(", ")}${codes.length > 2 ? ", …" : " …"}), dated by the PRD's order inside each milestone`);
  }
  if (data.milestones.some((m) => m.start_date && m.end_date)) parts.push("diamond and dashed line: a milestone ends");
  if (noWork.length) parts.push(`grey columns: ${noWork.map((h) => h.label || `${shortDay(h.start)} – ${shortDay(h.end)}`).join(", ")}`);
  if (data.items.some((i) => dated(i).some((x) => x.pm_owned || x.effort_weeks == null))) parts.push("dashed outline: PM-owned");
  if (pulled) parts.push("amber: pulled in, pending");
  const plain = data.items.filter((i) => !dated(i).length && !closedItem(i));
  if (plain.some((i) => !i.draft && !i.estimated)) parts.push("solid: dated");
  if (plain.some((i) => !i.draft && i.estimated)) parts.push("hatched: estimated (the horizon’s window)");
  if (plain.some((i) => i.draft)) parts.push("dashed: draft");
  if (data.items.some((i) => i.suggestion)) parts.push("dotted outline: Oracle’s date suggestion (? opens it)");
  if (data.milestones.some((m) => m.date && !(m.start_date && m.end_date))) parts.push("small amber diamond: a track’s milestone");
  if (data.key_dates?.length) parts.push("diamond and thin line: a key date");
  if (data.items.some((i) => broken(i).length)) parts.push("red outline: a broken link");
  parts.push("red line: today");
  return parts.join(" · ");
}

/** The goal counters (each goal's metric line): items, and how many need a decision. S7:
 * each goal's suggested features open its panel; a goal with no items yet has its own tile. */
function GoalCounters({ items, suggestions, onGoal }: { items: Item[]; suggestions: GoalSuggestionsApi; onGoal: (g: GoalBrief) => void }) {
  const count = (id: string) => (suggestions.data?.suggestions ?? []).filter((s) => s.goal.id === id).length;
  const known = (id: string) => suggestions.data?.goals.find((g) => g.goal.id === id)?.goal;
  const empty = (suggestions.data?.goals ?? []).filter((g) => g.empty && !items.some((i) => i.goal?.id === g.goal.id));
  const goals = new Map<string, { title: string; metric: string | null; items: number; broken: number }>();
  for (const i of items) {
    if (!i.goal) continue;
    const g = goals.get(i.goal.id) ?? { title: i.goal.title, metric: i.goal.metric ?? null, items: 0, broken: 0 };
    g.items += 1;
    if (broken(i).length) g.broken += 1;
    goals.set(i.goal.id, g);
  }
  if (!goals.size && !empty.length) return null;
  const open = (id: string, title: string) => {
    const g = known(id);
    return g ? (
      <button type="button" data-testid="goal-counter-suggestions" onClick={() => onGoal(g)} className="text-sm font-semibold text-accent-ink hover:underline">
        ✦ {count(id)} suggested {count(id) === 1 ? "feature" : "features"}
        <span className="sr-only"> for {title}</span>
      </button>
    ) : null;
  };
  return (
    <ul className="grid grid-cols-2 gap-2 min-[900px]:grid-cols-4" data-testid="goal-counters">
      {[...goals.entries()].slice(0, 4).map(([id, g]) => (
        <li key={id} data-testid="goal-counter" className="rounded-xl border border-line bg-surface px-3 py-2">
          <p className="truncate text-[15px] font-semibold">{g.title}</p>
          <p className="truncate text-sm text-text2">{g.metric ?? "No metric yet"}</p>
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
          <p className="truncate text-[15px] font-semibold">{g.goal.title}</p>
          <p className="truncate text-sm text-text2">No items yet</p>
          {open(g.goal.id, g.goal.title)}
        </li>
      ))}
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
function DraftBanner({ drafts, inReview, meId, onUndo, onSubmit }: { drafts: Draft[]; inReview: number; meId: string | null; onUndo: (id: string) => void; onSubmit: (d: Draft[]) => void }) {
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
        <p className="min-w-0 flex-1 text-[15px]">
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
              {opWords(c.op)} · {c.by_name} · {time(c.at)}
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
}) {
  const twins = items.filter((i) => i.can_decide && i.looks_like.length > 0);
  const suggested = (suggestions.data?.suggestions ?? []).filter((s) => s.can_accept || s.can_reject);
  const brokenItems = items.filter((i) => i.can_decide && broken(i).length);
  const dates = items.filter((i) => i.suggestion?.can_decide);
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
  const mine = proposals.filter((c) => c.can_decide);
  const pulled = mine.filter((c) => c.op === "change_horizon");
  const others = mine.filter((c) => c.op !== "change_horizon");
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
      className={`${phone ? "fixed inset-x-0 bottom-0 z-50 max-h-[85dvh] rounded-t-2xl border-t border-line" : "fixed top-0 right-0 bottom-0 z-50 w-[440px] border-l border-line"} overflow-y-auto bg-surface p-4 shadow-tip`}
    >
      {phone && <div aria-hidden className="mx-auto -mt-1 mb-2 h-1 w-10 rounded-full bg-line-strong" />}
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-lg font-semibold">Needs a decision</h2>
        <button type="button" aria-label="Close" onClick={onClose} className="h-8 w-8 rounded text-text2 hover:bg-surface2">
          ×
        </button>
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-2 min-[420px]:grid-cols-4" data-testid="tray-counters">
        {counters.map(([label, n]) => (
          <li key={label} className="rounded-lg border border-line px-2 py-1.5 text-center">
            <b className="tnum block text-xl">{n}</b>
            <span className="text-xs text-text2">{label}</span>
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
      <section className="mt-4">
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
  const [f, setF] = useState<Filters>(() => ({ ...NO_FILTERS, prd: params.get("prd") ?? "", roadmap: params.get("roadmap") ?? "" }));
  const [format, setFormat] = useState<Format>("timeline");
  const [unit, setUnit] = useState<GanttUnit>("week");
  const [card, setCard] = useState<{ id: string; left: number; top: number } | null>(null);
  const [pop, setPop] = useState<{ id: string; left: number; top: number } | null>(null);
  // Home's "All proposals" opens the roadmap with its Needs-a-decision tray open (?review=1).
  const [tray, setTray] = useState(() => params.get("review") === "1");
  const [keyDates, setKeyDates] = useState(false);
  const [exporting, setExporting] = useState(false);
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
    const next = { ...f, goal: kept?.goal || f.goal, track: kept?.track || f.track };
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
        toast({
          message: resultWords(r, what),
          action: r.change.status === "applied" && r.change.can_undo ? { label: "Undo", onClick: () => void undo(r.change.id).then(reload, (e) => toast({ message: String(e.message) })) } : undefined,
        });
        return r;
      } catch (e) {
        toast({ message: e instanceof ChangeFailed ? e.message : "Oracle could not make this change" });
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

  const anchorOf = (id: string): { left: number; top: number } => {
    const el = wrap.current?.querySelector(`[data-bar-id="${id}"]`);
    const box = wrap.current?.getBoundingClientRect();
    const r = el?.getBoundingClientRect();
    if (!r || !box) return { left: 0, top: 0 };
    return { left: Math.max(0, Math.min(r.left - box.left, box.width - 390)), top: r.bottom - box.top + 6 };
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
        const words = how === "dismiss" ? "Dismissed Oracle's dates" : i.suggestion.can_decide ? "Dates accepted in your working draft" : "Dates proposed: they wait for the decider";
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
  const waiting =
    data.items.filter((i) => i.can_decide && broken(i).length).length + data.items.filter((i) => i.suggestion?.can_decide).length + allProposals.filter((c) => c.can_decide).length;
  const qList = quarters(data.windows.now.start, data.windows.later.end);

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
      else toast({ message: `Proposed ${title} (${w.label}): it waits for the decider` });
      await reload();
      return true;
    } catch (e) {
      toast({ message: e instanceof ChangeFailed ? e.message : "Oracle could not add it" });
      return false;
    }
  };
  const goalCounts = new Map<string, number>();
  for (const s of suggestions.data?.suggestions ?? []) goalCounts.set(s.goal.id, (goalCounts.get(s.goal.id) ?? 0) + 1);
  const openGoal = (id: string, title: string) => setGoalPanel(suggestions.data?.goals.find((g) => g.goal.id === id)?.goal ?? { id, key: id, title });

  // D: the items a change waiting for its decider pulls into another horizon ("pending").
  const pulledIn = new Set(allProposals.filter((c) => c.op === "change_horizon" && c.target.item_id).map((c) => String(c.target.item_id)));
  // roadmap-milestones D: the header's actions (D1: on the header's right, wrapping under the switch).
  const actions = (
    <div className={`flex flex-wrap items-center gap-2 ${phone ? "" : "ml-auto justify-end"}`} data-testid="roadmap-actions">
      {phone && canChange && <QuickAdd phone options={addOptions} verb={addVerb} onAdd={onAdd} target={target?.title ?? null} roadmaps={askRoadmap ? addable.map((r) => r.roadmap) : []} />}
      {decides && (
        <Button data-testid="needs-decision" onClick={() => setTray(true)} className={waiting ? "border-warn" : ""}>
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
      <Button onClick={() => setStarting(true)}>Start review</Button>
      <Button disabled={exporting} onClick={() => void doExport("png")}>
        Export PNG
      </Button>
      <Button disabled={exporting} onClick={() => void doExport("pdf")}>
        Export PDF
      </Button>
    </div>
  );
  const scaleSwitch = (
    <SegmentedControl<GanttUnit>
      label="Gantt scale"
      size="sm"
      value={unit}
      onChange={setUnit}
      items={[
        { value: "day", label: "Day", testId: "unit-day" },
        { value: "week", label: "Week", testId: "unit-week" },
      ]}
    />
  );
  // D1: PRD, Goal, Track, From, To, Group by and the Gantt's scale on one line (each select as wide as its choice).
  const filters = (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2" data-testid="filters">
      {readable.length > 1 && (
        <Select label="Roadmap" all="All roadmaps" testId="filter-roadmap" value={data.roadmap?.id ?? ""} options={readable.map((r) => [r.roadmap.id, r.roadmap.title])} onChange={pickRoadmap} />
      )}
      <Select label="PRD" value={f.prd} options={seen.prd} onChange={(prd) => pickFilter("prd", prd)} />
      <Select label="Goal" value={f.goal} options={seen.goal} onChange={(goal) => pickFilter("goal", goal)} />
      <Select label="Track" value={f.track} options={seen.track} onChange={(track) => pickFilter("track", track)} />
      <Select label="From" value={f.from} options={qList.map((q) => [q.start, q.label])} onChange={(from) => setF({ ...f, from })} />
      <Select label="To" value={f.to} options={qList.map((q) => [q.end, q.label])} onChange={(to) => setF({ ...f, to })} />
      <span className="flex items-center gap-1.5 text-sm text-text2">
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
          Gantt scale
          {scaleSwitch}
        </span>
      )}
    </div>
  );
  const goalCounters = <GoalCounters items={data.items} suggestions={suggestions} onGoal={setGoalPanel} />;
  const draftBanner = (
    <DraftBanner
      drafts={drafts.data ?? []}
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
    // A phone's page ends clear of the tab bar (its filters come last, D3).
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
          {offscreen && <span data-testid="swipe-hint">Swipe sideways for {offscreen}</span>}
        </div>
      )}
      {!phone && canChange && <QuickAdd phone={false} options={addOptions} verb={addVerb} onAdd={onAdd} target={target?.title ?? null} roadmaps={askRoadmap ? addable.map((r) => r.roadmap) : []} />}
      {!phone && goalCounters}
      <StartSheet open={starting} onClose={() => setStarting(false)} origin="roadmap" />
      {draftBanner}
      {!phone && filters}
      <div ref={wrap} className="relative">
        {format === "board" ? (
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
                const [, end] = moved[i.id] ?? [i.start.date, i.end.date];
                return [<Callout key={i.id} item={i} flag={f0} items={byId} act={act} canChange={canChange} x={sc.x(end) + sc.px + 14} y={y} h={l.rowH} compact={phone} />];
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
            onAccept={() => void onSuggestion(popItem, "accept")}
            onEdit={(s, e) => void onSuggestion(popItem, "edit", { start_date: s, end_date: e })}
            onDismiss={() => void onSuggestion(popItem, "dismiss")}
            onClose={() => setPop(null)}
          />
        )}
      </div>
      {format === "waterfall" ? (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-text2" data-testid="legend">
          {PHASES.map((p) => (
            <span key={p.key} className="inline-flex items-center gap-1.5" data-testid="phase-key">
              <span aria-hidden className="inline-block h-3 w-5 rounded-sm" style={{ background: p.ink }} />
              {p.label}
            </span>
          ))}
          <span>
            · solid: a milestone or validation gate dates the phase · hatched: estimated from the bar&rsquo;s span ·{" "}
            {canChange
              ? `drag a bar${phone ? " (press and hold first)" : ""} or use the arrow keys to move the whole item: its estimated phases are worked out again, a dated gate stays on its day (the phases before it may bunch up)`
              : "a dated gate stays on its day when the item moves"}{" "}
            · diamond and thin line: a key date
          </span>
        </p>
      ) : format === "board" ? (
        <p className="text-sm text-text2" data-testid="legend">
          Drag a card to another column{phone ? " (press and hold first)" : ""} to change its horizon · hatched dates: estimated (the horizon&rsquo;s window) · dashed: draft · red: a broken link
        </p>
      ) : format === "gantt" ? (
        <p className="text-sm text-text2" data-testid="legend">
          {ganttLegend(laned ?? data, noWork, pulledIn.size)}
        </p>
      ) : (
        <p className="text-sm text-text2" data-testid="legend">
          Solid: dated · hatched: estimated (the horizon&rsquo;s window) · dashed: draft · dotted outline: Oracle&rsquo;s date suggestion (? opens it) ·{" "}
          {data.milestones.some((m) => m.start_date && m.end_date) && "flag and dashed line: a milestone ends · "}diamond: a milestone · diamond and thin line: a key date · red: a broken link
        </p>
      )}
      {/* D3: on a phone the chart comes first; the actions, the goals and the filters follow it. */}
      {phone && actions}
      {phone && goalCounters}
      {phone && filters}
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
        />
      )}
      {goalPanel && <GoalPanel goal={goalPanel} api={suggestions} onClose={() => setGoalPanel(null)} />}
    </div>
  );
}
