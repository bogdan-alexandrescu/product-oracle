"use client";
// MOCK-HOOK: the whole file is the mk-fitdate mock-up ("bring this date in"), switched by
// ?fd1=a|b|c (where the owner asks), ?fd2=a|b|c (how Oracle shows its picks), ?fd3=a|b|c (what
// happens after the pick), &phase=rest|open|mid|result|adjusted|hard and &theme=light|dark.

import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Icon } from "@/components/ds/Icon";
import { Sheet } from "@/components/ds/Sheet";
import { setPanelOpen } from "@/components/hop/open-state"; // MOCK-HOOK
import {
  FIT_AFTER,
  FIT_DIFF,
  FIT_GOAL,
  FIT_ITEMS,
  FIT_LOCKED,
  FIT_PACKAGES,
  FIT_RECS,
  FIT_TEAM,
  type FitRec,
} from "@/lib/api/mock/fit-date";

type Phase = "rest" | "open" | "mid" | "result" | "adjusted" | "hard"; // MOCK-HOOK

export function useFit() {
  // MOCK-HOOK
  const p = useSearchParams();
  const on = p.has("fd1") || p.has("fd2") || p.has("fd3");
  const theme = p.get("theme");
  useEffect(() => {
    if (theme === "light" || theme === "dark")
      document.documentElement.dataset.theme = theme; // MOCK-HOOK
  }, [theme]);
  return {
    on,
    fd1: (p.get("fd1") ?? "a") as "a" | "b" | "c",
    fd2: (p.get("fd2") ?? "a") as "a" | "b" | "c",
    fd3: (p.get("fd3") ?? "a") as "a" | "b" | "c",
    phase: (p.get("phase") ?? "rest") as Phase,
    closed: p.get("open") === "0", // MOCK-HOOK: &open=0 keeps the panel shut (a hard case at rest)
    step: p.get("step"), // MOCK-HOOK: &step=result shows the hard case's drafted changes
  };
}

const FIT_SET = ["bulk", "analytics", "hold", "summary", "tone"]; // MOCK-HOOK
const MID_SET = ["bulk", "hold", "summary"]; // MOCK-HOOK
const MID_A = ["bulk", "analytics", "hold", "summary"]; // MOCK-HOOK: FD2 a, the owner unticked Tone presets
const ALL_SET = [
  "bulk",
  "analytics",
  "hold",
  "summary",
  "tone",
  "snippets",
  "focus",
]; // MOCK-HOOK

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
function shift(days: number) {
  const d = new Date(Date.UTC(2027, 2, 12) - days * 86400000);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
function dayOf(label: string) {
  const [m, d] = label.split(" ");
  return Date.UTC(
    MONTHS.indexOf(m) >= 10 ? 2026 : 2027,
    MONTHS.indexOf(m),
    Number(d),
  );
}
function gap(a: string, b: string) {
  return Math.round((dayOf(a) - dayOf(b)) / 86400000);
}
function saved(ids: string[]) {
  return FIT_RECS.filter((r) => ids.includes(r.id)).reduce(
    (s, r) => ({ days: s.days + r.days, pw: s.pw + r.pwSaved }),
    { days: 0, pw: 0 },
  );
}

function Meter({
  ids,
  target,
  compact = false,
}: {
  ids: string[];
  target: string;
  compact?: boolean;
}) {
  const s = saved(ids);
  const date = shift(s.days);
  const over = gap(date, target);
  const pct = Math.max(
    4,
    Math.min(
      100,
      100 - (Math.max(0, over) / gap(FIT_GOAL.projected, target)) * 100,
    ),
  );
  return (
    <div
      className="flex flex-col gap-2 rounded-xl border border-line bg-surface2 p-3"
      data-testid="fit-meter"
      aria-live="polite"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="simple-small">New date for {FIT_GOAL.milestone}</span>
        <span
          className={`tnum text-xl font-semibold ${over <= 0 ? "text-pass" : "text-warn"}`}
        >
          {date}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-line" aria-hidden>
        <div
          className={`h-full rounded-full ${over <= 0 ? "bg-pass" : "bg-warn"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="simple-small">
        {over <= 0 ? (
          <>
            <span className="font-semibold text-pass">Reaches {target}</span>,{" "}
            {-over} {-over === 1 ? "day" : "days"} to spare.
          </>
        ) : (
          <>
            <span className="font-semibold text-warn">
              {over} days after {target}.
            </span>{" "}
            Was {FIT_GOAL.projected}.
          </>
        )}
        {!compact &&
          ` ${s.pw} person-weeks off the milestone, ${ids.length} ${ids.length === 1 ? "change" : "changes"} picked.`}
      </p>
    </div>
  );
}

function CostTag({ r }: { r: FitRec }) {
  const map = {
    goal: ["Goal at risk", "bg-warn-bg text-warn"],
    gate: ["Off the gate", "bg-warn-bg text-warn"],
    risk: ["Risk", "bg-warn-bg text-warn"],
    guard: ["Guardrail", "bg-crit-bg text-crit"],
    must: ["Must-include", "bg-crit-bg text-crit"],
    none: ["Small cost", "bg-surface2 text-text2"],
  } as const;
  const [l, c] = map[r.costKind];
  return (
    <span className={`rounded-full px-2 py-0.5 text-[12px] font-semibold ${c}`}>
      {l}
    </span>
  );
}

function Locked({ hard = false }: { hard?: boolean }) {
  return (
    <div
      className="flex flex-col gap-2 rounded-xl border border-line p-3"
      data-testid="fit-locked"
    >
      <p className="flex items-center gap-2 font-semibold">
        <Icon name="lock" size={18} /> Oracle will not cut these
      </p>
      <ul className="flex flex-col gap-1.5">
        {FIT_LOCKED.map((l) => (
          <li key={l.item} className="simple-small">
            <span className="font-medium text-text">{l.item}</span> ({l.pw}{" "}
            person-weeks). {l.why}
            {hard && l.pw === 3 && (
              <span className="font-semibold text-crit">
                {" "}
                Cutting it would reach Jan 8; Oracle will not offer it.
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function HardNote() {
  const best = shift(saved(ALL_SET).days);
  return (
    <div
      className="flex flex-col gap-2 rounded-xl border border-crit/40 bg-crit-bg p-3"
      data-testid="fit-hard"
    >
      <p className="font-semibold text-crit">
        No set of cuts reaches {FIT_GOAL.hardTarget}. The earliest is {best},{" "}
        {gap(best, FIT_GOAL.hardTarget)} days after.
      </p>
      <p className="simple-small text-text">
        Every change is picked. Another engineer counts only after a 3-week
        start, so lands too late to help. Two items stay whatever the date:
      </p>
      <Locked hard />
    </div>
  );
}

/** FD2 a: one ranked list with tick boxes and a live new-date meter. */
function RankedList({
  picks,
  setPicks,
  target,
  hard,
}: {
  picks: string[];
  setPicks: (p: string[]) => void;
  target: string;
  hard: boolean;
}) {
  return (
    <div className="flex flex-col gap-3" data-testid="fit-ranked">
      <div className="sticky top-0 z-10 -mx-1 bg-surface px-1 pb-1">
        <Meter ids={picks} target={target} />
      </div>
      {hard && <HardNote />}
      <p className="simple-small">
        Ranked by days saved for the least harm. Tick what to change.
      </p>
      <ol className="flex flex-col gap-2">
        {FIT_RECS.map((r, i) => {
          const must = r.id === "drafts";
          const on = picks.includes(r.id);
          return (
            <li
              key={r.id}
              className={`rounded-xl border p-3 ${on ? "border-accent bg-accent-soft/40" : "border-line"} ${must ? "opacity-70" : ""}`}
            >
              <label className="flex cursor-pointer gap-3">
                <input
                  type="checkbox"
                  className="mt-1 size-5 flex-none accent-[var(--accent)]"
                  checked={on}
                  disabled={must}
                  onChange={() =>
                    setPicks(
                      on ? picks.filter((p) => p !== r.id) : [...picks, r.id],
                    )
                  }
                />
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="font-semibold">
                      {i + 1}. {r.item}
                    </span>
                    <span className="tnum text-[14px] font-semibold text-pass">
                      {must ? "Must-include" : `${r.days} days sooner`}
                    </span>
                  </span>
                  <span className="simple-small">
                    <span className="font-medium text-text">{r.title}.</span>{" "}
                    {r.effect}.
                    {r.pwSaved > 0 &&
                      ` Saves ${r.pwSaved} ${r.pwSaved === 1 ? "person-week" : "person-weeks"}.`}
                  </span>
                  <span className="simple-small flex flex-wrap items-center gap-2">
                    <CostTag r={r} /> {r.cost}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ol>
      {!hard && <Locked />}
    </div>
  );
}

/** FD2 b: three packages, least to most cut. */
function Packages({
  pkg,
  setPkg,
  target,
  hard,
}: {
  pkg: string;
  setPkg: (p: string) => void;
  target: string;
  hard: boolean;
}) {
  const chosen = FIT_PACKAGES.find((p) => p.id === pkg);
  return (
    <div className="flex flex-col gap-3" data-testid="fit-packages">
      {hard && <HardNote />}
      <p className="simple-small">
        Three ways to bring {FIT_GOAL.milestone} in, from least to most cut.
        Pick one.
      </p>
      {FIT_PACKAGES.map((p) => {
        const s = saved(p.recs);
        const date = shift(s.days);
        const over = gap(date, target);
        const on = p.id === pkg;
        return (
          <label
            key={p.id}
            className={`flex cursor-pointer flex-col gap-2 rounded-xl border p-3 ${on ? "border-accent bg-accent-soft/40" : "border-line"}`}
          >
            <span className="flex items-center gap-3">
              <input
                type="radio"
                name="fit-pkg"
                className="size-5 accent-[var(--accent)]"
                checked={on}
                onChange={() => setPkg(p.id)}
              />
              <span className="flex-1 font-semibold">{p.name}</span>
              <span
                className={`tnum text-lg font-semibold ${over <= 0 ? "text-pass" : "text-warn"}`}
              >
                {date}
              </span>
            </span>
            <span className="simple-small">
              {p.id === "fit" && !hard ? "Oracle\u2019s pick. " : ""}
              {over <= 0
                ? `Reaches ${target} with ${-over} days to spare`
                : `${over} days after ${target}`}
              ; {s.pw} person-weeks off. {hard ? p.hardGives : p.gives}
            </span>
            {on && (
              <ul className="flex flex-col gap-1 border-t border-line pt-2">
                {FIT_RECS.filter((r) => p.recs.includes(r.id)).map((r) => (
                  <li
                    key={r.id}
                    className="simple-small flex flex-wrap items-center gap-2"
                  >
                    <span className="font-medium text-text">{r.item}:</span>{" "}
                    {r.title} <CostTag r={r} />
                  </li>
                ))}
              </ul>
            )}
          </label>
        );
      })}
      {chosen && (
        <p className="simple-small">
          To change one item inside a package, untick it on the next step.
        </p>
      )}
      {!hard && <Locked />}
    </div>
  );
}

/** Where a bar sits once the picks are made: kept M2 items slide left so they end by M2's new date. */
function placed(id: string, start: string, end: string, picks: string[], m2: string) {
  // MOCK-HOOK
  const fixed: Record<string, [string, string]> = {
    bulk: ["Feb 8", "Mar 19"],
    analytics: ["Jan 25", "Mar 5"],
  };
  if (id in fixed && picks.includes(id)) return fixed[id];
  if (id === "summary" && picks.includes("summary")) return [start, "Jan 8"];
  const base = dayOf("Dec 30");
  const squeeze = (label: string) => {
    const d = dayOf(label);
    if (d <= base) return label;
    const r = (dayOf(m2) - base) / (dayOf(FIT_GOAL.projected) - base);
    const n = new Date(base + (d - base) * r);
    return `${MONTHS[n.getUTCMonth()]} ${n.getUTCDate()}`;
  };
  const e = id === "snippets" && picks.includes("snippets") ? "Jan 14" : end;
  // The fitting pick matches the roadmap after approval exactly.
  const after = m2 === "Jan 25" ? ({ snippets: "Jan 18", redact: "Jan 25" } as Record<string, string>)[id] : undefined;
  return [squeeze(start), after ?? squeeze(e)];
}

/** FD2 c: a before/after timeline; drag an item past the date line. */
function DragTimeline({
  picks,
  target,
  hard,
  dragging,
}: {
  picks: string[];
  target: string;
  hard: boolean;
  dragging: boolean;
}) {
  // Weeks from Nov 16 to Apr 12: 21 columns.
  const start = Date.UTC(2026, 10, 16);
  const span = 21 * 7;
  const x = (label: string) => ((dayOf(label) - start) / 86400000 / span) * 100;
  const s = saved(picks);
  const newEnd = shift(s.days);
  const ticks = ["Dec 1", "Jan 1", "Feb 1", "Mar 1", "Apr 1"];
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // MOCK-HOOK: a phone starts the bars scrolled so the target line is in view.
    const el = scroller.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    const names = (el.querySelector("[data-names]") as HTMLElement | null)?.offsetWidth ?? 0;
    const at = names + ((el.scrollWidth - names) * x(target)) / 100;
    el.scrollLeft = at - names - (el.clientWidth - names) * 0.6;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
  const rows = [
    // MOCK-HOOK: M1's calendar-only wait has a bar of its own.
    { id: "hold", title: "M1 7-day hold", pw: 0, owner: "Rina Vale", start: "Dec 4", end: "Dec 11" },
    ...FIT_ITEMS,
  ];
  const label = (id: string, guard: boolean) => {
    if (guard) return "locked";
    if (!picks.includes(id)) return "";
    return (
      {
        bulk: "after the date, in M3",
        analytics: "no longer holds M2",
        tone: "moved to the next PRD",
        summary: "first slice",
        snippets: "first slice",
        hold: "M2 work no longer waits",
      } as Record<string, string>
    )[id];
  };
  return (
    <div className="flex flex-col gap-3" data-testid="fit-drag">
      <Meter ids={picks} target={target} compact />
      {hard && <HardNote />}
      <p className="simple-small">
        Drag a bar past the dashed line to move it after the date; drag its end
        to ship a slice. Locked bars do not move.
      </p>
      <div
        ref={scroller}
        className="relative min-w-0 overflow-x-auto rounded-xl border border-line"
      >
        <div className="relative min-w-[760px] py-2">
          <div className="relative mt-12 ml-[170px] h-6 max-[600px]:ml-[128px] text-[12px] text-text2">
            {ticks.map((t) => (
              <span
                key={t}
                className="absolute -translate-x-1/2"
                style={{ left: `${x(t)}%` }}
              >
                {t.split(" ")[0]}
              </span>
            ))}
          </div>
          <div className="pointer-events-none absolute top-0 bottom-0 left-[170px] right-0 max-[600px]:left-[128px]">
            <div
              className="absolute top-0 bottom-0 border-l-2 border-dashed border-accent"
              style={{ left: `${x(target)}%` }}
            >
              <span className="absolute top-0 right-1 z-10 rounded bg-accent px-1.5 text-[12px] font-semibold whitespace-nowrap text-on-accent">
                Target {target}
              </span>
            </div>
            <div
              className="absolute top-0 bottom-0 border-l-2 border-warn"
              style={{ left: `${x(newEnd)}%` }}
            >
              <span className="absolute top-6 left-1 rounded bg-warn-bg px-1.5 text-[12px] font-semibold whitespace-nowrap text-warn">
                M2 now {newEnd}
              </span>
            </div>
          </div>
          {rows.map((it) => {
            const on = picks.includes(it.id);
            const gone = on && it.id === "tone";
            const isDrag = dragging && it.id === "analytics" && !on;
            const wait = it.id === "hold";
            const guard = "guard" in it && !!it.guard;
            const [a, b] = placed(it.id, it.start, it.end, picks, newEnd);
            const moved = on && (a !== it.start || b !== it.end || gone);
            const width = Math.max(4, x(b) - x(a));
            const tag = label(it.id, guard);
            return (
              <div key={it.id} className="flex h-12 items-center">
                <div data-names className="sticky left-0 z-[5] flex h-full w-[170px] flex-none flex-col justify-center max-[600px]:w-[128px] border-r border-line bg-surface pr-2 pl-3 leading-tight">
                  <span className="truncate text-[14px]">
                    {guard && (
                      <Icon
                        name="lock"
                        size={16}
                        className="mr-1 inline text-crit"
                      />
                    )}
                    {it.title}
                  </span>
                  <span className="truncate text-[12px] text-text2">
                    {wait ? "a wait, no work" : `${it.pw} person-weeks`}
                  </span>
                </div>
                <div className="relative h-full flex-1">
                  {(moved || isDrag) && (
                    <div
                      className="absolute top-2.5 bottom-2.5 rounded-md border border-dashed border-line-strong"
                      style={{
                        left: `${x(it.start)}%`,
                        width: `${Math.max(4, x(it.end) - x(it.start))}%`,
                      }}
                    />
                  )}
                  {!gone && (
                    <div
                      className={`absolute top-2.5 bottom-2.5 flex items-center overflow-hidden rounded-md px-2 text-[12px] font-semibold whitespace-nowrap ${guard ? "bg-crit-bg text-crit" : wait ? "bg-[repeating-linear-gradient(135deg,var(--surface2)_0_6px,var(--line)_6px_12px)] text-text2" : on && (it.id === "bulk" || it.id === "analytics") ? "bg-surface2 text-text2" : "bg-accent-soft text-accent-ink"} ${isDrag ? "z-10 translate-x-[160px] -translate-y-1 shadow-lg ring-2 ring-accent" : ""}`}
                      style={{ left: `${x(a)}%`, width: `${width}%` }}
                    >
                      {width >= 9 && tag}
                    </div>
                  )}
                  {!gone && width < 9 && tag && (
                    <span
                      className="absolute top-3 text-[12px] font-semibold whitespace-nowrap text-text2"
                      style={{ left: `calc(${x(b)}% + 8px)` }}
                    >
                      {tag}
                    </span>
                  )}
                  {gone && (
                    <span
                      className="absolute top-3 text-[12px] font-semibold whitespace-nowrap text-text2"
                      style={{ left: `calc(${x(it.end)}% + 8px)` }}
                    >
                      {tag}
                    </span>
                  )}
                  {isDrag && (
                    <span
                      className="absolute top-2 z-20 rounded-md bg-hero px-2 py-1 text-[12px] font-semibold whitespace-nowrap text-on-accent shadow-tip"
                      style={{ left: `calc(${x(it.start) + width}% + 172px)` }}
                    >
                      Drop: M2 stops waiting for it
                    </span>
                  )}
                </div>
              </div>
            );
          })}
          {picks.includes("focus") && (
            <div className="flex h-10 items-center">
              <div className="sticky left-0 z-[5] flex h-full w-[170px] flex-none items-center max-[600px]:w-[128px] border-r border-line bg-surface pr-2 pl-3 text-[14px]">
                Team focus
              </div>
              <p className="simple-small px-3">
                70% to 80%: every bar above is 6 days shorter.
              </p>
            </div>
          )}
        </div>
      </div>
      {!hard && <Locked />}
    </div>
  );
}

function Diff({ fd3, hard = false }: { fd3: "a" | "b" | "c"; hard?: boolean }) {
  const dates = hard ? FIT_DIFF.hardDates : FIT_DIFF.dates; // MOCK-HOOK
  const prd = hard ? [...FIT_DIFF.prd, ...FIT_DIFF.hardPrd] : FIT_DIFF.prd; // MOCK-HOOK
  return (
    <div className="flex flex-col gap-3" data-testid="fit-diff">
      <p className="simple-small">
        {fd3 === "c"
          ? "Oracle drafted these. Tomas Brook, the engineering lead, checks the sizes before the dates change."
          : `Oracle drafted PRD version ${FIT_GOAL.prdVersion + 1} and roadmap version ${FIT_GOAL.roadmapVersion + 1}. Nothing changes until you approve.`}
      </p>
      <div className="rounded-xl border border-line p-3">
        <p className="mb-2 font-semibold">
          {FIT_GOAL.prd}: version {FIT_GOAL.prdVersion} →{" "}
          {FIT_GOAL.prdVersion + 1}
        </p>
        <ul className="flex flex-col gap-1.5">
          {prd.map((d) => (
            <li key={d.item} className="simple-small">
              <span className="font-medium text-text">{d.item}</span>:{" "}
              {d.change}
            </li>
          ))}
        </ul>
      </div>
      <div className="rounded-xl border border-line p-3">
        <p className="mb-2 font-semibold">
          Roadmap dates: version {FIT_GOAL.roadmapVersion} →{" "}
          {FIT_GOAL.roadmapVersion + 1}
        </p>
        <ul className="flex flex-col gap-1.5">
          {dates.map((d) => (
            <li
              key={d.what}
              className="simple-small flex flex-wrap items-center gap-x-2 gap-y-0.5"
            >
              <span className="font-medium text-text">{d.what}</span>
              <del className="rounded bg-crit-bg px-1.5 text-crit">
                {d.before}
              </del>
              <span aria-hidden>→</span>
              <ins
                className={`rounded px-1.5 no-underline ${d.kind === "in" ? "bg-pass-bg text-pass" : "bg-warn-bg text-warn"}`}
              >
                {d.after}
              </ins>
              {"note" in d && d.note && (
                <span className="basis-full">{d.note}.</span>
              )}
            </li>
          ))}
        </ul>
      </div>
      <p className="simple-small">
        Every date that moves is listed. This took {FIT_DIFF.run.took} and cost{" "}
        {FIT_DIFF.run.costs}. The locked items keep their size.
      </p>
    </div>
  );
}

/** True on a phone-width screen (the timeline then opens in the same sheet as the list). */
function usePhoneWidth() {
  // MOCK-HOOK
  const [p, setP] = useState(false);
  useEffect(() => {
    const m = window.matchMedia("(max-width: 600px)");
    setP(m.matches);
    const on = () => setP(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return p;
}

/** The panel Oracle answers in: the picks (FD2), then what follows them (FD3). */
export function FitPanel({ onClose }: { onClose: () => void }) {
  const f = useFit();
  const hard = f.phase === "hard";
  const target = hard ? FIT_GOAL.hardTarget : FIT_GOAL.target;
  const [picks, setPicks] = useState<string[]>(
    hard ? ALL_SET : f.phase === "mid" ? (f.fd2 === "a" ? MID_A : MID_SET) : FIT_SET,
  );
  const phone = usePhoneWidth();
  const [pkg, setPkg] = useState(
    hard ? "deep" : f.phase === "mid" ? "light" : "fit",
  );
  const result =
    (f.phase === "result" || (hard && f.step === "result")) && f.fd3 !== "b";
  const title = result
    ? f.fd3 === "c"
      ? "Sent for a size check"
      : "Check the new drafts"
    : `Bring ${FIT_GOAL.milestone} in`;
  const body = result ? (
    <Diff fd3={f.fd3} hard={hard} />
  ) : f.fd2 === "b" ? (
    <Packages pkg={pkg} setPkg={setPkg} target={target} hard={hard} />
  ) : f.fd2 === "c" ? (
    <DragTimeline
      picks={picks}
      target={target}
      hard={hard}
      dragging={f.phase === "mid"}
    />
  ) : (
    <RankedList picks={picks} setPicks={setPicks} target={target} hard={hard} />
  );
  const n =
    f.fd2 === "b"
      ? (FIT_PACKAGES.find((p) => p.id === pkg)?.recs.length ?? 0)
      : picks.length;
  const foot = result ? (
    f.fd3 === "c" ? (
      <div className="flex flex-col gap-2">
        <p className="simple-small">
          <span className="font-semibold text-text">
            Waiting on Tomas Brook
          </span>{" "}
          since Oct 22, 3:12 PM. Most size checks come back within a day; you
          hear on Home.
        </p>
        <button type="button" className="simple-button" onClick={onClose}>
          Close
        </button>
      </div>
    ) : (
      <div className="flex flex-wrap gap-2">
        <button type="button" className="simple-button simple-button-primary">
          {hard ? "Approve both and the Jan 16 target" : "Approve both"}
        </button>
        <button type="button" className="simple-button">
          Back to the picks
        </button>
      </div>
    )
  ) : (
    <div className="flex flex-col gap-2">
      <p className="simple-small">
        {hard &&
          `None of this reaches ${FIT_GOAL.hardTarget}, so the target moves to Jan 16 with it. `}
        {f.fd3 === "a" &&
          "Oracle drafts the next PRD and roadmap versions for you to check. About 40 seconds, about $0.20."}
        {f.fd3 === "b" &&
          "Oracle writes these into the PRD and roadmap drafts now. You can undo for 7 days."}
        {f.fd3 === "c" &&
          "Oracle drafts both, then Tomas Brook checks the sizes. Dates change once he approves."}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="simple-button simple-button-primary"
          disabled={n === 0}
        >
          {f.fd3 === "b"
            ? `Apply ${n} changes to the drafts`
            : f.fd3 === "c"
              ? `Send ${n} changes for a size check`
              : `Draft ${n} changes`}
          {hard && " and the Jan 16 target"}
        </button>
        {hard && (
          <button type="button" className="simple-button">
            Keep {FIT_GOAL.hardTarget} with a smaller goal
          </button>
        )}
      </div>
    </div>
  );
  const inner = (
    <div className="flex flex-col gap-4 px-4 pt-3">
      <p className="simple-small">
        Goal: <span className="font-medium text-text">{FIT_GOAL.title}</span>.
        Target {target}; on today&rsquo;s plan {FIT_GOAL.projected}.{" "}
        {FIT_TEAM.engineers} engineers at {Math.round(FIT_TEAM.focus * 100)}%
        focus.
      </p>
      {body}
      <div className="sticky bottom-0 z-30 -mx-4 border-t border-line bg-surface px-4 py-3">
        {foot}
      </div>
    </div>
  );
  if (f.fd2 === "c" && !result && !phone)
    // The timeline needs room: a wide panel at the right edge on a desktop, the whole screen on a phone.
    return (
      <div
        className="fixed inset-0 z-50 flex justify-end"
        data-testid="fit-panel"
      >
        <div
          aria-hidden
          className="absolute inset-0 bg-hero/50"
          onClick={onClose}
        />
        <div
          role="dialog"
          aria-modal="true"
          aria-label={title}
          className="relative flex h-dvh w-[min(1040px,100vw)] flex-col border-l border-line bg-surface text-text shadow-tip min-[601px]:rounded-l-inspector"
        >
          <div className="flex min-h-11 flex-none items-center gap-2 border-b border-line pr-1 pl-4">
            <h2 className="min-w-0 flex-1 truncate font-display text-lg font-bold tracking-heading">
              {title}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label={`Close ${title}`}
              className="grid size-11 place-items-center rounded-button text-text2 hover:bg-surface2"
            >
              <Icon name="x" size={20} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{inner}</div>
        </div>
      </div>
    );
  return (
    <Sheet open title={title} onClose={onClose} side tall testId="fit-panel">
      {inner}
    </Sheet>
  );
}

function Lane({ m, after }: { m: (typeof FIT_AFTER)[number]; after: boolean }) {
  return (
    <section className="simple-card" aria-label={m.milestone}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="simple-h2">{m.milestone}</h2>
        {m.date && (
          <span className="tnum flex items-center gap-2 text-[15px]">
            {after && m.was !== m.date && (
              <del className="text-text2">{m.was}</del>
            )}
            <span className="font-semibold">{m.date}</span>
          </span>
        )}
      </div>
      <ul className="flex flex-col divide-y divide-line">
        {m.items.map((it) => (
          <li
            key={it.t}
            className="flex items-start justify-between gap-3 py-2"
          >
            <span className="flex min-w-0 flex-1 items-start gap-2">
              {"lock" in it && it.lock && (
                <Icon name="lock" size={16} className="text-crit" />
              )}
              {it.t}
            </span>
            <span className="tnum simple-small flex flex-none gap-2 whitespace-nowrap">
              {after && "was" in it && it.was && <del>{it.was}</del>}
              <span className="font-medium text-text">{it.d}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const BEFORE = [
  // MOCK-HOOK: today's plan, milestone order then priority order.
  FIT_AFTER[0],
  {
    milestone: "M2 Agent reply flow",
    date: "Mar 12",
    was: "Mar 12",
    items: FIT_ITEMS.map((i) => ({ t: i.title, d: i.end, lock: !!i.guard })),
  },
  {
    milestone: "M3 Team inbox",
    date: "Apr 2",
    was: "Apr 2",
    items: [{ t: "Edit a thread summary", d: "Apr 2" }],
  },
];

/** The Simple Roadmap's body in the mock-up: the goal's milestones, the date control (FD1 a), the panel and the result. */
export function FitRoadmap() {
  const f = useFit();
  const [open, setOpen] = useState(
    f.phase !== "rest" &&
      f.phase !== "adjusted" &&
      !f.closed &&
      !(f.phase === "result" && f.fd3 === "b"),
  );
  const drafted = f.phase === "result" && f.fd3 === "b"; // MOCK-HOOK: applied to the drafts, not yet live
  const after =
    f.phase === "adjusted" || (f.phase === "result" && f.fd3 === "b");
  const lanes = after ? FIT_AFTER : BEFORE;
  const banner = useMemo(() => {
    if (f.phase === "result" && f.fd3 === "b")
      return (
        <div
          className="simple-card flex-row flex-wrap items-center justify-between gap-3"
          data-testid="fit-applied"
        >
          <p className="min-w-0 flex-1">
            <span className="font-semibold">Applied to the drafts:</span> PRD
            version {FIT_GOAL.prdVersion + 1} and roadmap version{" "}
            {FIT_GOAL.roadmapVersion + 1}. In them M2 moves from Mar 12 to Jan
            25; the live plan keeps Mar 12 until you publish. You can undo all 5
            changes for 7 days, until Oct 29.
          </p>
          <span className="flex gap-2">
            <button
              type="button"
              className="simple-button simple-button-primary"
            >
              Publish both
            </button>
            <button type="button" className="simple-button">
              Undo all 5
            </button>
          </span>
        </div>
      );
    if (f.phase === "adjusted")
      return (
        <div
          className="simple-card flex-row flex-wrap items-center gap-3"
          data-testid="fit-approved"
        >
          <p className="flex items-start gap-2">
            <Icon name="check" className="mt-0.5 flex-none text-pass" />
            <span>
            {f.fd3 === "c"
              ? "Tomas Brook approved the sizes on Oct 22, 5:40 PM. "
              : f.fd3 === "b"
                ? "Published on Oct 22, 3:20 PM. "
                : "Approved on Oct 22, 3:14 PM. "}
            PRD version {FIT_GOAL.prdVersion + 1} and roadmap version{" "}
            {FIT_GOAL.roadmapVersion + 1} are live: M2 lands Jan 25. Home and
            Priorities show the new dates.
            {f.fd3 === "b" && " You can undo it until Oct 29."}
            </span>
          </p>
        </div>
      );
    return null;
  }, [f.phase, f.fd3]);
  const m2 = lanes[1];
  return (
    <div className="flex flex-col gap-3" data-testid="fit-roadmap">
      <div className="simple-card" data-testid="fit-goal">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="simple-h2">Goal: {FIT_GOAL.title}</h2>
          <span className="simple-small">{FIT_GOAL.now}</span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="tnum">
            Target{" "}
            <span className="font-semibold">
              {f.phase === "hard" ? FIT_GOAL.hardTarget : FIT_GOAL.target}
            </span>
          </span>
          <span className="tnum">
            On the plan{" "}
            <span
              className={`font-semibold ${after && !drafted ? "text-pass" : "text-warn"}`}
            >
              {after && !drafted ? "Jan 25" : FIT_GOAL.projected}
            </span>
          </span>
          {drafted && (
            <span className="tnum">
              In the drafts <span className="font-semibold">Jan 25</span>
            </span>
          )}
          {(!after || drafted) && (
            <span className="simple-status simple-status-risk">
              {f.phase === "hard" ? "9 weeks late" : FIT_GOAL.late}
            </span>
          )}
          {f.fd1 === "a" && !after && (
            <button
              type="button"
              className="simple-button simple-button-primary"
              data-testid="fit-ask"
              onClick={() => setOpen(true)}
            >
              Bring this date in
            </button>
          )}
        </div>
      </div>
      {banner}
      <div className="grid gap-3 min-[641px]:grid-cols-2">
        <Lane m={m2} after={after} />
        <div className="flex flex-col gap-3">
          {lanes
            .filter((l) => l !== m2)
            .map((l) => (
              <Lane key={l.milestone} m={l} after={after} />
            ))}
        </div>
      </div>
      {open && <FitPanel onClose={() => setOpen(false)} />}
    </div>
  );
}

const APPROVED = {
  // MOCK-HOOK: who made the new versions live, per FD3 proposal.
  a: "You approved PRD version 4 and roadmap version 7 on Oct 22, 3:14 PM.",
  b: "You published PRD version 4 and roadmap version 7 on Oct 22, 3:20 PM.",
  c: "Tomas Brook checked the sizes and approved on Oct 22, 5:40 PM.",
};

/** FD1 b: a prompt on Simple Home when a target date is not reachable. */
export function FitHomeCard() {
  const f = useFit();
  if (f.phase === "adjusted")
    return (
      <section className="simple-card" data-testid="fit-home" aria-label="A date brought in">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="simple-h2">{FIT_GOAL.milestone} is on its date</h2>
          <span className="simple-status simple-status-ok">On target</span>
        </div>
        <p>
          It now lands <span className="font-semibold">Jan 25</span> (was <del>Mar 12</del>), 4 days before Jan 29. {APPROVED[f.fd3]}
        </p>
        <ul className="simple-small flex flex-col gap-1">
          <li>Reply to similar threads at once moved to M3 Team inbox: it lands Mar 19, and M3 lands Apr 9 (was Apr 2).</li>
          <li>The reply time chart is still built and lands Mar 5; M2 no longer waits for it.</li>
          <li>Tone presets left this PRD; Priorities lists it under the next one.</li>
          <li>The goal starts at 34 of 40 replied threads at launch and reaches 40 with M3.</li>
        </ul>
      </section>
    );
  return <FitHomePrompt />;
}

function FitHomePrompt() {
  const f = useFit();
  const [open, setOpen] = useState(
    (f.phase === "open" || f.phase === "mid" || f.phase === "hard") && !f.closed,
  );
  const hard = f.phase === "hard";
  return (
    <section
      className="simple-card"
      data-testid="fit-home"
      aria-label="A date you can bring in"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="simple-h2">{FIT_GOAL.milestone} misses its date</h2>
        <span className="simple-status simple-status-risk">
          {hard ? "9 weeks late" : FIT_GOAL.late}
        </span>
      </div>
      <p>
        On today&rsquo;s plan it lands{" "}
        <span className="font-semibold">{FIT_GOAL.projected}</span>; the target
        is{" "}
        <span className="font-semibold">
          {hard ? FIT_GOAL.hardTarget : FIT_GOAL.target}
        </span>
        .{" "}
        {hard
          ? "Oracle found 7 changes that bring it closer, though none reach the target."
          : "Oracle found 7 changes that could bring it in; 5 are enough."}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="simple-button simple-button-primary"
          onClick={() => setOpen(true)}
        >
          See what to cut
        </button>
        <button type="button" className="simple-button simple-button-quiet">
          Keep the date as it is
        </button>
      </div>
      {open && <FitPanel onClose={() => setOpen(false)} />}
    </section>
  );
}

/** Home's greeting and "since your last visit" line once an approval has just happened (FD3 home frames). */
export function FitGreet({ text }: { text: string }) {
  // MOCK-HOOK
  const f = useFit();
  return <>{f.on && f.phase === "adjusted" ? "Good afternoon" : text}</>;
}
export function FitSince({ text }: { text: string }) {
  // MOCK-HOOK
  const f = useFit();
  return (
    <>
      {f.on && f.phase === "adjusted" && f.fd1 === "b"
        ? "The one change since your last visit is the new M2 date above."
        : text}
    </>
  );
}

/**
 * FD1 c: the question is asked in the built Ask Oracle panel (the rail's Ask Oracle; Ask in a
 * phone's top bar), and Oracle's answer card there opens the picks. It stands in for the panel's
 * thread while ?fd1=c is set.
 */
export function FitAsk() {
  const f = useFit();
  const hard = f.phase === "hard";
  const done = f.phase === "adjusted";
  const [open, setOpen] = useState(
    (f.phase === "open" || f.phase === "mid" || hard) && !f.closed,
  );
  const who = (name: string, at: string) => (
    <p className="text-sm text-text2">
      <span className="font-semibold text-text">{name}</span> · {at}
    </p>
  );
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="fit-ask-chat"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-3">
        <div className="flex flex-col items-end gap-1">
          {who("You", "3:10 PM")}
          <p className="max-w-[300px] rounded-2xl bg-accent-soft px-3 py-2 text-accent-ink">
            What can we cut or shrink to bring {FIT_GOAL.milestone} in to{" "}
            {hard ? FIT_GOAL.hardTarget : FIT_GOAL.target}?
          </p>
        </div>
        <div className="flex flex-col gap-2">
          {who("Oracle", "3:10 PM")}
          <p>
            {hard
              ? "Even with every change I would make, M2 lands Jan 16, 8 days after Jan 8. I will not cut the send check or hiding card numbers: they keep drafts safe."
              : "Five changes bring M2 from Mar 12 to Jan 25, 4 days before the target. The biggest: move “Reply to similar threads at once” to M3, and stop M2 waiting for the reply time chart. The goal starts at 34 of 40."}
          </p>
          <div
            className="flex flex-col gap-2 rounded-xl border border-line bg-surface2 p-3"
            data-testid="fit-ask-card"
          >
            <p className="flex items-baseline justify-between gap-2">
              <span className="font-semibold">{FIT_GOAL.milestone}</span>
              <span className="tnum">
                <del className="text-text2">Mar 12</del>{" "}
                <span className={`font-semibold ${hard ? "text-warn" : "text-pass"}`}>
                  {hard ? "Jan 16" : "Jan 25"}
                </span>
              </span>
            </p>
            <p className="simple-small">
              {hard ? "7 changes, all of them" : "5 of 7 changes"}; the send check
              and hiding card numbers stay.
            </p>
            {done ? (
              <p className="simple-small font-semibold text-pass">
                Picked and approved: 5 changes.
              </p>
            ) : (
              <button
                type="button"
                className="simple-button simple-button-primary self-start"
                onClick={() => setOpen(true)}
              >
                Pick the changes
              </button>
            )}
          </div>
          <p className="text-[13px] text-text2">
            This answer took about 6 seconds and cost about 2 cents.
          </p>
        </div>
        {done && (
          <div className="flex flex-col gap-2">
            {who("Oracle", { a: "3:15 PM", b: "3:21 PM", c: "5:41 PM" }[f.fd3])}
            <p>
              Done. {APPROVED[f.fd3]} M2 Agent reply flow now lands Jan 25 (was
              Mar 12); M3 Team inbox moves to Apr 9. Home, Roadmap and
              Priorities show the new dates.
            </p>
          </div>
        )}
      </div>
      <div className="flex-none border-t border-line px-4 py-3">
        <div className="flex items-center gap-2 rounded-xl border border-line-strong px-3 py-2.5 text-text2">
          Ask a follow-up
        </div>
      </div>
      {open && <FitPanel onClose={() => setOpen(false)} />}
    </div>
  );
}

/** Stands the FD1 c thread in for the Ask panel's own chat while ?fd1=c is set. */
export function FitAskGate({ children }: { children: ReactNode }) {
  // MOCK-HOOK
  const f = useFit();
  return f.on && f.fd1 === "c" ? <FitAsk /> : <>{children}</>;
}

/** Opens the Ask panel on Home for FD1 c (the frames start with the question asked). */
export function FitAskOpener() {
  // MOCK-HOOK
  const f = useFit();
  const want = f.on && f.fd1 === "c";
  useEffect(() => {
    if (want) setPanelOpen(true, false);
  }, [want]);
  return null;
}
