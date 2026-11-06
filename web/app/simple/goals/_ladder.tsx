"use client";

// MOCK-HOOK: whole file. Mock-up set mk-goal-ladder only (a throwaway branch, never merged).
// The Goal ladder proposals behind URL switches: ?ld1=a|b|c|d (layout), &ld2=a|b|c (dependencies),
// &ld3=a|b|c (changing the ladder), &st=<state>, &edit=1, &as=viewer|commenter, &sel=<feature>.
import { useSearchParams } from "next/navigation";
import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";

import { Icon } from "@/components/ds/Icon";
import { mockLadder, type Ladder, type LdFeature, type LdGoal, type LdMilestone, type LdRole, type LdStatus, type LdWork } from "@/lib/api/mock/goal-ladder";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (iso: string | null) => (iso ? `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}` : "");
const span = (a: string | null, b: string | null) => (a && b ? `${day(a)} – ${day(b)}` : "No dates yet");

const KR: Record<LdStatus, string> = { met: "text-pass", on_track: "text-accent-ink", at_risk: "text-warn", missed: "text-crit", not_measured: "text-text2", no_gate: "text-text2" };
const KR_WORD: Record<LdStatus, string> = { met: "Met", on_track: "On track", at_risk: "At risk", missed: "Missed", not_measured: "Too early", no_gate: "No gate yet" };
const WORK: Record<LdWork, { w: string; cls: string }> = {
  done: { w: "Done", cls: "text-pass" },
  in_progress: { w: "In progress", cls: "text-accent-ink" },
  planning: { w: "Planning", cls: "text-warn" },
  backlog: { w: "Backlog", cls: "text-warn" },
  not_on_board: { w: "Not on the eng board yet", cls: "text-crit" },
};

type Op =
  | { k: "move"; f: string; from: string; to: string }
  | { k: "delete"; f: string }
  | { k: "link"; f: string; on: string }
  | { k: "unlink"; f: string; on: string }
  | { k: "add"; f: LdFeature };

/** The action each state shows performed (the same one its drag or menu frame starts). */
const PRESET: Record<string, Op[]> = {
  moved: [{ k: "move", f: "f15", from: "m4", to: "m6" }],
  deleted: [{ k: "delete", f: "f15" }],
  linked: [{ k: "link", f: "f24", on: "f34" }],
  unlinked: [{ k: "unlink", f: "f3", on: "f2" }],
  added: [{ k: "add", f: { id: "f66", code: "F-66", name: "Import from calendar tools with every date kept", goal: "g2", milestones: ["m5"], area: "Platform", status: "backlog", start: null, end: null, prd: "One day setup PRD", depends: [], can_change: true, can_propose: false } }],
};

function apply(l: Ladder, ops: Op[], role: LdRole): { l: Ladder; proposed: Op[] } {
  // A commenter's gesture makes a proposal: the ladder stays as it is, the proposal shows on it.
  if (role === "commenter") return { l, proposed: ops };
  let fs = l.features.map((f) => ({ ...f, milestones: [...f.milestones], depends: [...f.depends] }));
  for (const o of ops) {
    if (o.k === "move") {
      // dropped at the top of the new milestone's list (where the drag frame's drop place is)
      const moved = fs.find((f) => f.id === o.f)!;
      const rest = fs.filter((f) => f.id !== o.f);
      const at = rest.findIndex((f) => f.milestones.includes(o.to));
      rest.splice(at < 0 ? rest.length : at, 0, { ...moved, milestones: moved.milestones.map((m) => (m === o.from ? o.to : m)), goal: l.milestones.find((m) => m.id === o.to)!.goal });
      fs = rest;
    }
    if (o.k === "delete") fs = fs.filter((f) => f.id !== o.f);
    if (o.k === "link") fs = fs.map((f) => (f.id === o.f ? { ...f, depends: [...f.depends, o.on] } : f));
    if (o.k === "unlink") fs = fs.map((f) => (f.id === o.f ? { ...f, depends: f.depends.filter((d) => d !== o.on) } : f));
    if (o.k === "add") fs = [...fs, o.f];
  }
  return { l: { ...l, features: fs }, proposed: [] };
}

function usePhone(): boolean {
  return useSyncExternalStore(
    (on) => {
      const m = window.matchMedia("(max-width: 600px)");
      m.addEventListener("change", on);
      return () => m.removeEventListener("change", on);
    },
    () => window.matchMedia("(max-width: 600px)").matches,
    () => false,
  );
}

interface V {
  ld1: string;
  ld2: string;
  ld3: string;
  st: string;
  edit: boolean;
  role: LdRole;
  sel: string | null;
  l: Ladder;
  byId: Map<string, LdFeature>;
  waitsOnIt: Map<string, string[]>;
  proposed: Op[];
  fresh: string | null;
  phone: boolean;
  may: boolean; // can_change or can_propose: the gesture is offered
  handles: boolean; // grips, + slots and menus showing
  setSel: (id: string | null) => void;
  run: (o: Op) => void;
  setSt: (s: string) => void;
}

export function GoalLadder({ where }: { where: "map" | "roadmap" }) {
  const p = useSearchParams();
  const phone = usePhone();
  const ld1 = p.get("ld1") ?? "a";
  const ld2 = p.get("ld2") ?? "a";
  const ld3 = p.get("ld3") ?? "b";
  const role = (p.get("as") as LdRole) || "owner";
  const [st, setSt] = useState(p.get("st") ?? "rest");
  const [edit, setEdit] = useState(p.get("edit") === "1");
  const [sel, setSel] = useState<string | null>(p.get("sel") ?? (ld2 === "a" && st === "rest" && !p.has("edit") ? null : null));
  const [ops, setOps] = useState<Op[]>(PRESET[p.get("st") ?? ""] ?? []);
  const base = useMemo(() => mockLadder(role), [role]);
  const { l, proposed } = useMemo(() => apply(base, ops, role), [base, ops, role]);
  const byId = useMemo(() => new Map(l.features.map((f) => [f.id, f])), [l]);
  const waitsOnIt = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const f of l.features) for (const d of f.depends) m.set(d, [...(m.get(d) ?? []), f.id]);
    return m;
  }, [l]);
  const may = l.features.some((f) => f.can_change || f.can_propose);
  const handles = may && (ld3 === "a" || (ld3 === "b" && edit));
  const last = ops[ops.length - 1];
  const fresh = last?.k === "move" || last?.k === "link" || last?.k === "unlink" ? last.f : last?.k === "add" ? last.f.id : null;
  const v: V = { ld1, ld2, ld3, st, edit, role, sel, l, byId, waitsOnIt, proposed, fresh, phone, may, handles, setSel, setSt, run: (o) => setOps((x) => [...x, o]) };

  const body = phone ? <Phone v={v} /> : ld1 === "b" ? <PeriodColumns v={v} /> : ld1 === "c" ? <GridLadder v={v} /> : ld1 === "d" ? <Canvas v={v} /> : <GoalColumns v={v} />;

  return (
    <div className="simple-page" data-testid="ld-page" style={{ maxWidth: "none" }}>
      <header className="sticky top-0 z-30 -mx-2 flex flex-wrap items-end justify-between gap-3 bg-bg px-2 py-2">
        <div className="flex flex-col gap-1">
          <h1 className="simple-h1 max-[600px]:sr-only">{where === "roadmap" ? "Roadmap" : "Goal map"}</h1>
          <p className="simple-small">Updated {day(l.today)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {where === "roadmap" && <Formats />}
          {ld3 === "b" && may && (
            <Btn primary={edit} onClick={() => setEdit(!edit)} testId="ld-edit">
              {edit ? <><Icon name="check" size={16} /> {role === "commenter" ? "Done suggesting" : "Done"}</> : role === "commenter" ? "Suggest changes" : "Edit ladder"}
            </Btn>
          )}
          {!may && <span className="rounded-full bg-surface2 px-3 py-1 text-[14px] font-semibold text-text2" title="You can read this ladder. Owners and approvers change it; commenters suggest changes.">Read only</span>}
        </div>
      </header>
      {!phone && <Guardrail l={l} />}
      {!phone && ld1 !== "b" && <PeriodStrip l={l} />}
      {body}
      <Toast v={v} undo={() => setOps((x) => x.slice(0, -1))} />
    </div>
  );
}

function Formats() {
  const fmts = ["Timeline", "Gantt", "Now / Next / Later", "Waterfall", "Ladder"];
  return (
    <span className="inline-flex rounded-full border border-line bg-surface p-0.5 text-[14px] font-semibold">
      {fmts.map((f) => (
        <span key={f} className={`rounded-full px-3 py-1 ${f === "Ladder" ? "bg-accent text-on-accent" : "text-text2"}`}>{f}</span>
      ))}
    </span>
  );
}

function Btn({ children, onClick, primary, testId, small }: { children: ReactNode; onClick?: () => void; primary?: boolean; testId?: string; small?: boolean }) {
  return (
    <button type="button" data-testid={testId} onClick={onClick} className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border font-semibold ${small ? "px-2.5 py-0.5 text-[14px]" : "px-4 py-1.5 text-[15px]"} ${primary ? "border-accent bg-accent text-on-accent" : "border-line bg-surface text-text hover:bg-surface2"}`}>
      {children}
    </button>
  );
}

function Guardrail({ l }: { l: Ladder }) {
  return (
    <div data-testid="ld-guardrail" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl border border-pass/40 bg-pass-bg px-4 py-2">
      <Icon name="lock" size={18} className="text-pass" />
      <span className="font-semibold">Guardrail: {l.guardrail.name} {l.guardrail.rule}</span>
      <span className="ml-auto font-semibold text-pass">Held {l.guardrail.held} of 7 days</span>
    </div>
  );
}

/** Rest of 2026 and Q1 2027 as week chips: today and each milestone's week filled and named. */
function PeriodStrip({ l, only }: { l: Ladder; only?: string }) {
  return (
    <div className="flex gap-4" data-testid="ld-periods">
      {l.periods.filter((p) => !only || p.id === only).map((p) => (
        <div key={p.id} className="flex min-w-0 flex-col gap-1" style={{ flex: p.weeks.length }}>
          <span className="text-[13px] font-bold tracking-wide text-text2 uppercase">
            {p.name} · {l.goals.filter((g) => l.milestones.some((m) => m.goal === g.id && periodOf(l, m.due) === p.id)).length} goals
          </span>
          <span className="flex gap-1">
            {p.weeks.map((w) => (
              <span key={w.n} className="flex min-w-0 flex-1 flex-col items-center gap-0.5">
                <span title={`Week of ${day(w.from)}`} className={`grid h-6 w-full place-items-center rounded-md text-[12px] font-semibold ${w.today ? "bg-accent text-on-accent" : w.mark ? "bg-accent-soft text-accent-ink ring-1 ring-accent/50" : "bg-surface2 text-text-faint"}`}>W{w.n}</span>
              </span>
            ))}
          </span>
          <WeekLabels weeks={p.weeks} />
        </div>
      ))}
    </div>
  );
}

/** Under the week chips: "We are here" and each milestone's name, a row down when a neighbour is too close. */
function WeekLabels({ weeks }: { weeks: Ladder["periods"][number]["weeks"] }) {
  const last: number[] = [];
  const placed = weeks.flatMap((w, i) => {
    const text = w.today ? "We are here" : w.mark;
    if (!text) return [];
    const lines = text.split("\n").length;
    let r = 0;
    while (Array.from({ length: lines }, (_, k) => last[r + k]).some((x) => x !== undefined && i - x < 3)) r++;
    for (let k = 0; k < lines; k++) last[r + k] = i;
    return [{ i, text, r, today: !!w.today }];
  });
  const n = weeks.length;
  return (
    <span className="relative block" style={{ height: last.length * 13 }}>
      {placed.map(({ i, text, r, today }) => (
        <span key={i} className={`absolute w-max max-w-[140px] text-[11px] leading-[13px] whitespace-pre-line ${today ? "font-semibold text-accent-ink" : "text-text2"} ${i === 0 ? "text-left" : i === n - 1 ? "text-right" : "-translate-x-1/2 text-center"}`} style={{ top: r * 13, ...(i === n - 1 ? { right: 0 } : { left: i === 0 ? 0 : `${((i + 0.5) / n) * 100}%` }) }}>{text}</span>
      ))}
    </span>
  );
}

function periodOf(l: Ladder, due: string | null): string | null {
  if (!due) return null;
  return l.periods.find((p) => p.weeks.some((w) => due >= w.from && due < addDays(w.from, 7)))?.id ?? null;
}
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/* ---------- cards ---------- */

function GoalCard({ g, i, l, v, period }: { g: LdGoal; i: number; l: Ladder; v: V; period?: string }) {
  const now = (period ?? g.period) === "now";
  return (
    <div data-ld-goal={g.id} className={`relative flex flex-col gap-0.5 rounded-2xl border bg-surface px-3 py-2 ${now ? "border-2 border-accent" : "border-line"}`}>
      <span className="flex items-start justify-between gap-2">
        <span className="text-[13px] font-bold tracking-wide text-text2 uppercase">Goal {i + 1}</span>
        {v.handles && <More />}
      </span>
      <span className="text-[16px] leading-5 font-semibold">{g.name}</span>
      <span className="text-[13px] leading-[18px] text-text2">{g.line}</span>
      <span className="flex items-baseline gap-2 text-[14px]">
        <b className="text-[16px]">{g.current}</b> of {g.target}
        <span className={`ml-auto font-semibold ${KR[g.status]}`}>{KR_WORD[g.status]}</span>
      </span>
      <span className="text-[12px] leading-4 text-text2">Draws on: {g.draws.join(", ")}</span>
      {l.milestones.length === 0 && null}
    </div>
  );
}

function More({ open }: { open?: boolean }) {
  return (
    <span aria-label="More" className={`grid h-6 w-7 shrink-0 place-items-center rounded-md border ${open ? "border-accent bg-accent-soft text-accent-ink" : "border-transparent text-text2 hover:border-line"}`}><Icon name="more" size={16} /></span>
  );
}

function MilestoneCard({ m, v }: { m: LdMilestone; v: V }) {
  return (
    <div data-ld-ms={m.id} className="relative flex flex-col gap-0.5 rounded-xl border border-line bg-surface px-2.5 py-1.5">
      <span className="flex items-start gap-2">
        <span className="text-[14px] leading-[18px] font-semibold"><span className="simple-code mr-1">{m.code}</span>{m.name}</span>
        {v.handles && v.role !== "commenter" && <span className="ml-auto"><More /></span>}
      </span>
      <span className="text-[12px] leading-4 text-text2" title={m.measure}>
        {m.target === "Baseline" ? <>Reads <b className="text-text">{m.reading}</b> · baseline</> : <><b className="text-text">{m.reading}</b> of {m.target}</>}
        {m.due ? ` · by ${day(m.due)}` : ""} · {m.area} · <b className={`whitespace-nowrap ${KR[m.status]}`}>{m.when}</b>
      </span>
    </div>
  );
}

function FeatureCard({ f, v, ms, compact }: { f: LdFeature; v: V; ms?: string; compact?: boolean }) {
  const { ld2, sel, byId, waitsOnIt, handles } = v;
  const waits = f.depends.filter((d) => byId.has(d));
  const wanted = (waitsOnIt.get(f.id) ?? []).filter((d) => byId.has(d));
  const related = sel ? sel === f.id || waits.includes(sel) || (byId.get(sel)?.depends ?? []).includes(f.id) : true;
  const dim = sel && ld2 !== "c" && !related && !(v.st === "draw" && f.id === "f24");
  const isSel = sel === f.id;
  const menu = v.st === "menu" && f.id === "f15";
  const dragging = v.st === "drag" && f.id === "f15";
  const drawFrom = v.st === "draw" && f.id === "f34";
  const drawTo = v.st === "draw" && f.id === "f24";
  const loop = v.st === "loop" && (f.id === "f2" || f.id === "f4");
  const fresh = v.fresh === f.id;
  const prop = v.proposed.find((o) => "f" in o && (o.f === f.id || (o.k === "add" && o.f.id === f.id)));
  return (
    <div
      role="button"
      tabIndex={0}
      data-ld-card={f.id}
      onClick={() => v.setSel(isSel ? null : f.id)}
      className={`relative flex cursor-pointer flex-col gap-0.5 rounded-xl border bg-surface ${compact ? "px-2 py-1.5" : "px-2.5 py-1.5"} transition-opacity ${dim ? "[&>*]:opacity-40" : ""} ${isSel ? "border-accent ring-2 ring-accent/40" : "border-line hover:border-line-strong"} ${fresh ? "border-accent! ring-2 ring-accent/40" : ""} ${dragging ? "border-dashed opacity-40" : ""} ${drawTo ? "border-accent! bg-accent-soft" : ""} ${loop ? "border-crit! ring-2 ring-crit/30" : ""}`}
    >
      <span className="flex items-start gap-1.5">
        {handles && !compact && !v.phone && <span className="mt-0.5 cursor-grab text-text-faint" aria-label="Drag to move"><Icon name="grip" size={16} /></span>}
        <span className={`min-w-0 flex-1 font-semibold ${compact ? "text-[13px] leading-[17px]" : "text-[14px] leading-[19px]"}`}>
          <span className="simple-code mr-1 whitespace-nowrap">{f.code}</span>
          {f.name}
        </span>
        {(handles || (v.ld3 === "c" && v.may)) && !compact && <More open={menu} />}
      </span>
      <span className={`flex flex-wrap items-center gap-x-1.5 ${compact ? "text-[12px]" : "text-[13px]"} leading-5`}>
        <b className={WORK[f.status].cls}>{WORK[f.status].w}</b>
        {!compact && <span className="text-text2">· {span(f.start, f.end)}</span>}
        {ld2 !== "c" && (waits.length > 0 || wanted.length > 0) && (
          <span className="ml-auto flex gap-1.5 text-text2" title={`Waits on ${waits.length} · ${wanted.length} wait on it`}>
            {waits.length > 0 && <span>←{waits.length}</span>}
            {wanted.length > 0 && <span>{wanted.length}→</span>}
          </span>
        )}
      </span>
      {ld2 === "c" && waits.length > 0 && !compact && (
        <span className="flex flex-wrap gap-1">
          {waits.map((d) => (
            <span key={d} className={`inline-flex max-w-full items-start gap-1 rounded-xl border px-2 py-px text-[12px] leading-4 ${fresh && d === "f34" ? "border-accent bg-accent-soft text-accent-ink" : "border-line bg-surface2 text-text2"}`}>
              <span>Waits on <b>{byId.get(d)!.code}</b> {byId.get(d)!.name}</span>
              {handles && <span className="font-bold">×</span>}
            </span>
          ))}
        </span>
      )}
      {ld2 === "c" && handles && !compact && <span className={`w-max rounded-full border border-dashed px-2 text-[12px] leading-5 ${v.st === "pick" && f.id === "f24" ? "border-accent text-accent-ink" : "border-line-strong text-text2"}`}>+ Waits on</span>}
      {fresh && v.st === "added" && <span className="w-max rounded-full bg-accent-soft px-2 text-[12px] leading-5 font-semibold text-accent-ink">New</span>}
      {prop && <span className="w-fit rounded-xl bg-warn-bg px-2 py-px text-[12px] leading-4 font-semibold text-warn" title="Waiting for an approver">Suggested: {opWords(prop, v)}</span>}
      {ms && f.milestones.length > 1 && <span className="text-[12px] leading-4 text-text2">Also serves {f.milestones.filter((x) => x !== ms).map((x) => v.l.milestones.find((m) => m.id === x)!.code).join(", ")}</span>}
      {/* the edge dots a dependency is drawn from (LD2 a, while editing or the card is selected) */}
      {ld2 === "a" && handles && (isSel || drawFrom) && <span className={`absolute top-1/2 ${drawFrom ? "-left-[7px]" : "-right-[7px]"} h-3 w-3 -translate-y-1/2 rounded-full border-2 border-surface bg-accent`} />}
      {menu && !v.phone && <Menu f={f} v={v} />}
      {v.st === "pick" && f.id === "f24" && <Picker v={v} />}
    </div>
  );
}

function opWords(o: Op, v: V): string {
  const ms = (id: string) => { const m = v.l.milestones.find((x) => x.id === id)!; return `${m.code} ${m.name}`; };
  const fe = (id: string) => { const f = v.byId.get(id); return f ? `${f.code} ${f.name}` : ""; };
  if (o.k === "move") return `move to ${ms(o.to)}`;
  if (o.k === "delete") return "delete";
  if (o.k === "link") return `wait on ${fe(o.on)}`;
  if (o.k === "unlink") return `stop waiting on ${fe(o.on)}`;
  return "add";
}

function Menu({ f, v }: { f: LdFeature; v: V }) {
  const keys = v.ld3 === "c";
  const items: [string, string?][] = [["Open"], ["Move to…", keys ? "M" : undefined], ["Move up", keys ? "Alt ↑" : undefined], ["Move down", keys ? "Alt ↓" : undefined], ["Waits on…"], ["Delete", keys ? "Del" : undefined]];
  const next = v.ld3 === "c" ? "Move to…" : "Delete";
  return (
    <div className="absolute top-full right-1 z-20 mt-1 flex w-52 flex-col rounded-xl border border-line bg-surface py-1 shadow-lg" onClick={(e) => e.stopPropagation()}>
      {items.map(([w, k]) => (
        <span key={w} className={`flex items-center justify-between px-3 py-1.5 text-[14px] hover:bg-surface2 ${w === "Delete" ? "text-crit" : ""} ${w === next ? "bg-surface2 font-semibold" : ""}`} onClick={() => w === "Delete" && v.run({ k: "delete", f: f.id })}>
          {w === "Delete" ? "Delete (to Trash)" : w}
          {k && <kbd className="rounded border border-line px-1 text-[11px] text-text2">{k}</kbd>}
        </span>
      ))}
    </div>
  );
}

function Picker({ v }: { v: V }) {
  const hits = v.l.features.filter((f) => /report/i.test(f.name) && f.id !== "f24").slice(0, 6);
  return (
    <div className="absolute top-full left-0 z-20 mt-1 flex w-80 flex-col gap-1 rounded-xl border border-line bg-surface p-2 shadow-lg" onClick={(e) => e.stopPropagation()}>
      <span className="text-[13px] font-semibold text-text2">{v.byId.get("f24")!.code} {v.byId.get("f24")!.name} waits on</span>
      <span className="rounded-lg border border-accent px-2 py-1 text-[14px]">report<span className="animate-pulse">|</span></span>
      {hits.map((f) => (
        <span key={f.id} className={`rounded-lg px-2 py-1 text-[13px] leading-[17px] ${f.id === "f34" ? "bg-accent-soft font-semibold text-accent-ink" : "hover:bg-surface2"}`} onClick={() => v.run({ k: "link", f: "f24", on: f.id })}>
          <span className="simple-code mr-1">{f.code}</span>{f.name}
        </span>
      ))}
    </div>
  );
}

/** + slots: a feature under each milestone, a milestone under each goal. */
function AddSlot({ what, open }: { what: string; open?: boolean }) {
  if (open)
    return (
      <div className="flex flex-col gap-1.5 rounded-xl border border-accent bg-surface p-2">
        <span className="rounded-lg border border-line px-2 py-1 text-[14px]">Import from calendar tools with every date kept<span className="animate-pulse">|</span></span>
        <span className="flex gap-1.5"><Btn small primary>Add</Btn><Btn small>Cancel</Btn></span>
      </div>
    );
  return <span className="rounded-xl border border-dashed border-line-strong px-2.5 py-1 text-[13px] font-semibold text-text2 hover:bg-surface">+ Add {what}</span>;
}

function Placeholder() {
  return <span className="block h-[58px] rounded-xl border-2 border-dashed border-accent bg-accent-soft/60" />;
}

/** The card being dragged, under the pointer. */
function Ghost({ v }: { v: V }) {
  const f = v.byId.get("f15");
  if (v.st !== "drag" || !f) return null;
  return (
    <div className="pointer-events-none absolute z-30 w-[250px] rotate-2 rounded-xl border border-accent bg-surface px-2.5 py-1.5 shadow-2xl" data-ld-ghost style={{ left: "var(--gx)", top: "var(--gy)" }}>
      <span className="line-clamp-2 text-[14px] leading-[19px] font-semibold"><span className="simple-code mr-1">{f.code}</span>{f.name}</span>
      <b className="text-[13px] text-accent-ink">In progress</b>
    </div>
  );
}

/* ---------- LD1 a: goal columns (the Goal map becomes the ladder) ---------- */

function GoalColumns({ v, scale }: { v: V; scale?: number }) {
  const { l } = v;
  const root = useRef<HTMLDivElement>(null);
  const noGoal = l.features.filter((f) => !f.goal);
  return (
    <div ref={root} className="relative" style={scale ? { zoom: scale } : undefined}>
      <Arrows root={root} v={v} />
      <div className="grid grid-cols-4 gap-3">
        {l.goals.map((g, i) => (
          <div key={g.id} className="flex min-w-0 flex-col items-stretch">
            <GoalCard g={g} i={i} l={l} v={v} />
            <Stem />
            <div className="flex flex-col gap-1.5 rounded-2xl bg-accent-soft/50 p-2">
              <span className="text-[12px] font-bold tracking-wide text-text2 uppercase">Milestones</span>
              {l.milestones.filter((m) => m.goal === g.id).map((m) => <MilestoneCard key={m.id} m={m} v={v} />)}
              {v.handles && v.role !== "commenter" && <AddSlot what="milestone" />}
            </div>
            <Stem />
            <div className="flex flex-col gap-1.5 rounded-2xl bg-surface2 p-2">
              <span className="text-[12px] font-bold tracking-wide text-text2 uppercase">Work behind it</span>
              {l.milestones.filter((m) => m.goal === g.id).map((m) => (
                <Group key={m.id} m={m} v={v} />
              ))}
            </div>
          </div>
        ))}
      </div>
      {noGoal.length > 0 && (
        <div className="mt-3 flex flex-col gap-1.5 rounded-2xl border border-dashed border-line-strong p-2">
          <span data-ld-nogoal className="text-[12px] font-bold tracking-wide text-text2 uppercase">No goal yet · {noGoal.length}</span>
          <div className="grid grid-cols-4 gap-1.5">{noGoal.map((f) => <FeatureCard key={f.id} f={f} v={v} />)}</div>
        </div>
      )}
      <Ghost v={v} />
    </div>
  );
}

function Stem() {
  return <span aria-hidden className="mx-auto block h-3 w-0.5 bg-line-strong" />;
}

/** One milestone's features in the work column (a feature drawn once; its other milestone points to it). */
function Group({ m, v, compact }: { m: LdMilestone; v: V; compact?: boolean }) {
  const fs = v.l.features.filter((f) => f.milestones.includes(m.id));
  const drop = v.st === "drag" && m.id === "m6";
  return (
    <div data-ld-group={m.id} className={`flex flex-col gap-1.5 ${drop ? "rounded-xl outline-2 outline-offset-2 outline-accent" : ""} ${v.handles && v.ld3 === "b" ? "rounded-xl border border-dashed border-line p-1" : ""}`}>
      <span className="text-[12px] leading-4 font-semibold text-text2"><span className="simple-code">{m.code}</span> {m.name}</span>
      {drop && <Placeholder />}
      {fs.map((f) =>
        f.milestones[0] === m.id ? (
          <FeatureCard key={f.id} f={f} v={v} ms={m.id} compact={compact} />
        ) : (
          <span key={f.id} className="rounded-xl border border-dashed border-line-strong px-2 py-1 text-[12px] leading-4 text-text2"><b className="text-text">{f.code}</b> {f.name} · card under {v.l.milestones.find((x) => x.id === f.milestones[0])!.code}</span>
        ),
      )}
      {v.handles && v.st === "add" && m.id === "m5" ? <AddSlot what="feature" open /> : v.handles && !compact && <AddSlot what="feature" />}
    </div>
  );
}

/* ---------- dependency arrows (LD2 a: the selected card's; LD2 b: all) ---------- */

function Arrows({ root, v }: { root: RefObject<HTMLDivElement | null>; v: V }) {
  const [paths, setPaths] = useState<{ d: string; lit: boolean; key: string; mid: [number, number] }[]>([]);
  const [draw, setDraw] = useState<string | null>(null);
  const over = useRef<SVGSVGElement>(null);
  const { ld2, sel, l, st } = v;
  const me = useRef<SVGSVGElement>(null);
  useLayoutEffect(() => {
    // the svg's own parent: a parent's ref is not set yet when a child's layout effect runs
    const el = (me.current?.parentElement ?? root.current) as HTMLDivElement | null;
    if (!el || ld2 === "c") return;
    const measure = () => {
      const box = el.getBoundingClientRect();
      const s = el.offsetWidth ? box.width / el.offsetWidth : 1;
      const at = (id: string) => el.querySelector(`[data-ld-card="${id}"]`)?.getBoundingClientRect();
      const out: typeof paths = [];
      for (const f of l.features)
        for (const d of f.depends) {
          const lit = !!sel && (f.id === sel || d === sel);
          if (ld2 === "a" && !lit && !(st === "arrow" && f.id === "f3" && d === "f2")) continue;
          const a = at(d);
          const b = at(f.id);
          if (!a || !b) continue;
          out.push({ ...curve(a, b, box, s), lit: lit || st === "arrow", key: `${d}-${f.id}` });
        }
      setPaths(out);
      // the arrow being drawn: F-34 to F-24 (draw), or the refused F-04 to F-02 (loop)
      const pair = st === "draw" ? ["f34", "f24"] : st === "loop" ? ["f4", "f2"] : null;
      if (pair) {
        const a = at(pair[0]);
        const b = at(pair[1]);
        if (a && b) setDraw(curve(a, b, box, s).d);
      }
      if (st === "drag") {
        const g = el.querySelector('[data-ld-group="m6"]')?.getBoundingClientRect();
        if (g) {
          el.style.setProperty("--gx", `${(g.left - box.left) / s + 30}px`);
          el.style.setProperty("--gy", `${(g.top - box.top) / s + 30}px`);
        }
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [root, ld2, sel, l, st]);
  if (ld2 === "c") return null;
  const picked = paths.find((p) => p.key === "f2-f3");
  const word = (id: string) => { const f = v.byId.get(id)!; return <><b>{f.code}</b> {f.name}</>; };
  return (
    <>
    <svg ref={me} className="pointer-events-none absolute inset-0 z-0 h-full w-full overflow-visible" aria-hidden>
      <defs>
        <marker id="ld-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="var(--accent)" />
        </marker>
        <marker id="ld-head-dim" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="var(--text-faint)" />
        </marker>
      </defs>
      {paths.map((p) => (
        <path key={p.key} d={p.d} fill="none" markerEnd={p.lit ? "url(#ld-head)" : "url(#ld-head-dim)"} className={p.lit ? "text-accent" : "text-text-faint"} stroke="currentColor" strokeWidth={st === "arrow" && p.key === "f2-f3" ? 4 : p.lit ? 2 : 1.4} strokeOpacity={st === "arrow" && p.key !== "f2-f3" ? 0.35 : p.lit ? 0.95 : sel ? 0.25 : 0.7} />
      ))}
    </svg>
    <svg ref={over} className="pointer-events-none absolute inset-0 z-20 h-full w-full overflow-visible" aria-hidden>
      <defs>
        <marker id="ld-head-crit" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="var(--crit)" />
        </marker>
      </defs>
      {draw && <path d={draw} fill="none" stroke="currentColor" className={st === "loop" ? "text-crit" : "text-accent"} strokeWidth={2.5} strokeDasharray="6 4" markerEnd={st === "loop" ? "url(#ld-head-crit)" : "url(#ld-head)"} />}
      {st === "arrow" && picked && (
        <foreignObject x={picked.mid[0] + 14} y={picked.mid[1] - 40} width="280" height="110" className="pointer-events-auto">
          <span className="flex flex-col gap-1 rounded-xl border border-accent bg-surface px-2.5 py-1.5 text-[13px] leading-[17px] shadow">
            <span>{word("f3")} waits on {word("f2")}</span>
            <b className="text-crit">Remove</b>
          </span>
        </foreignObject>
      )}
    </svg>
    </>
  );
}

function curve(a: DOMRect, b: DOMRect, box: DOMRect, s: number): { d: string; mid: [number, number] } {
  const ay = (a.top + a.height / 2 - box.top) / s;
  const by = (b.top + b.height / 2 - box.top) / s;
  const same = Math.abs(a.left - b.left) < 40;
  if (same) {
    // In one column: out of the right edge and back in, bowed by how far apart they are.
    const x = (a.right - box.left) / s;
    const bow = 10 + Math.min(8, Math.abs(by - ay) / 60);
    return { d: `M${x},${ay} C${x + bow},${ay} ${x + bow},${by} ${x + 2},${by}`, mid: [x + bow * 0.75, (ay + by) / 2] };
  }
  const right = b.left > a.left;
  const x1 = ((right ? a.right : a.left) - box.left) / s;
  const x2 = ((right ? b.left : b.right) - box.left) / s;
  const dx = Math.max(40, Math.abs(x2 - x1) / 2) * (right ? 1 : -1);
  return { d: `M${x1},${ay} C${x1 + dx},${ay} ${x2 - dx},${by} ${x2},${by}`, mid: [(x1 + x2) / 2, (ay + by) / 2] };
}

/* ---------- LD1 b: a Ladder format on the Roadmap, columns grouped by period ---------- */

function PeriodColumns({ v }: { v: V }) {
  const { l } = v;
  const root = useRef<HTMLDivElement>(null);
  const groups = l.periods.map((p) => ({ p, cols: l.goals.map((g, i) => ({ g, i, ms: l.milestones.filter((m) => m.goal === g.id && periodOf(l, m.due) === p.id) })).filter((c) => c.ms.length) }));
  const undated = l.milestones.filter((m) => !m.due);
  return (
    <div className="overflow-x-auto pb-2" style={{ scrollbarGutter: "stable" }}>
      <div ref={root} className="relative flex w-max gap-5">
        <Arrows root={root} v={v} />
        {groups.map(({ p, cols }) => (
          <div key={p.id} className="flex flex-col gap-2">
            <PeriodStrip l={l} only={p.id} />
            <div className="flex gap-3">
              {cols.map(({ g, i, ms }) => (
                <div key={g.id} className="flex w-[232px] flex-col">
                  {groups.findIndex((x) => x.cols.some((c) => c.g.id === g.id)) === groups.findIndex((x) => x.p.id === p.id) ? (
                    <GoalCard g={g} i={i} l={l} v={v} period={p.id} />
                  ) : (
                    <span className="rounded-2xl border border-dashed border-line-strong px-3 py-2 text-[14px] leading-5 font-semibold"><span className="text-[13px] font-bold tracking-wide text-text2 uppercase">Goal {i + 1}</span> · {g.name}</span>
                  )}
                  <Stem />
                  <div className="flex flex-col gap-1.5 rounded-2xl bg-accent-soft/50 p-2" data-ld-krcol={`${p.id}-${g.id}`}>
                    {ms.map((m) => <MilestoneCard key={m.id} m={m} v={v} />)}
                  </div>
                  <Stem />
                  <div className="flex flex-col gap-1.5 rounded-2xl bg-surface2 p-2">{ms.map((m) => <Group key={m.id} m={m} v={v} />)}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
        <div className="flex w-[232px] flex-col gap-2">
          <span className="text-[13px] font-bold tracking-wide text-text2 uppercase">No dates yet · {undated.length} milestone</span>
          <div className="flex flex-col gap-1.5 rounded-2xl bg-accent-soft/50 p-2">{undated.map((m) => <MilestoneCard key={m.id} m={m} v={v} />)}</div>
          <div className="flex flex-col gap-1.5 rounded-2xl bg-surface2 p-2">{undated.map((m) => <Group key={m.id} m={m} v={v} />)}</div>
        </div>
        <Ghost v={v} />
      </div>
    </div>
  );
}

/* ---------- LD1 c: the Goal map's grid (areas × milestones) with the ladder's top and arrows ---------- */

function GridLadder({ v }: { v: V }) {
  const { l } = v;
  const root = useRef<HTMLDivElement>(null);
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto pb-2">
        <div ref={root} className="relative grid w-max gap-1.5" style={{ gridTemplateColumns: `120px repeat(${l.milestones.length}, 200px)` }}>
          <Arrows root={root} v={v} />
          <span />
          {l.goals.map((g, i) => (
            <div key={g.id} style={{ gridColumn: `span ${l.milestones.filter((m) => m.goal === g.id).length}` }}>
              <GoalCard g={g} i={i} l={l} v={v} />
            </div>
          ))}
          <span />
          {l.milestones.map((m) => <MilestoneCard key={m.id} m={m} v={v} />)}
          {l.areas.map((a) => (
            <Row key={a} a={a} v={v} />
          ))}
          <Ghost v={v} />
        </div>
      </div>
    </div>
  );
}

function Row({ a, v }: { a: string; v: V }) {
  const { l } = v;
  return (
    <>
      <span className="sticky left-0 z-[5] self-start bg-surface py-1 text-[13px] font-bold tracking-wide text-text2 uppercase">{a}</span>
      {l.milestones.map((m) => (
        <div key={m.id} className="flex min-h-10 flex-col gap-1 rounded-xl bg-surface2 p-1">
          {l.features.filter((f) => f.area === a && f.milestones[0] === m.id).map((f) => <FeatureCard key={f.id} f={f} v={v} ms={m.id} compact />)}
        </div>
      ))}
    </>
  );
}

/* ---------- LD1 d: a pan-and-zoom canvas, cards placed by the ladder but movable ---------- */

function Canvas({ v }: { v: V }) {
  const me = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // a card dragged off its place by hand: F-15 put under Goal 4's last feature (it no longer sits where the ladder puts it)
    if (me.current) me.current.style.height = `${Math.max(420, innerHeight - me.current.getBoundingClientRect().top - window.scrollY - 16)}px`;
    const c = me.current?.querySelector<HTMLElement>('[data-ld-card="f15"]');
    const cards = [...(me.current?.querySelectorAll<HTMLElement>("[data-ld-card]") ?? [])];
    const col4 = me.current?.querySelector('[data-ld-goal="g4"]')?.getBoundingClientRect();
    if (!c || !col4 || v.st !== "placed") return;
    const ms4 = me.current?.querySelector('[data-ld-ms="m10"]')?.getBoundingClientRect();
    const r = c.getBoundingClientRect();
    const z = r.width / c.offsetWidth;
    if (!ms4 || !cards.length) return;
    Object.assign(c.style, { transform: `translate(${(col4.right + 40 - r.left) / z}px, ${(ms4.top - r.top) / z}px)`, boxShadow: "0 8px 24px rgb(0 0 0 / .18)", borderColor: "var(--accent)", zIndex: "20" });
  }, [v.st]);
  return (
    <div ref={me} className="relative h-[560px] overflow-hidden rounded-2xl border border-line" style={{ backgroundImage: "radial-gradient(var(--color-line) 1px, transparent 1px)", backgroundSize: "18px 18px" }}>
      <div data-ld-canvas className="absolute top-3 left-4 right-4" style={{ transform: "translate(8px, 4px)" }}>
        <GoalColumns v={v} scale={0.72} />
      </div>
      <div className="absolute right-3 bottom-3 z-20 flex items-center gap-1 rounded-full border border-line bg-surface px-1.5 py-1 text-[14px] font-semibold shadow">
        <span className="grid h-7 w-7 place-items-center rounded-full hover:bg-surface2">−</span>
        <span className="px-1">72%</span>
        <span className="grid h-7 w-7 place-items-center rounded-full hover:bg-surface2">+</span>
        <span className="rounded-full px-2 hover:bg-surface2">Fit</span>
        {v.may && <span className="rounded-full px-2 hover:bg-surface2" title="Put every card back where the ladder places it">Tidy up</span>}
      </div>
      <div className="absolute bottom-3 left-3 z-20 flex h-24 w-40 gap-1 rounded-lg border border-line bg-surface/95 p-2 shadow" aria-label="Overview">
        {[0.9, 0.75, 0.6, 0.5].map((h, i) => <span key={i} className="flex-1 rounded-sm bg-surface2" style={{ height: `${h * 100}%` }} />)}
        <span className="absolute top-1.5 left-1.5 h-14 w-24 rounded border-2 border-accent" />
      </div>
    </div>
  );
}

/* ---------- phone: one goal at a time ---------- */

function Phone({ v }: { v: V }) {
  const { l } = v;
  const [gi, setGi] = useState(1);
  const g = l.goals[gi];
  const today = l.periods[0].weeks.find((w) => w.today)!;
  return (
    <div className="flex flex-col gap-2">
      <span className="rounded-xl bg-surface2 px-3 py-1.5 text-[14px]"><b>We are here: week of {day(today.from)}</b> · next: M4 Setup time under two days, Nov 13</span>
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {l.goals.map((x, i) => (
          <button type="button" key={x.id} onClick={() => setGi(i)} className={`shrink-0 rounded-full border px-3 py-1 text-[14px] font-semibold ${i === gi ? "border-accent bg-accent text-on-accent" : "border-line bg-surface"}`}>Goal {i + 1}</button>
        ))}
      </div>
      <GoalCard g={g} i={gi} l={l} v={v} />
      {l.milestones.filter((m) => m.goal === g.id).map((m) => (
        <div key={m.id} className="flex flex-col gap-1.5 rounded-2xl bg-surface2 p-2">
          <MilestoneCard m={m} v={v} />
          {l.features.filter((f) => f.milestones[0] === m.id).map((f) => <FeatureCard key={f.id} f={f} v={v} ms={m.id} />)}
          {v.handles && <AddSlot what="feature" />}
        </div>
      ))}
      {v.st === "menu" && <MoveSheet v={v} />}
    </div>
  );
}

/** Move to…: pick the goal, then the milestone (the phone's way, and LD3 c's on a desktop). */
function MoveSheet({ v, dialog }: { v: V; dialog?: boolean }) {
  const f = v.byId.get("f15")!;
  return (
    <div className={dialog ? "fixed inset-0 z-40 grid place-items-center bg-black/30" : "fixed inset-0 z-40 flex flex-col justify-end bg-black/30"}>
      <div className={dialog ? "flex w-[440px] flex-col gap-2 rounded-2xl border border-line bg-surface p-4 shadow-2xl" : "flex max-h-[80vh] flex-col gap-2 rounded-t-2xl border-t border-line bg-surface p-4 shadow-2xl"}>
        <b className="text-[16px]">Move <span className="simple-code">{f.code}</span> {f.name}</b>
        <div className={dialog ? "contents" : "flex min-h-0 flex-col gap-2 overflow-y-auto"}>
        {v.l.goals.map((g, i) => (
          <div key={g.id} className="flex flex-col gap-0.5">
            <span className="text-[12px] font-bold tracking-wide text-text2 uppercase">Goal {i + 1} · {g.name}</span>
            {v.l.milestones.filter((m) => m.goal === g.id).map((m) => (
              <label key={m.id} className={`flex items-center gap-2 rounded-lg px-2 py-1 text-[14px] ${m.id === "m6" ? "bg-accent-soft font-semibold text-accent-ink" : ""}`}>
                <input type="radio" name="ld-move" readOnly checked={m.id === "m6"} />
                <span className="simple-code">{m.code}</span> {m.name}{m.id === "m4" ? " (now)" : ""}
              </label>
            ))}
          </div>
        ))}
        </div>
        <span className="flex justify-end gap-2 border-t border-line pt-2"><Btn>Cancel</Btn><Btn primary onClick={() => v.run({ k: "move", f: "f15", from: "m4", to: "m6" })}>{v.role === "commenter" ? "Suggest move" : "Move"}</Btn></span>
      </div>
    </div>
  );
}

function Toast({ v, undo }: { v: V; undo: () => void }) {
  const f = (id: string) => v.byId.get(id) ?? mockLadder("owner").features.find((x) => x.id === id)!;
  const ms = (id: string) => v.l.milestones.find((m) => m.id === id)!;
  let words: ReactNode = null;
  let canUndo = true;
  const fn = (id: string) => `${f(id).code} ${f(id).name}`;
  const st = v.st;
  if (st === "moveto" && v.ld3 === "c") return <MoveSheet v={v} dialog />;
  if (st === "moved") words = v.role === "commenter" ? <>Suggested: move <b>{f("f15").code} {f("f15").name}</b> to <b>{ms("m6").code} {ms("m6").name}</b>. Sent to Dana Example to approve.</> : <>Moved <b>{f("f15").code} {f("f15").name}</b> to <b>{ms("m6").code} {ms("m6").name}</b></>;
  if (st === "deleted") words = v.role === "commenter" ? <>Suggested: delete <b>{fn("f15")}</b>. Sent to Dana Example.</> : <>Moved <b>{fn("f15")}</b> to Trash · <u>Open Trash</u></>;
  if (st === "linked") words = v.role === "commenter" ? <>Suggested: <b>{fn("f24")}</b> waits on <b>{fn("f34")}</b>. Sent to Dana Example.</> : <><b>F-24 {f("f24").name}</b> now waits on <b>F-34 {f("f34").name}</b></>;
  if (st === "unlinked") words = <><b>{fn("f3")}</b> no longer waits on <b>{fn("f2")}</b></>;
  if (st === "placed") words = <>Moved <b>{fn("f15")}</b> by hand</>;
  if (st === "added") words = <>Added <b>F-66 Import from calendar tools with every date kept</b> under <b>M5</b></>;
  if (st === "loop") {
    words = <>Not added, it would make a loop: <b>{fn("f4")}</b> already waits on <b>{fn("f2")}</b></>;
    canUndo = false;
  }
  if (!words) return null;
  return (
    <p role="status" className="fixed bottom-6 left-1/2 z-30 flex w-max max-w-[min(760px,calc(100vw-32px))] -translate-x-1/2 items-center gap-3 rounded-2xl bg-tip px-4 py-2.5 text-[15px] text-tip-text shadow-lg">
      <span>{words}</span>
      {canUndo && <button type="button" onClick={undo} className="font-bold underline">Undo</button>}
    </p>
  );
}

/** Shows the ladder when the URL asks for a proposal (?ld1=...), else the page as built. */
export function LadderSwitch({ where, children }: { where: "map" | "roadmap"; children: ReactNode }) {
  const ld1 = useSearchParams().get("ld1");
  if (!ld1 || (where === "roadmap") !== (ld1 === "b")) return <>{children}</>;
  return <GoalLadder where={where} />;
}
