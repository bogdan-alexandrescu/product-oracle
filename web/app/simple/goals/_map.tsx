"use client";

/**
 * Simple Goal map (build-goal-map), drawn as the Goal ladder (goal-ladder, the owner's picks of
 * Nov 6, see _ladder.tsx): the guardrail strip every milestone must hold (never a goal card),
 * the week strip, then the goals as columns in priority order with their milestones and the
 * work behind each on a pan-and-zoom canvas. A phone shows one goal at a time. Every feature
 * opens Simple's item panel; the goal map's own edits (a milestone, a gate, a goal's target or
 * metric, an area, a PRD from a milestone) open here.
 */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { createContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { Icon } from "@/components/ds/Icon";
import { NewPrdSheet, useCanStartPrd } from "@/components/simple/NewPrd";
import { api, unwrap } from "@/lib/api/client";
import type { GmArea, GmFeature, GmGoal, GoalMap } from "@/lib/api/mock/goal-map";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

import { GoalLadder } from "./_ladder";
import { FeaturePanel } from "./_panel";

/** one-feature-panel: each feature's code (its roadmap item's), shown before its name. */
const Codes = createContext<Map<string, string>>(new Map());
/** Each milestone's unit, for a feature's readings before and after it shipped. */
const Units = createContext<Map<string, string>>(new Map());

type Edit = "propose" | "goal" | "attach" | "prd" | "area" | "gate" | "metric" | "gaps" | "unplaced" | null;




function num(v: number | null, unit: string): string {
  if (v === null) return "—";
  if (unit === "$") return v >= 1000 ? `$${Math.round(v / 100) / 10}k` : `$${v}`;
  return `${Math.round(v * 10) / 10}`;
}




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



const msName = (map: GoalMap, id: string) => map.milestones.find((m) => m.id === id)?.name ?? "";

/** After an edit, brings what changed into view. */
function reveal(sel: string, block: ScrollLogicalPosition = "center") {
  setTimeout(() => document.querySelector(sel)?.scrollIntoView({ block, inline: "nearest" }), 50);
}


function goalWarning(map: GoalMap, goal: GmGoal, target: string): string {
  const ms = map.milestones.filter((m) => m.goal === goal.id).filter((m) => m.threshold !== null).sort((a, b) => b.threshold! - a.threshold!);
  const top = ms[0];
  const words = `${num(goal.target, goal.unit)} → ${num(Number(target), goal.unit)}: its ${ms.length} milestones keep their own thresholds.`;
  return top && top.threshold! < Number(target) ? `${words} The highest, “${top.name}”, would now stop short of the goal.` : words;
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
  /** The metric picked for a goal. */
  metric: string;
}

/** A proposed milestone starts with nothing before it (gm1-a-open): "Nothing: it can start now". */
function emptyDraft(map: GoalMap): Draft {
  return { name: "", goal: map.goals[0]?.id ?? "", threshold: "", areas: [], after: "", target: "", feature: "", search: "", milestone: "", areaName: "", area: "", expected: "", confirm: false, metric: "" };
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
  const units = useMemo(() => new Map((map?.milestones ?? []).map((m) => [m.id, m.unit])), [map]);
  // goal-map-scoreboard: a Home goal card opens the map on its goal (by id; else by its name).
  const params = useSearchParams();
  const asked = params.get("goal");
  const askedName = params.get("name");
  const picked = map?.goals.find((g) => g.id === asked)?.id ?? map?.goals.find((g) => !!askedName && g.name.toLowerCase() === askedName.toLowerCase())?.id ?? null;
  // A goal left off the map (no number to aim at): a line names it and why, never the top in silence.
  const off = map && asked && !picked ? (map.off_map.find((g) => g.id === asked) ?? (askedName ? { id: asked, key: asked, name: askedName } : null)) : null;
  const offId = off?.id ?? null;
  useEffect(() => {
    if (picked) reveal(`[data-goal="${picked}"]`, "start");
    else if (offId) reveal(`[data-testid="gm-off-map"]`);
  }, [picked, offId]);

  if (!map) return <div className="simple-page" role="status">{q.error ? errorMessage(q.error) : "Loading the goal map…"}</div>;

  const open = (e: Edit, goal?: string, milestone?: string, area?: string, feature?: string) => {
    if (goal) setGoalId(goal);
    setFlash(null);
    setEdit(e);
    const m = map.milestones.find((x) => x.id === milestone);
    const gate = e === "gate" && m ? { threshold: m.threshold === null ? "" : String(m.threshold), after: m.depends[0] ?? "" } : {};
    // An unplaced feature: picked already, found by its name.
    const placing = feature ? { feature, search: map.unplaced.find((f) => f.id === feature)?.name ?? "" } : {};
    setDraft({ ...emptyDraft(map), ...(e === "propose" && goal ? { goal } : {}), milestone: milestone ?? "", area: area ?? "", ...gate, ...placing });
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
    if (edit === "metric") {
      const g = map.goals.find((x) => x.id === goalId)!;
      const c = g.choices.find((x) => x.id === draft.metric);
      const ok = await send(api.POST("/v1/simple/goal-map/goals/{goal_id}/metric", { params: { path: { goal_id: g.id } }, body: { metric: draft.metric } }), (next) =>
        next.goals.find((x) => x.id === g.id)?.missing ? `${g.name} now reads ${c?.title}; it has no value yet.` : `${g.name} now reads ${c?.title}.`,
      );
      if (!ok) return;
      reveal(`[data-goal="${g.id}"]`, "start");
    }
    if (edit === "area") {
      const ok = await send(api.POST("/v1/simple/goal-map/areas", { body: { name: draft.areaName, lever: "" } }), () => `Area added: ${draft.areaName}. It shows last; move it to change the order.`);
      if (!ok) return;
    }
    close();
  };

  return (
    <Codes.Provider value={codes}>
    <Units.Provider value={units}>
    <div className="simple-page" data-testid="gm-page" style={{ maxWidth: "none" }}>
      {flash && (
        <p role="status" data-testid="gm-flash" className="fixed bottom-6 left-1/2 z-30 w-max max-w-[min(720px,calc(100vw-32px))] -translate-x-1/2 rounded-2xl border border-accent bg-accent-soft px-4 py-2.5 font-semibold text-accent-ink shadow-lg max-[600px]:bottom-24">
          {flash}
        </p>
      )}
      {/* goal-ladder: the ladder on a pan-and-zoom canvas (a phone: one goal at a time). */}
      <GoalLadder
        map={map}
        setMap={(m) => q.setData(() => m)}
        reloadMap={() => q.reload()}
        onOpen={setPanel}
        onAddMilestone={(goal) => open("propose", goal)}
        onGate={(m) => open("gate", undefined, m)}
        onAttach={(m, area) => open("attach", undefined, m, area)}
        onGoal={(goal) => open("goal", goal)}
        onMetric={(goal) => open("metric", goal)}
        onPrd={canPrd ? (m) => open("prd", undefined, m) : null}
        picked={picked}
        head={
          <div className="flex flex-col gap-1">
            <h1 className="simple-h1 max-[600px]:sr-only">Goal map</h1>
            <p className="simple-small">Updated {map.today}</p>
            <Flags map={map} open={open} />
            {off && (
              <p data-testid="gm-off-map" className="simple-small flex flex-wrap items-center gap-x-2 rounded-xl border border-line px-3 py-1.5">
                <span>
                  Not on the map yet: <b className="font-semibold text-text">{off.name}</b> has no number to aim at.
                </span>
                <Link href={`/simple/priorities?goal=${encodeURIComponent(off.key)}&name=${encodeURIComponent(off.name)}`} className="font-semibold text-accent-ink hover:underline">
                  Open the goal
                </Link>
              </p>
            )}
          </div>
        }
        guardrail={<Guardrail map={map} />}
      />

      {edit && draft && (
        <Editor map={map} edit={edit} draft={draft} setDraft={setDraft} goal={map.goals.find((g) => g.id === goalId) ?? map.goals[0]} onClose={close} onSave={() => void save()} open={open} onOpen={(f) => setPanel(f)} />
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
    </Units.Provider>
    </Codes.Provider>
  );
}

interface Ctx {
  map: GoalMap;
  open: (e: Edit, goal?: string, milestone?: string, area?: string, feature?: string) => void;
  moveArea: (id: string, dir: -1 | 1) => void;
  onOpen: (f: GmFeature) => void;
  week: string[];
  /** The goal a link opened the map on (Home's goal cards). */
  picked: string | null;
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

function Editor({ map, edit, draft, setDraft, goal, onClose, onSave, open, onOpen }: { map: GoalMap; edit: Edit; draft: Draft; setDraft: (d: Draft) => void; goal: GmGoal; onClose: () => void; onSave: () => void; open: Ctx["open"]; onOpen: Ctx["onOpen"] }) {
  const set = (k: Partial<Draft>) => setDraft({ ...draft, ...k });
  if (edit === "metric") return <MetricDrawer goal={goal} draft={draft} set={set} onClose={onClose} onSave={onSave} />;
  if (edit === "gaps" || edit === "unplaced") return <FlagDrawer map={map} kind={edit} onClose={onClose} open={open} onOpen={onOpen} />;
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

/* ---------- The scoreboard's flags (goal-map-scoreboard) ---------- */

/** The counts that open their items: gate areas with no feature, features serving no gate. */
function Flags({ map, open }: { map: GoalMap; open: Ctx["open"] }) {
  const gaps = map.gaps.length;
  const unplaced = map.unplaced.length;
  if (!gaps && !unplaced) return null;
  const chip = "inline-flex items-center gap-1.5 rounded-full border border-warn/50 bg-warn-bg px-3 py-0.5 text-[14px] font-semibold text-warn hover:underline";
  return (
    <span className="flex flex-wrap gap-2" data-testid="gm-flags">
      {gaps > 0 && (
        <button type="button" data-testid="gm-flag-gaps" className={chip} onClick={() => open("gaps")}>
          {gaps} {gaps === 1 ? "gate area" : "gate areas"} with no feature
        </button>
      )}
      {unplaced > 0 && (
        <button type="button" data-testid="gm-flag-unplaced" className={chip} onClick={() => open("unplaced")}>
          {unplaced} {unplaced === 1 ? "feature serves" : "features serve"} no gate
        </button>
      )}
    </span>
  );
}

function FlagDrawer({ map, kind, onClose, open, onOpen }: { map: GoalMap; kind: "gaps" | "unplaced"; onClose: () => void; open: Ctx["open"]; onOpen: Ctx["onOpen"] }) {
  const { can } = useMe();
  const adds = can("create_simple_change");
  const addItem = adds && (
    <Link href="/simple/roadmap" data-testid="gm-add-item" className="text-[14px] font-semibold text-accent-ink hover:underline">
      Add an item
    </Link>
  );
  const row = "flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line px-3 py-2";
  if (kind === "gaps")
    return (
      <Drawer title="Gate areas with no feature" onClose={onClose} testId="gm-flag-list">
        {!map.can_edit && map.approver && (
          <p data-testid="gm-gap-who" className="simple-small">
            Ask {map.approver} to place a feature.
          </p>
        )}
        <ul className="flex flex-col gap-1.5">
          {map.gaps.map((g) => {
            const m = map.milestones.find((x) => x.id === g.milestone);
            const area = map.areas.find((a) => a.id === g.area);
            return (
              <li key={`${g.milestone}:${g.area}`} data-testid="gm-gap" className={row}>
                <span className="flex flex-col">
                  <b className="font-semibold">{m?.name}</b>
                  <span className="simple-small text-[14px]!">{area ? area.name : "No area yet"}</span>
                </span>
                <span className="flex items-center gap-2">
                  {map.can_edit && (
                    <Btn small testId="gm-place" onClick={() => open("attach", undefined, g.milestone, g.area ?? "")}>
                      Place a feature
                    </Btn>
                  )}
                  {addItem}
                </span>
              </li>
            );
          })}
        </ul>
      </Drawer>
    );
  return (
    <Drawer title="Features serving no gate" onClose={onClose} testId="gm-flag-list">
      <ul className="flex flex-col gap-1.5">
        {map.unplaced.map((f) => (
          <li key={f.id} data-testid="gm-unplaced" className={row}>
            <button type="button" className="text-left font-semibold hover:underline" onClick={() => onOpen({ id: f.id, name: f.name } as GmFeature)}>
              {f.name}
            </button>
            {map.can_edit && (
              <Btn small testId="gm-place" onClick={() => open("attach", undefined, undefined, undefined, f.id)}>
                Place it
              </Btn>
            )}
          </li>
        ))}
      </ul>
      {addItem && <span className="flex justify-end">{addItem}</span>}
    </Drawer>
  );
}

/** Pick the metric whose weekly values give the goal its readings, or add one. */
function MetricDrawer({ goal, draft, set, onClose, onSave }: { goal: GmGoal; draft: Draft; set: (k: Partial<Draft>) => void; onClose: () => void; onSave: () => void }) {
  const { can } = useMe();
  return (
    <Drawer title={`Pick the metric for ${goal.name}`} onClose={onClose} testId="gm-editor">
      {goal.choices.length ? (
        <ul className="flex flex-col gap-1.5" data-testid="gm-metric-list">
          {goal.choices.map((c) => (
            <li key={c.id}>
              <button type="button" aria-pressed={draft.metric === c.id} onClick={() => set({ metric: c.id })} className={`w-full rounded-xl border px-3 py-2 text-left ${draft.metric === c.id ? "border-accent bg-accent-soft" : "border-line"}`}>
                <span className="font-semibold">{c.title}</span>
                <span className="simple-small block text-[14px]! leading-5">{c.last === null ? "No value yet" : `Last week: ${num(c.last, goal.unit)}`}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="simple-small" data-testid="gm-metric-none">No metric in this unit yet</p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {can("create_metric") && (
          <Link href="/company/metrics" data-testid="gm-add-metric" className="mr-auto text-[15px] font-semibold text-accent-ink hover:underline">
            Add a metric
          </Link>
        )}
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn primary testId="gm-save" disabled={!draft.metric} onClick={onSave}>Use this metric</Btn>
      </div>
    </Drawer>
  );
}

/* ---------- Shared pieces of the proposals ---------- */







