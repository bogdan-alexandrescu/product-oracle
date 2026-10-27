"use client";

import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { Button, Notice, SegmentedControl, toast } from "@/components/ds";
import { Loading } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { shownDay } from "@/lib/dates";
import { useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";

import { Callout, FlagLine, FixButtons, FloatingCard, opWords, SuggestionPopover, type Act } from "./_card";
import { exportView } from "./_export";
import {
  broken,
  ChangeFailed,
  decide,
  propose,
  quarters,
  resultWords,
  shortDay,
  storedDates,
  suggestion,
  undo,
  type Change,
  type Draft,
  type Format,
  type GanttUnit,
  type Item,
  type Roadmap,
} from "./_lib";
import { Chart } from "./_timeline";

type Group = Roadmap["group"];
type Filters = { group: Group; prd: string; goal: string; track: string; from: string; to: string };
const NO_FILTERS: Filters = { group: "goal", prd: "", goal: "", track: "", from: "", to: "" };

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

const time = (at: string) => shownDay(at, { hour: "numeric", minute: "2-digit" });

/** The goal counters (each goal's metric line): items, and how many need a decision. */
function GoalCounters({ items }: { items: Item[] }) {
  const goals = new Map<string, { title: string; metric: string | null; items: number; broken: number }>();
  for (const i of items) {
    if (!i.goal) continue;
    const g = goals.get(i.goal.id) ?? { title: i.goal.title, metric: i.goal.metric ?? null, items: 0, broken: 0 };
    g.items += 1;
    if (broken(i).length) g.broken += 1;
    goals.set(i.goal.id, g);
  }
  if (!goals.size) return null;
  return (
    <ul className="grid grid-cols-2 gap-2 min-[900px]:grid-cols-4" data-testid="goal-counters">
      {[...goals.entries()].slice(0, 4).map(([id, g]) => (
        <li key={id} data-testid="goal-counter" className="rounded-xl border border-line bg-surface px-3 py-2">
          <p className="truncate text-[15px] font-semibold">{g.title}</p>
          <p className="truncate text-sm text-text2">{g.metric ?? "No metric yet"}</p>
          <p className="mt-1 text-sm">
            <b className="tnum">{g.items}</b> items
            {g.broken > 0 && (
              <span className="text-crit">
                {" "}
                · <b className="tnum">{g.broken}</b> broken
              </span>
            )}
          </p>
        </li>
      ))}
    </ul>
  );
}

function Select({ label, value, options, onChange }: { label: string; value: string; options: [string, string][]; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center gap-1.5 text-sm text-text2">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)} className="h-8 max-w-[11rem] rounded-lg border border-line-strong bg-surface px-2 text-sm text-text">
        <option value="">All</option>
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
}: {
  items: Item[];
  byId: Map<string, Item>;
  proposals: Change[];
  act: Act;
  canChange: boolean;
  onDecide: (c: Change, how: "accept" | "decline") => void;
  onSuggestion: (i: Item, how: "accept" | "dismiss") => void;
  onClose: () => void;
  phone: boolean;
}) {
  const brokenItems = items.filter((i) => i.can_decide && broken(i).length);
  const dates = items.filter((i) => i.suggestion?.can_decide);
  const mine = proposals.filter((c) => c.can_decide);
  const pulled = mine.filter((c) => c.op === "change_horizon");
  const others = mine.filter((c) => c.op !== "change_horizon");
  const counters: [string, number][] = [
    ["Broken links", brokenItems.length],
    ["Dates to confirm", dates.length],
    ["Proposals", others.length],
    ["Pulled in", pulled.length],
  ];
  const title = (c: Change) => byId.get(String(c.target.item_id))?.title ?? "An item";
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
      className={`${phone ? "fixed inset-0 z-50" : "fixed top-0 right-0 bottom-0 z-50 w-[440px] border-l border-line"} overflow-y-auto bg-surface p-4 shadow-tip`}
    >
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-lg font-semibold">Needs a decision</h2>
        <button type="button" aria-label="Close" onClick={onClose} className="h-8 w-8 rounded text-text2 hover:bg-surface2">
          ×
        </button>
      </div>
      <ul className="mt-3 grid grid-cols-4 gap-2" data-testid="tray-counters">
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
        {dates.length ? (
          <ul>
            {dates.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-2 py-1.5" data-testid="tray-date">
                <span className="min-w-0 flex-1 text-[15px]">
                  {i.title}: {shortDay(i.suggestion!.start_date)} – {shortDay(i.suggestion!.end_date)}
                </span>
                <Button onClick={() => onSuggestion(i, "accept")}>Accept</Button>
                <Button variant="ghost" onClick={() => onSuggestion(i, "dismiss")}>
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
    </aside>
  );
}

export function SimpleRoadmap() {
  const { me, can } = useMe();
  const phone = usePhone();
  const [f, setF] = useState<Filters>(NO_FILTERS);
  const [format, setFormat] = useState<Format>("timeline");
  const [unit, setUnit] = useState<GanttUnit>("week");
  const [moved, setMoved] = useState<Record<string, [string, string]>>({});
  const [card, setCard] = useState<{ id: string; left: number; top: number } | null>(null);
  const [pop, setPop] = useState<{ id: string; left: number; top: number } | null>(null);
  const [tray, setTray] = useState(false);
  const [exporting, setExporting] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement | null>(null);

  const qs = useMemo(() => {
    const q: Record<string, string> = { group: f.group };
    for (const k of ["prd", "goal", "track", "from", "to"] as const) if (f[k]) q[k] = f[k];
    return q;
  }, [f]);
  const roadmap = useQuery(
    `simple-roadmap:${JSON.stringify(qs)}`,
    () => unwrap(api.GET("/v1/simple/roadmap", { params: { query: qs as never } })),
    { keepPrevious: true },
  );
  const proposals = useQuery("simple-proposals", () => unwrap(api.GET("/v1/simple/changes", { params: { query: { status: "proposed" } } })));
  const drafts = useQuery("simple-drafts", () => unwrap(api.GET("/v1/simple/drafts")));
  const reload = useCallback(async () => {
    await Promise.all([roadmap.reload(), proposals.reload(), drafts.reload()]);
  }, [roadmap, proposals, drafts]);

  // The filters' choices: every PRD, goal and track seen, so narrowing keeps the others.
  const data = roadmap.data;
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

  const act: Act = useCallback(
    async (what, body) => {
      try {
        const r = await propose(body);
        toast({
          message: resultWords(r, what),
          action: r.change.status === "applied" && r.change.can_undo ? { label: "Undo", onClick: () => void undo(r.change.id).then(reload, (e) => toast({ message: String(e.message) })) } : undefined,
        });
      } catch (e) {
        toast({ message: e instanceof ChangeFailed ? e.message : "Oracle could not make this change" });
      } finally {
        await reload();
        setMoved({});
      }
    },
    [reload],
  );

  const onMove = useCallback(
    (item: Item, start: string, end: string) => {
      setMoved((m) => ({ ...m, [item.id]: [start, end] }));
      setCard(null);
      void act(`Moved '${item.title}' to ${shortDay(start)} – ${shortDay(end)}`, {
        op: "move_dates",
        target: { item_id: item.id },
        before: storedDates(item),
        after: { start_date: start, end_date: end },
      });
    },
    [act],
  );

  const anchorOf = (id: string): { left: number; top: number } => {
    const el = wrap.current?.querySelector(`g[data-bar-id="${id}"]`);
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
    async (i: Item, how: "accept" | "edit" | "dismiss", dates?: { start_date: string; end_date: string }) => {
      if (!i.suggestion) return;
      try {
        await suggestion(i.suggestion.id, how, dates);
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

  const doExport = async (kind: "png" | "pdf") => {
    if (!svg.current) return;
    setExporting(true);
    try {
      const labels = wrap.current?.querySelector<HTMLElement>('[data-testid="chart-labels"]') ?? null;
      await exportView(kind, svg.current, labels, `Roadmap · ${format === "gantt" ? `Gantt (${unit})` : "Timeline"}`, `roadmap-${format}`);
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

  return (
    <div className="simple-mode space-y-3 px-4 py-4 min-[641px]:px-6" data-testid="simple-roadmap" data-phone={phone ? "true" : "false"}>
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">Roadmap</h1>
        <SegmentedControl<Format>
          label="Format"
          size="sm"
          value={format}
          onChange={setFormat}
          items={[
            { value: "timeline", label: "Timeline", testId: "format-timeline" },
            { value: "gantt", label: "Gantt", testId: "format-gantt" },
            { value: "board", label: "Now / Next / Later", testId: "format-board" },
            { value: "waterfall", label: "Waterfall", testId: "format-waterfall" },
          ]}
        />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {decides && (
            <Button data-testid="needs-decision" onClick={() => setTray(true)} className={waiting ? "border-warn" : ""}>
              Needs a decision · {waiting}
            </Button>
          )}
          <Button disabled={exporting || format === "board" || format === "waterfall"} onClick={() => void doExport("png")}>
            Export PNG
          </Button>
          <Button disabled={exporting || format === "board" || format === "waterfall"} onClick={() => void doExport("pdf")}>
            Export PDF
          </Button>
        </div>
      </header>
      <GoalCounters items={data.items} />
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
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2" data-testid="filters">
        <Select label="PRD" value={f.prd} options={seen.prd} onChange={(prd) => setF({ ...f, prd })} />
        <Select label="Goal" value={f.goal} options={seen.goal} onChange={(goal) => setF({ ...f, goal })} />
        <Select label="Track" value={f.track} options={seen.track} onChange={(track) => setF({ ...f, track })} />
        <Select label="From" value={f.from} options={qList.map((q) => [q.start, q.label])} onChange={(from) => setF({ ...f, from })} />
        <Select label="To" value={f.to} options={qList.map((q) => [q.end, q.label])} onChange={(to) => setF({ ...f, to })} />
        <SegmentedControl<Group>
          label="Group by"
          size="sm"
          value={f.group}
          onChange={(group) => setF({ ...f, group })}
          items={[
            { value: "goal", label: "Goal", testId: "group-goal" },
            { value: "track", label: "Track", testId: "group-track" },
            { value: "prd", label: "PRD", testId: "group-prd" },
          ]}
        />
        {format === "gantt" && (
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
        )}
      </div>
      {format === "board" || format === "waterfall" ? (
        <section data-testid="format-later" className="rounded-xl border border-dashed border-line-strong p-8 text-center text-text2">
          {format === "board" ? "The Now / Next / Later board" : "The waterfall phases"} come with the roadmap&rsquo;s second part.
        </section>
      ) : (
        <div ref={wrap} className="relative">
          <Chart
            data={data}
            format={format}
            unit={unit}
            compact={phone}
            canDrag={canChange}
            moved={moved}
            open={card?.id ?? null}
            chartRef={(el) => {
              svg.current = el;
            }}
            onOpen={(item) => {
              setPop(null);
              setCard({ id: item.id, ...anchorOf(item.id) });
            }}
            onMove={onMove}
            onSuggestion={(item) => {
              setCard(null);
              setPop({ id: item.id, ...anchorOf(item.id) });
            }}
            overlay={(l, sc) =>
              data.items.flatMap((i) => {
                const y = l.y.get(i.id);
                if (y == null || i.status === "cut") return [];
                const f0 = broken(i).find((x) => x.kind === "dependency_order");
                if (!f0) return [];
                const [, end] = moved[i.id] ?? [i.start.date, i.end.date];
                return [<Callout key={i.id} item={i} flag={f0} items={byId} act={act} canChange={canChange} x={sc.x(end) + sc.px + 14} y={y} h={l.rowH} compact={phone} />];
              })
            }
          />
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
      )}
      <p className="text-sm text-text2" data-testid="legend">
        Solid: dated · hatched: estimated (the horizon&rsquo;s window) · dashed: draft · dotted outline: Oracle&rsquo;s date suggestion (? opens it) · diamond: a milestone · red: a broken link
      </p>
      {tray && (
        <DecisionTray
          items={data.items}
          byId={byId}
          proposals={allProposals}
          act={act}
          canChange={canChange}
          onDecide={(c, how) => void onDecide(c, how)}
          onSuggestion={(i, how) => void onSuggestion(i, how)}
          onClose={() => setTray(false)}
          phone={phone}
        />
      )}
    </div>
  );
}
