"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

import { Button, Sheet, toast } from "@/components/ds";
import { FlowThumb } from "@/components/simple/Flow";
import { GoalPanel, SuggestionsButton, useGoalSuggestions, type GoalBrief, type GoalPanelStart, type GoalSuggestionsApi } from "@/components/simple/GoalSuggestions";
import { FlowPanel, subjectOf } from "@/components/simple/FlowVisual";
import { usePanelOpen } from "@/components/hop/open-state";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { calendarDay } from "@/lib/dates";
import { useMe } from "@/lib/me";
import { useSetParams } from "@/lib/use-set-params";
import { errorMessage, useQuery } from "@/lib/use-query";

import { CodeTag, featureCount, goalLabel, PlanBucketsHead, PlanFeatureList, planGoals, planSpan } from "./plan-buckets";

type Out = Schemas["SimplePrioritiesOut"];
type Row = Schemas["SimplePriorityRow"];
type Proposal = Schemas["SimplePriorityProposal"];
type Draft = Schemas["SimplePriorityDraft"];
type Bucket = Schemas["SimpleGoalBucket"];
type ChangeIn = Schemas["SimpleChangeIn"];
type Tab = "ranked" | "value-effort" | "buckets";

const TABS: { key: Tab; label: string }[] = [
  { key: "ranked", label: "Ranked list" },
  { key: "value-effort", label: "Value / effort" },
  { key: "buckets", label: "Goal buckets" },
];
/** Shapes by goal (never colour alone), in the order the goals first rank; "none": a row with no goal. */
const SHAPES = ["circle", "square", "triangle", "diamond", "pentagon"] as const;
type Shape = (typeof SHAPES)[number] | "none";

/** Whether the screen is a phone's (under 640 px). */
export function usePhone(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const q = window.matchMedia("(max-width: 639px)");
    const on = () => setPhone(q.matches);
    on();
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  return phone;
}

const fmt = (n: number | null | undefined, digits = 1): string => (n == null ? "–" : Number(n.toFixed(digits)).toString());
/** A score, always to two places (1.60 · 1.25 · 1.00), so a list of them reads one way (qa-plan-53). */

/** A feature as people read it: its title and its short code ("Sample data import (F-12)"), never its key. */
const nameOf = (r: { title: string; short_code?: string | null }): string => (r.short_code ? `${r.title} (${r.short_code})` : r.title);

/** qa-simple-plan-3: what the score is, in words (the API's formula: Σ goal weight × contribution × confidence ÷ effort). */
const SCORE_WORDS = "Score = goal value × Oracle's confidence in it (0 to 1) ÷ effort in engineer-weeks.";

/** Each tab's own line under the heading; only the Ranked list is a ranking. */
const SUBTITLE: Record<Tab, string> = {
  ranked: "Features that serve a goal first, then by score; a feature never ranks above one it depends on.",
  "value-effort": "Each feature by its goal value and its effort; the dashed lines are the middles.",
  buckets: "Where the engineer-weeks go, goal by goal.",
};

type Sent = { ok: true; change: Schemas["SimpleChangeOut"] } | { ok: false; status: number; message: string; pushback: boolean };

/** POST /v1/simple/changes; a refusal comes back with its words (409 Oracle's pushback included). */
/** The API's reason for a refusal: its detail, or its detail's message. */
function detailMessage(error: unknown, response: Response): string {
  const detail = (error as { detail?: unknown } | undefined)?.detail;
  return typeof detail === "string" ? detail : detail && typeof detail === "object" && "message" in detail ? String((detail as { message: unknown }).message) : response.statusText;
}

async function send(body: ChangeIn): Promise<Sent> {
  try {
    const { data, error, response } = await api.POST("/v1/simple/changes", { body });
    if (response.ok && data) return { ok: true, change: data.change };
    const detail = (error as { detail?: unknown } | undefined)?.detail;
    const pushback = !!detail && typeof detail === "object" && "pushback" in detail;
    return { ok: false, status: response.status, message: detailMessage(error, response), pushback };
  } catch (e) {
    return { ok: false, status: 0, message: errorMessage(e), pushback: false };
  }
}

export function Priorities() {
  const params = useSearchParams();
  const setParams = useSetParams();
  const phone = usePhone();
  const { can, capsReady } = useMe();
  const urlTab = (TABS.find((t) => t.key === params.get("tab"))?.key ?? "ranked") as Tab;
  // qa-simple-plan-42: a tab picked shows at once, whatever else rewrites the URL meanwhile (the
  // remembered line put back as the page loads); the URL follows, and wins once it moves on.
  const [tabPick, setTabPick] = useState<{ tab: Tab; from: string | null } | null>(null);
  const tab = tabPick && tabPick.from === params.get("tab") ? tabPick.tab : urlTab;
  const pickTab = (t: Tab) => {
    setTabPick({ tab: t, from: params.get("tab") });
    setParams({ tab: t === "ranked" ? null : t });
  };
  // qa-simple-plan-42: while the URL still reads what it did at the pick (the line put back
  // meanwhile rewrote it without the tab), the pick is written again, so a reload keeps it.
  const urlQuery = params.toString();
  useEffect(() => {
    const now = new URLSearchParams(urlQuery).get("tab");
    if (!tabPick || tabPick.from !== now) return;
    const want = tabPick.tab === "ranked" ? null : tabPick.tab;
    if (now !== want) setParams({ tab: want });
  }, [tabPick, urlQuery, setParams]);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // qa-simple-plan-41: the arrow keys (and Home / End) move between the tabs, as a WAI-ARIA tablist.
  const tabKey = (e: KeyboardEvent, k: number) => {
    const to = e.key === "ArrowRight" ? (k + 1) % TABS.length : e.key === "ArrowLeft" ? (k + TABS.length - 1) % TABS.length : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    pickTab(TABS[to].key);
    tabRefs.current[to]?.focus();
  };
  const compare = params.get("compare") === "1";
  // Roadmap-plus: the line, from the URL; landing without one, the person's remembered pick
  // (preferences) is put back in the URL once.
  const prefs = useQuery("me-preferences", () => unwrap(api.GET("/v1/me/preferences")));
  const remembered = prefs.data?.priorities_line ?? null;
  // Once the person picks, the URL alone says the line (Now: none).
  const [picked, setPicked] = useState(false);
  const line = params.get("line") ?? (picked ? null : remembered);
  // qa-simple-plan-42: put back until the URL holds it (a tab clicked meanwhile rewrites the URL
  // too, and one of two quick rewrites can be lost), unless the person picks a line themselves.
  useEffect(() => {
    if (picked || new URLSearchParams(urlQuery).get("line") || !remembered || remembered === "now") return;
    setParams({ line: remembered });
  }, [picked, urlQuery, remembered, setParams]);
  const q = useQuery<Out>(`simple-priorities:${line ?? "now"}`, () => unwrap(api.GET("/v1/simple/priorities", { params: { query: line ? { line } : {} } })), { keepPrevious: true });
  const pickLine = (key: string) => {
    setPicked(true);
    setParams({ line: key === "now" ? null : key });
    void api.PATCH("/v1/me/preferences", { body: { priorities_line: key } });
  };
  const data = q.data;
  // Roles through can() and the rows' own fields: the API says who applies and who proposes.
  const mayChange = capsReady && can("create_simple_change") && !!data?.can_change;
  // S7: Oracle's suggested features under each goal bucket (an accept adds a draft here).
  const suggestions = useGoalSuggestions(() => q.reload());
  // The item just moved (dragged, re-estimated or moved with the keys) and its rank before, kept
  // until the next move or leaving the page: highlighted with "moved #a → #b".
  const [moved, setMoved] = useState<Moved | null>(null);
  // A proposal's toast names who decides, once the read that lists it is back; a read that
  // fails still says it was proposed.
  const proposed = useRef<string | null>(null);
  const readError = q.error;
  useEffect(() => {
    if (!proposed.current || (!data && !readError)) return;
    const p = data?.proposals.find((x) => x.change_id === proposed.current);
    proposed.current = null;
    toast({ message: p?.waiting_for.length ? `Proposed: ${p.waiting_for.join(", ")} ${p.waiting_for.length === 1 ? "decides" : "decide"}` : "Proposed: it waits for a decision" });
  }, [data, readError]);

  // An applied change is the next move: `row` is the item it moved (highlighted), none clears
  // the highlight; `moves` false (a decline) leaves it.
  async function changed(r: Sent, done: string, row?: Row, moves = true, why?: string): Promise<void> {
    if (!r.ok) {
      toast({ message: r.message });
      return;
    }
    const c = r.change;
    if (c.status !== "applied") proposed.current = c.id;
    await q.reload();
    if (c.status === "applied" && moves) setMoved(row ? { featureId: row.feature_id, from: row.rank, why } : null);
    if (c.status === "applied")
      toast({
        message: done,
        action: c.can_undo
          ? {
              label: "Undo",
              onClick: async () => {
                const u = await api.POST("/v1/simple/changes/{change_id}/undo", { params: { path: { change_id: c.id } } });
                if (row) setMoved(null);
                await q.reload();
                toast({ message: u.response.ok ? "Undone" : "Could not undo" });
              },
            }
          : undefined,
      });
  }

  const shapes = goalShapes(data?.rows ?? []);
  // qa-shell-8: a new company has no feature to rank: one line on what shows here and the next
  // step, with no line or comparison to pick over nothing.
  const blank = !!data && !data.rows.length && !data.drafts.length && !data.proposals.length;
  const hasGoals = (suggestions.data?.goals.length ?? 0) > 0;
  const mkQp1 = useSearchParams().get("qp1"); // MOCK-HOOK
  const mkLead: Record<string, string> = { a: "and the rows stay in rank order: a Misses tag marks what misses it.", c: "so what makes it is listed first and numbered 1, 2, 3 down the page.", d: "so what makes it and what misses it sit in two columns, each by rank." }; // MOCK-HOOK

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 text-[length:var(--simple-text)] leading-[var(--simple-leading)] text-text" data-testid="simple-priorities">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[length:var(--simple-h1)] font-semibold leading-[var(--simple-h1-leading)]">Priorities</h1>
          <p className="text-text2" data-testid="prio-subtitle">
            {tab === "buckets" && data?.plan?.span && data.plan.milestones.length ? "Goal by goal, the features in the plan and what else is on this quarter." : SUBTITLE[tab]}
            {data ? ` ${data.plan?.span ? `This plan, ${planSpan(data.plan.span)}` : data.quarter.label}.` : ""}
            {data && tab === "ranked" && splitAtLine(data) ? ` ${data.plan?.span ? "The plan's dates" : "Each feature's end date"} decide${data.plan?.span ? "" : "s"} what makes the line, ${mkLead[mkQp1 ?? ""] ?? "so what makes it is listed first, each part by rank."}` : ""}{/* MOCK-HOOK */}
          </p>
        </div>
        <Link href="/priorities" className="text-[length:var(--simple-small)] font-medium text-accent-ink underline">
          Open the detailed view
        </Link>
      </header>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Priorities views" className="flex max-w-full gap-1 overflow-x-auto rounded-[var(--simple-card-radius)] border border-line bg-surface p-1">
          {TABS.map((t, k) => (
            <button
              key={t.key}
              ref={(el) => {
                tabRefs.current[k] = el;
              }}
              role="tab"
              aria-selected={tab === t.key}
              tabIndex={tab === t.key ? 0 : -1}
              onKeyDown={(e) => tabKey(e, k)}
              onClick={() => pickTab(t.key)}
              className={`whitespace-nowrap rounded-[10px] px-2.5 py-1.5 text-[length:var(--simple-small)] font-medium sm:px-3 ${tab === t.key ? "bg-accent text-on-accent" : "text-text2 hover:bg-surface2"}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {data && !blank && tab !== "buckets" && <LinePicker data={data} onPick={pickLine} />}
        {tab === "ranked" && !blank && (
          <label className="flex cursor-pointer items-center gap-2 text-[length:var(--simple-small)]">
            <button
              role="switch"
              aria-checked={compare}
              aria-label="Compare with Oracle"
              onClick={() => setParams({ compare: compare ? null : "1" })}
              className={`relative h-6 w-11 rounded-full border border-line-strong ${compare ? "bg-accent" : "bg-surface2"}`}
            >
              <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-surface shadow transition-all ${compare ? "left-6" : "left-0.5"}`} />
            </button>
            <span aria-hidden>Compare with Oracle</span>
          </label>
        )}
      </div>

      {q.error && !data && <p role="alert" className="text-crit">{q.error}</p>}
      {!data && !q.error && <p className="text-text2">Loading priorities…</p>}
      {blank && (
        <p className="text-text2" data-testid="priorities-empty">
          {hasGoals ? (
            <>
              No features yet: they rank here once the roadmap has some, so add one or accept one Oracle suggests on the{" "}
              <Link href="/simple/roadmap" className="font-medium text-accent-ink underline">
                Roadmap
              </Link>
              .
            </>
          ) : (
            <>
              No features yet: confirm your company&rsquo;s goals in{" "}
              <Link href="/baseline" className="font-medium text-accent-ink underline">
                Detailed › Baseline
              </Link>{" "}
              and the features Oracle suggests for them rank here.
            </>
          )}
        </p>
      )}
      {data && !blank && tab === "ranked" && (
        <Ranked data={data} phone={phone} compare={compare} mayChange={mayChange} changed={changed} moved={moved} />
      )}
      {data && !blank && tab === "value-effort" && <ValueEffort data={data} shapes={shapes} mayChange={mayChange} changed={changed} moved={moved} />}
      {data && !blank && tab === "buckets" && <Buckets data={data} suggestions={suggestions} />}
    </div>
  );
}

/** Each goal's shape (first ranked first); rows with no goal are a neutral dashed circle. */
function goalShapes(rows: Row[]): Map<string, Shape> {
  const out = new Map<string, Shape>();
  for (const r of rows) if (r.goal && !out.has(r.goal.key)) out.set(r.goal.key, SHAPES[out.size % SHAPES.length]);
  return out;
}

type Changed = (r: Sent, done: string, row?: Row, moves?: boolean, why?: string) => Promise<void>;
/** `why`: a re-estimate's words ("effort 4 wk"); none: a manual move. */
type Moved = { featureId: string; from: number; why?: string };

/** "moved #8 → #3" for the row just moved, "now #5 (effort 4 wk)" for one re-estimated (its rank now from the read); null for any other row. */
function movedWords(moved: Moved | null, r: Row): string | null {
  if (moved?.featureId !== r.feature_id) return null;
  if (moved.why) return moved.from === r.rank ? `rank stays #${r.rank} (${moved.why})` : `now #${r.rank} (${moved.why})`;
  return moved.from === r.rank ? `stays #${r.rank}` : `moved #${moved.from} → #${r.rank}`;
}

function MovedTag({ words }: { words: string }) {
  return (
    <span data-testid="moved" className="flex-none whitespace-nowrap rounded-full bg-accent px-2 text-[length:var(--simple-small)] font-medium text-on-accent">
      {words}
    </span>
  );
}

/** The row's short code (stays with the item however it ranks), one chip style above and below the line; its name in the title. */
function CodeChip({ r }: { r: Row }) {
  return (
    <span data-testid="prio-code" title={r.title} className="min-w-[3.25rem] flex-none whitespace-nowrap rounded-md border border-line-strong bg-surface px-1.5 text-center text-[length:var(--simple-small)] font-semibold tabular-nums text-text">
      {r.short_code || r.title}
    </span>
  );
}

/** Where a move may land: a feature never goes above one it needs, nor below one that needs it. */
function moveBounds(rows: Row[], row: Row): { top: number; bottom: number; needs: Row | null; neededBy: Row | null } {
  const needs = rows.filter((x) => row.depends_on.includes(x.code)).sort((a, b) => b.rank - a.rank)[0] ?? null;
  const neededBy = rows.filter((x) => x.depends_on.includes(row.code)).sort((a, b) => a.rank - b.rank)[0] ?? null;
  return { top: needs ? needs.rank + 1 : 1, bottom: neededBy ? neededBy.rank - 1 : rows.length, needs, neededBy };
}

/** Where a move to `position` puts the item in a dated plan's list: under which row, on which side of the line. */
function landsUnder(rows: Row[], row: Row, position: number): string {
  const order = rows.filter((x) => x !== row);
  order.splice(position - 1, 0, row);
  const side = order.filter((x) => x.above_line === row.above_line);
  const under = side[side.indexOf(row) - 1];
  const where = row.above_line ? "above the line" : "below the line";
  if (under) return `It lands just under ${nameOf(under)}, ${where}.`;
  return row.above_line ? "It lands at the top." : "It lands first below the line.";
}

// --------------------------------------------------------------------------- ranked list

function Ranked({ data, phone, compare, mayChange, changed, moved }: { data: Out; phone: boolean; compare: boolean; mayChange: boolean; changed: Changed; moved: Moved | null }) {
  const [side, setSide] = useState<"yours" | "oracle">("yours");
  const mkGoalOn = !!useSearchParams().get("goal"); // MOCK-HOOK qp4=b: a goal's list leaves out the features not ranked yet
  const [move, setMove] = useState<{ row: Row; position: number } | null>(null);
  // qa-simple-plan-5: closing the move dialog (Escape, Cancel, Move) puts focus back on the row's handle.
  const backToHandle = (featureId: string) =>
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-handle="${featureId}"]`)?.focus());
  const list = <YourList data={data} mayChange={mayChange} onMove={(row, position) => setMove({ row, position })} changed={changed} moved={moved} />;
  return (
    <>
      {compare && phone && (
        <div role="radiogroup" aria-label="Which order" className="mb-3 flex gap-1 rounded-[var(--simple-card-radius)] border border-line bg-surface p-1">
          {(["yours", "oracle"] as const).map((s) => (
            <button key={s} role="radio" aria-checked={side === s} onClick={() => setSide(s)} className={`flex-1 rounded-[10px] px-3 py-1.5 text-[length:var(--simple-small)] ${side === s ? "bg-accent text-on-accent" : "text-text2"}`}>
              {s === "yours" ? "Yours" : "Oracle's"}
            </button>
          ))}
        </div>
      )}
      {compare && data.rows.every((r) => r.oracle_rank == null || r.oracle_rank === r.rank) && (
        <p className="mb-3 rounded-lg bg-accent-soft px-3 py-2 text-[length:var(--simple-small)] text-accent-ink" data-testid="compare-same">
          Same as Oracle&apos;s order: no one has moved a feature.
        </p>
      )}
      {compare && !phone ? (
        <div className="grid grid-cols-2 gap-4">
          <section aria-label="Your order">
            <h2 className="mb-2 text-[length:var(--simple-h2)] font-semibold leading-[var(--simple-h2-leading)]">Your order</h2>
            {list}
          </section>
          <OracleOrder data={data} />
        </div>
      ) : compare && side === "oracle" ? (
        <OracleOrder data={data} />
      ) : (
        list
      )}
      {data.drafts.length > 0 && !mkGoalOn && <Drafts drafts={data.drafts} proposals={data.proposals} mayChange={mayChange} changed={changed} />}{/* MOCK-HOOK */}
      {move && (
        <MoveDialog
          move={move}
          rows={data.rows}
          dated={splitAtLine(data)}
          onClose={() => {
            setMove(null);
            backToHandle(move.row.feature_id);
          }}
          changed={async (r, done) => {
            setMove(null);
            await changed(r, done, move.row);
            backToHandle(move.row.feature_id);
          }}
        />
      )}
    </>
  );
}

function YourList({ data, mayChange, onMove, changed, moved }: { data: Out; mayChange: boolean; onMove: (row: Row, position: number) => void; changed: Changed; moved: Moved | null }) {
  const qp1 = useSearchParams().get("qp1"); // MOCK-HOOK
  const qp2 = useSearchParams().get("qp2"); // MOCK-HOOK
  const mkGoal = useSearchParams().get("goal"); // MOCK-HOOK qp4=b: a Home goal card opens the list for its goal
  const rows = (qp1 === "a" ? data.rows : byLine(data)).filter((r) => !mkGoal || goalOfRow(data)(r) === mkGoal); // MOCK-HOOK
  const setParamsMk = useSetParams(); // MOCK-HOOK
  const maxScore = Math.max(0.01, ...rows.map((r) => r.score ?? 0)); // MOCK-HOOK
  const refs = useRef<(HTMLLIElement | null)[]>([]);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const maxValue = Math.max(1, ...rows.map((r) => r.goal_value ?? 0));
  // qa-simple-plan-34: a look-alike's link (?show=<its item or feature>) marks its row and brings it into view.
  const show = useSearchParams().get("show");
  const shown = (r: Row) => !!show && (r.feature_id === show || r.item_id === show);
  useEffect(() => {
    if (show) document.querySelector('[data-shown="true"]')?.scrollIntoView({ block: "center" });
  }, [show]);

  // A dated plan lists what makes the line first, so a row's neighbour on screen is not its
  // neighbour by rank: the keys move by rank (data.rows), a drag stays on its side of the line.
  // Its dates, not its rank, decide that side, so a row dragged above the line asks for a rank
  // at most the last above-the-line rank (and one below it for at least the first below it).
  const split = lineSplit(rows);
  const apart = split >= 0 && splitAtLine(data);

  function targetIndex(y: number, from: number): number {
    let to = 0;
    refs.current.forEach((el, i) => {
      if (!el) return;
      const box = el.getBoundingClientRect();
      if (y > box.top + box.height / 2) to = i;
    });
    if (!apart) return to;
    return from < split ? Math.min(to, split - 1) : Math.max(to, split);
  }

  function start(e: ReactPointerEvent, from: number) {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    setDrag({ from, to: from });
  }

  function end(e: ReactPointerEvent) {
    if (!drag) return;
    const to = targetIndex(e.clientY, drag.from);
    setDrag(null);
    if (to !== drag.from) onMove(rows[drag.from], dropRank(rows[to]));
  }

  // Clamp above the line (BGD): with a dated plan, a row dropped onto the last row above the line
  // lands at the last rank still above it (as many ranks as rows make the line), never at that
  // row's own rank when it is past them. A drop onto any other row takes that row's rank.
  const aboveCount = data.rows.filter((r) => r.above_line).length;
  const lastAbove = rows.filter((r) => r.above_line).at(-1);
  const dropRank = (target: Row): number => (dateLine(data) && target === lastAbove ? Math.min(target.rank, aboveCount) : target.rank);

  function key(e: KeyboardEvent, i: number) {
    const at = data.rows.indexOf(rows[i]);
    if (e.key === "ArrowUp" && at > 0) {
      e.preventDefault();
      onMove(rows[i], data.rows[at - 1].rank);
    } else if (e.key === "ArrowDown" && at < data.rows.length - 1) {
      e.preventDefault();
      onMove(rows[i], data.rows[at + 1].rank);
    }
  }

  const goalOf = goalOfRow(data);
  // qa-simple-plan-4: the override ends (after.clear) and the feature takes Oracle's rank again; Undo puts it back.
  async function backToOracle(r: Row) {
    const sent = await send({ op: "override_priority", target: { item_id: r.item_id }, before: { override: r.before_override ?? null }, after: { clear: true }, reason: "Back to Oracle's rank" });
    await changed(sent, r.applies ? `Moved ${nameOf(r)} back to Oracle's rank` : `Proposed putting ${nameOf(r)} back at Oracle's rank`, r);
  }
  return (
    <>
    {mkGoal && ( // MOCK-HOOK
      <p className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-accent-soft px-3 py-2 text-accent-ink" data-testid="mk-goal-filter">{/* MOCK-HOOK */}
        <span>Showing <b>{mkGoal}</b> only: {rows.length ? `${rows.length} of ${data.rows.length} features` : "nothing for this goal is planned yet"}</span>{/* MOCK-HOOK */}
        <button type="button" className="font-semibold underline" onClick={() => setParamsMk({ goal: null })}>Show all</button>{/* MOCK-HOOK */}
      </p> // MOCK-HOOK
    )}{/* MOCK-HOOK */}
    {mkGoal ? rows.length > 0 && <LineCaption data={{ ...data, rows }} /> : ((qp1 !== "b" && qp1 !== "c") || !apart) && <LineCaption data={data} />}{/* MOCK-HOOK */}
    <p className="mb-2 text-[length:var(--simple-small)] text-text2" data-testid="prio-score-help">
      {SCORE_WORDS}
    </p>
    {qp1 === "d" && apart ? ( // MOCK-HOOK
      <div className="grid items-start gap-4 lg:grid-cols-2" data-testid="mk-qp1-columns">{/* MOCK-HOOK */}
        {[true, false].map((makes) => ( // MOCK-HOOK
          <section key={String(makes)} aria-label={makes ? "Makes the line" : "Misses the line"}>{/* MOCK-HOOK */}
            <MkPartHead data={data} makes={makes} n={makes ? split : rows.length - split} />{/* MOCK-HOOK */}
            <ol className="flex flex-col gap-[var(--simple-gap)]">{makes ? rows.slice(0, split).flatMap(item) : rows.slice(split).flatMap((r, k) => item(r, k + split))}</ol>{/* MOCK-HOOK */}
          </section> // MOCK-HOOK
        ))}{/* MOCK-HOOK */}
      </div> // MOCK-HOOK
    ) : ( // MOCK-HOOK
    <ol aria-label="Ranked list" className="flex flex-col gap-[var(--simple-gap)]">
      {rows.flatMap(item)}{/* MOCK-HOOK */}
    </ol> // MOCK-HOOK
    )}{/* MOCK-HOOK */}
    </> // MOCK-HOOK
  ); // MOCK-HOOK
  function item(r: Row, i: number) { // MOCK-HOOK: the row's callback, named so qp1=d can split it
        const heads = qp1 === "b" && apart; // MOCK-HOOK
        const divider = qp1 === "d" && apart ? [] : heads ? [...(i === 0 ? [<MkPartHead key="makes" data={data} makes n={split} li />] : []), ...(i === split ? [<MkPartHead key="misses" data={data} makes={false} n={rows.length - split} li />] : [])] : i === split ? [<LineDivider key="the-line" data={data} />] : []; // MOCK-HOOK
        // Any of the feature's items (a proposal on its later item shows here too).
        const proposals = data.proposals.filter((p) => p.feature_id === r.feature_id && (p.op === "override_priority" || p.op === "estimate_feature"));
        const target = drag && drag.to === i && drag.from !== i;
        const words = movedWords(moved, r);
        return [
          ...divider,
          <li
            key={r.feature_id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            data-testid="prio-row"
            data-code={r.code}
            data-above={r.above_line ? "true" : "false"}
            data-end={r.end_date ?? ""}
            data-misses={r.above_line ? undefined : "true"}
            data-moved={words ? "true" : undefined}
            data-shown={shown(r) ? "true" : undefined}
            className={`rounded-[var(--simple-card-radius)] border p-3 ${r.above_line ? "bg-surface" : "bg-surface2 text-text2"} ${target || words || shown(r) ? "border-accent ring-2 ring-accent" : "border-line"} ${drag?.from === i ? "opacity-60" : ""}`}
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {mayChange && r.can_reorder && (
                <button
                  aria-label={`Drag ${nameOf(r)} to reorder`}
                  // A role whose move is a proposal is told so (qa-plan-14): the row's own `applies`.
                  title={r.applies ? "Drag to reorder (or use the arrow keys)" : "Drag to propose a new rank (or use the arrow keys): the decider decides"}
                  data-handle={r.feature_id}
                  className="-my-3 flex min-h-11 min-w-11 cursor-grab touch-none items-center justify-center rounded-md px-1 text-[length:var(--simple-h2)] leading-none text-text2 hover:bg-surface2 sm:my-0 sm:min-h-0 sm:min-w-[22px]"
                  onPointerDown={(e) => start(e, i)}
                  onPointerMove={(e) => drag && setDrag({ ...drag, to: targetIndex(e.clientY, drag.from) })}
                  onPointerUp={end}
                  onPointerCancel={() => setDrag(null)}
                  onKeyDown={(e) => key(e, i)}
                >
                  <svg width="14" height="20" viewBox="0 0 14 20" aria-hidden fill="currentColor">
                    {[3, 10, 17].flatMap((y) => [4, 10].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.8" />))}
                  </svg>
                </button>
              )}
              {/* qa-simple-plan-32: a row the reader cannot move keeps the handle's column; why is said under it. */}
              {mayChange && !r.can_reorder && <span aria-hidden data-testid="prio-no-handle" className="min-w-11 sm:min-w-[22px]" />}
              <span className="w-8 text-right text-[length:var(--simple-lead)] font-semibold tabular-nums" data-testid="prio-rank">
                {qp1 === "c" && apart ? i + 1 : r.rank}{/* MOCK-HOOK */}
              </span>
              <span
                aria-label={r.above_line ? "Above the line" : "Below the line"}
                title={r.above_line ? "Above the line" : "Below the line"}
                className={`inline-block h-3 w-3 flex-none rounded-full border-2 border-accent ${r.above_line ? "bg-accent" : "bg-transparent"}`}
                data-testid="prio-line-mark"
              />
              <CodeChip r={r} />
              <span className="min-w-[12rem] flex-1 font-medium" data-testid="prio-title">{r.title}</span>
              {/* After the title, so a moved row's title starts where the others' do. */}
              {r.oracle_rank != null && r.oracle_rank !== r.rank && (
                <span
                  data-testid="prio-ghost"
                  title="Oracle's rank"
                  className="flex-none whitespace-nowrap rounded-full border border-dashed border-[var(--simple-ghost)] px-2 text-[length:var(--simple-small)] text-text2"
                >
                  Oracle #{r.oracle_rank}
                </span>
              )}
              {words && <MovedTag words={words} />}
              {qp1 === "c" && apart && r.rank !== i + 1 && <span data-testid="mk-rank" title="Its rank by score" className="flex-none whitespace-nowrap rounded-full border border-line-strong px-2 text-[length:var(--simple-small)] text-text2">rank {r.rank}</span>}{/* MOCK-HOOK */}
              <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[length:var(--simple-small)] text-text2">
                {/* The chips stay together, wrapping as one group. */}
                <span className="flex flex-none flex-wrap items-center gap-1.5">
                  {!r.above_line && (qp1 === "a" ? <MissesTag data={data} compact /> : qp1 ? null : <MissesTag data={data} row={r} />)}{/* MOCK-HOOK */}
                  {goalOf(r) ? (
                    <span data-testid="prio-goal">{goalOf(r)}</span>
                  ) : (
                    <span data-testid="prio-goal" className="whitespace-nowrap rounded-full bg-warn-bg px-2 text-warn">
                      No goal
                    </span>
                  )}
                </span>
                {r.milestone && <span className="whitespace-nowrap">Milestone {r.milestone}</span>}
                {/* qa-simple-plan-3: the confidence the score is worked out with, beside the numbers. */}
                {r.effort != null && !qp2 && ( // MOCK-HOOK
                  <span data-testid="prio-confidence" className="whitespace-nowrap tabular-nums" title={SCORE_WORDS}>
                    confidence {fmt(r.confidence, 2)}
                  </span>
                )}
                {/* The numbers say what they are and wrap as one group. */}
                {qp2 ? <MkNumbers r={r} v={qp2} maxValue={maxValue} maxScore={maxScore} /> : ( // MOCK-HOOK
                <span data-testid="prio-numbers" className="flex items-center gap-1 whitespace-nowrap tabular-nums">
                  <span aria-hidden className="h-2 w-16 flex-none overflow-hidden rounded-full border border-line bg-surface2">
                    <span className="block h-full rounded-full bg-accent" style={{ width: `${((r.goal_value ?? 0) / maxValue) * 100}%` }} />
                  </span>
                  {r.effort == null ? (
                    // qa-simple-plan-8: PM-owned work has no engineer-weeks, so no score.
                    <span data-testid="prio-pm-owned">{`value ${fmt(r.goal_value)} · PM-owned, no engineer-weeks · no score`}</span>
                  ) : (
                    <>
                      {`value ${fmt(r.goal_value)} · ${fmt(r.effort)} wk · score `}
                      <span className="font-semibold text-text" data-testid="prio-score" title={SCORE_WORDS}>
                        {fmt(r.score, 2)}
                      </span>
                    </>
                  )}
                </span>
                )}{/* MOCK-HOOK */}
              </span>
            </div>
            {mayChange && !r.can_reorder && (
              <p className="mt-1 text-[length:var(--simple-small)] text-text2 sm:pl-12" data-testid="prio-locked">
                You can&apos;t move this one: it is on a roadmap you don&apos;t have open to you.
              </p>
            )}
            {r.after && (
              <p className="mt-1 text-[length:var(--simple-small)] text-text2 sm:pl-12" data-testid="prio-after">
                After {r.after.title}, which it needs.
              </p>
            )}
            {r.override && (
              <p className="mt-1 flex flex-wrap items-center gap-x-3 text-[length:var(--simple-small)] text-text2 sm:pl-12" data-testid="prio-override">
                <span>
                  Moved by {r.override.by_name}: “{r.override.reason}”
                </span>
                {mayChange && r.can_reorder && r.item_id && !proposals.length && (
                  <button type="button" data-testid="prio-back-to-oracle" className="font-semibold text-accent-ink underline" onClick={() => void backToOracle(r)}>
                    {r.applies ? "Back to Oracle's rank" : "Propose Oracle's rank"}
                  </button>
                )}
              </p>
            )}
            {proposals.map((p) => (
              <ProposalCard key={p.change_id} p={p} row={r} changed={changed} />
            ))}
          </li>,
        ];
  } // MOCK-HOOK
}

/**
 * Oracle's order beside yours: the two orders differ, so rows cannot line up one to one; each row
 * Oracle ranks differently is marked (and says where yours has it), with the line and the goal as yours shows them.
 */
function OracleOrder({ data }: { data: Out }) {
  const sorted = [...data.rows].sort((a, b) => (a.oracle_rank ?? 1e9) - (b.oracle_rank ?? 1e9));
  const goalOf = goalOfRow(data);
  return (
    <section aria-label="Oracle's order">
      <h2 className="mb-2 text-[length:var(--simple-h2)] font-semibold leading-[var(--simple-h2-leading)]">Oracle&apos;s order</h2>
      <ol className="flex flex-col gap-[var(--simple-gap)]">
        {sorted.map((r) => (
          <li key={r.feature_id} data-testid="oracle-row" data-code={r.code} data-differs={r.oracle_rank !== r.rank ? "true" : undefined} className={`rounded-[var(--simple-card-radius)] border border-dashed p-3 ${r.oracle_rank !== r.rank ? "border-accent bg-accent-soft" : "border-line-strong bg-surface"}`}>
            <div className="flex flex-wrap items-center gap-3">
              <span className="w-8 text-right text-[length:var(--simple-lead)] font-semibold tabular-nums">{r.oracle_rank ?? "–"}</span>
              <span
                aria-label={r.above_line ? "Above the line" : "Below the line"}
                title={r.above_line ? "Above the line" : "Below the line"}
                className={`inline-block h-3 w-3 flex-none rounded-full border-2 border-accent ${r.above_line ? "bg-accent" : "bg-transparent"}`}
              />
              <CodeChip r={r} />
              <span className="min-w-[8rem] flex-1 font-medium">{r.title}</span>
              <span className="flex flex-wrap items-center gap-x-3 text-[length:var(--simple-small)] text-text2">
                <span data-testid="oracle-goal">{goalOf(r) ?? "No goal"}</span>
                <span className="whitespace-nowrap">{r.score == null ? "no score" : `score ${fmt(r.score, 2)}`}</span>
              </span>
            </div>
            {r.oracle_rank !== r.rank && (
              <p className="mt-1 text-[length:var(--simple-small)] text-text2 sm:pl-12" data-testid="oracle-why">
                {r.override
                  ? `Yours: #${r.rank}. ${r.override.by_name} moved it: “${r.override.reason}”`
                  : `Yours: #${r.rank}, moved by other people's moves.`}
              </p>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

function MoveDialog({ move, rows, dated, onClose, changed }: { move: { row: Row; position: number }; rows: Row[]; dated: boolean; onClose: () => void; changed: Changed }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [pushback, setPushback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { row } = move;
  const verb = row.applies ? "Move" : "Propose";
  // Where the item can really land: a dependency stops it short (said), or keeps it where it is (refused).
  const bounds = moveBounds(rows, row);
  const position = Math.min(bounds.bottom, Math.max(bounds.top, move.position));
  const stopped =
    position === move.position
      ? null
      : position > move.position
        ? `It needs ${bounds.needs!.title} (#${bounds.needs!.rank}), so it can go no higher than #${position}.`
        : `${bounds.neededBy!.title} (#${bounds.neededBy!.rank}) needs it, so it can go no lower than #${position}.`;
  const refused =
    position !== row.rank
      ? null
      : move.position < row.rank
        ? `Can't go above ${bounds.needs?.title}, which it needs.`
        : `Can't go below ${bounds.neededBy?.title}, which needs it.`;
  // A dated plan lists each side of the line by rank: where the item lands in its side, which the
  // plan's dates, not the rank, decide.
  const lands = dated ? landsUnder(rows, row, position) : null;
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit(confirm = false) {
    if (refused) return;
    if (!reason.trim()) {
      setError("Say why in one line.");
      return;
    }
    setBusy(true);
    setError(null);
    const r = await send({
      op: "override_priority",
      target: { item_id: row.item_id },
      before: { override: row.before_override ?? null },
      after: { position, reason: reason.trim(), ...(confirm ? { confirm: true } : {}) },
      reason: reason.trim(),
    });
    setBusy(false);
    if (!r.ok && r.pushback) setPushback(r.message);
    else if (!r.ok) setError(r.message);
    else await changed(r, `${row.applies ? "Moved" : "Proposed moving"} ${nameOf(row)} to rank ${position}`);
  }

  if (refused)
    return (
      <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center" onClick={onClose}>
        <div role="dialog" aria-modal="true" aria-label={`Why move ${nameOf(row)}`} className="w-full max-w-md rounded-[var(--simple-card-radius)] border border-line bg-surface p-4 shadow-lg" onClick={(e) => e.stopPropagation()}>
          <h2 className="text-[length:var(--simple-h2)] font-semibold leading-[var(--simple-h2-leading)]">{nameOf(row)} stays #{row.rank}</h2>
          <p className="mt-1 text-[length:var(--simple-small)] text-text2" data-testid="move-refused">
            {refused}
          </p>
          <div className="mt-3 flex justify-end">
            <Button type="button" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      </div>
    );


  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Why move ${nameOf(row)}`}
        className="w-full max-w-md rounded-[var(--simple-card-radius)] border border-line bg-surface p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-[length:var(--simple-h2)] font-semibold leading-[var(--simple-h2-leading)]">
          {verb} {nameOf(row)} to rank {position}
        </h2>
        {lands && (
          <p className="mt-1 text-[length:var(--simple-small)] text-text2" data-testid="move-lands">
            {lands}
          </p>
        )}
        {stopped && (
          <p className="mt-1 text-[length:var(--simple-small)] text-text2" data-testid="move-stopped">
            {stopped}
          </p>
        )}
        <p className="mb-2 text-[length:var(--simple-small)] text-text2">
          Oracle ranks it #{row.oracle_rank ?? row.rank}. {row.applies ? "Your order replaces Oracle's for it: say why in one line." : "If accepted, your order replaces Oracle's for it: say why in one line; whoever decides accepts or declines it."}
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="block text-[length:var(--simple-small)] font-medium" htmlFor="prio-reason">
            Reason <span className="font-normal text-text2">(required)</span>
          </label>
          <input
            id="prio-reason"
            aria-required="true"
            autoFocus
            maxLength={500}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value.replace(/[\r\n]/g, " "));
              setError(null);
            }}
            className="mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2 text-[length:var(--simple-small)]"
          />
          {pushback && (
            <div role="alert" className="mt-3 rounded-lg bg-warn-bg p-2 text-[length:var(--simple-small)] text-warn">
              Oracle disagrees: {pushback}
              <div className="mt-2">
                <Button type="button" onClick={() => void submit(true)} disabled={busy}>
                  Keep my order
                </Button>
              </div>
            </div>
          )}
          {error && (
            <p role="alert" className="mt-2 text-[length:var(--simple-small)] text-crit">
              {error}
            </p>
          )}
          <div className="mt-3 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {verb}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function proposalWords(p: Proposal): string {
  const a = p.after as Record<string, unknown>;
  if (p.op === "override_priority" && "override" in a && a.override === null) return `${p.by_name} proposes putting it back at Oracle's rank`;
  if (p.op === "override_priority") {
    const o = (a.override ?? a) as { position?: number; reason?: string };
    return `${p.by_name} proposes rank ${o.position}: “${o.reason ?? p.reason ?? ""}”`;
  }
  if (p.op === "confirm_item") return `${p.by_name} proposes confirming it`;
  // S7: a Merge is a merge_item change (train T's was a cut with this note).
  if (p.op === "cut" || p.op === "merge_item") return `${p.by_name} proposes merging it: “${p.reason ?? ""}”`;
  const parts = [a.goal_value != null ? `goal value ${a.goal_value}` : null, a.effort != null ? `effort ${a.effort} wk` : null].filter(Boolean);
  return `${p.by_name} proposes ${parts.join(" and ")}`;
}

/** A proposal inline under its row: the flow thumbnail (or "No flow yet") widens the card in place; a phone opens a full-height sheet. */
function ProposalCard({ p, row, changed }: { p: Proposal; row?: Row; changed: Changed }) {
  const [open, setOpen] = useState(false);
  const phone = usePhone();
  const [busy, setBusy] = useState(false);

  // qa-simple-plan-30: "withdraw" is the proposer taking it back (closed, nothing changes).
  async function decide(action: "accept" | "decline" | "withdraw") {
    setBusy(true);
    const r = await api.POST(`/v1/simple/changes/{change_id}/${action}`, { params: { path: { change_id: p.change_id } }, body: {} });
    setBusy(false);
    await changed(
      r.response.ok && r.data
        ? { ok: true, change: { ...r.data.change, status: "applied", can_undo: false } }
        : { ok: false, status: r.response.status, message: `Could not decide: ${detailMessage(r.error, r.response)}`, pushback: false },
      action === "accept" ? `Accepted the proposal for ${p.title}` : action === "withdraw" ? `Withdrew your proposal for ${p.title}` : `Declined the proposal for ${p.title}`,
      row,
      action === "accept",
    );
  }

  const flow = p.flow ? <FlowPanel subject={subjectOf(p.flow) ?? { kind: "change", id: p.change_id }} /> : null;
  return (
    <div
      data-testid="prio-proposal"
      data-wide={open && !phone ? "true" : "false"}
      className={`mt-2 rounded-[var(--simple-card-radius)] border border-dashed border-accent bg-accent-soft p-3 text-[length:var(--simple-small)] transition-all ${open && !phone ? "ml-0" : "max-w-xl sm:ml-12"}`}
    >
      <div className="flex flex-wrap items-center gap-3">
        {p.flow ? (
          <button aria-label={`Open the flow for ${p.title}`} onClick={() => setOpen(!open)} className="rounded-md border border-line bg-surface p-1" data-testid="flow-thumb">
            <FlowThumb flow={p.flow} />
          </button>
        ) : null}
        <span className="flex-1" data-testid="prio-proposal-words">
          {proposalWords(p)} · {p.can_decide ? "waiting for you" : `waiting for ${p.waiting_for.join(", ") || "the company's owners"}`}
        </span>
        {p.can_decide && (
          <span className="flex gap-2">
            <Button onClick={() => void decide("accept")} disabled={busy}>
              Accept
            </Button>
            <Button variant="secondary" onClick={() => void decide("decline")} disabled={busy}>
              Decline
            </Button>
          </span>
        )}
        {p.can_withdraw && !p.can_decide && (
          <Button variant="secondary" onClick={() => void decide("withdraw")} disabled={busy} title="Take your proposal back; nothing changes">
            Withdraw
          </Button>
        )}
      </div>
      {open && !phone && flow}
      {phone && p.flow && (
        <Sheet open={open} title={p.flow.title} onClose={() => setOpen(false)} full testId="flow-sheet">
          {flow}
        </Sheet>
      )}
    </div>
  );
}

function Drafts({ drafts, proposals, mayChange, changed }: { drafts: Draft[]; proposals: Proposal[]; mayChange: boolean; changed: Changed }) {
  const [merging, setMerging] = useState<string | null>(null);
  const [into, setInto] = useState("");
  const show = useSearchParams().get("show");
  return (
    <section aria-label="Not ranked yet" className="mt-6">
      <h2 className="mb-2 text-[length:var(--simple-h2)] font-semibold leading-[var(--simple-h2-leading)]">Not ranked yet</h2>
      <ul className="flex flex-col gap-[var(--simple-gap)]">
        {drafts.map((d) => {
          // qa-simple-plan-29: a Confirm or Merge waiting for the decider; none more until it is decided.
          const pending = proposals.filter((p) => p.item_id === d.item_id && (p.op === "confirm_item" || p.op === "cut" || p.op === "merge_item"));
          return (
          <li key={d.item_id} data-testid="prio-draft" data-code={d.code} data-shown={show === d.item_id ? "true" : undefined} className={`rounded-[var(--simple-card-radius)] border border-dashed bg-surface p-3 ${show === d.item_id ? "border-accent ring-2 ring-accent" : "border-line-strong"}`}>
            <div className="flex flex-wrap items-center gap-3">
              <span className="rounded-full bg-na-bg px-2 text-[length:var(--simple-small)] text-na">Draft</span>
              <span className="flex-1 font-medium">{d.title}</span>
              <span className="text-[length:var(--simple-small)] text-text2">{d.goal?.title ?? "No goal"}</span>
              {mayChange && (
                <span className="flex gap-2">
                  {/* qa-plan-14: who only proposes (the draft's own `applies`) is offered Propose, not Confirm. */}
                  <Button
                    disabled={pending.length > 0}
                    title={pending.length ? "A proposal for it is waiting for a decision" : d.applies ? undefined : "Propose confirming it: the decider decides"}
                    onClick={async () =>
                      changed(
                        await send({ op: "confirm_item", target: { item_id: d.item_id }, before: { draft: true }, after: { draft: false } }),
                        d.applies ? `Added ${d.title} to the ranking` : `Proposed adding ${d.title}`,
                      )
                    }
                  >
                    {d.applies ? "Add to the ranking" : "Propose adding"}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={pending.length > 0}
                    title={pending.length ? "A proposal for it is waiting for a decision" : undefined}
                    aria-expanded={merging === d.item_id}
                    onClick={() => setMerging(merging === d.item_id ? null : d.item_id)}
                  >
                    {d.applies ? "Merge into…" : "Propose a merge…"}
                  </Button>
                </span>
              )}
            </div>
            {merging === d.item_id && (
              <form
                className="mt-2 flex flex-wrap items-center gap-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const target = d.merge_into.find((m) => m.item_id === into);
                  if (!target) return;
                  setMerging(null);
                  await changed(
                    await send({ op: "merge_item", target: { item_id: d.item_id, into_id: target.item_id }, before: {}, after: {}, reason: `Merged into ${target.title}` }),
                    `Merged ${d.title} into ${target.title}`,
                  );
                }}
              >
                <label htmlFor={`merge-${d.item_id}`} className="text-[length:var(--simple-small)]">
                  Merge into
                </label>
                <select id={`merge-${d.item_id}`} value={into} onChange={(e) => setInto(e.target.value)} className="rounded-lg border border-line bg-bg px-2 py-1 text-[length:var(--simple-small)]">
                  <option value="">Choose a feature…</option>
                  {d.merge_into.map((m) => (
                    <option key={m.item_id} value={m.item_id}>
                      {m.title}
                    </option>
                  ))}
                </select>
                <Button type="submit" disabled={!into}>
                  {d.applies ? "Merge" : "Propose"}
                </Button>
                <p className="w-full text-[length:var(--simple-small)] text-text2" data-testid="merge-hint">
                  {into ? "" : "Choose the feature it repeats. "}Only features on {d.roadmap?.title ? `the ${d.roadmap.title} roadmap` : "its own roadmap"}, the same as the draft&apos;s, are listed.
                </p>
              </form>
            )}
            {/* A Confirm or Merge waiting for the decider. */}
            {pending.map((p) => (
              <ProposalCard key={p.change_id} p={p} changed={changed} />
            ))}
          </li>
          );
        })}
      </ul>
    </section>
  );
}

// --------------------------------------------------------------------------- value / effort

/**
 * A mark as the owner's pick B draws it, in a 36 px box centred on its spot: the goal's shape in
 * the accent, its code on it (9.5 px); hollow below the line. No goal: a neutral circle with a
 * dashed edge (never a cross).
 */
function ShapeMark({ shape, hollow, code }: { shape: Shape; hollow: boolean; code?: string }) {
  const none = shape === "none";
  const fill = hollow ? "var(--surface)" : none ? "var(--line)" : "var(--accent)";
  const text = hollow || none ? "var(--text)" : "var(--on-accent)";
  const common = { fill, stroke: none ? "var(--text2)" : "var(--accent)", strokeWidth: 2, ...(none ? { strokeDasharray: "4 3" } : {}) };
  const path: Record<Shape, React.ReactNode> = {
    circle: <circle cx="18" cy="18" r="14" {...common} />,
    square: <rect x="5" y="5" width="26" height="26" rx="3" {...common} />,
    triangle: <polygon points="18,2 36,31 0,31" {...common} />,
    diamond: <polygon points="18,1 35,18 18,35 1,18" {...common} />,
    pentagon: <polygon points="18,3 33,14 27,32 9,32 3,14" {...common} />,
    none: <circle cx="18" cy="18" r="14" {...common} />,
  };
  return (
    <svg width="36" height="36" viewBox="0 0 36 36" aria-hidden className="block overflow-visible">
      {path[shape]}
      {code != null && (
        <text data-testid="vxe-code" x="18" y={shape === "triangle" ? 26.3 : shape === "pentagon" ? 23 : 21.4} textAnchor="middle" fontSize={code.length <= 4 ? 9.5 : 8} fontWeight="700" fill={text}>
          {code}
        </text>
      )}
    </svg>
  );
}

/** The legend's small marks (22 px), as B draws them. */
function LegendMark({ shape }: { shape: Shape }) {
  const none = shape === "none";
  const common = { fill: none ? "var(--line)" : "var(--accent)", stroke: none ? "var(--text2)" : "var(--accent)", strokeWidth: 2, ...(none ? { strokeDasharray: "3 2" } : {}) };
  const path: Record<Shape, React.ReactNode> = {
    circle: <circle cx="11" cy="11" r="7" {...common} />,
    square: <rect x="5" y="5" width="12" height="12" rx="3" {...common} />,
    triangle: <polygon points="11,3 22,18 0,18" {...common} />,
    diamond: <polygon points="11,1 21,11 11,21 1,11" {...common} />,
    pentagon: <polygon points="11,2 20,9 17,19 5,19 2,9" {...common} />,
    none: <circle cx="11" cy="11" r="8" {...common} />,
  };
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden className="flex-none overflow-visible">
      {path[shape]}
    </svg>
  );
}

/** The effort axis's ticks: 0.5, 1, 2, 4 weeks, doubling on while they stay on the axis (up to `top`). */
function effortTicks(top: number): number[] {
  const out = [0.5, 1, 2, 4];
  while (out.at(-1)! * 2 <= top) out.push(out.at(-1)! * 2);
  return out;
}

/** The goal value axis: up to four even steps (0, 0.5, 1, 1.5, 2 as B draws them) from 0 to just past the highest value. */
function valueTicks(max: number): number[] {
  const step = [0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100].find((x) => Math.ceil((max * 1.05) / x) <= 4) ?? Math.ceil((max * 1.05) / 4);
  const n = Math.max(1, Math.ceil((max * 1.05) / step));
  return Array.from({ length: n + 1 }, (_, k) => Math.round(k * step * 100) / 100);
}

/**
 * Half the rows on each side: the first half by rank order of `key` (descending for value,
 * ascending for effort) is "high value" / "low effort"; a mark on a median line counts on the
 * side its rank puts it. The median itself is where the line is drawn.
 */
function medianSplit(rows: Row[], key: (r: Row) => number, high: boolean): { median: number; firstHalf: Set<string> } {
  const sorted = [...rows].sort((a, b) => (high ? key(b) - key(a) : key(a) - key(b)) || a.rank - b.rank);
  const n = sorted.length;
  const vals = sorted.map(key).sort((a, b) => a - b);
  const median = n === 0 ? 0 : n % 2 ? vals[(n - 1) / 2] : (vals[n / 2 - 1] + vals[n / 2]) / 2;
  return { median, firstHalf: new Set(sorted.slice(0, Math.ceil(n / 2)).map((r) => r.feature_id)) };
}

/** A rectangle on the plot, in pixels: left, top, right, bottom. */
type Box = [number, number, number, number];

/**
 * Each mark's centre on a w x h plot: at its real spot (qa-simple-plan-13: on a middle line too;
 * the legend says how it counts), else, where that spot is taken by a mark placed before it or a
 * quadrant's name (a phone's crowded plot), the nearest free spot around it (qa-simple-plan-11:
 * no two marks ever overlap), kept inside the plot. Marks are placed in rank order.
 */
function markSpots(
  rows: Row[],
  w: number,
  h: number,
  o: { at: (r: Row) => [number, number]; avoid: Box[] },
): Map<string, [number, number]> {
  const R = 18;
  if (!w || !h) return new Map(rows.map((r) => [r.feature_id, o.at(r)]));
  const placed: [number, number][] = [];
  const inside = (x: number, y: number) => x >= R && x <= w - R && y >= R && y <= h - R;
  const free = (x: number, y: number) =>
    inside(x, y) &&
    placed.every(([px, py]) => Math.abs(px - x) >= 2 * R || Math.abs(py - y) >= 2 * R) &&
    o.avoid.every((q) => x + R - 2 <= q[0] || x - R + 2 >= q[2] || y + R - 2 <= q[1] || y - R + 2 >= q[3]);
  const out = new Map<string, [number, number]>();
  for (const r of rows) {
    const [x0, y0] = o.at(r);
    const cx = Math.min(w - R, Math.max(R, x0));
    const cy = Math.min(h - R, Math.max(R, y0));
    let spot: [number, number] = [cx, cy];
    if (!free(cx, cy)) {
      search: for (let rad = 3; rad < Math.max(w, h); rad += 3) {
        const n = Math.max(12, Math.round(rad / 2));
        for (let k = 0; k < n; k++) {
          const t = (k / n) * 2 * Math.PI;
          const x = cx + rad * Math.cos(t);
          const y = cy + rad * Math.sin(t);
          if (free(x, y)) {
            spot = [x, y];
            break search;
          }
        }
      }
    }
    placed.push(spot);
    out.set(r.feature_id, spot);
  }
  return out;
}

function ValueEffort({ data, shapes, mayChange, changed, moved }: { data: Out; shapes: Map<string, Shape>; mayChange: boolean; changed: Changed; moved: Moved | null }) {
  const box = useRef<HTMLDivElement>(null);
  // The plot's size, kept as it resizes (where the median lines' words fit).
  const [plotSize, setPlotSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const on = () => setPlotSize({ w: el.clientWidth, h: el.clientHeight });
    on();
    const ro = new ResizeObserver(on);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [drag, setDrag] = useState<{ code: string; x0: number; y0: number; dx: number; dy: number } | null>(null);
  // plan-charts: the mark and row selected together (Escape clears); a drag is not a selection.
  const [selected, setSelected] = useState<string | null>(null);
  const dragged = useRef(false);
  const rows = data.rows;
  const effortOf = (r: Row) => Math.max(0.25, r.effort ?? 0);
  const maxE = Math.max(4, ...rows.map(effortOf));
  const minE = Math.min(0.5, ...rows.map(effortOf));
  const vTicks = valueTicks(Math.max(0, ...rows.map((r) => r.goal_value ?? 0)));
  const maxV = vTicks.at(-1)!;
  // The log effort axis, a little room past the first and last tick.
  const lo = Math.log2(minE) - 0.4;
  const hi = Math.log2(maxE) + 0.4;
  const xPct = (e: number) => 4 + ((Math.log2(Math.max(0.25, e)) - lo) / (hi - lo)) * 92;
  const yPct = (v: number) => 4 + (1 - v / maxV) * 92;
  const ticks = effortTicks(2 ** hi);
  const byValue = medianSplit(rows, (r) => r.goal_value ?? 0, true);
  const byEffort = medianSplit(rows, effortOf, false);
  const quadrant = (r: Row) => (byValue.firstHalf.has(r.feature_id) ? (byEffort.firstHalf.has(r.feature_id) ? 0 : 1) : byEffort.firstHalf.has(r.feature_id) ? 2 : 3);
  const counts = [0, 1, 2, 3].map((q) => rows.filter((r) => quadrant(r) === q).length);
  const shapeOf = (r: Row): Shape => (r.goal ? (shapes.get(r.goal.key) ?? "circle") : "none");
  const goalOf = goalOfRow(data);
  const sideRefs = useRef(new Map<string, HTMLLIElement>());
  const markRefs = useRef(new Map<string, HTMLButtonElement>());

  const panelOpen = usePanelOpen();
  useEffect(() => {
    if (!selected) return;
    // Escape closes what is open on top first (a dialog, a sheet, the Ask panel), then the selection.
    const off = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || panelOpen || document.querySelector('[role="dialog"], [aria-modal="true"]')) return;
      setSelected(null);
    };
    window.addEventListener("keydown", off);
    return () => window.removeEventListener("keydown", off);
  }, [selected, panelOpen]);

  /** Selects a feature and brings its other half (the row, or the mark) into view. */
  function select(id: string, from: "mark" | "row") {
    setSelected(id);
    const other = from === "mark" ? sideRefs.current.get(id) : markRefs.current.get(id);
    other?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  async function estimate(r: Row, after: { goal_value?: number; effort?: number }) {
    const words = after.effort != null ? `effort ${after.effort} wk` : `goal value ${after.goal_value}`;
    await changed(
      await send({
        op: "estimate_feature",
        target: { item_id: r.item_id },
        before: { goal_value: r.value_estimated ? (r.goal_value ?? null) : null, effort: r.effort ?? null },
        after,
      }),
      `Re-estimated ${nameOf(r)}: ${words}`,
      r,
      true,
      words,
    );
  }

  /**
   * Where a drag of (dx, dy) takes the mark: sideways its effort (on the log scale: the same
   * distance is the same factor), up/down its goal value (none for a feature with no goal); the
   * lowest effort is 0.5 (the API's are above 0), the lowest goal value 0. Null: no change.
   */
  function dragTo(r: Row, dx: number, dy: number): { goal_value?: number; effort?: number } | null {
    const { w: width, h: height } = plotSize;
    if (!width || !height || (Math.abs(dx) < 6 && Math.abs(dy) < 6)) return null;
    const round = (n: number) => Math.max(0.5, Math.round(n * 2) / 2);
    if (Math.abs(dx) >= Math.abs(dy)) {
      const effort = round(effortOf(r) * 2 ** ((dx / (width * 0.92)) * (hi - lo)));
      return effort === r.effort ? null : { effort };
    }
    if (!r.goal) return null;
    const value = Math.round(((r.goal_value ?? 0) - (dy / (height * 0.92)) * maxV) * 2) / 2;
    if (value < 0 && (r.goal_value ?? 0) <= 0) return null;
    const goal_value = Math.max(0, value);
    return goal_value === r.goal_value ? null : { goal_value };
  }

  function drop(r: Row) {
    if (!drag || !box.current) return;
    const { dx, dy } = drag;
    setDrag(null);
    if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
    dragged.current = true;
    const to = dragTo(r, dx, dy);
    if (to) void estimate(r, to);
  }

  function key(e: KeyboardEvent, r: Row) {
    if (!mayChange || !r.can_reorder) return;
    const step = 0.5;
    const value = r.goal_value ?? 0;
    const effort = r.effort ?? 0;
    // qa-simple-plan-6: a key never raises what it should lower; an effort stays at 0.5 or more
    // (the API's are above 0), a goal value goes down to 0, and a feature with no goal has none to change.
    const map: Record<string, { goal_value?: number; effort?: number } | null> = {
      ArrowRight: { effort: effort + step },
      ArrowLeft: effort - step >= 0.5 ? { effort: effort - step } : null,
      ArrowUp: r.goal ? { goal_value: value + step } : null,
      ArrowDown: r.goal && value - step >= 0 ? { goal_value: value - step } : null,
    };
    if (e.key in map) {
      e.preventDefault();
      const to = map[e.key];
      if (to) void estimate(r, to);
    }
  }

  // Marks on the same spot fan out sideways around it so none hides another (B: 37 px apart).
  const spot = (r: Row) => `${effortOf(r)}|${r.goal_value ?? 0}`;
  const twins = new Map<string, string[]>();
  for (const r of rows) twins.set(spot(r), [...(twins.get(spot(r)) ?? []), r.feature_id]);
  const fan = (r: Row) => {
    const at = twins.get(spot(r))!;
    return (at.indexOf(r.feature_id) - (at.length - 1) / 2) * 37;
  };

  const QUADRANTS = [
    { name: "Quick wins", at: "left-[10px] top-[8px]" },
    { name: "Big bets", at: "right-[10px] top-[8px] text-right" },
    { name: "Fill-ins", at: "bottom-[8px] left-[10px]" },
    { name: "Later", at: "bottom-[22px] right-[10px] text-right" },
  ];
  // B's legend: "Codes are the one-pager's feature codes" when every mark's code is one, else codes stay with the item.
  const fCodes = rows.length > 0 && rows.every((r) => /^F-\d+$/.test(r.short_code || r.code));
  const effortAt = xPct(byEffort.median);
  const valueAt = yPct(byValue.median);
  // B writes "middle effort" at the foot of its line and "middle value" under its line at 82%
  // across; where a mark or a quadrant's name sits there, the words take the next free spot.
  const { w, h } = plotSize;
  const ex = (effortAt / 100) * w;
  const vy = (valueAt / 100) * h;
  const quadrantBoxes = QUADRANTS.map((q, k): Box => {
    const len = `${q.name} · ${counts[k]}`.length * 8.6;
    return [[10, 8, 10 + len, 28], [w - 10 - len, 8, w - 10, 28], [10, h - 28, 10 + len, h - 8], [w - 10 - len, h - 42, w - 10, h - 22]][k] as Box;
  });
  const spots = markSpots(rows, w, h, {
    at: (r) => [(xPct(effortOf(r)) / 100) * w + fan(r), (yPct(r.goal_value ?? 0) / 100) * h],
    avoid: quadrantBoxes,
  });
  const taken: Box[] = [...rows.map((r): Box => {
    const [x, y] = spots.get(r.feature_id)!;
    return [x - 18, y - 18, x + 18, y + 18];
  }), ...quadrantBoxes];
  const free = (b: Box) => b[0] >= 0 && b[2] <= w && b[1] >= 0 && b[3] <= h && !taken.some((o) => o[0] < b[2] && b[0] < o[2] && o[1] < b[3] && b[1] < o[3]);
  const effortSpots: { box: Box; style: React.CSSProperties }[] = [
    { box: [ex + 5, h - 19, ex + 91, h - 3], style: { left: `calc(${effortAt}% + 5px)`, bottom: 3 } },
    { box: [ex - 91, h - 19, ex - 5, h - 3], style: { left: `calc(${effortAt}% - 5px)`, bottom: 3, transform: "translateX(-100%)" } },
    ...[0.75, 0.6].flatMap((at): { box: Box; style: React.CSSProperties }[] => [
      { box: [ex + 5, at * h - 8, ex + 91, at * h + 8], style: { left: `calc(${effortAt}% + 5px)`, top: `calc(${at * 100}% - 8px)` } },
      { box: [ex - 91, at * h - 8, ex - 5, at * h + 8], style: { left: `calc(${effortAt}% - 5px)`, top: `calc(${at * 100}% - 8px)`, transform: "translateX(-100%)" } },
    ]),
    { box: [ex + 5, 32, ex + 91, 48], style: { left: `calc(${effortAt}% + 5px)`, top: 32 } },
    { box: [ex - 91, 32, ex - 5, 48], style: { left: `calc(${effortAt}% - 5px)`, top: 32, transform: "translateX(-100%)" } },
  ];
  const valueSpots: { box: Box; style: React.CSSProperties }[] = [0.82, 0.6, 0.3, 0.9, 0.7, 0.5, 0.4, 0.2, 0.12].flatMap((at) => [
    { box: [at * w - 42, vy + 4, at * w + 42, vy + 20] as Box, style: { left: `${at * 100}%`, top: `calc(${valueAt}% + 4px)`, transform: "translateX(-50%)" } },
    { box: [at * w - 42, vy - 20, at * w + 42, vy - 4] as Box, style: { left: `${at * 100}%`, top: `calc(${valueAt}% - 20px)`, transform: "translateX(-50%)" } },
  ]);
  const effortLabel = (w && effortSpots.find((s) => free(s.box))) || effortSpots[0];
  const valueLabel = (w && valueSpots.find((s) => free(s.box))) || valueSpots[0];
  // qa-simple-plan-14: what the dragged mark will take, live.
  const dragRow = drag ? rows.find((r) => r.code === drag.code) : undefined;
  const pending = dragRow && drag ? dragTo(dragRow, drag.dx, drag.dy) : null;
  const listed = byLine(data);
  const split = lineSplit(listed);
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <section aria-label="Value / effort" className="min-w-0">
        <div className="pl-[46px] pr-[14px] pt-3">
          {/* B's plot is 706 x 548; a phone's narrow plot is square, so its marks keep their room. */}
          <div ref={box} data-testid="vxe-plot" className="relative aspect-square rounded-xl border border-line bg-surface sm:aspect-[706/548]">
            <svg aria-hidden className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
              {ticks.map((t) => (
                <line key={`x${t}`} x1={`${xPct(t)}%`} x2={`${xPct(t)}%`} y1="0" y2="100%" stroke="var(--line)" strokeWidth=".7" />
              ))}
              {vTicks.map((v) => (
                <line key={`y${v}`} x1="0" x2="100%" y1={`${yPct(v)}%`} y2={`${yPct(v)}%`} stroke="var(--line)" strokeWidth=".7" />
              ))}
              <line x1={`${effortAt}%`} x2={`${effortAt}%`} y1="0" y2="100%" stroke="var(--accent-ink)" strokeDasharray="6 4" strokeWidth="1.5" />
              <line x1="0" x2="100%" y1={`${valueAt}%`} y2={`${valueAt}%`} stroke="var(--accent-ink)" strokeDasharray="6 4" strokeWidth="1.5" />
            </svg>
            <span aria-hidden className="pointer-events-none absolute top-1/2 whitespace-nowrap text-[14px] leading-5 text-text2" style={{ left: -32, transform: "translate(-50%, -50%) rotate(-90deg)" }}>
              Goal value ↑
            </span>
            {vTicks.map((v) => (
              <span key={v} data-testid="vxe-value-tick" aria-hidden className="pointer-events-none absolute right-[calc(100%+6px)] -translate-y-1/2 text-[12px] leading-4 tabular-nums text-text2" style={{ top: `${yPct(v)}%` }}>
                {v}
              </span>
            ))}
            <span data-testid="vxe-median-effort" aria-hidden className="pointer-events-none absolute inset-y-0 w-0" style={{ left: `${effortAt}%` }} />
            <span data-testid="vxe-median-value" aria-hidden className="pointer-events-none absolute inset-x-0 h-0" style={{ top: `${valueAt}%` }} />
            <span data-testid="vxe-middle-effort" aria-hidden className="pointer-events-none absolute whitespace-nowrap text-[12px] font-semibold leading-4 text-accent-ink" style={effortLabel.style}>
              middle effort
            </span>
            <span data-testid="vxe-middle-value" aria-hidden className="pointer-events-none absolute whitespace-nowrap text-[12px] font-semibold leading-4 text-accent-ink" style={valueLabel.style}>
              middle value
            </span>
            {QUADRANTS.map((q, k) => (
              <span key={q.name} data-testid="vxe-quadrant" className={`pointer-events-none absolute whitespace-nowrap text-[15px] font-[650] leading-5 text-text-faint ${q.at}`}>
                {q.name} · {counts[k]}
              </span>
            ))}
            {rows.map((r) => {
              const d = drag?.code === r.code ? drag : null;
              // Laid out in pixels once the plot is measured (off the middle lines, apart from each other).
              const [sx, sy] = spots.get(r.feature_id)!;
              const left = w ? `${sx + (d?.dx ?? 0)}px` : `calc(${xPct(effortOf(r))}% + ${(d?.dx ?? 0) + fan(r)}px)`;
              const top = w ? `${sy + (d?.dy ?? 0)}px` : `calc(${yPct(r.goal_value ?? 0)}% + ${d?.dy ?? 0}px)`;
              const isMoved = !!movedWords(moved, r);
              const isSelected = selected === r.feature_id;
              return (
                <button
                  key={r.feature_id}
                  ref={(el) => {
                    if (el) markRefs.current.set(r.feature_id, el);
                    else markRefs.current.delete(r.feature_id);
                  }}
                  data-testid="vxe-point"
                  data-code={r.code}
                  data-above={r.above_line ? "true" : "false"}
                  data-moved={isMoved ? "true" : undefined}
                  data-shape={shapeOf(r)}
                  aria-pressed={isSelected}
                  aria-label={`#${r.rank} ${nameOf(r)}: goal value ${fmt(r.goal_value)}, ${r.effort == null ? "PM-owned, no effort" : `effort ${fmt(r.effort)} ${r.effort === 1 ? "week" : "weeks"}`}${r.above_line ? "" : ", below the line"}${goalOf(r) ? "" : ", no goal"}`}
                  title={`#${r.rank} ${r.short_code || r.code} · ${r.title}`}
                  className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full ${isSelected ? "z-20 ring-[3px] ring-accent ring-offset-2 ring-offset-surface" : isMoved ? "z-10 ring-2 ring-accent ring-offset-2 ring-offset-surface" : ""} ${mayChange && r.can_reorder ? "cursor-grab touch-none" : "cursor-pointer"}`}
                  style={{ left, top }}
                  onClick={() => {
                    if (dragged.current) {
                      dragged.current = false;
                      return;
                    }
                    select(r.feature_id, "mark");
                  }}
                  onPointerDown={(e) => {
                    dragged.current = false;
                    if (!mayChange || !r.can_reorder) return;
                    e.preventDefault();
                    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
                    setDrag({ code: r.code, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0 });
                  }}
                  onPointerMove={(e) => drag?.code === r.code && setDrag({ ...drag, dx: e.clientX - drag.x0, dy: e.clientY - drag.y0 })}
                  onPointerUp={() => drop(r)}
                  onPointerCancel={() => setDrag(null)}
                  onKeyDown={(e) => key(e, r)}
                >
                  <ShapeMark shape={shapeOf(r)} hollow={!r.above_line} code={r.short_code || r.code} />
                </button>
              );
            })}
            {dragRow && drag && (
              <span
                data-testid="vxe-drag-readout"
                role="status"
                className="pointer-events-none absolute z-30 -translate-x-1/2 whitespace-nowrap rounded-md bg-text px-2 py-0.5 text-[13px] font-semibold text-bg"
                style={{ left: (spots.get(dragRow.feature_id)?.[0] ?? 0) + drag.dx, top: (spots.get(dragRow.feature_id)?.[1] ?? 0) + drag.dy - 44 }}
              >
                {pending?.effort != null ? `effort ${fmt(pending.effort)} wk` : pending?.goal_value != null ? `goal value ${fmt(pending.goal_value)}` : !dragRow.goal && Math.abs(drag.dy) > Math.abs(drag.dx) ? "No goal: no goal value to change" : "no change"}
              </span>
            )}
          </div>
          <div className="relative h-[22px]" aria-hidden>
            {ticks.map((t) => (
              <span key={t} data-testid="vxe-tick" className="absolute top-[4px] -translate-x-1/2 whitespace-nowrap text-[12px] leading-4 tabular-nums text-text2" style={{ left: `${xPct(t)}%` }}>
                {t}
              </span>
            ))}
          </div>
          <p className="text-center text-[14px] leading-[18px] text-text2">Effort (engineer-weeks, log scale) →</p>
        </div>
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 pl-6 text-[15px] leading-[22px] text-text2" aria-label="Legend">
          {[...shapes.entries()].map(([k, s]) => (
            <li key={k} className="flex items-center gap-1">
              <LegendMark shape={s} />
              {rows.find((r) => r.goal?.key === k)?.goal?.title}
            </li>
          ))}
          {rows.some((r) => !r.goal) && (
            <li className="flex items-center gap-1" data-testid="vxe-legend-no-goal">
              <LegendMark shape="none" />
              No goal
            </li>
          )}
          <li>
            {fCodes ? "Each mark shows the feature's code from its one-pager; its rank is in the list." : "Each mark shows the feature's code; its rank is in the list."} Hollow: below the line ({lineWords(data)}). A mark on a middle line counts on the side its rank puts it.
          </li>
        </ul>
        <p className="mt-1 pl-6 text-[15px] leading-[22px] text-text-faint">
          {mayChange ? "Drag a mark sideways to change its effort, up or down to change its goal value (or use the arrow keys); a feature with no goal has no goal value to change." : "Select a mark to find it in the list."}
        </p>
      </section>
      <section aria-label="Ranked side list" className="min-w-0">
        <h2 className="mb-2 text-[21px] font-[650] leading-7">Ranked</h2>
        <LineCaption data={data} compact />
        <ol className="flex flex-col gap-1">
          {listed.flatMap((r, i) => {
            const words = movedWords(moved, r);
            const isSelected = selected === r.feature_id;
            return [
              ...(i === split ? [<LineDivider key="the-line" data={data} compact />] : []),
              <li
                key={r.feature_id}
                ref={(el) => {
                  if (el) sideRefs.current.set(r.feature_id, el);
                  else sideRefs.current.delete(r.feature_id);
                }}
                data-testid="side-row"
                data-code={r.code}
                data-above={r.above_line ? "true" : "false"}
                data-misses={r.above_line ? undefined : "true"}
                data-moved={words ? "true" : undefined}
                data-selected={isSelected ? "true" : undefined}
                className={`scroll-my-4 rounded-lg border text-[15px] leading-[22px] ${isSelected ? "border-accent bg-accent-soft ring-2 ring-accent" : words ? "border-accent ring-2 ring-accent" : "border-line"} ${isSelected ? "" : r.above_line ? "bg-surface" : "bg-surface2 text-text2"}`}
              >
                <button type="button" aria-pressed={isSelected} onClick={() => select(r.feature_id, "row")} className="flex w-full items-center gap-1.5 rounded-lg px-2 py-0.5 text-left">
                  <span className="w-5 flex-none text-right font-[650] tabular-nums" data-testid="side-rank">
                    {r.rank}
                  </span>
                  <span className="flex-none whitespace-nowrap rounded-md border border-line-strong bg-surface px-1 text-[13px] font-semibold tabular-nums text-text" data-testid="side-code" title={r.title}>
                    {r.short_code || r.title}
                  </span>
                  <span className="min-w-0 flex-1 truncate" data-testid="prio-title" title={r.title}>
                    {r.title}
                  </span>
                  {!r.above_line && <MissesTag data={data} compact />}
                  <span className="flex-none tabular-nums text-text2" title="Score">{r.score == null ? "–" : fmt(r.score, 2)}</span>
                </button>
                {isSelected && (
                  <span data-testid="side-numbers" className="block px-2 pb-1 pl-[34px] text-[13px] tabular-nums text-text">
                    {r.effort == null ? `goal value ${fmt(r.goal_value)} · PM-owned, no score` : `goal value ${fmt(r.goal_value)} · confidence ${fmt(r.confidence, 2)} · ${fmt(r.effort)} wk · score ${fmt(r.score, 2)}`}
                  </span>
                )}
                {/* The badge on a line of its own, so the name stays readable. */}
                {words && (
                  <span className="flex px-2 pb-1 pl-[34px]">
                    <MovedTag words={words} />
                  </span>
                )}
              </li>,
            ];
          })}
        </ol>
      </section>
    </div>
  );
}

// --------------------------------------------------------------------------- the line

/** The line in words: "not this quarter" for Now, else "not done by <day>". */
function lineWords(data: Out): string {
  const l = data.line;
  return !l || l.kind === "now" ? "not this quarter" : `not planned to finish by ${l.label.replace(/^By /, "")}`;
}

/** Roadmap-plus: the "Line" picker: This quarter (Now) · each key date · each dated milestone · Pick a date. */
function LinePicker({ data, onPick }: { data: Out; onPick: (key: string) => void }) {
  const current = data.line ?? { key: "now", kind: "now" as const, label: "This quarter (Now)", date: null };
  // Picking a date, the date field takes the select's place (one control); a picked day is the select's own option.
  const [picking, setPicking] = useState(false);
  // qa-simple-plan-1: the day typed is applied only when whole (Apply or Enter), never mid-typing.
  const [day, setDay] = useState("");
  const whole = /^\d{4}-\d{2}-\d{2}$/.test(day) && Number(day.slice(0, 4)) >= 2000;
  const apply = () => {
    if (!whole) return;
    setPicking(false);
    onPick(`date:${day}`);
  };
  // qa-simple-plan-25: in date order (the API's), one naming style: "<kind>: <name> · <day>".
  const offered = data.lines ?? [];
  const value = current.kind === "date" ? "picked" : current.key;
  // B's box: 32 px high, as wide as the line it shows (not its longest option), a chevron of its own.
  const field = "h-8 rounded-lg border border-line-strong bg-surface px-2 text-[15px] text-text";
  return (
    <div className="flex flex-wrap items-center gap-2 text-[15px]" data-testid="line-picker">
      <label htmlFor="prio-line" className="font-semibold">
        Line
      </label>
      {picking && (
        <span className="inline-flex items-center gap-1">
          <input
            type="date"
            autoFocus
            min="2000-01-01"
            aria-label="The line's date"
            className={field}
            value={day}
            onChange={(e) => setDay(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                apply();
              } else if (e.key === "Escape") setPicking(false);
            }}
          />
          {whole && (
            <span data-testid="line-day-preview" className="whitespace-nowrap text-text2">
              {calendarDay(day, { month: "short", day: "numeric", year: "numeric" }, "en-US")}
            </span>
          )}
          <Button type="button" onClick={apply} disabled={!whole} title={whole ? undefined : "Type the whole date first"}>
            Apply
          </Button>
          <Button type="button" variant="ghost" onClick={() => setPicking(false)}>
            Cancel
          </Button>
        </span>
      )}
      <span className={`relative max-w-full ${picking ? "hidden" : "inline-flex"}`}>
        <select
          id="prio-line"
          value={value}
          className={`${field} max-w-full appearance-none pr-[26px] [field-sizing:content]`}
          onChange={(e) => {
            if (e.target.value === "pick") {
              setDay(current.date ?? "");
              setPicking(true);
            }
            else if (e.target.value !== "picked") onPick(e.target.value);
          }}
        >
          {offered.map((l) => (
            <option key={l.key} value={l.key}>
              {l.kind === "key_date" ? `Key date: ${l.label}` : l.kind === "milestone" ? `Milestone: ${l.label}` : l.label}
            </option>
          ))}
          {current.kind === "date" && <option value="picked">{`Date: ${current.label.replace(/^By /, "")}`}</option>}
          <option value="pick">{current.kind === "date" ? "Pick another date…" : "Pick a date…"}</option>
        </select>
        <span aria-hidden className="pointer-events-none absolute right-[9px] top-[11px] h-1.5 w-1.5 rotate-45 border-b-[1.5px] border-r-[1.5px] border-text2" />
      </span>
    </div>
  );
}

/** The line inside a sentence: "this quarter", "Nov 20, 2026", "Beta · Dec 4, 2026" (never the picker's "By " or "(Now)"). */
const lineLabel = (data: Out): string => (!data.line || data.line.kind === "now" ? "this quarter" : data.line.label.replace(/^By /, ""));

/**
 * A row's goal: the item's, else the plan's (a row the item does not give a goal, but the plan
 * does, each feature under the goal it moves most), as Goal buckets shows it.
 */
function goalOfRow(data: Out): (r: Row) => string | null {
  const planGoal = new Map((data.plan?.slices ?? []).filter((x) => x.goal).map((x) => [x.feature_code, goalLabel(x.goal!).name]));
  return (r) => r.goal?.title ?? planGoal.get(r.short_code) ?? null;
}

/**
 * The rows as the list shows them: by rank, except that with a dated plan the plan's dates
 * decide what makes the line, so what makes it comes first and what misses it after (each
 * part by rank, every row keeping its #), and the line is drawn once between them.
 */
function byLine(data: Out): Row[] {
  const rows = data.rows;
  if (!dateLine(data)) return rows;
  return [...rows.filter((r) => r.above_line), ...rows.filter((r) => !r.above_line)];
}

/**
 * qa-simple-plan-2: whether dates decide the line (a dated plan, a key date, a milestone, a
 * picked day): then what makes it is listed first, as a dated plan's list is.
 */
function dateLine(data: Out): boolean {
  return !!data.plan?.span || (!!data.line && data.line.kind !== "now");
}

/** The list is regrouped at the line: dates decide it and rank order alone would interleave. */
const splitAtLine = (data: Out): boolean => dateLine(data) && regrouped(data.rows);

/** True when the plan's dates put rows that make the line below rows that miss it. */
function regrouped(rows: Row[]): boolean {
  return rows.some((r, i) => r.above_line && rows.slice(0, i).some((x) => !x.above_line));
}

/**
 * Where a single divider may sit: before the first row that misses the line, only when every
 * row after it misses it too (rank order is dependency order and stays; otherwise each row
 * that misses is marked on its own and there is no divider). -1: no divider.
 */
function lineSplit(rows: Row[]): number {
  const first = rows.findIndex((r) => !r.above_line);
  return first >= 0 && rows.slice(first).every((r) => !r.above_line) ? first : -1;
}

/**
 * Above the list: "N of M miss <line>" and the names of those that miss it. Compact (Value/effort's
 * 320 px side list): three names and "and N more", every name in its title.
 */
function LineCaption({ data, compact = false }: { data: Out; compact?: boolean }) {
  const misses = data.rows.filter((r) => !r.above_line).map((r) => r.title);
  // qa-simple-plan-19: "and N more" opens the rest.
  const [all, setAll] = useState(false);
  const cut = compact && misses.length > 3 && !all;
  return (
    <p data-testid="line-caption" className={`mb-2 text-[length:var(--simple-small)] text-text2 ${compact ? "leading-[21px]" : ""}`}>
      <span className="font-medium text-accent-ink">
        {misses.length} of {data.rows.length} miss {lineLabel(data)}
      </span>
      {misses.length > 0 && `: ${cut ? `${misses.slice(0, 3).join(", ")} ` : misses.join(", ")}`}
      {cut && (
        <button type="button" data-testid="line-caption-more" aria-expanded={false} onClick={() => setAll(true)} className="font-semibold text-accent-ink underline">
          and {misses.length - 3} more
        </button>
      )}
    </p>
  );
}

/** A row's own mark when it misses the line; compact (Value/effort's side list, B): a small "Misses" chip, the line in its title. */
function MissesTag({ data, row, compact = false }: { data: Out; row?: Row; compact?: boolean }) {
  // qa-simple-plan-27: a feature tagged with the very milestone the line is drawn at misses its own milestone.
  const own = !!row?.milestone && data.line?.kind === "milestone" && data.line.label.split(" · ")[0] === row.milestone;
  if (own && !compact)
    return (
      <span data-testid="prio-misses" data-own="true" className="flex-none whitespace-nowrap rounded-full bg-crit-bg px-2 text-[length:var(--simple-small)] font-medium text-crit">
        Misses its own milestone, {lineLabel(data)}
      </span>
    );
  if (compact)
    return (
      <span data-testid="prio-misses" title={`Misses ${lineLabel(data)}`} className="flex-none whitespace-nowrap rounded-full border border-line-strong px-1.5 text-[12px] leading-[18px] text-text2">
        Misses
      </span>
    );
  return (
    <span data-testid="prio-misses" className="flex-none whitespace-nowrap rounded-full border border-line-strong bg-surface px-2 text-[length:var(--simple-small)] text-text2">
      Misses {lineLabel(data)}
    </span>
  );
}
// MOCK-HOOK
/** MOCK-HOOK qp1=b/d: a part's heading, "Makes Customer conference · Nov 14 · 5 features, in rank order". */
function MkPartHead({ data, makes, n, li = false }: { data: Out; makes: boolean; n: number; li?: boolean }) { // MOCK-HOOK
  const Tag = li ? "li" : "h3"; // MOCK-HOOK
  return ( // MOCK-HOOK
    <Tag data-testid="mk-part-head" className={`flex flex-wrap items-baseline gap-x-2 ${li ? "pt-2" : "mb-2"} ${makes || !li ? "" : "mt-2 border-t-2 border-accent-ink pt-3"}`}>{/* MOCK-HOOK */}
      <span className="text-[length:var(--simple-h2)] font-semibold leading-[var(--simple-h2-leading)]">{makes ? "Makes" : "Misses"} {lineLabel(data)}</span>{/* MOCK-HOOK */}
      <span className="text-[length:var(--simple-small)] text-text2">{n} {n === 1 ? "feature" : "features"}, in rank order</span>{/* MOCK-HOOK */}
    </Tag> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK
// MOCK-HOOK
/** MOCK-HOOK qp2: how value and confidence read on a row (a: no bar; b: the bar with value; c: two meters; d: a score bar). */
function MkNumbers({ r, v, maxValue, maxScore }: { r: Row; v: string; maxValue: number; maxScore: number }) { // MOCK-HOOK
  const bar = (share: number, label: string) => ( // MOCK-HOOK
    <span role="img" aria-label={label} title={label} className="inline-block h-2 w-14 flex-none overflow-hidden rounded-full border border-line bg-surface2">{/* MOCK-HOOK */}
      <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.min(1, share) * 100}%` }} />{/* MOCK-HOOK */}
    </span> // MOCK-HOOK
  ); // MOCK-HOOK
  const value = <span className="whitespace-nowrap">value {fmt(r.goal_value)}</span>; // MOCK-HOOK
  const valueBar = bar((r.goal_value ?? 0) / maxValue, `Goal value ${fmt(r.goal_value)} of the top ${fmt(maxValue)}`); // MOCK-HOOK
  const conf = r.effort == null ? null : <span className="whitespace-nowrap">confidence {fmt(r.confidence, 2)}</span>; // MOCK-HOOK
  const score = r.effort == null ? <span>PM-owned, no score</span> : <span className="whitespace-nowrap">score <span className="font-semibold text-text" data-testid="prio-score" title={SCORE_WORDS}>{fmt(r.score, 2)}</span></span>; // MOCK-HOOK
  const wk = r.effort == null ? null : <span className="whitespace-nowrap">{fmt(r.effort)} wk</span>; // MOCK-HOOK
  const parts = [ // MOCK-HOOK each number keeps its "·" on its own line, so a wrap never leaves one stranded
    v === "b" || v === "c" ? <>{value}{valueBar}</> : value, // MOCK-HOOK
    conf && (v === "c" ? <>{conf}{bar(r.confidence ?? 0, `Confidence ${fmt(r.confidence, 2)} of 1`)}</> : conf), // MOCK-HOOK
    wk, // MOCK-HOOK
    v === "d" && r.effort != null ? <>{score}{bar((r.score ?? 0) / maxScore, `Score ${fmt(r.score, 2)} of the top ${fmt(maxScore, 2)}`)}</> : score, // MOCK-HOOK
  ].filter(Boolean); // MOCK-HOOK
  return ( // MOCK-HOOK
    <span data-testid="prio-numbers" data-mk={v} className="block overflow-hidden tabular-nums">{/* MOCK-HOOK a "·" that would start a line sits in the clipped margin */}
      <span className="-ml-[14px] flex flex-wrap items-center gap-y-1">{/* MOCK-HOOK */}
        {parts.map((p, k) => <span key={k} className="relative flex items-center gap-1.5 whitespace-nowrap pl-[14px]"><span aria-hidden className="absolute left-[4px]">·</span>{p}</span>)}{/* MOCK-HOOK */}
      </span>{/* MOCK-HOOK */}
    </span> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK
// MOCK-HOOK
/** The divider row, drawn only when every row after it misses the line. */
function LineDivider({ data, compact = false }: { data: Out; compact?: boolean }) {
  return (
    <li role="separator" data-testid="line-divider" className={`flex items-center gap-2 text-[length:var(--simple-small)] font-medium text-accent-ink ${compact ? "py-0.5 leading-[21px]" : "py-1"}`}>
      <span aria-hidden className="h-0.5 w-6 flex-none bg-accent-ink" />
      {/* qa-simple-plan-19: "misses it" kept together, so no word is left alone on a line. */}
      <span className="min-w-0">The line: {lineLabel(data)} · everything below misses{"\u00a0"}it</span>
      <span aria-hidden className="h-0.5 flex-1 bg-accent-ink" />
    </li>
  );
}

// --------------------------------------------------------------------------- goal buckets

function Buckets({ data, suggestions }: { data: Out; suggestions: GoalSuggestionsApi }) {
  const { can } = useMe();
  const [goalPanel, setGoalPanel] = useState<GoalBrief | null>(null);
  // plan-charts: with a dated plan, where each goal's work lands milestone by milestone.
  if (data.plan?.milestones.length && data.plan.span) return <PlanBuckets data={data} plan={data.plan} suggestions={suggestions} />;
  // An empty "No goal" bucket warns about nothing: it is left out.
  const buckets: Bucket[] = data.buckets.filter((b) => !(b.no_goal && b.weeks === 0 && b.codes.length === 0));
  const percent = sharePercents(buckets.map((b) => b.weeks));
  // Each feature by its code and its name, as the Ranked list shows them.
  const named = new Map(data.rows.map((r) => [r.code, r.short_code ? `${r.short_code} ${r.title}` : r.title]));
  return (
    <section aria-label="Goal buckets">
      <p className="mb-3 text-text2">
        No dated plan yet, so the work is not placed by milestone. Engineer-weeks per confirmed goal this quarter: {fmt(data.weeks_total)} wk in all.
      </p>
      <figure className="hidden sm:block" data-testid="bucket-bar">
        <figcaption className="mb-1 text-[length:var(--simple-small)] text-text2">Share of engineer-weeks by goal</figcaption>
        <div className="flex overflow-hidden rounded-[var(--simple-card-radius)] border border-line">
          {buckets.map((b, k) =>
            b.weeks > 0 ? (
              <div
                key={b.key}
                data-testid="bucket-segment"
                title={`${b.title}: ${fmt(b.weeks)} wk · ${percent[k]}%`}
                style={{ width: `${b.share * 100}%` }}
                className={`min-h-12 min-w-0 border-r border-surface p-2 text-[length:var(--simple-small)] ${b.no_goal ? "bg-warn-bg text-warn" : "bg-accent-soft text-accent-ink"}`}
              >
                {/* qa-simple-plan-40: the numbers are said once, on the cards below. */}
                <span className="block truncate font-medium">{b.title}</span>
              </div>
            ) : null,
          )}
        </div>
      </figure>
      <ul className="mt-3 grid gap-[var(--simple-gap)] sm:grid-cols-2">
        {buckets.map((b, k) => (
          <li key={b.key} data-testid="goal-bucket" data-key={b.key} className={`rounded-[var(--simple-card-radius)] border bg-surface p-3 ${b.no_goal ? "border-warn" : "border-line"}`}>
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="font-semibold">{b.title}</h3>
              <span className="tabular-nums">
                {fmt(b.weeks)} wk · <span data-testid="bucket-share">{percent[k]}%</span>
              </span>
            </div>
            <div className="mt-2 h-3 overflow-hidden rounded-full bg-surface2">
              <div className={`h-full ${b.no_goal ? "bg-warn" : "bg-accent"}`} style={{ width: `${b.share * 100}%` }} />
            </div>
            {b.no_goal && <p className="mt-1 text-[length:var(--simple-small)] text-warn">⚠ Serves no confirmed goal</p>}
            <p className="mt-1 text-[length:var(--simple-small)] text-text2">{b.codes.length ? b.codes.map((c) => named.get(c) ?? c).join(", ") : "Nothing this quarter"}</p>
            {!b.no_goal && (
              <div className="mt-3 border-t border-line pt-3">
                <SuggestionsButton goal={{ id: "", key: b.key, title: b.title }} api={suggestions} onOpen={setGoalPanel} label={can("create_goal_suggestion") ? "See or make suggestions" : "See suggestions"} />
              </div>
            )}
          </li>
        ))}
      </ul>
      {goalPanel && <GoalPanel goal={goalPanel} api={suggestions} onClose={() => setGoalPanel(null)} />}
    </section>
  );
}

/** Whole percentages of `weeks` that add up to 100 (largest remainder); all 0 when there are none. */
function sharePercents(weeks: number[]): number[] {
  const total = weeks.reduce((n, x) => n + x, 0);
  if (!total) return weeks.map(() => 0);
  const exact = weeks.map((x) => (x / total) * 100);
  const out = exact.map(Math.floor);
  let left = 100 - out.reduce((n, x) => n + x, 0);
  const order = exact.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (left <= 0) break;
    out[i] += 1;
    left -= 1;
  }
  return out;
}

/** The goal a plan goal names among the goals people suggest under: the same name (its code aside), the same code, or the same key. */
function suggestionGoal(api: GoalSuggestionsApi, goal: string): Schemas["SimpleGoalSuggestionGoal"] | undefined {
  const mine = goalLabel(goal);
  return api.data?.goals.find((g) => {
    const theirs = goalLabel(g.goal.title);
    return theirs.name.toLowerCase() === mine.name.toLowerCase() || (!!mine.code && theirs.code === mine.code) || g.goal.key === goal;
  });
}

/** plan-charts (the owner's pick B): the plan's header, then a card per goal listing each feature with its milestone chips. */
function PlanBuckets({ data, plan, suggestions }: { data: Out; plan: Schemas["SimplePlanOut"]; suggestions: GoalSuggestionsApi }) {
  const { can } = useMe();
  const goals = planGoals(plan);
  const noGoal = plan.slices.some((x) => !x.goal);
  const [panel, setPanel] = useState<{ goal: GoalBrief; start?: GoalPanelStart } | null>(null);
  // Who may suggest (commenters and up) gets B's two buttons; anyone else, the suggestions to read.
  const suggests = can("create_goal_suggestion");
  // A goal's code: its own ("G-A1 Account Safety"), else the code of the goal it names.
  const codeOf = (goal: string): string | null => {
    const own = goalLabel(goal).code;
    if (own) return own;
    const named = suggestionGoal(suggestions, goal);
    return named ? goalLabel(named.goal.title).code : null;
  };
  // This quarter's roadmap items the plan does not hold (another PRD's, or none), by their goal.
  const rowOf = new Map(data.rows.map((r) => [r.code, r]));
  const outside = data.buckets
    .map((b) => ({ b, rows: b.codes.map((c) => rowOf.get(c)).filter((r): r is Row => !!r && !r.in_plan) }))
    .filter((x) => x.rows.length > 0);
  return (
    <section aria-label="Goal buckets">
      <PlanBucketsHead plan={plan} codeOf={codeOf} />
      <ul className="mt-4 grid items-start gap-4 sm:grid-cols-2">
        {goals.map((g) => {
          const state = suggestionGoal(suggestions, g);
          const code = codeOf(g);
          return (
            <li key={g} data-testid="plan-goal" data-goal={g} className="rounded-[var(--simple-card-radius)] border border-line bg-surface p-4">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <h3 className="text-[21px] font-[650] leading-7">{goalLabel(g).name}</h3>
                {code && <CodeTag code={code} />}
                <span data-testid="plan-goal-count" className="ml-auto text-[15px] text-text2">
                  {featureCount(plan, g)}
                </span>
              </div>
              <PlanFeatureList plan={plan} goal={g} />
              {state && suggests && (
                <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
                  <button
                    type="button"
                    data-testid="goal-suggest-feature"
                    onClick={() => setPanel({ goal: state.goal, start: "form" })}
                    className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-line-strong bg-surface px-3 text-[14px] font-[650] text-text hover:bg-surface2"
                  >
                    + Suggest a feature
                  </button>
                  <button
                    type="button"
                    data-testid="goal-ask-oracle"
                    disabled={state.pending}
                    onClick={() => {
                      setPanel({ goal: state.goal, start: "oracle" });
                      void suggestions.suggest(state.goal);
                    }}
                    className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-transparent bg-accent-soft px-3 text-[14px] font-[650] text-accent-ink hover:bg-accent-mid disabled:cursor-default"
                  >
                    {state.pending ? "✦ Oracle is suggesting…" : "✦ Ask Oracle to suggest"}
                  </button>
                </div>
              )}
              {state && !suggests && (
                <div className="mt-3 border-t border-line pt-3">
                  <SuggestionsButton goal={state.goal} api={suggestions} onOpen={(goal) => setPanel({ goal })} label="See suggestions" />
                </div>
              )}
            </li>
          );
        })}
        {noGoal && (
          <li data-testid="plan-goal" data-goal="" className="rounded-[var(--simple-card-radius)] border border-warn bg-surface p-4">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <h3 className="text-[21px] font-[650] leading-7">No goal</h3>
              <span data-testid="plan-goal-count" className="ml-auto text-[15px] text-text2">
                {featureCount(plan, null)}
              </span>
            </div>
            <p className="mt-1 text-[15px] text-warn">⚠ Serves no goal in the plan</p>
            <PlanFeatureList plan={plan} goal={null} />
          </li>
        )}
        {outside.length > 0 && (
          <li data-testid="plan-outside" className="rounded-[var(--simple-card-radius)] border border-line bg-surface p-4 sm:col-span-2">
            <h3 className="text-[21px] font-[650] leading-7">Also this quarter, outside the plan</h3>
            <ul className="mt-2">
              {outside.map(({ b, rows }) => (
                <li key={b.key} data-testid="plan-outside-goal" data-key={b.key} className="border-b border-line py-[5px] text-[16px] leading-[22px]">
                  <span className={`font-[650] ${b.no_goal ? "text-warn" : ""}`}>{b.no_goal ? "⚠ Serves no confirmed goal" : b.title}</span>
                  {": "}
                  {rows.map((r) => `${r.short_code || r.code} ${r.title}`).join(", ")}
                  <span className="whitespace-nowrap text-text2"> · {fmt(rows.reduce((n, r) => n + (r.effort ?? 0), 0))}{"\u00a0"}wk</span>
                </li>
              ))}
            </ul>
          </li>
        )}
      </ul>
      {panel && <GoalPanel key={`${panel.goal.key}:${panel.start ?? ""}`} goal={panel.goal} start={panel.start} api={suggestions} onClose={() => setPanel(null)} />}
    </section>
  );
}
