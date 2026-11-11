"use client";

/**
 * The goal map's own editors, as the Goal ladder had them (its drawers, kept as built): a
 * milestone's gate, a proposed milestone, a goal's metric and a new PRD from a milestone. The
 * grid opens them from its ⋯ menus and from the badges that ask for them (No gate, Not measured).
 */
import Link from "next/link";
import { useState, type ReactNode } from "react";

import { Icon } from "@/components/ds/Icon";
import type { GmArea, GmGoal, GmMilestone, GoalMap } from "@/lib/api/mock/goal-map";
import { CURRENCY_SIGNS, goalFigure } from "@/lib/format";
import { useMe } from "@/lib/me";

export type Edit = { kind: "gate" | "prd"; milestone: string } | { kind: "metric" | "propose"; goal: string };

/** What an editor sends: the gate, a proposed milestone, a goal's metric, a PRD's areas. */
export type EditSave =
  | { kind: "gate"; milestone: GmMilestone; threshold: number; after: string; confirm: boolean }
  | { kind: "propose"; name: string; goal: string; threshold: number; areas: string[]; after: string }
  | { kind: "metric"; goal: GmGoal; metric: string }
  | { kind: "prd"; milestone: GmMilestone; areas: string[] };

function num(v: number | null, unit: string): string {
  if (v === null) return "—";
  // goal-figure-words: "$20,000", "1,200 shops"; a count to one decimal.
  return goalFigure(CURRENCY_SIGNS[unit.trim().toLowerCase()] ? v : Math.round(v * 10) / 10, unit);
}

function Btn({ children, onClick, primary, testId, disabled }: { children: ReactNode; onClick?: () => void; primary?: boolean; testId?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-4 py-1.5 text-[15px] font-semibold ${primary ? "border-accent bg-accent text-on-accent disabled:opacity-40" : "border-line bg-surface text-text hover:bg-surface2"}`}
    >
      {children}
    </button>
  );
}

function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/20 max-[600px]:items-end">
      <div role="dialog" aria-label={title} data-testid="gm-editor" className="simple-card m-3 w-[460px] max-w-[calc(100vw-24px)] overflow-y-auto max-[600px]:m-0 max-[600px]:max-h-[85vh] max-[600px]:w-full max-[600px]:max-w-full max-[600px]:rounded-b-none">
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
const label = "flex flex-col gap-1.5 font-semibold";

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

const flip = (xs: string[], id: string) => (xs.includes(id) ? xs.filter((a) => a !== id) : [...xs, id]);

export function Editor({ map, edit, onClose, onSave }: { map: GoalMap; edit: Edit; onClose: () => void; onSave: (s: EditSave) => void }) {
  if (edit.kind === "gate") {
    const m = map.milestones.find((x) => x.id === edit.milestone);
    return m ? <GateDrawer map={map} m={m} onClose={onClose} onSave={onSave} /> : null;
  }
  if (edit.kind === "prd") return <PrdDrawer map={map} milestone={edit.milestone} onClose={onClose} onSave={onSave} />;
  if (edit.kind !== "metric" && edit.kind !== "propose") return null;
  const g = map.goals.find((x) => x.id === edit.goal);
  if (!g) return null;
  return edit.kind === "metric" ? <MetricDrawer goal={g} onClose={onClose} onSave={onSave} /> : <ProposeDrawer map={map} goal={g.id} onClose={onClose} onSave={onSave} />;
}

function GateDrawer({ map, m, onClose, onSave }: { map: GoalMap; m: GmMilestone; onClose: () => void; onSave: (s: EditSave) => void }) {
  const [threshold, setThreshold] = useState(m.threshold === null ? "" : String(m.threshold));
  const [after, setAfter] = useState(m.depends[0] ?? "");
  const [confirm, setConfirm] = useState(false);
  const t = Number(threshold);
  return (
    <Drawer title={`The gate of ${m.name}`} onClose={onClose}>
      <p className="simple-small">
        Met when {m.measure} holds this for 7 days in a row. Now {num(m.current, m.unit)}.
      </p>
      <label className={label}>
        At least
        <input className={field} inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
      </label>
      <label className={label}>
        Comes after
        <select className={field} data-testid="gm-after" value={after} onChange={(e) => setAfter(e.target.value)}>
          <option value="">Nothing: it can start now</option>
          {map.milestones
            .filter((x) => x.id !== m.id)
            .map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
        </select>
      </label>
      {m.proposed || !m.confirmed ? (
        <label className="flex items-center gap-2 font-semibold">
          <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> Confirm this gate
        </label>
      ) : (
        <p className="simple-small">
          Confirmed by {m.confirmed}
          {m.confirmed_on ? `, ${m.confirmed_on}` : ""}.
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn primary testId="gm-save" disabled={!(t > 0)} onClick={() => onSave({ kind: "gate", milestone: m, threshold: t, after, confirm })}>
          Save gate
        </Btn>
      </div>
    </Drawer>
  );
}

function ProposeDrawer({ map, goal, onClose, onSave }: { map: GoalMap; goal: string; onClose: () => void; onSave: (s: EditSave) => void }) {
  const [name, setName] = useState("");
  const [g, setG] = useState(goal);
  const [threshold, setThreshold] = useState("");
  const [areas, setAreas] = useState<string[]>([]);
  const [after, setAfter] = useState("");
  return (
    <Drawer title="Propose a milestone" onClose={onClose}>
      <label className={label}>
        Name
        <input className={field} value={name} placeholder="For example: 40 sign-ups per rep" onChange={(e) => setName(e.target.value)} />
      </label>
      <label className={label}>
        Goal it moves
        <select className={field} value={g} onChange={(e) => setG(e.target.value)}>
          {map.goals.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      </label>
      <label className={label}>
        Met when the reading is at least
        <input className={field} value={threshold} inputMode="decimal" placeholder="40" onChange={(e) => setThreshold(e.target.value)} />
      </label>
      <span className={label}>
        Areas it pulls
        <AreaPicks areas={map.areas} picked={areas} toggle={(id) => setAreas(flip(areas, id))} />
      </span>
      <label className={label}>
        Comes after
        <select className={field} data-testid="gm-after" value={after} onChange={(e) => setAfter(e.target.value)}>
          <option value="">Nothing: it can start now</option>
          {map.milestones.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      <div className="flex justify-end gap-2">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn primary testId="gm-save" disabled={!name.trim() || !(Number(threshold) > 0)} onClick={() => onSave({ kind: "propose", name: name.trim(), goal: g, threshold: Number(threshold), areas, after })}>
          Propose
        </Btn>
      </div>
    </Drawer>
  );
}

function PrdDrawer({ map, milestone, onClose, onSave }: { map: GoalMap; milestone: string; onClose: () => void; onSave: (s: EditSave) => void }) {
  const [id, setId] = useState(milestone);
  const [areas, setAreas] = useState<string[]>([]);
  const m = map.milestones.find((x) => x.id === id);
  return (
    <Drawer title="New PRD from a milestone" onClose={onClose}>
      <label className={label}>
        Milestone
        <select className={field} value={id} onChange={(e) => setId(e.target.value)}>
          <option value="">Pick a milestone</option>
          {map.milestones.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      </label>
      <span className={label}>
        Areas
        <AreaPicks areas={map.areas} picked={areas} toggle={(a) => setAreas(flip(areas, a))} />
      </span>
      {m && (
        <p className="simple-small rounded-xl bg-surface2 px-3 py-2">
          The PRD starts with this milestone&apos;s measure and threshold{map.guardrail ? `, the guardrail (${map.guardrail.name.toLowerCase()} ${map.guardrail.rule})` : ""} and the{" "}
          {map.features.filter((f) => f.milestones.includes(m.id)).length} features already serving it.
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn primary testId="gm-save" disabled={!m || !areas.length} onClick={() => m && onSave({ kind: "prd", milestone: m, areas })}>
          Start the PRD
        </Btn>
      </div>
    </Drawer>
  );
}

function MetricDrawer({ goal, onClose, onSave }: { goal: GmGoal; onClose: () => void; onSave: (s: EditSave) => void }) {
  const { can } = useMe();
  const [metric, setMetric] = useState("");
  return (
    <Drawer title={`Pick the metric for ${goal.name}`} onClose={onClose}>
      {goal.choices.length ? (
        <ul className="flex flex-col gap-1.5" data-testid="gm-metric-list">
          {goal.choices.map((c) => (
            <li key={c.id}>
              <button type="button" aria-pressed={metric === c.id} onClick={() => setMetric(c.id)} className={`w-full rounded-xl border px-3 py-2 text-left ${metric === c.id ? "border-accent bg-accent-soft" : "border-line"}`}>
                <span className="font-semibold">{c.title}</span>
                <span className="simple-small block text-[14px]! leading-5">{c.last === null ? "No value yet" : `Last week: ${num(c.last, goal.unit)}`}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="simple-small" data-testid="gm-metric-none">
          No metric in this unit yet
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {can("create_metric") && (
          <Link href="/company/metrics" data-testid="gm-add-metric" className="mr-auto text-[15px] font-semibold text-accent-ink hover:underline">
            Add a metric
          </Link>
        )}
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn primary testId="gm-save" disabled={!metric} onClick={() => onSave({ kind: "metric", goal, metric })}>
          Use this metric
        </Btn>
      </div>
    </Drawer>
  );
}
