"use client";

/**
 * MOCK-HOOK (GM1 mock-ups, never merged): the goal map. Company goals, areas of focus in the
 * owner's order, KPI milestones with their proof, and the features serving them, in one view.
 * Four proposals behind ?gm1=a|b|c|d; state switches: &data=hard, &open=<edit>, &phase=mid.
 * Edits are kept in the page's own state (the mock has no write route for them).
 */
import { useSearchParams } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { Icon } from "@/components/ds/Icon";
import { mockFetch } from "@/lib/api/mock/server";
import type { GmArea, GmFeature, GmGoal, GmLift, GmMilestone, GmStatus, GoalMap } from "@/lib/api/mock/goal-map";

type Edit = "propose" | "goal" | "attach" | "prd" | "area" | null;

const DAYS = ["Oct 28", "Oct 29", "Oct 30", "Oct 31", "Nov 1", "Nov 2", "Nov 3"];

const STATUS: Record<GmStatus, { label: string; cls: string }> = {
  met: { label: "Met", cls: "bg-pass-bg text-pass" },
  on_track: { label: "On track", cls: "bg-accent-soft text-accent-ink" },
  at_risk: { label: "At risk", cls: "bg-warn-bg text-warn" },
  missed: { label: "Missed", cls: "bg-crit-bg text-crit" },
  not_measured: { label: "Not measured yet", cls: "bg-na-bg text-na" },
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
function Proof({ m, compact }: { m: GmMilestone; compact?: boolean }) {
  const ok = (v: number | null) => v !== null && (m.measure.startsWith("days") ? v === 0 : v >= m.threshold);
  return (
    <span className="flex min-w-0 max-w-full flex-col gap-1">
      <span className={`flex w-full gap-1 ${compact ? "" : "flex-wrap"}`} aria-label="Last 7 days">
        {m.days.map((v, i) => (
          <span
            key={i}
            title={`${DAYS[i]}: ${v === null ? "not measured" : num(v, m.unit)}`}
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
          ? `Held 7 days in a row on a live rep · confirmed by ${m.confirmed}, Nov 2`
          : m.status === "not_measured"
            ? "No daily reading yet"
            : m.status === "missed"
              ? "Due Oct 31 · held 0 of 7 days"
              : `Held ${m.days.filter(ok).length} of 7 days · Oct 28 – Nov 3`}
      </span>
    </span>
  );
}

function Guardrail({ map }: { map: GoalMap }) {
  const g = map.guardrail;
  return (
    <div data-testid="gm-guardrail" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl border border-pass/40 bg-pass-bg px-4 py-2.5">
      <Icon name="lock" size={18} className="text-pass" />
      <span className="font-semibold">Guardrail: {g.name} {g.rule}</span>
      <span className="text-text2">Every milestone must hold it.</span>
      <span className="ml-auto font-semibold text-pass">0 today · held 7 of 7 days</span>
    </div>
  );
}

/** Feature line: expected lift and, once released, what it measured. */
function FeatureCard({ f, area, tight, also, fresh, serves = "Also serves" }: { f: GmFeature; area?: string; tight?: boolean; also?: string[]; fresh?: string; serves?: string }) {
  return (
    <div data-testid="gm-feature" data-fresh={fresh ? "1" : undefined} className={`flex flex-col gap-1 rounded-xl border border-line bg-surface ${tight ? "px-2.5 py-1.5" : "px-3 py-2"} ${f.lift === "not_helping" ? "border-crit/50" : ""} ${fresh ? "border-accent! ring-2 ring-accent/40" : ""}`}>
      <span className={`font-semibold ${tight ? "text-[16px] leading-6" : ""}`}>{f.name}</span>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <LiftPill l={f.lift} />
        <span className="simple-small text-[14px]! leading-5">
          {area ? `${area} · ` : ""}Expects {lower(f.expected)} ({f.confidence.toLowerCase()} confidence)
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
function AlsoHere({ f, under }: { f: GmFeature; under: string }) {
  return (
    <span data-testid="gm-feature-also" className="rounded-xl border border-dashed border-line-strong px-2.5 py-1 text-[14px] leading-5 text-text2">
      <b className="text-text">{f.name}</b> also serves this; its card is under {under}
    </span>
  );
}

/** For each feature, the milestone whose place draws its card: the first it serves in the order shown. */
function homes(order: string[], features: GmFeature[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of features) out[f.id] = [...f.milestones].sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
  return out;
}
const msName = (map: GoalMap, id: string) => map.milestones.find((m) => m.id === id)?.name ?? "";

/** After an edit, brings what changed into view (MOCK-HOOK: the frames record the scroll). */
function reveal(sel: string, block: ScrollLogicalPosition = "center") {
  setTimeout(() => document.querySelector(sel)?.scrollIntoView({ block, inline: "nearest" }), 50);
}

const lower = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);

function goalWarning(map: GoalMap, goal: GmGoal, target: string): string {
  const ms = map.milestones.filter((m) => m.goal === goal.id).sort((a, b) => b.threshold - a.threshold);
  const top = ms[0];
  const words = `${num(goal.target, goal.unit)} → ${num(Number(target), goal.unit)}: its ${ms.length} milestones keep their own thresholds.`;
  return top && top.threshold < Number(target) ? `${words} The highest, “${top.name}”, would now stop short of the goal.` : words;
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

function useMap(hard: boolean) {
  const [map, setMap] = useState<GoalMap | null>(null);
  useEffect(() => {
    let alive = true;
    mockFetch(new Request(`${location.origin}/v1/simple/goal-map${hard ? "?data=hard" : ""}`)) // MOCK-HOOK
      .then((r) => r.json())
      .then((m: GoalMap) => alive && setMap(m));
    return () => {
      alive = false;
    };
  }, [hard]);
  return [map, setMap] as const;
}

/* ---------- The edit drawers every proposal shares ---------- */

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
}

function emptyDraft(map: GoalMap, mid: boolean, edit: Edit): Draft {
  const d: Draft = { name: "", goal: "signups", threshold: "", areas: [], after: "", target: "", feature: "", search: "", milestone: "", areaName: "" };
  if (!mid) return d;
  if (edit === "propose") return { ...d, name: "40 sign-ups per rep", goal: "signups", threshold: "40", areas: ["scale", "onboard"], after: "m1" };
  if (edit === "goal") return { ...d, target: "12" };
  if (edit === "attach") return { ...d, search: "trial", feature: "f6", milestone: "m6" };
  if (edit === "prd") return { ...d, milestone: "m4", areas: ["conv", "safety"] };
  if (edit === "area") return { ...d, areaName: "Rep hiring" };
  return d;
}

/* ---------- The page ---------- */

export function GoalMapPage() {
  const q = useSearchParams();
  const variant = (q.get("gm1") ?? "a") as "a" | "b" | "c" | "d"; // MOCK-HOOK
  const hard = q.get("data") === "hard"; // MOCK-HOOK
  const seedOpen = (q.get("open") as Edit) ?? null; // MOCK-HOOK
  const mid = q.get("phase") === "mid"; // MOCK-HOOK
  const seedPick = q.get("pick"); // MOCK-HOOK: the milestone the scoreboard has drilled into
  const [map, setMap] = useMap(hard);
  const [edit, setEdit] = useState<Edit>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [goalId, setGoalId] = useState("conversions");
  const [pick, setPick] = useState<string | null>(seedPick);
  const [started, setStarted] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [linked, setLinked] = useState<{ feature: string; milestone: string } | null>(null);
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    if (map && seedOpen && !seeded) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- MOCK-HOOK: the URL seeds the open edit once
      setSeeded(true);
      setEdit(seedOpen);
      setDraft({ ...emptyDraft(map, mid, seedOpen), ...(!mid && seedPick ? { milestone: seedPick } : {}) });
    }
  }, [map, seedOpen, mid, seeded, seedPick]);

  if (!map) return <div className="simple-page" role="status">Loading the goal map…</div>;

  const open = (e: Edit, goal?: string, milestone?: string) => {
    if (goal) setGoalId(goal);
    setEdit(e);
    setDraft({ ...emptyDraft(map, false, e), milestone: milestone ?? "" });
  };
  const close = () => {
    setEdit(null);
    setDraft(null);
  };
  const moveArea = (id: string, dir: -1 | 1) => {
    const areas = [...map.areas];
    const i = areas.findIndex((a) => a.id === id);
    const j = i + dir;
    if (j < 0 || j >= areas.length) return;
    [areas[i], areas[j]] = [areas[j], areas[i]];
    setMap({ ...map, areas });
  };

  const save = () => {
    if (!draft) return;
    if (edit === "propose") {
      const g = map.goals.find((x) => x.id === draft.goal)!;
      const m: GmMilestone = {
        id: "new",
        name: draft.name,
        goal: draft.goal,
        measure: g.measure,
        threshold: Number(draft.threshold),
        unit: g.unit,
        current: g.current,
        status: "on_track",
        areas: draft.areas,
        depends: draft.after ? [draft.after] : [],
        month: "Nov",
        days: g.current === null ? Array(7).fill(null) : DAYS.map((_, i) => Math.round(((g.current ?? 0) - (6 - i) * 0.6) * 10) / 10),
        confirmed: null,
        proposed: true,
      };
      setMap({ ...map, milestones: [...map.milestones, m] });
      setFlash(`Proposed: ${m.name}. Sent to Dana Whitlock to approve.`);
      reveal('[data-gate="new"]');
    }
    if (edit === "goal") {
      const goals = map.goals.map((g) =>
        g.id === goalId ? { ...g, target: Number(draft.target), history: [{ date: "Nov 3, 2026", text: `Target ${num(g.target, g.unit)} → ${num(Number(draft.target), g.unit)}`, by: "Dana Whitlock" }, ...g.history] } : g,
      );
      setMap({ ...map, goals });
      const g = map.goals.find((x) => x.id === goalId)!;
      const rev = map.goals.find((x) => x.id === "revenue")!;
      const t = Number(draft.target);
      setFlash(
        goalId === "conversions" && rev.target && t
          ? `Goal saved; its history keeps ${num(g.target, g.unit)}. Revenue still aims at ${num(rev.target, "$")} a day: ${map.reps} reps × ${t} × $${Math.round(rev.target / (map.reps * t))} a conversion.`
          : `Goal saved; its history keeps the old target.`,
      );
      reveal(`[data-goal="${goalId}"]`, "start");
    }
    if (edit === "attach") {
      const features = map.features.map((f) => (f.id === draft.feature && !f.milestones.includes(draft.milestone) ? { ...f, milestones: [...f.milestones, draft.milestone] } : f));
      setMap({ ...map, features });
      const f = map.features.find((x) => x.id === draft.feature);
      const m = map.milestones.find((x) => x.id === draft.milestone);
      setLinked({ feature: draft.feature, milestone: draft.milestone });
      setFlash(`Attached: ${f?.name} now also serves ${m?.name}.`);
      reveal("[data-fresh]");
    }
    if (edit === "prd") {
      const m = map.milestones.find((x) => x.id === draft.milestone);
      setStarted(m?.name ?? "");
      setFlash(null);
    }
    if (edit === "area") {
      setMap({ ...map, areas: [...map.areas, { id: "new-area", name: draft.areaName, lever: "Number of reps" }] });
      setFlash(`Area added: ${draft.areaName}. It shows last; move it to change the order.`);
    }
    close();
  };

  const ctx: Ctx = { map, open, moveArea, pick, setPick, started, linked };
  const wide = variant !== "b";

  return (
    <div className="simple-page" data-testid="gm-page" style={wide ? { maxWidth: "none" } : undefined}>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="simple-h1 max-[600px]:sr-only">Goal map</h1>
          <p className="simple-small">Goals, areas, milestones and features. Updated daily · Nov 3.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Btn testId="gm-propose" onClick={() => open("propose")}>
            <Icon name="plus" size={16} /> Propose a milestone
          </Btn>
          <Btn testId="gm-new-prd" primary onClick={() => open("prd")}>
            New PRD from a milestone
          </Btn>
        </div>
      </header>
      {flash && (
        <p role="status" data-testid="gm-flash" className="fixed bottom-6 left-1/2 z-30 w-max max-w-[min(720px,calc(100vw-32px))] -translate-x-1/2 rounded-2xl border border-accent bg-accent-soft px-4 py-2.5 font-semibold text-accent-ink shadow-lg max-[600px]:bottom-24">
          {flash}
        </p>
      )}
      {started && (
        <div role="status" data-testid="gm-started" className="simple-card flex-row! flex-wrap items-center justify-between gap-3">
          <span className="flex flex-col">
            <span className="font-semibold">New PRD started: “{started}”</span>
            <span className="simple-small">Its goal, threshold, guardrail and areas are filled in. Oracle is writing the first draft.</span>
          </span>
          <Btn primary>Open the draft</Btn>
        </div>
      )}
      {variant === "a" && <Ladder {...ctx} />}
      {variant === "b" && <GoalTree {...ctx} />}
      {variant === "c" && <DriverTree {...ctx} />}
      {variant === "d" && <Scoreboard {...ctx} />}

      {edit && draft && (
        <Editor map={map} edit={edit} draft={draft} setDraft={setDraft} goal={map.goals.find((g) => g.id === goalId)!} onClose={close} onSave={save} />
      )}
    </div>
  );
}

interface Ctx {
  map: GoalMap;
  open: (e: Edit, goal?: string, milestone?: string) => void;
  moveArea: (id: string, dir: -1 | 1) => void;
  pick: string | null;
  setPick: (id: string | null) => void;
  started: string | null;
  linked: { feature: string; milestone: string } | null;
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
          <select className={field} value={draft.after} onChange={(e) => set({ after: e.target.value })}>
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
  if (edit === "attach") {
    const list = map.features.filter((f) => !draft.search || f.name.toLowerCase().includes(draft.search.toLowerCase()));
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
          Feature
          <input className={field} value={draft.search} placeholder="Search features" onChange={(e) => set({ search: e.target.value })} />
        </label>
        <ul className="flex max-h-72 flex-col gap-1.5 overflow-y-auto">
          {list.map((f) => (
            <li key={f.id}>
              <button type="button" onClick={() => set({ feature: f.id })} className={`w-full rounded-xl border px-3 py-2 text-left ${draft.feature === f.id ? "border-accent bg-accent-soft" : "border-line"}`}>
                <span className="font-semibold">{f.name}</span>
                <span className="simple-small block text-[14px]! leading-5">
                  {map.areas.find((a) => a.id === f.area)?.name} · expects {lower(f.expected)}{f.lever === "Guardrail" ? "" : ` on ${f.lever.toLowerCase()}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-2">
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn primary testId="gm-save" disabled={!draft.feature || !draft.milestone} onClick={onSave}>Attach</Btn>
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
            The PRD starts with this milestone&apos;s measure and threshold, the guardrail ({map.guardrail.name.toLowerCase()} {map.guardrail.rule}) and the
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

function GoalCard({ g, onEdit, goals }: { g: GmGoal; onEdit: () => void; goals: GmGoal[] }) {
  return (
    <div data-testid="gm-goal" className="simple-card flex-1 gap-1.5! px-4! py-3!">
      <span className="flex items-start justify-between gap-2">
        <span className="font-semibold leading-6">{g.name}</span>
        <StatusPill s={g.status} />
      </span>
      <span className="flex items-baseline gap-2">
        <span className="simple-number text-[26px]! leading-8!">{num(g.current, g.unit)}</span>
        <span className="text-text2">of {num(g.target, g.unit)} a day</span>
        <span className="ml-auto">
          <Btn small testId={`gm-edit-goal-${g.id}`} onClick={onEdit}>Edit</Btn>
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

function Goals({ map, open, arrows = true }: Ctx & { arrows?: boolean }) {
  return (
    <div className="flex items-stretch gap-2 max-[600px]:flex-col">
      {map.goals.map((g, i) => (
        <div key={g.id} className="flex flex-1 items-stretch gap-2 max-[600px]:flex-col">
          <GoalCard g={g} goals={map.goals} onEdit={() => open("goal", g.id)} />
          {arrows && i < map.goals.length - 1 && (
            <span className="self-center text-[24px] font-bold text-text-faint max-[600px]:rotate-90" aria-label="builds on">→</span>
          )}
        </div>
      ))}
    </div>
  );
}

function AreaOrder({ map, open, moveArea }: Ctx) {
  return (
    <div data-testid="gm-areas" className="flex flex-wrap items-center gap-2">
      <span className="font-semibold">Areas, in order:</span>
      {map.areas.map((a, i) => (
        <span key={a.id} className="inline-flex items-center gap-1 rounded-full border border-line bg-surface py-0.5 pl-3 pr-1 text-[15px]">
          {i + 1}. {a.name}
          <button type="button" aria-label={`Move ${a.name} earlier`} onClick={() => moveArea(a.id, -1)} className="rounded-full px-1.5 text-text2 hover:bg-surface2">‹</button>
          <button type="button" aria-label={`Move ${a.name} later`} onClick={() => moveArea(a.id, 1)} className="rounded-full px-1.5 text-text2 hover:bg-surface2">›</button>
        </span>
      ))}
      <Btn small testId="gm-add-area" onClick={() => open("area")}>
        <Icon name="plus" size={16} /> Add an area
      </Btn>
    </div>
  );
}

function sortMs(map: GoalMap): GmMilestone[] {
  const d = depth(map.milestones);
  const order = ["Oct", "Nov", "Dec", "Jan", "Feb"];
  return [...map.milestones].sort((a, b) => d[a.id] - d[b.id] || order.indexOf(a.month) - order.indexOf(b.month) || a.goal.localeCompare(b.goal) || a.threshold - b.threshold);
}

function afterWords(m: GmMilestone, map: GoalMap): string {
  if (!m.depends.length) return "Starts now";
  return `After ${m.depends.map((id) => map.milestones.find((x) => x.id === id)?.name).join(" and ")}`;
}

/* ---------- A · Ladder × lanes ---------- */

/** MOCK-HOOK: `&at=<milestone>` scrolls the grid sideways to that gate and the page down to the gates (the hard case's second frame). */
function useAt(at: string | null) {
  useEffect(() => {
    if (!at) return;
    const t = setTimeout(() => {
      const box = document.querySelector<HTMLElement>('[data-testid="gm-ladder-scroll"]');
      const gate = document.querySelector<HTMLElement>(`[data-gate="${at}"]`);
      if (box && gate) box.scrollLeft = gate.offsetLeft - 200;
      const sec = document.querySelector('[data-testid="gm-ladder"]');
      if (sec) window.scrollTo(0, sec.getBoundingClientRect().top + window.scrollY - 16);
    }, 300);
    return () => clearTimeout(t);
  }, [at]);
}

function Ladder(ctx: Ctx) {
  const { map, open, moveArea } = ctx;
  const ms = sortMs(map);
  const d = depth(map.milestones);
  const home = homes(ms.map((m) => m.id), map.features);
  const at = useSearchParams().get("at"); // MOCK-HOOK
  useAt(at);
  return (
    <>
      <Goals {...ctx} />
      <Guardrail map={map} />
      <div className="max-[600px]:hidden!">
        <section className="simple-card gap-0! p-0!" data-testid="gm-ladder" aria-label="Milestones by area">
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
            <h2 className="simple-h2">Milestones by area</h2>
            <span className="simple-small">Left to right in steps: a milestone needs the ones it comes after.</span>
            {ms.length > 3 && <span className="simple-small font-semibold">3 of {ms.length} steps shown at a time · scroll sideways for the rest →</span>}
          </div>
          <div className="relative border-t border-line">
            <div data-testid="gm-ladder-scroll" className="snap-x snap-mandatory overflow-x-auto scroll-pl-[200px] [container-type:inline-size]">
              <div className="grid w-max min-w-full" style={{ gridTemplateColumns: `200px repeat(${ms.length}, max(248px, calc((100cqw - 200px) / 3)))` }}>
                <div className="sticky left-0 z-10 border-b border-r border-line bg-surface px-3 py-2">
                  <Btn small testId="gm-add-area" onClick={() => open("area")}>
                    <Icon name="plus" size={16} /> Add an area
                  </Btn>
                </div>
                {ms.map((m) => (
                  <div
                    key={m.id}
                    data-testid="gm-gate"
                    data-gate={m.id}
                    className={`flex snap-start flex-col gap-1.5 border-b border-r border-line px-3 py-2.5 ${m.proposed ? "border-2 border-dashed border-accent! bg-accent-soft" : m.status === "missed" ? "bg-crit-bg" : ""}`}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-[14px] font-semibold uppercase tracking-wide text-text2">
                        Step {d[m.id] + 1} · due {m.month}
                      </span>
                      {m.proposed ? <Pill cls="bg-surface text-accent-ink border border-accent">Proposed</Pill> : <StatusPill s={m.status} />}
                    </span>
                    <span className="text-[17px] font-semibold leading-6">{m.name}</span>
                    <span className="text-[16px] leading-6 text-text2">
                      {num(m.current, m.unit)} of {num(m.threshold, m.unit)} · {afterWords(m, map)}
                    </span>
                    <Proof m={m} compact />
                  </div>
                ))}
                {map.areas.map((a, ai) => (
                  <LadderRow key={a.id} a={a} ai={ai} n={map.areas.length} ms={ms} map={map} open={open} moveArea={moveArea} home={home} proposed={ms.find((m) => m.proposed)?.id} />
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

function LadderRow({ a, ai, n, ms, map, open, moveArea, home, proposed }: { a: GmArea; ai: number; n: number; ms: GmMilestone[]; map: GoalMap; open: Ctx["open"]; moveArea: Ctx["moveArea"]; home: Record<string, string>; proposed?: string }) {
  return (
    <>
      <div className="sticky left-0 z-10 flex flex-col gap-1 border-b border-r border-line bg-surface px-3 py-2.5" data-testid="gm-lane">
        <span className="font-semibold leading-6">
          {ai + 1}. {a.name}
        </span>
        <span className="simple-small text-[14px]! leading-5">Pulls: {a.lever.toLowerCase()}</span>
        <span className="flex gap-1">
          <button type="button" disabled={ai === 0} aria-label={`Move ${a.name} up`} onClick={() => moveArea(a.id, -1)} className="rounded-md border border-line px-1.5 text-[14px] disabled:opacity-40">↑</button>
          <button type="button" disabled={ai === n - 1} aria-label={`Move ${a.name} down`} onClick={() => moveArea(a.id, 1)} className="rounded-md border border-line px-1.5 text-[14px] disabled:opacity-40">↓</button>
        </span>
      </div>
      {ms.map((m) => {
        const fs = map.features.filter((f) => f.area === a.id && f.milestones.includes(m.id));
        const serves = m.areas.includes(a.id);
        return (
          <div key={m.id} className={`flex flex-col gap-1.5 border-b border-r border-line p-2 ${serves ? "bg-surface2/60" : ""} ${m.id === proposed ? "border-x-2 border-dashed border-x-accent" : ""}`}>
            {fs.map((f) =>
              home[f.id] === m.id ? (
                <FeatureCard key={f.id} f={f} tight also={f.milestones.filter((x) => x !== m.id).map((x) => msName(map, x))} />
              ) : (
                <AlsoHere key={f.id} f={f} under={msName(map, home[f.id])} />
              ),
            )}
            {serves && !fs.length && <span className="simple-small text-[14px]! leading-5 px-1">No feature yet</span>}
            {serves && (
              <button type="button" onClick={() => open("attach")} className="self-start rounded-full px-1.5 text-[14px] font-semibold text-accent-ink hover:underline">
                + Attach a feature
              </button>
            )}
          </div>
        );
      })}
    </>
  );
}

function LadderPhone({ map, ms, home }: Ctx & { ms: GmMilestone[]; home: Record<string, string> }) {
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
            {num(m.current, m.unit)} of {num(m.threshold, m.unit)} · {afterWords(m, map)}
          </span>
          <Proof m={m} compact />
          {map.areas
            .filter((a) => m.areas.includes(a.id))
            .map((a) => (
              <div key={a.id} className="flex flex-col gap-1.5 border-t border-line pt-2">
                <span className="text-[14px] font-semibold text-text2">{map.areas.indexOf(a) + 1}. {a.name}</span>
                {map.features
                  .filter((f) => f.area === a.id && f.milestones.includes(m.id))
                  .map((f) =>
                    home[f.id] === m.id ? (
                      <FeatureCard key={f.id} f={f} tight also={f.milestones.filter((x) => x !== m.id).map((x) => msName(map, x))} />
                    ) : (
                      <AlsoHere key={f.id} f={f} under={msName(map, home[f.id])} />
                    ),
                  )}
              </div>
            ))}
        </div>
      ))}
    </section>
  );
}

/* ---------- B · Goal tree ---------- */

function GoalTree(ctx: Ctx) {
  const { map, open } = ctx;
  const ms = sortMs(map);
  const order = map.goals.flatMap((g) => ms.filter((m) => m.goal === g.id).map((m) => m.id));
  const home = homes(order, map.features);
  return (
    <>
      <Guardrail map={map} />
      <AreaOrder {...ctx} />
      <section className="flex flex-col gap-4" data-testid="gm-tree">
        {map.goals.map((g, gi) => (
          <div key={g.id} className="simple-card gap-3!" data-testid="gm-goal" data-goal={g.id}>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <span className="text-[13px] font-semibold uppercase tracking-wide text-text2">Goal {gi + 1}</span>
              <h2 className="simple-h2">{g.name} ≥ {num(g.target, g.unit)}</h2>
              <StatusPill s={g.status} />
              <span className="ml-auto flex items-center gap-3">
                <span className="text-[17px]">
                  Now <b>{num(g.current, g.unit)}</b> of {num(g.target, g.unit)}
                </span>
                <Btn small testId={`gm-edit-goal-${g.id}`} onClick={() => open("goal", g.id)}>Edit</Btn>
              </span>
            </div>
            <span className="simple-small">
              {g.builds_on.length ? `Builds on goal ${gi}. ` : ""}
              {g.math}. Last change: {g.history[0].text}, {g.history[0].date.replace(", 2026", "")}.
            </span>
            <ul className="flex flex-col gap-2 border-l-2 border-line pl-4">
              {ms
                .filter((m) => m.goal === g.id)
                .map((m) => (
                  <li key={m.id} className={`flex flex-col gap-2 rounded-xl border px-3 py-2.5 ${m.status === "missed" ? "border-crit/50 bg-crit-bg/40" : "border-line"}`}>
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="font-semibold">{m.name}</span>
                      <StatusPill s={m.status} />
                      <span className="text-text2">
                        {num(m.current, m.unit)} of {num(m.threshold, m.unit)} · due in {m.month}
                      </span>
                      <span className="simple-small ml-auto">{afterWords(m, map)}</span>
                    </span>
                    <span className="flex flex-wrap items-center gap-x-4 gap-y-2">
                      <Proof m={m} />
                      <span className="flex flex-wrap gap-1.5">
                        {map.areas.filter((a) => m.areas.includes(a.id)).map((a) => (
                          <Pill key={a.id} cls="bg-surface2 text-text2">{map.areas.indexOf(a) + 1}. {a.name}</Pill>
                        ))}
                      </span>
                    </span>
                    <ul className="flex flex-col gap-1.5 border-l-2 border-line pl-4">
                      {map.features
                        .filter((f) => f.milestones.includes(m.id))
                        .sort((a, b) => map.areas.findIndex((x) => x.id === a.area) - map.areas.findIndex((x) => x.id === b.area))
                        .map((f) => (
                          <li key={f.id} className="flex flex-col">
                            {home[f.id] === m.id ? (
                              <FeatureCard f={f} tight area={map.areas.find((a) => a.id === f.area)?.name} also={f.milestones.filter((x) => x !== m.id).map((x) => msName(map, x))} />
                            ) : (
                              <AlsoHere f={f} under={msName(map, home[f.id])} />
                            )}
                          </li>
                        ))}
                      <li>
                        <button type="button" onClick={() => open("attach")} className="text-[14px] font-semibold text-accent-ink hover:underline">+ Attach a feature</button>
                      </li>
                    </ul>
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </section>
    </>
  );
}

/* ---------- C · Driver tree ---------- */

function Lever({ title, now, target, status, testId, children, goal, onEdit }: { title: string; now: string; target: string; status: GmStatus; testId?: string; children?: ReactNode; goal?: boolean; onEdit?: () => void }) {
  return (
    <div data-testid={testId} className={`simple-card min-w-0 flex-1 gap-2! p-4! ${goal ? "border-accent!" : ""}`}>
      <span className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1">
        <span className="font-semibold leading-6">{title}</span>
        <StatusPill s={status} />
      </span>
      <span className="flex items-baseline gap-2">
        <span className="simple-number text-[26px]!">{now}</span>
        <span className="text-text2">{target}</span>
        {onEdit && (
          <span className="ml-auto">
            <Btn small onClick={onEdit}>Edit</Btn>
          </span>
        )}
      </span>
      {children}
    </div>
  );
}

const Op = ({ c, className = "" }: { c: string; className?: string }) => <span className={`self-center px-1 text-[26px] font-bold text-text-faint ${className}`}>{c}</span>;

function LeverBody({ map, lever, open, linked }: { map: GoalMap; lever: string; open: Ctx["open"]; linked: Ctx["linked"] }) {
  const fs = map.features.filter((f) => f.lever === lever);
  const areas = map.areas.filter((a) => fs.some((f) => f.area === a.id));
  const msIds = [...new Set(fs.flatMap((f) => f.milestones))];
  const ms = sortMs(map).filter((m) => msIds.includes(m.id));
  const shown = fs.slice(0, 6);
  return (
    <>
      <span className="flex flex-wrap gap-1.5">
        {areas.map((a) => (
          <Pill key={a.id} cls="bg-surface2 text-text2 whitespace-normal! max-w-full">{map.areas.indexOf(a) + 1}. {a.name}</Pill>
        ))}
      </span>
      {!fs.length && <span className="simple-small">No milestone or feature pulls it yet.</span>}
      {!!ms.length && <span className="text-[14px] font-semibold text-text2">Milestones it moves</span>}
      <ol className="flex flex-col gap-2">
        {ms.map((m) => {
          const n = fs.filter((f) => f.milestones.includes(m.id)).length;
          const isNew = linked?.milestone === m.id && fs.some((f) => f.id === linked.feature);
          return (
            <li key={m.id} className={`flex flex-col gap-1.5 rounded-xl border px-2.5 py-2 ${isNew ? "border-accent bg-accent-soft/50" : "border-line"}`}>
              <span className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[16px] font-semibold leading-6">
                <span>{m.name}</span>
                <StatusPill s={m.status} />
              </span>
              <span className="simple-small text-[14px]! leading-5">
                {num(m.current, m.unit)} of {num(m.threshold, m.unit)} · due in {m.month} · {n} {n === 1 ? "feature" : "features"} here
                {isNew ? <b className="text-accent-ink"> (1 new)</b> : null}
              </span>
              <Proof m={m} />
            </li>
          );
        })}
      </ol>
      {!!fs.length && <span className="text-[14px] font-semibold text-text2">Features pulling it</span>}
      {shown.map((f) => {
        const names = f.milestones.map((x) => msName(map, x));
        return <FeatureCard key={f.id} f={f} tight serves="Serves" also={names} fresh={linked?.feature === f.id ? msName(map, linked.milestone) : undefined} />;
      })}
      {fs.length > shown.length && <span className="simple-small">and {fs.length - shown.length} more</span>}
      <button type="button" onClick={() => open("attach")} className="self-start text-[14px] font-semibold text-accent-ink hover:underline">+ Attach a feature</button>
    </>
  );
}

function DriverTree(ctx: Ctx) {
  const { map, open, linked } = ctx;
  const [s, c, r] = map.goals;
  const rate = s.current && c.current ? Math.round((c.current / s.current) * 100) : null;
  const value = r.current && c.current ? Math.round(r.current / (c.current * map.reps)) : null;
  const box = "flex max-[600px]:w-full";
  return (
    <>
      <AreaOrder {...ctx} />
      <section className="flex flex-col gap-3" data-testid="gm-driver">
        <div className="flex justify-center">
          <div className="w-[min(520px,100%)]">
            <Lever goal title={`Revenue per day (goal)`} now={num(r.current, "$")} target={`of ${num(r.target, "$")}`} status={r.status} onEdit={() => open("goal", r.id)}>
              <span className="simple-small text-[14px]! leading-5">= reps × paid conversions per rep × value of a conversion</span>
            </Lever>
          </div>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)] items-start gap-x-1 gap-y-3 max-[600px]:flex max-[600px]:flex-col max-[600px]:items-stretch">
          <div className={`row-span-2 ${box} max-[600px]:order-1`}>
            <Lever title="Reps live" now={`${map.reps}`} target="reps" status="on_track">
              <LeverBody map={map} lever="Number of reps" open={open} linked={linked} />
            </Lever>
          </div>
          <Op c="×" className="max-[600px]:order-2" />
          <div className={`col-span-3 ${box} max-[600px]:order-3`}>
            <Lever goal title="Paid conversions per rep (goal)" now={num(c.current, "")} target={`of ${c.target} a day`} status={c.status} onEdit={() => open("goal", c.id)}>
              <span className="simple-small text-[14px]! leading-5">= sign-ups per rep × conversion rate. Needs 40–65 sign-ups at 15–25%.</span>
            </Lever>
          </div>
          <Op c="×" className="max-[600px]:order-8" />
          <div className={`row-span-2 ${box} max-[600px]:order-9`}>
            <Lever title="Value of a conversion" now={value === null ? "—" : `$${value}`} target="each" status={value === null ? "not_measured" : "on_track"}>
              <LeverBody map={map} lever="Value per conversion" open={open} linked={linked} />
            </Lever>
          </div>
          <span className="max-[600px]:hidden" />
          <div className={`col-start-3 ${box} max-[600px]:order-4 max-[600px]:border-l-4 max-[600px]:border-line max-[600px]:pl-3`}>
            <Lever goal title="Sign-ups per rep (goal)" now={num(s.current, "")} target={`of ${s.target} a day`} status={s.status} onEdit={() => open("goal", s.id)}>
              <LeverBody map={map} lever="Sign-ups per rep" open={open} linked={linked} />
            </Lever>
          </div>
          <Op c="×" className="max-[600px]:order-5 max-[600px]:ml-4" />
          <div className={`${box} max-[600px]:order-6 max-[600px]:border-l-4 max-[600px]:border-line max-[600px]:pl-3`}>
            <Lever title="Conversion rate" now={rate === null ? "—" : `${rate}%`} target="needs 15–25%" status="on_track">
              <LeverBody map={map} lever="Conversion rate" open={open} linked={linked} />
            </Lever>
          </div>
        </div>
        <div className="simple-card gap-2! border-pass/50! max-[600px]:mb-24">
          <Guardrail map={map} />
          <LeverBody map={map} lever="Guardrail" open={open} linked={linked} />
        </div>
      </section>
    </>
  );
}

/* ---------- D · Scoreboard with drill-in ---------- */

function Scoreboard(ctx: Ctx) {
  const { map, open, pick, setPick } = ctx;
  const ms = [...map.milestones].sort((a, b) => {
    const ai = Math.min(...a.areas.map((x) => map.areas.findIndex((y) => y.id === x)));
    const bi = Math.min(...b.areas.map((x) => map.areas.findIndex((y) => y.id === x)));
    return ai - bi;
  });
  const chosen = map.milestones.find((m) => m.id === pick);
  useEffect(() => {
    // On a narrow screen the drill-in is a sheet: the page behind it stays still.
    if (!chosen || window.innerWidth > 900) return;
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.documentElement.style.overflow = "";
    };
  }, [chosen]);
  return (
    <>
      <div className="grid grid-cols-4 gap-3 max-[900px]:grid-cols-2 max-[600px]:grid-cols-1" data-testid="gm-tiles">
        {map.goals.map((g) => (
          <div key={g.id} className="simple-card gap-1! p-4!" data-testid="gm-goal">
            <span className="flex items-start justify-between gap-4">
              <span className="font-semibold leading-6">{g.name}</span>
              <button type="button" onClick={() => open("goal", g.id)} className="shrink-0 rounded-full border border-line px-2.5 py-0.5 text-[14px] font-semibold text-accent-ink hover:bg-surface2">Edit</button>
            </span>
            <span className="simple-number">{num(g.current, g.unit)}</span>
            <span className="flex items-center justify-between gap-2 text-text2">
              of {num(g.target, g.unit)} <StatusPill s={g.status} />
            </span>
          </div>
        ))}
        <div className="simple-card gap-1! border-pass/50! p-4!" data-testid="gm-guardrail">
          <span className="font-semibold leading-6">Guardrail: {map.guardrail.name}</span>
          <span className="simple-number text-pass">0</span>
          <span className="text-text2">must stay {map.guardrail.rule} · held 7 of 7</span>
        </div>
      </div>
      <AreaOrder {...ctx} />
      <div className="flex items-start gap-4">
        <section className="simple-card min-w-0 flex-1 gap-0! p-0!" aria-label="Milestones">
          <div className="grid grid-cols-[minmax(0,2.2fr)_1fr_1fr_1.2fr] gap-3 border-b border-line px-4 py-2 text-[14px] font-semibold text-text2 max-[600px]:hidden">
            <span>Milestone</span>
            <span>Now / needed</span>
            <span>Status</span>
            <span>Features</span>
          </div>
          {ms.map((m) => {
            const fs = map.features.filter((f) => f.milestones.includes(m.id));
            const help = fs.filter((f) => f.lift === "helping").length;
            const no = fs.filter((f) => f.lift === "not_helping").length;
            return (
              <button
                key={m.id}
                type="button"
                data-testid="gm-row"
                onClick={() => setPick(m.id)}
                className={`grid w-full grid-cols-[minmax(0,2.2fr)_1fr_1fr_1.2fr] items-center gap-3 border-b border-line px-4 py-2.5 text-left hover:bg-surface2 max-[600px]:grid-cols-[1fr_auto] ${pick === m.id ? "bg-accent-soft" : ""}`}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="font-semibold leading-6">{m.name}</span>
                  <span className="simple-small text-[14px]! leading-5">{m.areas.map((x) => map.areas.find((a) => a.id === x)?.name).join(" · ")}</span>
                  <span className="hidden text-[15px] leading-6 max-[600px]:block">
                    {num(m.current, m.unit)} of {num(m.threshold, m.unit)} · {fs.length} {fs.length === 1 ? "feature" : "features"}, <span className="text-pass">{help} helping</span>
                  </span>
                </span>
                <span className="max-[600px]:hidden">
                  {num(m.current, m.unit)} / {num(m.threshold, m.unit)}
                </span>
                <span>
                  <StatusPill s={m.status} />
                </span>
                <span className="text-[15px] max-[600px]:hidden">
                  {fs.length} · <span className="text-pass">{help} helping</span>
                  {no ? <span className="text-crit"> · {no} not helping</span> : null}
                </span>
              </button>
            );
          })}
        </section>
        {chosen && <div aria-hidden onClick={() => setPick(null)} className="fixed inset-0 z-20 hidden bg-black/40 max-[900px]:block" />}
        {chosen && (
          <aside className="simple-card sticky top-4 w-[400px] shrink-0 gap-3! max-[900px]:fixed max-[900px]:inset-x-0 max-[900px]:bottom-0 max-[900px]:top-auto max-[900px]:z-30 max-[900px]:max-h-[75vh] max-[900px]:w-full max-[900px]:overflow-y-auto max-[900px]:rounded-b-none max-[900px]:pb-24" data-testid="gm-drill" aria-label={chosen.name}>
            <span className="flex items-start justify-between gap-2">
              <h2 className="simple-h2">{chosen.name}</h2>
              <button type="button" aria-label="Close" onClick={() => setPick(null)} className="rounded-full p-1 hover:bg-surface2">
                <Icon name="x" />
              </button>
            </span>
            <span className="flex items-center gap-2">
              <StatusPill s={chosen.status} />
              <span className="text-text2">{num(chosen.current, chosen.unit)} of {num(chosen.threshold, chosen.unit)} · due in {chosen.month}</span>
            </span>
            <span className="simple-small">{afterWords(chosen, map)}. Met when held 7 days in a row on a live rep, guardrail held.</span>
            <Proof m={chosen} />
            <span className="font-semibold">Features</span>
            {map.features.filter((f) => f.milestones.includes(chosen.id)).map((f) => (
              <FeatureCard key={f.id} f={f} tight area={map.areas.find((a) => a.id === f.area)?.name} />
            ))}
            <span className="flex flex-wrap gap-2">
              <Btn small onClick={() => open("attach", undefined, chosen.id)}>+ Attach a feature</Btn>
              <Btn small primary testId="gm-drill-prd" onClick={() => open("prd", undefined, chosen.id)}>New PRD from this milestone</Btn>
            </span>
          </aside>
        )}
      </div>
    </>
  );
}
