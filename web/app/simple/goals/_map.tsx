"use client";

/**
 * Simple Goal map (build-goal-map), drawn to the owner's pick "Ladder by area lanes": the
 * goals on top as cards joined by arrows, the guardrail strip every milestone must hold,
 * then one grid with the areas as rows in the owner's order and the milestones as columns
 * in steps, each gate with its reading, status and 7 days of proof; each feature a card in
 * the cell of its area under the milestone it serves (drawn once; its other places point to
 * it). A phone shows the milestones one by one. Every feature opens Simple's item panel.
 */
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

import { Icon } from "@/components/ds/Icon";
import { NewPrdSheet, useCanStartPrd } from "@/components/simple/NewPrd";
import { api, unwrap } from "@/lib/api/client";
import type { GmArea, GmFeature, GmGoal, GmLift, GmMilestone, GmStatus, GoalMap } from "@/lib/api/mock/goal-map";
import { errorMessage, useQuery } from "@/lib/use-query";

import { FeaturePanel } from "./_panel";

/** one-feature-panel: each feature's code (its roadmap item's), shown before its name. */
const Codes = createContext<Map<string, string>>(new Map());

type Edit = "propose" | "goal" | "attach" | "prd" | "area" | "gate" | null;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The 7 days a gate's proof covers, oldest first, ending today ("Nov 3"), in words. */
function weekOf(today: string): string[] {
  const [mon, day] = today.split(" ");
  const end = Date.UTC(2001, MONTHS.indexOf(mon), Number(day));
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(end - (6 - i) * 86_400_000);
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  });
}

const STATUS: Record<GmStatus, { label: string; cls: string }> = {
  met: { label: "Met", cls: "bg-pass-bg text-pass" },
  on_track: { label: "On track", cls: "bg-accent-soft text-accent-ink" },
  at_risk: { label: "At risk", cls: "bg-warn-bg text-warn" },
  missed: { label: "Missed", cls: "bg-crit-bg text-crit" },
  not_measured: { label: "Not measured yet", cls: "bg-na-bg text-na" },
  no_gate: { label: "No gate yet", cls: "bg-na-bg text-na" },
};
const LIFT: Record<GmLift, { label: string; cls: string }> = {
  helping: { label: "Helping", cls: "bg-pass-bg text-pass" },
  not_helping: { label: "Not helping", cls: "bg-crit-bg text-crit" },
  not_measured: { label: "Not measured yet", cls: "bg-na-bg text-na" },
};

function num(v: number | null, unit: string): string {
  if (v === null) return "—";
  if (unit === "$") return v >= 1000 ? `$${Math.round(v / 100) / 10}k` : `$${v}`;
  return `${Math.round(v * 10) / 10}`;
}

function Pill({ cls, children, testId }: { cls: string; children: ReactNode; testId?: string }) {
  return (
    <span data-testid={testId} className={`inline-block shrink-0 whitespace-nowrap rounded-full [word-spacing:0.12em] px-2.5 py-0.5 text-[14px] font-semibold ${cls}`}>
      {children}
    </span>
  );
}
const StatusPill = ({ s }: { s: GmStatus }) => <Pill cls={STATUS[s].cls}>{STATUS[s].label}</Pill>;
const LiftPill = ({ l }: { l: GmLift }) => <Pill cls={LIFT[l].cls}>{LIFT[l].label}</Pill>;

function Btn({ children, onClick, primary, testId, small, disabled }: { children: ReactNode; onClick?: () => void; primary?: boolean; testId?: string; small?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border font-semibold ${small ? "px-2.5 py-0.5 text-[14px]" : "px-4 py-1.5 text-[15px]"} ${
        primary ? "border-accent bg-accent text-on-accent disabled:opacity-40" : "border-line bg-surface text-text hover:bg-surface2"
      }`}
    >
      {children}
    </button>
  );
}

/** A reading against its target as a bar: current of target. */
function Bar({ current, target, status }: { current: number | null; target: number; status: GmStatus }) {
  const pct = current === null ? 0 : Math.min(100, Math.round((current / target) * 100));
  const tone = status === "missed" ? "bg-crit" : status === "at_risk" ? "bg-warn" : status === "met" ? "bg-pass" : "bg-accent";
  return (
    <span className="block h-2 w-full overflow-hidden rounded-full bg-surface2" aria-hidden>
      <span className={`block h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
    </span>
  );
}

/** The 7 daily readings a milestone's 'met' rule counts, and who confirmed it. */
function Proof({ m, compact, week }: { m: GmMilestone; compact?: boolean; week: string[] }) {
  const ok = (v: number | null) => v !== null && m.threshold !== null && (m.measure.startsWith("days") ? v === 0 : v >= m.threshold);
  return (
    <span className="flex min-w-0 max-w-full flex-col gap-1">
      <span className={`flex w-full gap-1 ${compact ? "" : "flex-wrap"}`} aria-label="Last 7 days">
        {m.days.map((v, i) => (
          <span
            key={i}
            title={`${week[i]}: ${v === null ? "not measured" : num(v, m.unit)}`}
            className={`grid h-6 ${compact ? "min-w-0 flex-1 text-[12px]" : "min-w-9 px-1 text-[14px]"} place-items-center rounded-md font-semibold ${
              v === null ? "bg-surface2 text-text-faint" : ok(v) ? "bg-pass-bg text-pass" : "border border-line-strong bg-surface text-text"
            }`}
          >
            {v === null ? "·" : compact && m.unit === "$" ? `${Math.round(v / 1000)}k` : num(v, m.unit)}
          </span>
        ))}
      </span>
      <span className="simple-small text-[14px]! leading-5">
        {m.status === "met"
          ? `Held 7 days in a row on a live rep${m.confirmed ? ` · confirmed by ${m.confirmed}${m.confirmed_on ? `, ${m.confirmed_on}` : ""}` : ""}`
          : m.status === "no_gate"
            ? "No gate yet: set the reading it must hold"
            : m.status === "not_measured"
            ? "No daily reading yet"
            : m.status === "missed"
              ? `${m.due ? `Due ${m.due} · ` : ""}held ${m.days.filter(ok).length} of 7 days`
              : `Held ${m.days.filter(ok).length} of 7 days · ${week[0]} – ${week[6]}`}
      </span>
    </span>
  );
}

function Guardrail({ map }: { map: GoalMap }) {
  const g = map.guardrail;
  if (!g) return null;
  return (
    <div data-testid="gm-guardrail" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl border border-pass/40 bg-pass-bg px-4 py-2.5">
      <Icon name="lock" size={18} className="text-pass" />
      <span className="font-semibold">Guardrail: {g.name} {g.rule}</span>
      <span className="text-text2">Every milestone must hold it.</span>
      <span className={`ml-auto font-semibold ${g.held ? "text-pass" : "text-crit"}`}>
        {g.current === null ? "Not measured today" : `${num(g.current, "")} today`} · held {g.days.filter((v) => v === 0).length} of 7 days
      </span>
    </div>
  );
}

/** Feature line: expected lift and, once released, what it measured. */
function FeatureCard({ f: all, milestone, area, tight, also, fresh, serves = "Also serves", onOpen }: { f: GmFeature; milestone?: string; area?: string; tight?: boolean; also?: string[]; fresh?: string; serves?: string; onOpen: (f: GmFeature) => void }) {
  // In a milestone's cell: what it is expected to do for that milestone, and what it did.
  const link = all.links.find((l) => l.milestone === milestone);
  const f = link ? { ...all, expected: link.expected, confidence: link.confidence, measured: link.measured, lift: link.lift } : all;
  const code = useContext(Codes).get(all.id);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open ${f.name}`}
      onClick={() => onOpen(all)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(all);
        }
      }}
      data-testid="gm-feature"
      data-feature={f.id}
      data-fresh={fresh ? "1" : undefined}
      className={`flex cursor-pointer flex-col gap-1 rounded-xl border border-line bg-surface hover:border-line-strong ${tight ? "px-2.5 py-1.5" : "px-3 py-2"} ${f.lift === "not_helping" ? "border-crit/50" : ""} ${fresh ? "border-accent! ring-2 ring-accent/40" : ""}`}>
      <span className={`font-semibold ${tight ? "text-[16px] leading-6" : ""}`}>
        {code && <span className="simple-code mr-1.5">{code}</span>}
        {f.name}
      </span>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <LiftPill l={f.lift} />
        <span className="simple-small text-[14px]! leading-5">
          {area ? `${area} · ` : ""}{f.expected ? `Expects ${lower(f.expected)}` : "No expected lift yet"} ({f.confidence.toLowerCase()} confidence)
          {f.measured ? ` · measured ${f.measured}` : f.released ? " · out, no reading yet" : " · not out yet"}
        </span>
      </span>
      {!!also?.length && (
        <span className="text-[14px] leading-5 text-text2">
          {serves} {also.map((n, i) => (
            <span key={n}>
              {i ? " and " : ""}
              <b className={n === fresh ? "rounded bg-accent-soft px-1 text-accent-ink" : "font-semibold"}>{n}</b>
              {n === fresh ? <span className="font-semibold text-accent-ink"> (new)</span> : null}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

/** A feature already drawn under another milestone: a small pointer, not a second card. */
function AlsoHere({ f, under, onOpen }: { f: GmFeature; under: string; onOpen: (f: GmFeature) => void }) {
  return (
    <button type="button" data-testid="gm-feature-also" onClick={() => onOpen(f)} className="rounded-xl border border-dashed border-line-strong px-2.5 py-1 text-left text-[14px] leading-5 text-text2 hover:bg-surface2">
      <b className="text-text">{f.name}</b> also serves this; its card is under {under}
    </button>
  );
}

/** For each feature, the milestone whose place draws its card: the first it serves in the order shown. */
function homes(order: string[], features: GmFeature[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of features) out[f.id] = [...f.milestones].sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
  return out;
}
const msName = (map: GoalMap, id: string) => map.milestones.find((m) => m.id === id)?.name ?? "";

/** After an edit, brings what changed into view. */
function reveal(sel: string, block: ScrollLogicalPosition = "center") {
  setTimeout(() => document.querySelector(sel)?.scrollIntoView({ block, inline: "nearest" }), 50);
}

const lower = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);

function goalWarning(map: GoalMap, goal: GmGoal, target: string): string {
  const ms = map.milestones.filter((m) => m.goal === goal.id).filter((m) => m.threshold !== null).sort((a, b) => b.threshold! - a.threshold!);
  const top = ms[0];
  const words = `${num(goal.target, goal.unit)} → ${num(Number(target), goal.unit)}: its ${ms.length} milestones keep their own thresholds.`;
  return top && top.threshold! < Number(target) ? `${words} The highest, “${top.name}”, would now stop short of the goal.` : words;
}

function depth(ms: GmMilestone[]): Record<string, number> {
  const by = Object.fromEntries(ms.map((m) => [m.id, m]));
  const memo: Record<string, number> = {};
  const d = (id: string): number => {
    if (memo[id] !== undefined) return memo[id];
    const m = by[id];
    memo[id] = !m || !m.depends.length ? 0 : 1 + Math.max(...m.depends.map(d));
    return memo[id];
  };
  ms.forEach((m) => d(m.id));
  return memo;
}

/* ---------- The edit drawers ---------- */

function Drawer({ title, onClose, children, testId }: { title: string; onClose: () => void; children: ReactNode; testId: string }) {
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/20 max-[600px]:items-end">
      <div role="dialog" aria-label={title} data-testid={testId} className="simple-card m-3 w-[460px] max-w-[calc(100vw-24px)] overflow-y-auto max-[600px]:m-0 max-[600px]:max-h-[85vh] max-[600px]:w-full max-[600px]:max-w-full max-[600px]:rounded-b-none">
        <div className="flex items-center justify-between gap-2">
          <h2 className="simple-h2">{title}</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="rounded-full p-1 hover:bg-surface2">
            <Icon name="x" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const field = "w-full rounded-xl border border-line-strong bg-surface px-3 py-2 text-[17px]";

function AreaPicks({ areas, picked, toggle }: { areas: GmArea[]; picked: string[]; toggle: (id: string) => void }) {
  return (
    <span className="flex flex-wrap gap-2">
      {areas.map((a, i) => (
        <label key={a.id} className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-[15px] ${picked.includes(a.id) ? "border-accent bg-accent font-semibold text-on-accent" : "border-line-strong"}`}>
          <input type="checkbox" className="sr-only" checked={picked.includes(a.id)} onChange={() => toggle(a.id)} />
          {picked.includes(a.id) && <Icon name="check" size={16} />}
          {i + 1}. {a.name}
        </label>
      ))}
    </span>
  );
}

interface Draft {
  name: string;
  goal: string;
  threshold: string;
  areas: string[];
  after: string;
  target: string;
  feature: string;
  search: string;
  milestone: string;
  areaName: string;
  /** The area of the cell a feature is attached from. */
  area: string;
  expected: string;
  confirm: boolean;
}

/** A proposed milestone starts with nothing before it (gm1-a-open): "Nothing: it can start now". */
function emptyDraft(map: GoalMap): Draft {
  return { name: "", goal: map.goals[0]?.id ?? "", threshold: "", areas: [], after: "", target: "", feature: "", search: "", milestone: "", areaName: "", area: "", expected: "", confirm: false };
}

/* ---------- The page ---------- */
/* ---------- The page ---------- */

export function GoalMapPage() {
  const q = useQuery("simple-goal-map", () => unwrap(api.GET("/v1/simple/goal-map")));
  const canPrd = useCanStartPrd();
  const [edit, setEdit] = useState<Edit>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [goalId, setGoalId] = useState("");
  const [flash, setFlash] = useState<string | null>(null);
  const [panel, setPanel] = useState<GmFeature | null>(null);
  const [prd, setPrd] = useState<{ name: string; problem: string } | null>(null);
  const map = q.data;
  // Read after the map: its features are roadmap items once the map is read.
  const roadmap = useQuery(`simple-roadmap:goal-map-codes:${map ? 1 : 0}`, () => (map ? unwrap(api.GET("/v1/simple/roadmap", { params: { query: {} } })) : Promise.resolve(null)));
  const codes = useMemo(() => new Map((roadmap.data?.items ?? []).flatMap((i) => (i.code ? [[i.id, i.code] as [string, string]] : []))), [roadmap.data]);

  if (!map) return <div className="simple-page" role="status">{q.error ? errorMessage(q.error) : "Loading the goal map…"}</div>;

  const open = (e: Edit, goal?: string, milestone?: string, area?: string) => {
    if (goal) setGoalId(goal);
    setFlash(null);
    setEdit(e);
    const m = map.milestones.find((x) => x.id === milestone);
    const gate = e === "gate" && m ? { threshold: m.threshold === null ? "" : String(m.threshold), after: m.depends[0] ?? "" } : {};
    setDraft({ ...emptyDraft(map), milestone: milestone ?? "", area: area ?? "", ...gate });
  };
  const close = () => {
    setEdit(null);
    setDraft(null);
  };
  /** Sends one edit; the answer is the map as it now reads. */
  const send = async (call: Promise<{ data?: GoalMap; error?: unknown; response: Response }>, words: (next: GoalMap) => string | null) => {
    try {
      const next = await unwrap(call);
      q.setData(() => next);
      setFlash(words(next));
      return true;
    } catch (e) {
      setFlash(errorMessage(e));
      return false;
    }
  };
  const moveArea = (id: string, dir: -1 | 1) => {
    const ids = map.areas.map((a) => a.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    const by = new Map(map.areas.map((a) => [a.id, a]));
    q.setData((m) => (m ? { ...m, areas: ids.map((x) => by.get(x)!) } : m));
    void send(api.PUT("/v1/simple/goal-map/areas/order", { body: { ids } }), () => null);
  };

  const save = async () => {
    if (!draft) return;
    if (edit === "propose") {
      const ok = await send(
        api.POST("/v1/simple/goal-map/milestones", { body: { name: draft.name, goal: draft.goal, threshold: Number(draft.threshold), areas: draft.areas, after: draft.after || null } }),
        () => `Proposed: ${draft.name}.${map.approver ? ` Sent to ${map.approver} to approve.` : ""}`,
      );
      if (!ok) return;
      reveal('[data-proposed="1"]');
    }
    if (edit === "goal") {
      const g = map.goals.find((x) => x.id === goalId)!;
      const t = Number(draft.target);
      const next = map.goals.find((x) => x.builds_on.includes(g.id));
      const top = next && map.goals.find((x) => x.builds_on.includes(next.id));
      const money = [next, top].find((x) => x?.unit === "$");
      const ok = await send(api.PATCH("/v1/simple/goal-map/goals/{goal_id}", { params: { path: { goal_id: goalId } }, body: { target: t } }), () =>
        money && next?.unit !== "$" && map.reps && t
          ? `Goal saved; its history keeps ${num(g.target, g.unit)}. ${money.name.split(" ")[0]} still aims at ${num(money.target, "$")} a day: ${map.reps} reps × ${t} × $${Math.round(money.target / (map.reps * t))} a conversion.`
          : `Goal saved; its history keeps ${num(g.target, g.unit)}.`,
      );
      if (!ok) return;
      reveal(`[data-goal="${goalId}"]`, "start");
    }
    if (edit === "attach") {
      const m = map.milestones.find((x) => x.id === draft.milestone);
      const ok = await send(
        api.POST("/v1/simple/goal-map/links", { body: { feature: draft.feature, milestone: draft.milestone, area: draft.area, expected: draft.expected, confidence: "medium" } }),
        (next) => `Attached: ${next.features.find((x) => x.id === draft.feature)?.name} now also serves ${m?.name}.`,
      );
      if (!ok) return;
      reveal(`[data-feature="${draft.feature}"]`);
    }
    if (edit === "gate") {
      const m = map.milestones.find((x) => x.id === draft.milestone)!;
      const ok = await send(
        api.PATCH("/v1/simple/goal-map/milestones/{milestone_id}", { params: { path: { milestone_id: m.id } }, body: { threshold: Number(draft.threshold), after: draft.after || null, confirm: draft.confirm } }),
        () => (draft.confirm ? `Gate confirmed: ${m.name}, at least ${num(Number(draft.threshold), m.unit)} for 7 days.` : `Gate saved: ${m.name}, at least ${num(Number(draft.threshold), m.unit)} for 7 days.`),
      );
      if (!ok) return;
    }
    if (edit === "prd") {
      const m = map.milestones.find((x) => x.id === draft.milestone)!;
      const goal = map.goals.find((g) => g.id === m.goal);
      const areas = map.areas.filter((a) => draft.areas.includes(a.id)).map((a) => a.name);
      const g = map.guardrail;
      setPrd({
        name: m.name,
        problem: `Reach ${m.name} (${goal?.name.toLowerCase() ?? m.measure}, ${m.threshold === null ? "no gate yet" : `at least ${num(m.threshold, m.unit)}, held 7 days in a row`}; now ${num(m.current, m.unit)}). Areas: ${areas.join(", ")}.${g ? ` Guardrail: ${g.name.toLowerCase()} ${g.rule}.` : ""}`,
      });
    }
    if (edit === "area") {
      const ok = await send(api.POST("/v1/simple/goal-map/areas", { body: { name: draft.areaName, lever: "" } }), () => `Area added: ${draft.areaName}. It shows last; move it to change the order.`);
      if (!ok) return;
    }
    close();
  };

  const ctx: Ctx = { map, open, moveArea, onOpen: setPanel, week: weekOf(map.today) };

  return (
    <Codes.Provider value={codes}>
    <div className="simple-page" data-testid="gm-page" style={{ maxWidth: "none" }}>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="simple-h1 max-[600px]:sr-only">Goal map</h1>
          <p className="simple-small">Goals, areas, milestones and features. Updated daily · {map.today}.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {map.can_edit && (
            <Btn testId="gm-propose" onClick={() => open("propose")}>
              <Icon name="plus" size={16} /> Propose a milestone
            </Btn>
          )}
          {canPrd && (
            <Btn testId="gm-new-prd" primary onClick={() => open("prd")}>
              New PRD from a milestone
            </Btn>
          )}
        </div>
      </header>
      {flash && (
        <p role="status" data-testid="gm-flash" className="fixed bottom-6 left-1/2 z-30 w-max max-w-[min(720px,calc(100vw-32px))] -translate-x-1/2 rounded-2xl border border-accent bg-accent-soft px-4 py-2.5 font-semibold text-accent-ink shadow-lg max-[600px]:bottom-24">
          {flash}
        </p>
      )}
      <Ladder {...ctx} />

      {edit && draft && (
        <Editor map={map} edit={edit} draft={draft} setDraft={setDraft} goal={map.goals.find((g) => g.id === goalId) ?? map.goals[0]} onClose={close} onSave={() => void save()} />
      )}
      {panel && <FeaturePanel id={panel.id} code={codes.get(panel.id)} name={panel.name} onClose={() => setPanel(null)} />}
      {prd && (
        <NewPrdSheet
          prefill={prd}
          onClose={() => {
            setPrd(null);
            close();
          }}
          onStarted={() => setFlash(`New PRD started: “${prd.name}”.`)}
        />
      )}
    </div>
    </Codes.Provider>
  );
}

interface Ctx {
  map: GoalMap;
  open: (e: Edit, goal?: string, milestone?: string, area?: string) => void;
  moveArea: (id: string, dir: -1 | 1) => void;
  onOpen: (f: GmFeature) => void;
  week: string[];
}

/** Attach any roadmap item you can see to a milestone, filed under the cell's area. */
function AttachDrawer({ map, draft, set, onClose, onSave }: { map: GoalMap; draft: Draft; set: (k: Partial<Draft>) => void; onClose: () => void; onSave: () => void }) {
  const roadmap = useQuery("simple-roadmap:goal-map", () => unwrap(api.GET("/v1/simple/roadmap", { params: { query: {} } })));
  const label = "flex flex-col gap-1.5 font-semibold";
  const on = new Map(map.features.map((f) => [f.id, f]));
  const term = draft.search.toLowerCase();
  const named = (roadmap.data?.items ?? []).map((i) => ({ id: i.id, name: on.get(i.id)?.name ?? i.title }));
  const list = named.filter((i) => !on.get(i.id)?.milestones.includes(draft.milestone) && (!term || i.name.toLowerCase().includes(term)));
  // A feature sits in one area: attached from another area's cell, it moves there.
  const picked = on.get(draft.feature);
  const areaName = (id: string | null) => map.areas.find((a) => a.id === id)?.name;
  const from = areaName(picked?.area ?? null);
  const to = areaName(draft.area);
  const moves = !!picked && !!from && !!to && picked.area !== draft.area;
  return (
    <Drawer title="Attach a feature to a milestone" onClose={onClose} testId="gm-editor">
      <label className={label}>
        Milestone
        <select className={field} value={draft.milestone} onChange={(e) => set({ milestone: e.target.value })}>
          <option value="">Pick a milestone</option>
          {map.milestones.map((m) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </select>
      </label>
      <label className={label}>
        Area
        <select className={field} value={draft.area} onChange={(e) => set({ area: e.target.value })}>
          <option value="">Pick an area</option>
          {map.areas.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
      </label>
      <label className={label}>
        Feature
        <input className={field} value={draft.search} placeholder="Search the roadmap" onChange={(e) => set({ search: e.target.value })} />
      </label>
      {moves && (
        <p data-testid="gm-attach-moves" className="rounded-xl bg-warn-bg px-3 py-2 text-[15px] text-warn">
          {picked!.name} is filed under {from}: attached here, it moves to {to}.
        </p>
      )}
      <ul className="flex max-h-72 flex-col gap-1.5 overflow-y-auto" data-testid="gm-attach-list">
        {!roadmap.data && <li className="simple-small">{roadmap.error ? errorMessage(roadmap.error) : "Loading the roadmap…"}</li>}
        {roadmap.data && !list.length && <li className="simple-small">No roadmap feature left to attach</li>}
        {list.map((i) => {
          const f = on.get(i.id);
          return (
            <li key={i.id}>
              <button type="button" onClick={() => set({ feature: i.id })} className={`w-full rounded-xl border px-3 py-2 text-left ${draft.feature === i.id ? "border-accent bg-accent-soft" : "border-line"}`}>
                <span className="font-semibold">{i.name}</span>
                <span className="simple-small block text-[14px]! leading-5">
                  {f ? `${map.areas.find((a) => a.id === f.area)?.name ?? "No area"} · serves ${f.milestones.map((x) => msName(map, x)).join(", ")}` : "Not on the map yet"}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <label className={label}>
        Expected lift here
        <input className={field} value={draft.expected} placeholder="For example +5 a day" onChange={(e) => set({ expected: e.target.value })} />
      </label>
      <div className="flex justify-end gap-2">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn primary testId="gm-save" disabled={!draft.feature || !draft.milestone || !draft.area} onClick={onSave}>Attach</Btn>
      </div>
    </Drawer>
  );
}

function Editor({ map, edit, draft, setDraft, goal, onClose, onSave }: { map: GoalMap; edit: Edit; draft: Draft; setDraft: (d: Draft) => void; goal: GmGoal; onClose: () => void; onSave: () => void }) {
  const set = (k: Partial<Draft>) => setDraft({ ...draft, ...k });
  const toggle = (id: string) => set({ areas: draft.areas.includes(id) ? draft.areas.filter((a) => a !== id) : [...draft.areas, id] });
  const label = "flex flex-col gap-1.5 font-semibold";
  if (edit === "propose")
    return (
      <Drawer title="Propose a milestone" onClose={onClose} testId="gm-editor">
        <label className={label}>
          Name
          <input className={field} value={draft.name} placeholder="For example: 40 sign-ups per rep" onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label className={label}>
          Goal it moves
          <select className={field} value={draft.goal} onChange={(e) => set({ goal: e.target.value })}>
            {map.goals.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
        </label>
        <label className={label}>
          Met when the reading is at least
          <input className={field} value={draft.threshold} inputMode="decimal" placeholder="40" onChange={(e) => set({ threshold: e.target.value })} />
          <span className="simple-small font-normal">Held 7 days in a row on at least one live rep, with the guardrail held.</span>
        </label>
        <span className={label}>
          Areas it pulls
          <AreaPicks areas={map.areas} picked={draft.areas} toggle={toggle} />
        </span>
        <label className={label}>
          Comes after
          <select className={field} data-testid="gm-after" value={draft.after} onChange={(e) => set({ after: e.target.value })}>
            <option value="">Nothing: it can start now</option>
            {map.milestones.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </label>
        <div className="flex justify-end gap-2">
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn primary testId="gm-save" disabled={!draft.name || !draft.threshold} onClick={onSave}>Propose</Btn>
        </div>
      </Drawer>
    );
  if (edit === "goal")
    return (
      <Drawer title={`Edit goal: ${goal.name}`} onClose={onClose} testId="gm-editor">
        <p className="simple-small">Now {num(goal.current, goal.unit)} a day, target {num(goal.target, goal.unit)}. {goal.math}.</p>
        <label className={label}>
          New target (at least, every day)
          <input className={field} value={draft.target} placeholder="Type a number" onChange={(e) => set({ target: e.target.value })} />
        </label>
        {draft.target && (
          <p className="rounded-xl bg-warn-bg px-3 py-2 text-[15px] text-warn">
            {goalWarning(map, goal, draft.target)}
          </p>
        )}
        <div className="flex flex-col gap-1">
          <span className="font-semibold">History</span>
          <ul className="flex flex-col gap-1">
            {goal.history.map((h, i) => (
              <li key={i} className="simple-small flex justify-between gap-3">
                <span>{h.text}</span>
                <span className="whitespace-nowrap">{h.date} · {h.by}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex justify-end gap-2">
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn primary testId="gm-save" disabled={!draft.target} onClick={onSave}>Save goal</Btn>
        </div>
      </Drawer>
    );
  if (edit === "attach") return <AttachDrawer map={map} draft={draft} set={set} onClose={onClose} onSave={onSave} />;
  if (edit === "gate") {
    const m = map.milestones.find((x) => x.id === draft.milestone);
    if (!m) return null;
    return (
      <Drawer title={`The gate of ${m.name}`} onClose={onClose} testId="gm-editor">
        <p className="simple-small">
          Met when {m.measure} holds this for 7 days in a row. Now {num(m.current, m.unit)}.
        </p>
        <label className={label}>
          At least
          <input className={field} inputMode="decimal" value={draft.threshold} onChange={(e) => set({ threshold: e.target.value })} />
        </label>
        <label className={label}>
          Comes after
          <select className={field} data-testid="gm-after" value={draft.after} onChange={(e) => set({ after: e.target.value })}>
            <option value="">Nothing: it can start now</option>
            {map.milestones.filter((x) => x.id !== m.id).map((x) => (
              <option key={x.id} value={x.id}>{x.name}</option>
            ))}
          </select>
        </label>
        {m.proposed || !m.confirmed ? (
          <label className="flex items-center gap-2 font-semibold">
            <input type="checkbox" checked={draft.confirm} onChange={(e) => set({ confirm: e.target.checked })} /> Confirm this gate
          </label>
        ) : (
          <p className="simple-small">Confirmed by {m.confirmed}{m.confirmed_on ? `, ${m.confirmed_on}` : ""}.</p>
        )}
        <div className="flex justify-end gap-2">
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn primary testId="gm-save" disabled={!(Number(draft.threshold) > 0)} onClick={onSave}>Save gate</Btn>
        </div>
      </Drawer>
    );
  }
  if (edit === "prd")
    return (
      <Drawer title="New PRD from a milestone" onClose={onClose} testId="gm-editor">
        <label className={label}>
          Milestone
          <select className={field} value={draft.milestone} onChange={(e) => set({ milestone: e.target.value })}>
            <option value="">Pick a milestone</option>
            {map.milestones.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </label>
        <span className={label}>
          Areas
          <AreaPicks areas={map.areas} picked={draft.areas} toggle={toggle} />
        </span>
        {draft.milestone && (
          <p className="simple-small rounded-xl bg-surface2 px-3 py-2">
            The PRD starts with this milestone&apos;s measure and threshold{map.guardrail ? `, the guardrail (${map.guardrail.name.toLowerCase()} ${map.guardrail.rule})` : ""} and the
            {" "}{map.features.filter((f) => f.milestones.includes(draft.milestone)).length} features already serving it.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn primary testId="gm-save" disabled={!draft.milestone || !draft.areas.length} onClick={onSave}>Start the PRD</Btn>
        </div>
      </Drawer>
    );
  return (
    <Drawer title="Add an area of focus" onClose={onClose} testId="gm-editor">
      <label className={label}>
        Name
        <input className={field} value={draft.areaName} placeholder="For example: Rep hiring" onChange={(e) => set({ areaName: e.target.value })} />
      </label>
      <p className="simple-small">It goes last; move it up or down after. Every view keeps your order.</p>
      <div className="flex justify-end gap-2">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn primary testId="gm-save" disabled={!draft.areaName} onClick={onSave}>Add area</Btn>
      </div>
    </Drawer>
  );
}

/* ---------- Shared pieces of the proposals ---------- */

function GoalCard({ g, onEdit, goals, canEdit }: { g: GmGoal; onEdit: () => void; goals: GmGoal[]; canEdit: boolean }) {
  return (
    <div data-testid="gm-goal" data-goal={g.id} className="simple-card flex-1 gap-1.5! px-4! py-3!">
      <span className="flex items-start justify-between gap-2">
        <span className="font-semibold leading-6">{g.name}</span>
        <StatusPill s={g.status} />
      </span>
      <span className="flex items-baseline gap-2">
        <span className="simple-number text-[26px]! leading-8!">{num(g.current, g.unit)}</span>
        <span className="text-text2">of {num(g.target, g.unit)} a day</span>
        <span className="ml-auto">
          {canEdit && <Btn small testId="gm-edit-goal" onClick={onEdit}>Edit</Btn>}
        </span>
      </span>
      <Bar current={g.current} target={g.target} status={g.status} />
      <span className="simple-small text-[14px]! leading-5">
        {g.builds_on.length ? `Builds on ${goals.find((x) => x.id === g.builds_on[0])?.name.toLowerCase()}: ` : ""}
        {g.math}
      </span>
    </div>
  );
}

/** The goal cards' widths as the picked frame draws them: the last (the top goal) widest. */
const GOAL_GROW = [1.04, 1, 1.3];

function Goals({ map, open, arrows = true }: Ctx & { arrows?: boolean }) {
  return (
    <div className="flex items-stretch gap-2 max-[600px]:flex-col">
      {map.goals.map((g, i) => (
        <div key={g.id} className="flex flex-1 items-stretch gap-2 max-[600px]:flex-col" style={{ flexGrow: GOAL_GROW[i] ?? 1 }}>
          <GoalCard g={g} goals={map.goals} canEdit={map.can_edit} onEdit={() => open("goal", g.id)} />
          {arrows && i < map.goals.length - 1 && (
            <span className="self-center text-[24px] font-bold text-text-faint max-[600px]:rotate-90" aria-label="builds on">→</span>
          )}
        </div>
      ))}
    </div>
  );
}

function sortMs(map: GoalMap): GmMilestone[] {
  const d = depth(map.milestones);
  const order = ["Oct", "Nov", "Dec", "Jan", "Feb"];
  return [...map.milestones].sort((a, b) => d[a.id] - d[b.id] || order.indexOf(a.month) - order.indexOf(b.month) || a.goal.localeCompare(b.goal) || (a.threshold ?? 0) - (b.threshold ?? 0));
}

function afterWords(m: GmMilestone, map: GoalMap): string {
  if (!m.depends.length) return "Starts now";
  return `After ${m.depends.map((id) => map.milestones.find((x) => x.id === id)?.name).join(" and ")}`;
}

function Ladder(ctx: Ctx) {
  const { map, open, moveArea } = ctx;
  const ms = sortMs(map);
  const d = depth(map.milestones);
  const home = homes(ms.map((m) => m.id), map.features);
  return (
    <>
      <Goals {...ctx} />
      <Guardrail map={map} />
      <div className="max-[600px]:hidden!">
        <section className="simple-card gap-0! p-0!" data-testid="gm-ladder" aria-label="Milestones by area">
          <div className="flex flex-col gap-1 px-5 py-3" data-testid="gm-ladder-head">
            <span className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="simple-h2">Milestones by area</h2>
              <span className="simple-small">Left to right in steps: a milestone needs the ones it comes after.</span>
            </span>
            {ms.length > 3 && <span data-testid="gm-step-hint" className="simple-small font-semibold">3 of {ms.length} steps shown at a time · scroll sideways for the rest →</span>}
          </div>
          <div className="relative border-t border-line">
            <div data-testid="gm-ladder-scroll" className="snap-x snap-mandatory overflow-x-auto scroll-pl-[200px] [container-type:inline-size]">
              <div className="grid w-max min-w-full" style={{ gridTemplateColumns: `200px repeat(${ms.length}, max(248px, calc((100cqw - 200px) / 3)))` }}>
                <div className="sticky left-0 z-10 border-b border-r border-line bg-surface px-3 py-2">
                  {map.can_edit && (
                    <Btn small testId="gm-add-area" onClick={() => open("area")}>
                      <Icon name="plus" size={16} /> Add an area
                    </Btn>
                  )}
                </div>
                {ms.map((m) => (
                  <div
                    key={m.id}
                    data-testid="gm-gate"
                    data-gate={m.id}
                    data-proposed={m.proposed ? "1" : undefined}
                    className={`flex snap-start flex-col gap-1.5 border-b border-r border-line px-3 py-2.5 ${m.proposed ? "border-2 border-dashed border-accent! bg-accent-soft" : m.status === "missed" ? "bg-crit-bg" : ""}`}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-[14px] font-semibold uppercase tracking-wide text-text2">
                        Step {d[m.id] + 1} · due {m.month}
                      </span>
                      {m.proposed ? <Pill cls="bg-surface text-accent-ink border border-accent">Proposed</Pill> : <StatusPill s={m.status} />}
                    </span>
                    {map.can_edit ? (
                      <button type="button" data-testid="gm-edit-gate" title={m.proposed ? "Set and confirm the gate" : "Edit the gate"} onClick={() => open("gate", undefined, m.id)} className="text-left text-[17px] font-semibold leading-6 hover:underline">
                        {m.name}
                      </button>
                    ) : (
                      <span className="text-[17px] font-semibold leading-6">{m.name}</span>
                    )}
                    <span className="text-[16px] leading-6 text-text2">
                      {m.threshold === null ? `${num(m.current, m.unit)} now · no gate yet` : `${num(m.current, m.unit)} of ${num(m.threshold, m.unit)}`} · {afterWords(m, map)}
                    </span>
                    <Proof m={m} compact week={ctx.week} />
                  </div>
                ))}
                {map.areas.map((a, ai) => (
                  <LadderRow key={a.id} a={a} ai={ai} n={map.areas.length} ms={ms} map={map} open={open} moveArea={moveArea} onOpen={ctx.onOpen} home={home} proposed={ms.find((m) => m.proposed)?.id} />
                ))}
              </div>
            </div>
          </div>
        </section>
      </div>
      <LadderPhone {...ctx} ms={ms} home={home} />
    </>
  );
}

function LadderRow({ a, ai, n, ms, map, open, moveArea, onOpen, home, proposed }: { a: GmArea; ai: number; n: number; ms: GmMilestone[]; map: GoalMap; open: Ctx["open"]; moveArea: Ctx["moveArea"]; onOpen: Ctx["onOpen"]; home: Record<string, string>; proposed?: string }) {
  return (
    <>
      <div className="sticky left-0 z-10 flex flex-col gap-1 border-b border-r border-line bg-surface px-3 py-2.5" data-testid="gm-lane">
        <span className="font-semibold leading-6">
          {ai + 1}. {a.name}
        </span>
        <span className="simple-small text-[14px]! leading-5">Pulls: {a.lever.toLowerCase()}</span>
        {map.can_edit && (
        <span className="flex gap-1">
          <button type="button" disabled={ai === 0} aria-label={`Move ${a.name} up`} onClick={() => moveArea(a.id, -1)} className="rounded-md border border-line px-1.5 text-[14px] disabled:opacity-40">↑</button>
          <button type="button" disabled={ai === n - 1} aria-label={`Move ${a.name} down`} onClick={() => moveArea(a.id, 1)} className="rounded-md border border-line px-1.5 text-[14px] disabled:opacity-40">↓</button>
        </span>
        )}
      </div>
      {ms.map((m) => {
        const fs = map.features.filter((f) => f.area === a.id && f.milestones.includes(m.id));
        const serves = m.areas.includes(a.id);
        return (
          <div key={m.id} className={`flex flex-col gap-1.5 border-b border-r border-line p-2 ${serves ? "bg-surface2/60" : ""} ${m.id === proposed ? "border-x-2 border-dashed border-x-accent" : ""}`}>
            {fs.map((f) =>
              home[f.id] === m.id ? (
                <FeatureCard key={f.id} f={f} milestone={m.id} tight onOpen={onOpen} also={f.milestones.filter((x) => x !== m.id).map((x) => msName(map, x))} />
              ) : (
                <AlsoHere key={f.id} f={f} onOpen={onOpen} under={msName(map, home[f.id])} />
              ),
            )}
            {serves && !fs.length && <span className="simple-small text-[14px]! leading-5 px-1">No feature yet</span>}
            {serves && map.can_edit && (
              <button type="button" data-testid="gm-attach" onClick={() => open("attach", undefined, m.id, a.id)} className="self-start rounded-full px-1.5 text-[14px] font-semibold text-accent-ink hover:underline">
                + Attach a feature
              </button>
            )}
          </div>
        );
      })}
    </>
  );
}

function LadderPhone({ map, ms, home, onOpen, week }: Ctx & { ms: GmMilestone[]; home: Record<string, string> }) {
  return (
    <section className="hidden flex-col gap-3 pb-24 max-[600px]:flex" data-testid="gm-ladder-phone">
      <h2 className="simple-h2">Milestones, in steps</h2>
      {ms.map((m) => (
        <div key={m.id} className="simple-card gap-2!">
          <span className="flex items-center justify-between gap-2">
            <span className="font-semibold">{m.name}</span>
            <StatusPill s={m.status} />
          </span>
          <span className="simple-small">
            {m.threshold === null ? `${num(m.current, m.unit)} now · no gate yet` : `${num(m.current, m.unit)} of ${num(m.threshold, m.unit)}`} · {afterWords(m, map)}
          </span>
          <Proof m={m} compact week={week} />
          {map.areas
            .filter((a) => m.areas.includes(a.id))
            .map((a) => (
              <div key={a.id} className="flex flex-col gap-1.5 border-t border-line pt-2">
                <span className="text-[14px] font-semibold text-text2">{map.areas.indexOf(a) + 1}. {a.name}</span>
                {map.features
                  .filter((f) => f.area === a.id && f.milestones.includes(m.id))
                  .map((f) =>
                    home[f.id] === m.id ? (
                      <FeatureCard key={f.id} f={f} milestone={m.id} tight onOpen={onOpen} also={f.milestones.filter((x) => x !== m.id).map((x) => msName(map, x))} />
                    ) : (
                      <AlsoHere key={f.id} f={f} onOpen={onOpen} under={msName(map, home[f.id])} />
                    ),
                  )}
              </div>
            ))}
        </div>
      ))}
    </section>
  );
}
