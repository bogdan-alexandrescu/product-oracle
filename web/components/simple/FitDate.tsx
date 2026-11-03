"use client";
// MOCK-HOOK: the whole file is the mk-fitdate mock-up ("bring this date in"), switched by
// ?fd1=a|b|c (where the owner asks), ?fd2=a|b|c (how Oracle shows its picks), ?fd3=a|b|c (what
// happens after the pick), &phase=rest|open|mid|result|adjusted|hard and &theme=light|dark.

import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { Icon } from "@/components/ds/Icon";
import { Sheet } from "@/components/ds/Sheet";
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
  };
}

const FIT_SET = ["bulk", "analytics", "hold", "summary", "tone"]; // MOCK-HOOK
const MID_SET = ["bulk", "hold", "summary"]; // MOCK-HOOK
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
        start, so lands too late to help. What you can do:
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="simple-button simple-button-primary">
          Keep these cuts, move the date to {best}
        </button>
        <button type="button" className="simple-button">
          Keep {FIT_GOAL.hardTarget} with a smaller goal
        </button>
      </div>
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
                    {r.pwSaved > 0 && ` Saves ${r.pwSaved} person-weeks.`}
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
      <Locked hard={hard} />
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
              <span className="flex-1 font-semibold">{hard && p.id === "fit" ? "Middle cut" : p.name}</span>
              <span
                className={`tnum text-lg font-semibold ${over <= 0 ? "text-pass" : "text-warn"}`}
              >
                {date}
              </span>
            </span>
            <span className="simple-small">
              {over <= 0
                ? `Reaches ${target}, ${-over} days to spare.`
                : `${over} days after ${target}.`}{" "}
              {s.pw} person-weeks off.{" "}
              {p.id === "fit" && !hard ? "Oracle's pick. " : ""}
              {hard && p.id === "fit" ? "The goal starts at 34 of 40." : p.gives}
            </span>
            {on && (
              <ul className="flex flex-col gap-1 border-t border-line pt-2">
                {FIT_RECS.filter((r) => p.recs.includes(r.id)).map((r) => (
                  <li
                    key={r.id}
                    className="simple-small flex flex-wrap items-center gap-2"
                  >
                    <span className="font-medium text-text">{r.item}:</span>{" "}
                    {r.title.toLowerCase()} <CostTag r={r} />
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
      <Locked hard={hard} />
    </div>
  );
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
  return (
    <div className="flex flex-col gap-3" data-testid="fit-drag">
      <div className="flex flex-wrap items-center gap-3">
        <Meter ids={picks} target={target} compact />
      </div>
      {hard && <HardNote />}
      <p className="simple-small">
        Drag a bar past the dashed line to move it after the date; drag its end
        to ship a slice. Locked bars do not move.
      </p>
      <div className="relative overflow-x-auto rounded-xl border border-line">
        <div className="relative min-w-[720px] py-2">
          <div className="relative mt-12 ml-[220px] h-6 text-[12px] text-text2">
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
          <div className="pointer-events-none absolute top-0 bottom-0 ml-[220px] w-[calc(100%-220px)]">
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
          {FIT_ITEMS.map((it) => {
            const moved =
              (it.id === "bulk" && picks.includes("bulk")) ||
              (it.id === "tone" && picks.includes("tone")) ||
              (it.id === "analytics" && picks.includes("analytics"));
            const sliced = it.id === "summary" && picks.includes("summary");
            const isDrag = dragging && it.id === "analytics";
            const end = sliced ? "Jan 8" : it.end;
            const left = moved
              ? x("Feb 1") + (it.id === "tone" ? 18 : 10)
              : x(it.start);
            const width = Math.max(4, x(end) - x(it.start));
            return (
              <div key={it.id} className="flex h-10 items-center">
                <div className="w-[220px] flex-none truncate pr-2 pl-3 text-[14px]">
                  {it.guard && (
                    <Icon
                      name="lock"
                      size={16}
                      className="mr-1 inline text-crit"
                    />
                  )}
                  {it.title}
                </div>
                <div className="relative h-full flex-1">
                  {(moved || isDrag) && (
                    <div
                      className="absolute top-2 bottom-2 rounded-md border border-dashed border-line-strong"
                      style={{ left: `${x(it.start)}%`, width: `${width}%` }}
                    />
                  )}
                  <div
                    className={`absolute top-2 bottom-2 flex items-center rounded-md px-2 text-[12px] font-semibold whitespace-nowrap ${it.guard ? "bg-crit-bg text-crit" : moved ? "bg-surface2 text-text2" : "bg-accent-soft text-accent-ink"} ${isDrag ? "z-10 translate-x-[180px] -translate-y-1 shadow-lg ring-2 ring-accent" : ""}`}
                    style={{ left: `${left}%`, width: `${width}%` }}
                  >
                    {it.pw} pw
                    {moved
                      ? it.id === "tone"
                        ? " · next PRD"
                        : " · after date"
                      : sliced
                        ? " · slice"
                        : ""}
                    {it.guard && " · locked"}
                    {isDrag && " · drop to move off M2's gate"}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <Locked hard={hard} />
    </div>
  );
}

function Diff({ fd3 }: { fd3: "a" | "b" | "c" }) {
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
          {FIT_DIFF.prd.map((d) => (
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
          {FIT_DIFF.dates.map((d) => (
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
              {d.kind === "split" && (
                <span>(M2 launch Jan 25; the full 40 when M3 ships)</span>
              )}
            </li>
          ))}
        </ul>
      </div>
      <p className="simple-small">
        This took {FIT_DIFF.run.took} and cost {FIT_DIFF.run.costs}. The locked
        items stay as they are.
      </p>
    </div>
  );
}

/** The panel Oracle answers in: the picks (FD2), then what follows them (FD3). */
export function FitPanel({ onClose }: { onClose: () => void }) {
  const f = useFit();
  const hard = f.phase === "hard";
  const target = hard ? FIT_GOAL.hardTarget : FIT_GOAL.target;
  const [picks, setPicks] = useState<string[]>(
    hard ? ALL_SET : f.phase === "mid" ? MID_SET : FIT_SET,
  );
  const [pkg, setPkg] = useState(
    hard ? "deep" : f.phase === "mid" ? "light" : "fit",
  );
  const result = f.phase === "result" && f.fd3 !== "b";
  const title = result
    ? f.fd3 === "c"
      ? "Sent for a size check"
      : "Check the new drafts"
    : `Bring ${FIT_GOAL.milestone} in`;
  const body = result ? (
    <Diff fd3={f.fd3} />
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
          Approve both
        </button>
        <button type="button" className="simple-button">
          Back to the picks
        </button>
      </div>
    )
  ) : (
    <div className="flex flex-col gap-2">
      <p className="simple-small">
        {f.fd3 === "a" &&
          "Oracle drafts the next PRD and roadmap versions for you to check. About 40 seconds."}
        {f.fd3 === "b" &&
          "Oracle writes these into the PRD and roadmap drafts now. You can undo for 7 days."}
        {f.fd3 === "c" &&
          "Oracle drafts both, then Tomas Brook checks the sizes. Dates change once he approves."}
      </p>
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
      </button>
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
      <div className="sticky bottom-0 -mx-4 border-t border-line bg-surface px-4 py-3">
        {foot}
      </div>
    </div>
  );
  if (f.fd2 === "c" && !result)
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
            className="flex flex-wrap items-center justify-between gap-2 py-2"
          >
            <span className="flex items-center gap-2">
              {"lock" in it && it.lock && (
                <Icon name="lock" size={16} className="text-crit" />
              )}
              {it.t}
            </span>
            <span className="tnum simple-small flex gap-2">
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
    items: [{ t: "Thread summary card (edit)", d: "Apr 2" }],
  },
];

/** The Simple Roadmap's body in the mock-up: the goal's milestones, the date control (FD1 a), the panel and the result. */
export function FitRoadmap() {
  const f = useFit();
  const [open, setOpen] = useState(
    f.phase !== "rest" &&
      f.phase !== "adjusted" &&
      !(f.phase === "result" && f.fd3 === "b"),
  );
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
          <p>
            <span className="font-semibold">Applied to the drafts:</span> PRD
            version {FIT_GOAL.prdVersion + 1} and roadmap version{" "}
            {FIT_GOAL.roadmapVersion + 1}. M2 moves from Mar 12 to Jan 25.
            Publish them when you are ready.
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
          <Icon name="check" className="text-pass" />
          <p>
            {f.fd3 === "c"
              ? "Tomas Brook approved the sizes on Oct 23, 10:20 AM. "
              : f.fd3 === "b"
                ? "Published on Oct 22, 3:20 PM. "
                : "Approved on Oct 22, 3:14 PM. "}
            PRD version {FIT_GOAL.prdVersion + 1} and roadmap version{" "}
            {FIT_GOAL.roadmapVersion + 1} are live: M2 lands Jan 25. Home and
            Priorities show the new dates.
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
              className={`font-semibold ${after ? "text-pass" : "text-warn"}`}
            >
              {after ? "Jan 25" : FIT_GOAL.projected}
            </span>
          </span>
          {!after && (
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

/** FD1 b: a prompt on Simple Home when a target date is not reachable. */
export function FitHomeCard() {
  const f = useFit();
  const [open, setOpen] = useState(
    f.phase === "open" || f.phase === "mid" || f.phase === "hard",
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
        . Oracle found 7 changes that could bring it in
        {hard ? ", though none reach the target" : ""}.
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

/** FD1 c: an Ask Oracle question that turns into the flow. */
export function FitAsk() {
  const f = useFit();
  const [open, setOpen] = useState(
    f.phase === "open" || f.phase === "mid" || f.phase === "hard",
  );
  const bubble = (who: string, children: ReactNode, mine = false) => (
    <div
      className={`flex flex-col gap-1 ${mine ? "items-end" : "items-start"}`}
    >
      <span className="simple-small">{who}</span>
      <div
        className={`max-w-[560px] rounded-2xl px-4 py-3 ${mine ? "bg-accent-soft text-accent-ink" : "border border-line bg-surface"}`}
      >
        {children}
      </div>
    </div>
  );
  return (
    <section
      className="simple-card"
      data-testid="fit-ask-chat"
      aria-label="Ask Oracle"
    >
      <h2 className="simple-h2">Ask Oracle</h2>
      {bubble(
        "You · 3:10 PM",
        <>
          What can we cut or shrink to bring {FIT_GOAL.milestone} in to{" "}
          {f.phase === "hard" ? FIT_GOAL.hardTarget : FIT_GOAL.target}?
        </>,
        true,
      )}
      {bubble(
        "Oracle · 3:10 PM",
        <div className="flex flex-col gap-2">
          <p>
            {f.phase === "hard"
              ? `Even with every change I would make, M2 lands Jan 16, 8 days after Jan 8. Two items I will not cut: the send check and hiding card numbers.`
              : `Five changes bring M2 from Mar 12 to Jan 25. The biggest: move "Reply to similar threads at once" to M3, and take the reply time chart off M2's gate. The goal starts at 34 of 40.`}
          </p>
          <button
            type="button"
            className="simple-button simple-button-primary self-start"
            onClick={() => setOpen(true)}
          >
            Pick the changes
          </button>
        </div>,
      )}
      <div className="flex items-center gap-2 rounded-xl border border-line px-3 py-2 text-text2">
        <Icon name="ask" size={18} /> Ask a follow-up
      </div>
      {open && <FitPanel onClose={() => setOpen(false)} />}
    </section>
  );
}
