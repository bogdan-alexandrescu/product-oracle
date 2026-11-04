"use client";

/**
 * Bring a date in (Simple; the owner's picks FD1 a "On the roadmap date", FD2 a "Ranked list, live
 * date", FD3 a "Draft, check, approve"). Simple Roadmap shows a goal milestone with its target and
 * its date on today's plan; when the plan misses the target, "Bring this date in" opens Oracle's
 * answer in a side panel over the roadmap (a sheet on a phone): one list of changes ranked by days
 * saved, a tick box each, a meter with the live date (oracle.simple.fit_date: the capacity queue,
 * no model call), the items Oracle will not cut, then the drafted re-plan to approve. When no set
 * reaches the target, "Keep <date> with a smaller goal" opens the Baseline goal the milestone's
 * gate counts toward in a sheet over the panel (its target and due date, the target focused); it
 * saves through PATCH /v1/baseline/entities/{id} and the answer reloads against the new target.
 */

import { useEffect, useRef, useState } from "react";

import { GoalFields, goalDraft, goalPatch, problemsOf, typedTarget, type GoalDraft, type GoalProblem } from "@/app/baseline/_components/goal-fields";
import { Icon } from "@/components/ds/Icon";
import { Sheet } from "@/components/ds/Sheet";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { calendarDay, formatInZone, useCompanyZone } from "@/lib/dates";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

type Goal = Schemas["FitGoalOut"];
type Answer = Schemas["FitAnswerOut"];
type Change = Schemas["FitChangeOut"];
type Draft = Schemas["FitDraftOut"];
type Lane = Schemas["FitLane"];
type BaselineGoal = Schemas["FitBaselineGoalOut"];

const day = (d: string | null | undefined) => (d ? calendarDay(d) : "Not dated");
const gap = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "6 weeks late", "4 days late". */
export function lateWords(days: number): string {
  return days >= 14 ? `${Math.round(days / 7)} weeks late` : `${plural(days, "day")} late`;
}

/** The goal milestones Simple Roadmap shows (GET /v1/simple/fit-date), latest first. */
export function useFitGoals() {
  return useQuery("simple-fit-date", () => unwrap(api.GET("/v1/simple/fit-date")));
}

function Meter({ date, target, was, pw, n, milestone }: { date: string; target: string; was: string; pw: number; n: number; milestone: string }) {
  const over = gap(date, target);
  const pct = Math.max(4, Math.min(100, 100 - (Math.max(0, over) / Math.max(1, gap(was, target))) * 100));
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface2 p-3" data-testid="fit-meter" aria-live="polite">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="simple-small">New date for {milestone}</span>
        <span className={`tnum text-xl font-semibold ${over <= 0 ? "text-pass" : "text-warn"}`} data-testid="fit-meter-date" data-state={over <= 0 ? "reach" : "miss"}>
          {day(date)}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-line" aria-hidden>
        <div className={`h-full rounded-full ${over <= 0 ? "bg-pass" : "bg-warn"}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="simple-small">
        {over <= 0 ? (
          <>
            <span className="font-semibold text-pass">Reaches {day(target)}</span>, {plural(-over, "day")} to spare.
          </>
        ) : (
          <>
            <span className="font-semibold text-warn">
              {plural(over, "day")} after {day(target)}.
            </span>{" "}
            Was {day(was)}.
          </>
        )}
        {` ${pw} person-weeks off the milestone, ${plural(n, "change")} picked.`}
      </p>
    </div>
  );
}

function CostTag({ c }: { c: Change }) {
  const map = {
    goal: ["Goal at risk", "bg-warn-bg text-warn"],
    gate: ["Off the gate", "bg-warn-bg text-warn"],
    risk: ["Risk", "bg-warn-bg text-warn"],
    must: ["Must-include", "bg-crit-bg text-crit"],
    none: ["Small cost", "bg-surface2 text-text2"],
  } as const;
  const [l, cls] = map[c.cost_kind];
  return <span className={`rounded-full px-2 py-0.5 text-[12px] font-semibold ${cls}`}>{l}</span>;
}

function Locked({ a, hard = false }: { a: Answer; hard?: boolean }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line p-3" data-testid="fit-locked">
      <p className="flex items-center gap-2 font-semibold">
        <Icon name="lock" size={18} /> Oracle will not cut these
      </p>
      <ul className="flex flex-col gap-1.5">
        {a.locked.map((l) => (
          <li key={l.item} className="simple-small">
            <span className="font-medium text-text">{l.item}</span> ({l.pw} person-weeks). {l.why}
            {hard && l.would_reach && <span className="font-semibold text-crit"> Cutting it would reach {day(a.target)}; Oracle will not offer it.</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function HardNote({ a }: { a: Answer }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-crit/40 bg-crit-bg p-3" data-testid="fit-hard">
      <p className="font-semibold text-crit">
        No set of cuts reaches {day(a.target)}. The earliest is {day(a.best_date)}, {plural(gap(a.best_date, a.target), "day")} after.
      </p>
      <p className="simple-small text-text">
        Every change is picked.
        {a.hire &&
          (a.hire.reaches
            ? ` Another engineer, counted after a ${a.hire.start_weeks}-week start, brings it to ${day(a.hire.date)}.`
            : ` Another engineer counts only after a ${a.hire.start_weeks}-week start, so lands too late to help.`)}{" "}
        {a.locked.length === 2 ? "Two items stay" : a.locked.length === 1 ? "One item stays" : `${a.locked.length} items stay`} whatever the date:
      </p>
      <Locked a={a} hard />
    </div>
  );
}

/** FD2 a: one ranked list with tick boxes and the live new-date meter. */
function RankedList({ a, picks, setPicks, live }: { a: Answer; picks: string[]; setPicks: (p: string[]) => void; live: Schemas["FitLiveOut"] | null }) {
  const hard = !a.reachable;
  return (
    <div className="flex flex-col gap-3" data-testid="fit-ranked">
      <div className="sticky top-0 z-10 -mx-1 bg-surface px-1 pb-1">
        <Meter date={live?.date ?? a.pick_date} target={a.target} was={a.today} pw={live?.pw_saved ?? 0} n={picks.length} milestone={a.milestone_name} />
      </div>
      {hard && <HardNote a={a} />}
      <p className="simple-small">Ranked by days saved for the least harm. Tick what to change.</p>
      <ol className="flex flex-col gap-2">
        {a.changes.map((c, i) => {
          const must = !c.pickable;
          const on = picks.includes(c.id);
          return (
            <li key={c.id} className={`rounded-xl border p-3 ${on ? "border-accent bg-accent-soft/40" : "border-line"} ${must ? "opacity-70" : ""}`} data-testid={`fit-change-${c.id}`}>
              <label className="flex cursor-pointer gap-3">
                <input
                  type="checkbox"
                  className="mt-1 size-5 flex-none accent-[var(--accent)]"
                  checked={on}
                  disabled={must}
                  onChange={() => setPicks(on ? picks.filter((p) => p !== c.id) : [...picks, c.id])}
                />
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="flex items-baseline gap-1.5 font-semibold">
                      {must && (
                        <span className="self-center" data-testid="fit-change-lock" title="Must-include: Oracle will not tick it">
                          <Icon name="lock" size={16} className="text-crit" />
                        </span>
                      )}
                      {i + 1}. {c.item}
                    </span>
                    <span className="tnum text-[14px] font-semibold text-pass">{c.days} days sooner</span>
                  </span>
                  <span className="simple-small">
                    <span className="font-medium text-text">{c.title}.</span> {c.effect}.
                    {c.pw_saved > 0 && ` Saves ${c.pw_saved} ${c.pw_saved === 1 ? "person-week" : "person-weeks"}.`}
                  </span>
                  <span className="simple-small flex flex-wrap items-center gap-2">
                    <CostTag c={c} /> {c.cost}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ol>
      {!hard && <Locked a={a} />}
    </div>
  );
}

function Diff({ a, d }: { a: Answer; d: Draft }) {
  return (
    <div className="flex flex-col gap-3" data-testid="fit-diff">
      <p className="simple-small">
        Oracle drafted PRD version {d.next_version}
        {d.roadmap_version != null && ` and roadmap version ${d.roadmap_version + 1}`}. Nothing changes until you approve.
      </p>
      <div className="rounded-xl border border-line p-3">
        <p className="mb-2 font-semibold">
          {a.prd.title}: version {d.prd_version} → {d.next_version}
        </p>
        <ul className="flex flex-col gap-1.5">
          {d.changes.map((c) => (
            <li key={c.item} className="simple-small">
              <span className="font-medium text-text">{c.item}</span>: {c.change}
            </li>
          ))}
        </ul>
      </div>
      <div className="rounded-xl border border-line p-3">
        <p className="mb-2 font-semibold">
          Roadmap dates{d.roadmap_version != null && `: version ${d.roadmap_version} → ${d.roadmap_version + 1}`}
        </p>
        <ul className="flex flex-col gap-1.5" data-testid="fit-diff-dates">
          {d.dates.map((x) => (
            <li key={x.what} className="simple-small flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="font-medium text-text">{x.what}</span>
              <del className="rounded bg-crit-bg px-1.5 text-crit">{day(x.before)}</del>
              <span aria-hidden>→</span>
              <ins className={`rounded px-1.5 no-underline ${x.kind === "in" ? "bg-pass-bg text-pass" : "bg-warn-bg text-warn"}`}>{day(x.after)}</ins>
              {x.note && <span className="basis-full">{x.note}.</span>}
            </li>
          ))}
        </ul>
      </div>
      {d.needs_estimate.length > 0 && (
        <p className="simple-small" data-testid="fit-needs-estimate">
          {d.needs_estimate.map((e) => e.item).join(" and ")} {d.needs_estimate.length === 1 ? "needs" : "need"} a new estimate
          {d.needs_estimate.some((e) => e.owner) && ` from ${d.needs_estimate.map((e) => e.owner).filter(Boolean).join(" and ")}`}; its date here reads estimate pending until then.
        </p>
      )}
      <p className="simple-small">
        Every date that moves is listed. The locked items keep their size.
      </p>
    </div>
  );
}

/** The goal's target in words ("At least 30 threads"); the plain number when it is not typed. */
function targetWords(g: BaselineGoal, value = g.target): string {
  const t = typedTarget({ target: value, unit: g.unit, comparison: g.comparison });
  return t ? t.words : `${value ?? "no target"}`;
}

/** The Baseline goal's edit form (target and due date, the target focused) in a sheet over the panel. */
function GoalSheet({ goal, onClose, onSaved }: { goal: BaselineGoal; onClose: () => void; onSaved: () => void }) {
  const entity = useQuery(`baseline-entity:${goal.id}`, () => unwrap(api.GET("/v1/baseline/entities/{entity_id}", { params: { path: { entity_id: goal.id } } })));
  const [draft, setDraft] = useState<GoalDraft | null>(null);
  const [problems, setProblems] = useState<GoalProblem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attrs = entity.data?.attrs ?? null;
  const d = draft ?? (attrs ? goalDraft(attrs) : null);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!d || !attrs) return;
    if (d.target.trim() && !Number.isFinite(Number(d.target))) {
      setError("The target value must be a number.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.PATCH("/v1/baseline/entities/{entity_id}", { params: { path: { entity_id: goal.id } }, body: { attrs: goalPatch(d, attrs), origin: "user" } });
      const refused = res.response.status === 422 ? problemsOf(res.error) : null;
      if (refused) {
        setProblems(refused);
        return;
      }
      if (res.response.status === 202) {
        setError("The goal is locked, so your change was saved as a proposal for an approver. The answer keeps the current target until it is accepted.");
        return;
      }
      await unwrap(Promise.resolve(res));
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open title={`Goal: ${goal.title}`} onClose={onClose} dialog testId="fit-goal-sheet">
      <form className="flex flex-col gap-3 px-4 pt-3 pb-4" onSubmit={(e) => void save(e)} aria-label="Edit the goal" noValidate>
        <p className="simple-small">
          The PRD asks for {targetWords(goal, goal.plan_target)}. A smaller target needs less of the goal&rsquo;s own work before the milestone, so Oracle works out the date again.
        </p>
        {entity.error && <p className="simple-small text-crit">{entity.error}</p>}
        {!d && !entity.error && <p className="simple-small">Opening the goal…</p>}
        {d && <GoalFields draft={d} onChange={setDraft} problems={problems} targetOnly />}
        {error && (
          <p role="alert" className="simple-small text-crit">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <button type="submit" className="simple-button simple-button-primary" disabled={!d || busy}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button type="button" className="simple-button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Sheet>
  );
}

/** The panel Oracle answers in: the picks, then the drafted re-plan to approve. */
export function FitPanel({ goal, onClose, onApproved, onGoalSaved }: { goal: Goal; onClose: () => void; onApproved: (before: Lane[]) => void; onGoalSaved?: () => void }) {
  const { can } = useMe();
  const answer = useQuery(`simple-fit-answer:${goal.prd.slug}:${goal.milestone}`, () =>
    unwrap(api.GET("/v1/simple/prds/{prd}/fit-date", { params: { path: { prd: goal.prd.slug }, query: { milestone: goal.milestone } } })),
  );
  const a = answer.data;
  const [picks, setPicks] = useState<string[] | null>(null);
  const [live, setLive] = useState<Schemas["FitLiveOut"] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editGoal, setEditGoal] = useState(false);
  const asked = useRef(0);
  const chosen = picks ?? a?.pick ?? [];
  useEffect(() => {
    if (!a) return;
    const n = ++asked.current;
    void unwrap(api.POST("/v1/simple/prds/{prd}/fit-date/live", { params: { path: { prd: goal.prd.slug } }, body: { milestone: goal.milestone, picks: chosen } }))
      .then((r) => n === asked.current && setLive(r))
      .catch((e) => setError(errorMessage(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a, chosen.join(",")]);
  const hard = !!a && !a.reachable;
  const bg = a?.baseline_goal ?? null;
  const goalSaved = () => {
    setEditGoal(false);
    setPicks(null);
    setDraft(null);
    void answer.reload();
    onGoalSaved?.();
  };
  const title = draft ? "Check the new drafts" : `Bring ${goal.milestone_name} in`;
  const mayDraft = can("fit_date_draft");
  const runDraft = async () => {
    setBusy(true);
    setError(null);
    try {
      setDraft(await unwrap(api.POST("/v1/simple/prds/{prd}/fit-date/draft", { params: { path: { prd: goal.prd.slug } }, body: { milestone: goal.milestone, picks: chosen } })));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const approve = async () => {
    setBusy(true);
    setError(null);
    try {
      await unwrap(api.POST("/v1/simple/prds/{prd}/fit-date/approve", { params: { path: { prd: goal.prd.slug } }, body: { milestone: goal.milestone, picks: chosen } }));
      onApproved(goal.lanes);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  const newTarget = (live && live.over_days > 0 ? live.date : null) ?? draft?.new_target;
  const foot = draft ? (
    <div className="flex flex-wrap gap-2">
      <button type="button" className="simple-button simple-button-primary" disabled={busy || !can("fit_date_approve")} onClick={() => void approve()}>
        {draft.new_target ? `Approve both and the ${day(draft.new_target)} target` : "Approve both"}
      </button>
      <button type="button" className="simple-button" disabled={busy} onClick={() => setDraft(null)}>
        Back to the picks
      </button>
    </div>
  ) : (
    <div className="flex flex-col gap-2">
      <p className="simple-small">
        {hard && newTarget && `None of this reaches ${day(a!.target)}, so the target moves to ${day(newTarget)} with it. `}
        {a && "Oracle drafts the next PRD and roadmap versions for you to check."}
        {!mayDraft && " Only an approver can draft them."}
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="simple-button simple-button-primary" disabled={!a || chosen.length === 0 || busy || !mayDraft} onClick={() => void runDraft()} data-testid="fit-draft">
          {busy ? "Drafting…" : `Draft ${plural(chosen.length, "change")}`}
          {hard && newTarget && ` and the ${day(newTarget)} target`}
        </button>
      </div>
    </div>
  );
  // The goal's sheet sits beside the panel, not inside it: Escape closes the top one only.
  return (
    <>
      <Sheet open title={title} onClose={onClose} side tall testId="fit-panel">
        <div className="flex flex-col gap-4 px-4 pt-3">
          <p className="simple-small">
            Goal: <span className="font-medium text-text">{goal.goal ?? goal.milestone_name}</span>. Target {day(goal.target)}; on today&rsquo;s plan {day(goal.today)}. {goal.team.engineers}{" "}
            {goal.team.engineers === 1 ? "engineer" : "engineers"} at {Math.round(goal.team.focus * 100)}% focus.
          </p>
          {answer.error && <p className="simple-small text-crit">{answer.error}</p>}
          {!a && !answer.error && <p className="simple-small">Working out the changes…</p>}
          {a && bg?.smaller && (
            <p className="simple-small rounded-xl border border-line bg-surface2 p-3" data-testid="fit-smaller" aria-live="polite">
              Counted against the smaller goal: <span className="font-medium text-text">{targetWords(bg)}</span> (the PRD asks for {targetWords(bg, bg.plan_target)}).{" "}
              <span className={`font-semibold ${a.reachable ? "text-pass" : "text-warn"}`}>
                {a.reachable ? `${a.milestone_name} now reaches ${day(a.target)}.` : `${a.milestone_name} still lands after ${day(a.target)}.`}
              </span>
            </p>
          )}
          {a && (draft ? <Diff a={a} d={draft} /> : <RankedList a={a} picks={chosen} setPicks={setPicks} live={live} />)}
          {a && hard && !draft && (
            <div className="flex flex-col gap-2 rounded-xl border border-line p-3" data-testid="fit-keep-date">
              {!bg ? (
                <p className="simple-small">
                  Oracle finds no Baseline goal named &ldquo;{goal.goal ?? goal.milestone_name}&rdquo;, so it cannot offer to keep {day(a.target)} with a smaller goal.
                </p>
              ) : (
                <>
                  <p className="simple-small">
                    Or keep {day(a.target)} and ask for less: the goal is {targetWords(bg)}.{!bg.can_edit && " Only an owner or approver can change it."}
                  </p>
                  {bg.can_edit && (
                    <div>
                      <button type="button" className="simple-button" onClick={() => setEditGoal(true)}>
                        Keep {day(a.target)} with a smaller goal
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
          {error && (
            <p role="alert" className="simple-small text-crit">
              {error}
            </p>
          )}
          <div className="sticky bottom-0 z-30 -mx-4 border-t border-line bg-surface px-4 py-3">{foot}</div>
        </div>
      </Sheet>
      {editGoal && bg && <GoalSheet goal={bg} onClose={() => setEditGoal(false)} onSaved={goalSaved} />}
    </>
  );
}

function LaneCard({ m, was, before, open }: { m: Lane; was?: string | null; before?: Lane[]; open: Opener }) {
  const old = new Map((before ?? []).flatMap((l) => l.items.map((i) => [i.id, i.date] as const)));
  return (
    <section className="simple-card" aria-label={m.name} data-testid={`fit-lane-${m.code}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="simple-h2">{m.name}</h2>
        {m.date && (
          <span className="tnum flex items-center gap-2 text-[15px]">
            {was && was !== m.date && <del className="text-text2">{day(was)}</del>}
            <span className="font-semibold">{day(m.date)}</span>
          </span>
        )}
      </div>
      <ul className="flex flex-col divide-y divide-line">
        {[...m.items].sort((x, y) => (x.date ?? "9999").localeCompare(y.date ?? "9999")).map((it) => {
          const prior = old.get(it.id);
          return (
            <li key={it.id} className="flex items-start justify-between gap-3 py-2">
              <span className="flex min-w-0 flex-1 items-start gap-2">
                {it.locked && <Icon name="lock" size={16} className="text-crit" />}
                {open.itemOf(it.title) ? (
                  <button type="button" className="text-left hover:underline" data-testid="fit-item" onClick={() => open.onItem(open.itemOf(it.title)!)}>
                    {it.title}
                  </button>
                ) : (
                  it.title
                )}
              </span>
              <span className="tnum simple-small flex flex-none gap-2 whitespace-nowrap">
                {before && prior !== undefined && prior !== it.date && <del>{day(prior)}</del>}
                <span className="font-medium text-text">{it.needs_estimate ? "Estimate pending" : day(it.date)}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Simple Roadmap's goal card (FD1 a) and its milestones, the panel and the approved re-plan. */
type Opener = { itemOf: (title: string) => string | null; onItem: (id: string) => void };

export function FitRoadmap({ roadmapId, itemOf, onItem }: { roadmapId?: string | null } & Opener) {
  const goals = useFitGoals();
  const zone = useCompanyZone();
  const [open, setOpen] = useState(false);
  const [before, setBefore] = useState<Lane[] | null>(null);
  const g = (goals.data ?? []).find((x) => !roadmapId || x.roadmap?.id === roadmapId);
  if (!g) return null;
  const late = g.late_days > 0;
  const asked = g.lanes.find((l) => l.code === g.milestone);
  const done = g.approved && before ? g.approved : null;
  return (
    <div className="flex flex-col gap-3" data-testid="fit-roadmap">
      <div className="simple-card" data-testid="fit-goal">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="simple-h2">Goal: {g.goal ?? g.milestone_name}</h2>
          {g.goal_now && <span className="simple-small">{g.goal_now}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="tnum">
            Target <span className="font-semibold">{day(g.target)}</span>
          </span>
          <span className="tnum">
            On the plan{" "}
            <span className={`font-semibold ${late ? "text-warn" : "text-pass"}`} data-testid="fit-on-plan">
              {day(g.today)}
            </span>
          </span>
          {late && <span className="simple-status simple-status-risk">{lateWords(g.late_days)}</span>}
          {late && (
            <button type="button" className="simple-button simple-button-primary" data-testid="fit-ask" onClick={() => setOpen(true)}>
              Bring this date in
            </button>
          )}
        </div>
      </div>
      {done && (
        <div className="simple-card flex-row flex-wrap items-center gap-3" data-testid="fit-approved">
          <p className="flex items-start gap-2">
            <Icon name="check" className="mt-0.5 flex-none text-pass" />
            <span>
              Approved on {formatInZone(done.at, zone, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}. PRD version {done.version}
              {done.roadmap_version != null && done.roadmap_live
                ? ` and roadmap version ${done.roadmap_version} are live: ${g.milestone} lands ${day(done.date)}. Home and Priorities show the new dates.`
                : ` is live: ${g.milestone} lands ${day(done.date)}.`}
              {done.roadmap_version != null && !done.roadmap_live && ` Roadmap version ${done.roadmap_version} is in review with ${done.roadmap_decider ?? "its decider"}.`}
            </span>
          </p>
        </div>
      )}
      <div className="grid gap-3 min-[641px]:grid-cols-2">
        {asked && <LaneCard m={asked} was={done?.was} before={before ?? undefined} open={{ itemOf, onItem }} />}
        <div className="flex flex-col gap-3">
          {g.lanes
            .filter((l) => l !== asked)
            .map((l) => (
              <LaneCard key={l.code} m={l} was={before?.find((b) => b.code === l.code)?.date} before={before ?? undefined} open={{ itemOf, onItem }} />
            ))}
        </div>
      </div>
      {open && (
        <FitPanel
          goal={g}
          onClose={() => setOpen(false)}
          onGoalSaved={() => void goals.reload()}
          onApproved={(lanes) => {
            setBefore(lanes);
            setOpen(false);
            void goals.reload();
          }}
        />
      )}
    </div>
  );
}

/** Simple Home after a re-plan was approved: the milestone is on its date, and what moved. */
export function FitHomeCard() {
  const goals = useFitGoals();
  const zone = useCompanyZone();
  const g = (goals.data ?? []).find((x) => x.approved && x.late_days <= 0);
  if (!g?.approved) return null;
  const a = g.approved;
  const spare = -gap(a.date, a.target);
  const at = formatInZone(a.at, zone, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return (
    <section className="simple-card" data-testid="fit-home" aria-label="A date brought in">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="simple-h2">{g.milestone_name} is on its date</h2>
        <span className="simple-status simple-status-ok">On target</span>
      </div>
      <p>
        It now lands <span className="font-semibold">{day(a.date)}</span> (was <del>{day(a.was)}</del>), {spare > 0 ? `${plural(spare, "day")} before ${day(a.target)}` : `on ${day(a.target)}`}.{" "}
        {a.by_me ? "You" : "Someone"} approved PRD version {a.version}
        {a.roadmap_version != null && a.roadmap_live && ` and roadmap version ${a.roadmap_version}`} on {at}.
        {a.roadmap_version != null && !a.roadmap_live && ` Roadmap version ${a.roadmap_version} is in review with ${a.roadmap_decider ?? "its decider"}.`}
      </p>
      {a.moves.length > 0 && (
        <ul className="simple-small flex flex-col gap-1">
          {a.moves.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Home's "since your last visit" line when the approved re-plan is the one change. */
export function useFitSince(): string | null {
  const goals = useFitGoals();
  const g = (goals.data ?? []).find((x) => x.approved && x.late_days <= 0);
  return g ? `The one change since your last visit is the new ${g.milestone} date above.` : null;
}
