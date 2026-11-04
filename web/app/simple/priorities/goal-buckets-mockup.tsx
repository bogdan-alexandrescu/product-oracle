"use client";
// MOCK-HOOK: the whole file. Mock-ups (mk-goalbuckets) for adding, editing and archiving goals and
// moving features right in Goal buckets: `?gb1=a|b|c|d` (add and edit), `?gb2=a|b|c|d` (archive),
// `?gb3=a|b|c|d` (move features), with `&phase=rest|open|mid|result|add`, `&hard=1`.

import { useRouter, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";

import type { Schemas } from "@/lib/api/client";
import { mkGoalBuckets, MK_MILESTONES, type MkFeature, type MkGoal } from "@/lib/api/mock/goal-buckets-mockup";
import { calendarDay } from "@/lib/dates";
import { useMe } from "@/lib/me";

import { CodeTag, PlanBucketsHead, wk } from "./plan-buckets";

type Plan = Schemas["SimplePlanOut"];

const BTN = "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-line-strong bg-surface px-3 text-[14px] font-[650] text-text hover:bg-surface2"; // MOCK-HOOK
const PRIMARY = "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-transparent bg-accent px-3 text-[14px] font-[650] text-on-accent disabled:border-line-strong disabled:bg-surface2 disabled:text-text2"; // MOCK-HOOK
const SOFT = "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-transparent bg-accent-soft px-3 text-[14px] font-[650] text-accent-ink"; // MOCK-HOOK
const ICON = "inline-flex h-8 w-8 flex-none items-center justify-center rounded-lg border border-transparent text-[16px] text-text hover:border-line-strong hover:bg-surface2"; // MOCK-HOOK
const INPUT = "h-9 w-full min-w-0 rounded-lg border border-line-strong bg-surface px-2.5 text-[15px] text-text"; // MOCK-HOOK
const BAD = "h-9 w-full min-w-0 rounded-lg border-2 border-warn bg-surface px-2.5 text-[15px] text-text"; // MOCK-HOOK
const MENU = "absolute right-0 top-9 z-30 w-64 rounded-lg border border-line bg-surface p-1 text-[15px] shadow-lg"; // MOCK-HOOK
const ITEM = "flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left hover:bg-surface2"; // MOCK-HOOK

/** "Dec 31", or "Feb 12, 2027" past this year. */
const day = (iso: string): string => (iso ? calendarDay(iso, iso.startsWith("2026") ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" }) : ""); // MOCK-HOOK

/** A milestone's code with its name, never the bare code: "M2 Fleet care". */
const msLabel = (code: string): string => `${code} ${MK_MILESTONES.find((m) => m.code === code)?.name ?? ""}`.trim(); // MOCK-HOOK

/** A plan built from the mock-up's goals and features, so the buckets' header draws as built. */
function planOf(goals: MkGoal[], features: MkFeature[]): Plan { // MOCK-HOOK
  const weeks = (g: string | null, m: string) => features.filter((f) => (f.goals[0] ?? null) === g && f.ms.includes(m)).reduce((n, f) => n + f.weeks / f.ms.length, 0);
  const caps: Record<string, number> = { M1: 18, M2: 24, M3: 42 };
  return {
    prd: "fleet-plan",
    status: "ready",
    milestones: MK_MILESTONES.map((m) => ({ code: m.code, name: m.name, start_date: m.start, end_date: m.end, effort_weeks: caps[m.code], planned_weeks: features.filter((f) => f.ms.includes(m.code)).reduce((n, f) => n + f.weeks / f.ms.length, 0) })),
    slices: [],
    goals: goals.map((g) => ({ name: g.title })),
    goal_weeks: goals.flatMap((g) => MK_MILESTONES.map((m) => ({ goal: g.title, milestone: m.code, weeks: Math.round(weeks(g.id, m.code) * 10) / 10 }))),
    span: { start: "2026-11-02", end: "2027-02-12" },
  } as unknown as Plan;
}

/** The mock-up's switches, read off the address. */
function useSwitches() { // MOCK-HOOK
  const p = useSearchParams();
  const router = useRouter();
  const dec = (p.get("gb1") ? "gb1" : p.get("gb2") ? "gb2" : "gb3") as "gb1" | "gb2" | "gb3";
  const go = (patch: Record<string, string>) => {
    const next = new URLSearchParams(p.toString());
    for (const [k, v] of Object.entries(patch)) next.set(k, v);
    router.replace(`?${next.toString()}`, { scroll: false });
  };
  return { dec, v: p.get(dec) ?? "a", phase: p.get("phase") ?? "rest", hard: p.get("hard") === "1", go };
}

export function GoalBucketsMockup() { // MOCK-HOOK
  const { can, me } = useMe();
  const myName = me?.name || me?.email || "you"; // MOCK-HOOK
  const s = useSwitches();
  const { dec, v, phase, hard, go } = s;
  // Owners and approvers edit goals (update_entity); anyone else sees no controls.
  const edits = can("update_entity");
  const start = mkGoalBuckets(hard);
  let goals = start.goals;
  let features = start.features;
  let toast: ReactNode = null;
  let shelf: MkGoal[] = [];
  let noGoalNote: string | null = null;
  const at = (id: string) => goals.find((g) => g.id === id)!;

  // ------------------------------------------------------------ GB1 results
  if (dec === "gb1" && phase === "result") {
    if (v === "c") {
      goals = goals.map((g) => (g.id === "g2" ? { ...g, target: "Under 3%", by: "2027-03-31" } : g.id === "g5" ? { ...g, title: "Fewer support chats" } : g));
      toast = <>Saved changes to two goals.</>;
    } else if (v === "d") {
      goals = [...goals, { id: "g9", order: goals.length + 1, title: "Quieter bikes", measure: "", target: "", by: "" }];
      if (!hard) toast = <>Added Quieter bikes as goal {goals.length}. It needs a measure, a target and a date.</>;
    } else {
      goals = goals.map((g) => (g.id === "g2" ? { ...g, target: "Under 3%", by: "2027-03-31" } : g));
      toast = <>Saved Fewer bikes in repair: under 3% by Mar 31, 2027.</>;
    }
  }

  // ------------------------------------------------------------ GB2: archiving "Grow shop partners"
  const archived = at("g4");
  const its = features.filter((f) => f.goals[0] === "g4");
  if (dec === "gb2") {
    const away = (to: string | null) =>
      features.map((f) => {
        if (f.goals[0] !== "g4") return { ...f, goals: f.goals.filter((g) => g !== "g4") };
        const rest = f.goals.filter((g) => g !== "g4");
        return { ...f, goals: rest.length ? rest : to ? [to] : [] };
      });
    if (v === "a" && phase === "result") {
      features = away("g1");
      goals = goals.filter((g) => g.id !== "g4");
      const own = its.filter((f) => f.goals.length > 1).length;
      toast = (
        <>
          Archived Grow shop partners. {its.length - own} {its.length - own === 1 ? "feature" : "features"} moved to Faster first ride
          {own ? `, ${own} to the other goal ${own === 1 ? "it serves" : "each serves"}` : ""}.
        </>
      );
    }
    if (v === "b" && (phase === "mid" || phase === "result")) {
      features = features.map((f) => (f.goals[0] === "g4" ? { ...f, goals: ["g1", ...f.goals.filter((g) => g !== "g4" && g !== "g1")] } : f));
      if (phase === "result") {
        goals = goals.filter((g) => g.id !== "g4");
        features = features.map((f) => ({ ...f, goals: f.goals.filter((g) => g !== "g4") }));
        toast = <>Archived Grow shop partners. It had no features left.</>;
      } else toast = <>Moved {its.length} features to Faster first ride.</>;
    }
    if (v === "c" && (phase === "mid" || phase === "result")) {
      features = away(null);
      goals = goals.filter((g) => g.id !== "g4");
      shelf = [archived];
      noGoalNote = "Was under Grow shop partners, now archived";
      if (phase === "mid") toast = <>Archived Grow shop partners. Its features with no other goal are under No goal.</>;
    }
    if (v === "d" && phase === "result") {
      features = features.map((f) => {
        if (f.goals[0] !== "g4") return { ...f, goals: f.goals.filter((g) => g !== "g4") };
        const pick = PER_FEATURE[f.code] ?? f.goals.find((g) => g !== "g4") ?? null;
        return { ...f, goals: pick ? [pick] : [] };
      });
      goals = goals.filter((g) => g.id !== "g4");
      toast = <>Archived Grow shop partners and moved its {its.length} features as you picked.</>;
    }
  }

  // ------------------------------------------------------------ GB3: moving "Battery health alerts" (F-5) to "Lower support load"
  if (dec === "gb3" && phase === "result") {
    if (v === "c") {
      features = features.map((f) => (["F-4", "F-5", "F-6"].includes(f.code) ? { ...f, goals: ["g5", ...f.goals.filter((g) => g !== "g5" && g !== "g2")] } : f));
      toast = <>Moved three features to Lower support load.</>;
    } else if (v === "d") {
      features = features.map((f) => (f.code === "F-5" ? { ...f, goals: ["g5", "g2"] } : f));
      toast = <>Battery health alerts now sits under Lower support load. It still serves Fewer bikes in repair.</>;
    } else {
      features = features.map((f) => (f.code === "F-5" ? { ...f, goals: ["g5"] } : f));
      toast = <>Moved Battery health alerts to Lower support load.</>;
    }
  }

  const plan = planOf(goals, features);
  const under = (g: string | null) => features.filter((f) => (f.goals[0] ?? null) === g);
  const noGoal = under(null);
  const editMode = dec === "gb1" && v === "c" && (phase === "open" || phase === "mid" || (hard && phase !== "rest"));
  const panel = dec === "gb1" && v === "b" && (phase === "mid" || (hard && phase === "add"));
  const ticking = dec === "gb3" && v === "c" && (phase === "open" || phase === "mid");

  return (
    <section aria-label="Goal buckets" data-mockup={`${dec}-${v}-${phase}`} className={`pb-20 ${toast ? "max-sm:pb-48" : ""}`}>
      <PlanBucketsHead plan={plan} codeOf={() => null} />
      {edits && <Toolbar dec={dec} v={v} phase={phase} hard={hard} editMode={editMode} ticking={ticking} go={go} />}
      {toast && <Toast>{toast}</Toast>}
      <ul className="mt-4 grid items-start gap-4 sm:grid-cols-2">
        {goals.map((g) => (
          <GoalCard key={g.id} g={g} list={under(g.id)} goals={goals} edits={edits} editMode={editMode} ticking={ticking} sw={s} features={features} />
        ))}
        {edits && dec === "gb1" && (v === "a" || v === "d") && <AddCard v={v} phase={phase} hard={hard} next={goals.length + 1} go={go} />}
        {noGoal.length > 0 && (
          <li data-testid="plan-goal" data-goal="" className="rounded-[var(--simple-card-radius)] border border-warn bg-surface p-4">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <h3 className="text-[21px] font-[650] leading-7">No goal</h3>
              <span className="ml-auto text-[15px] text-text2">{count(noGoal.length)}</span>
            </div>
            <p className="mt-1 text-[15px] text-warn">⚠ Serves no goal in the plan{noGoalNote ? ` · ${noGoalNote}` : ""}</p>
            <Rows list={noGoal} goals={goals} sw={s} edits={edits} ticking={false} />
          </li>
        )}
        {shelf.length > 0 && (
          <li data-testid="archived-goals" className="rounded-[var(--simple-card-radius)] border border-dashed border-line-strong bg-surface p-4 sm:col-span-2">
            <div className="flex flex-wrap items-center gap-x-2">
              <h3 className="text-[17px] font-[650] leading-6 text-text2">Archived goals · 1</h3>
              <span className="text-[14px] text-text2">
                {phase === "result" ? "kept for the record; features no longer count toward them" : `Grow shop partners, held ${its.length} ${its.length === 1 ? "feature" : "features"}`}
              </span>
            </div>
            {phase === "result" && (
              <ul className="mt-2">
                {shelf.map((g) => (
                  <li key={g.id} className="flex flex-wrap items-center gap-2 border-b border-line py-[5px] text-[16px] leading-[22px]">
                    <span className="text-text2 line-through">{g.title}</span>
                    <span className="text-[14px] text-text2">
                      {g.measure}: {g.target} by {day(g.by)} · archived Nov 4 by {myName} · held {its.length} {its.length === 1 ? "feature" : "features"}
                    </span>
                    {edits && (
                      <button type="button" className={`${BTN} ml-auto`}>
                        Bring back
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </li>
        )}
      </ul>
      {panel && <SidePanel hard={hard} next={goals.length + 1} go={go} g={at("g2")} />}
      {dec === "gb2" && phase === "open" && v !== "c" && <ArchiveDialog v={v} goal={archived} list={its} goals={goals} hard={hard} go={go} />}
      {dec === "gb2" && phase === "mid" && (v === "a" || v === "d") && <ArchiveDialog v={v} goal={archived} list={its} goals={goals} hard={hard} go={go} mid />}
      {ticking && phase === "mid" && <MoveBar />}
      {dec === "gb3" && v === "a" && phase === "mid" && hard && <EdgeScroll f={features.find((f) => f.code === "F-5")!} />}
    </section>
  );
}

/** The goals each of the 15 features picks in GB2 d's hard case (any other goal it serves, else these). */
const PER_FEATURE: Record<string, string> = { "F-9": "g1", "F-10": "g3", "F-13": "g1", "F-14": "g5", "F-17": "g5", "F-21": "g1" }; // MOCK-HOOK

const count = (n: number) => `${n} ${n === 1 ? "feature" : "features"} in the plan`; // MOCK-HOOK

type Sw = ReturnType<typeof useSwitches>; // MOCK-HOOK

function Toolbar({ dec, v, phase, hard, editMode, ticking, go }: { dec: string; v: string; phase: string; hard: boolean; editMode: boolean; ticking: boolean; go: Sw["go"] }) { // MOCK-HOOK
  const b1 = dec === "gb1" && v === "b";
  const c1 = dec === "gb1" && v === "c";
  const c3 = dec === "gb3" && v === "c";
  if (!b1 && !c1 && !c3) return null;
  return (
    <div data-testid="mk-toolbar" className={`mt-4 flex flex-wrap items-center gap-2 ${editMode ? "z-30 sm:sticky sm:top-0 -mx-1 rounded-lg border border-line bg-surface px-3 py-2 shadow-md" : ""}`}>
      {b1 && (
        <button type="button" className={hard && phase === "add" ? SOFT : BTN} onClick={() => go({ phase: "add" })}>
          + Add goal
        </button>
      )}
      {c1 && !editMode && (
        <button type="button" className={BTN} onClick={() => go({ phase: "open" })}>
          ✎ Edit goals
        </button>
      )}
      {c1 && editMode && (
        <>
          <span className="text-[15px] text-text2">{phase === "mid" ? "2 goals changed · one needs a date" : hard ? "Editing all eight goals" : "Editing all five goals"}</span>
          <span className="ml-auto flex gap-2">
            <button type="button" className={BTN} onClick={() => go({ phase: "rest" })}>
              Discard
            </button>
            <button type="button" className={PRIMARY} disabled={phase === "mid"} onClick={() => go({ phase: "result" })}>
              Save all
            </button>
          </span>
        </>
      )}
      {c3 && !ticking && (
        <button type="button" className={BTN} onClick={() => go({ phase: "open" })}>
          ☐ Pick features to move
        </button>
      )}
      {c3 && ticking && (
        <>
          <span className="text-[15px] text-text2">Tick the features, then pick their new goal below.</span>
          <button type="button" className={`${BTN} ml-auto`} onClick={() => go({ phase: "rest" })}>
            Done
          </button>
        </>
      )}
    </div>
  );
}

function OrderBadge({ n }: { n: number }) { // MOCK-HOOK
  return (
    <span title={`Goal ${n} in the owner's order`} className="inline-flex h-6 min-w-6 flex-none items-center justify-center self-center rounded-full bg-surface2 px-1.5 text-[13px] font-[650] tabular-nums text-text2">
      {n}
    </span>
  );
}

function GoalCard({ g, list, goals, edits, editMode, ticking, sw, features }: { g: MkGoal; list: MkFeature[]; goals: MkGoal[]; edits: boolean; editMode: boolean; ticking: boolean; sw: Sw; features: MkFeature[] }) { // MOCK-HOOK
  const { dec, v, phase, hard, go } = sw;
  const inline = dec === "gb1" && v === "a" && g.id === "g2" && (phase === "open" || phase === "mid");
  const menuOpen =
    (dec === "gb1" && v === "b" && g.id === "g2" && phase === "open") || (dec === "gb2" && g.id === "g4" && ((phase === "open" && v === "c") || (phase === "mid" && v === "b")));
  const archiving = dec === "gb2" && g.id === "g4";
  const dropTarget = dec === "gb3" && v === "a" && phase === "mid" && !hard && g.id === "g5";
  const incomplete = !g.measure || !g.target || !g.by;
  const also = features.filter((f) => f.goals[0] !== g.id && f.goals.includes(g.id));
  const fixD = dec === "gb1" && v === "d" && g.id === "g9" && hard;
  return (
    <li
      data-testid="plan-goal"
      data-goal={g.title}
      className={`relative rounded-[var(--simple-card-radius)] border bg-surface p-4 ${dropTarget ? "border-2 border-accent bg-accent-soft" : incomplete ? "border-warn" : "border-line"}`}
    >
      {editMode ? (
        <GoalFields g={g} bad={sw.phase === "mid" && g.id === "g2"} changed={sw.phase === "mid" && (g.id === "g2" || g.id === "g5")} />
      ) : inline ? (
        <GoalForm g={phase === "mid" ? { ...g, target: "Under 3%", by: "" } : g} bad={phase === "mid"} onSave={() => go({ phase: "result" })} onCancel={() => go({ phase: "rest" })} title="Edit goal" />
      ) : fixD ? (
        <GoalForm g={{ ...g, measure: "Rider noise complaints a month" }} bad title="Finish this goal" onSave={() => go({ phase: "rest" })} onCancel={() => go({ phase: "rest" })} />
      ) : (
        <>
          <div className="flex items-start gap-2">
            <OrderBadge n={g.order} />
            <h3 className="min-w-0 flex-1 text-[21px] font-[650] leading-7">{g.title}</h3>
            <span data-testid="plan-goal-count" className="mt-1 flex-none text-[15px] text-text2">
              {count(list.length)}
            </span>
            {edits && (dec === "gb1" ? v === "a" || v === "d" : false) && (
              <button type="button" aria-label={`Edit ${g.title}`} title="Edit goal" className={ICON} onClick={() => go({ phase: "open" })}>
                ✎
              </button>
            )}
            {edits && ((dec === "gb1" && v === "b") || dec === "gb2" || false) && (
              <span className="relative">
                <button type="button" aria-label={`More for ${g.title}`} className={`${ICON} ${menuOpen ? "border-line-strong bg-surface2" : ""}`} onClick={() => go({ phase: "open" })}>
                  ⋯
                </button>
                {menuOpen && <GoalMenu v={v} dec={dec} go={go} />}
              </span>
            )}
          </div>
          <p className="mt-0.5 pl-8 text-[15px] leading-5 text-text2">
            {incomplete ? (
              <span className="text-warn">⚠ Needs {[!g.measure && "a measure", !g.target && "a target", !g.by && "a date"].filter(Boolean).join(", ")}</span>
            ) : (
              <>
                {g.measure}: <b className="font-[650] text-text">{g.target}</b> by {day(g.by)}
              </>
            )}
          </p>
        </>
      )}
      {!editMode && <Rows list={list} goals={goals} sw={sw} edits={edits} ticking={ticking} />}
      {editMode && <p className="mt-2 text-[15px] text-text2">{count(list.length)}, hidden while you edit</p>}
      {dropTarget && <DragGhost f={features.find((f) => f.code === "F-5")!} left="18%" top="64px" phone="max-sm:!left-5 max-sm:!top-[128px] max-sm:w-[calc(100%-32px)] max-sm:max-w-none" />}
      {dropTarget && <p className="mt-2 rounded-lg border border-dashed border-accent px-3 py-2 text-[15px] text-accent-ink">Drop here: Lower support load becomes the goal it moves most</p>}
      {also.length > 0 && dec === "gb3" && v === "d" && !editMode && (
        <p className="mt-2 text-[14px] text-text2">
          Also served here: {also.map((f) => f.name).join(", ")}
        </p>
      )}
      {archiving && dec === "gb2" && v === "b" && phase === "mid" && <p className="mt-2 text-[15px] text-text2">Empty now, so it can be archived.</p>}
      {!editMode && !inline && !fixD && (
        <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
          <button type="button" className={BTN}>
            + Suggest a feature
          </button>
          <button type="button" className={SOFT}>
            ✦ Ask Oracle to suggest
          </button>
        </div>
      )}
    </li>
  );
}

function GoalMenu({ v, dec, go }: { v: string; dec: string; go: Sw["go"] }) { // MOCK-HOOK
  return (
    <div role="menu" className={MENU}>
      <button type="button" role="menuitem" className={ITEM} onClick={() => go({ phase: "mid" })}>
        Edit goal
      </button>
      <button type="button" role="menuitem" className={`${ITEM} ${dec === "gb2" ? "bg-surface2" : ""}`} onClick={() => go({ phase: dec === "gb2" && v === "c" ? "mid" : "result" })}>
        Archive goal
      </button>
    </div>
  );
}

function Field({ label, children, error }: { label: string; children: ReactNode; error?: string }) { // MOCK-HOOK
  return (
    <label className="block min-w-0">
      <span className="text-[13px] font-[650] text-text2">{label}</span>
      {children}
      {error && <span className="mt-0.5 block text-[13px] text-warn">{error}</span>}
    </label>
  );
}

/** GB1 a and d: the goal's header turned into a form, inside its bucket. */
function GoalForm({ g, bad, onSave, onCancel, title }: { g: MkGoal; bad: boolean; onSave: () => void; onCancel: () => void; title: string }) { // MOCK-HOOK
  return (
    <form data-testid="goal-form" className="grid gap-2" onSubmit={(e) => (e.preventDefault(), onSave())}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <OrderBadge n={g.order} />
        <h3 className="whitespace-nowrap text-[17px] font-[650]">{title}</h3>
        <span className="text-[13px] text-text2 max-sm:basis-full sm:ml-auto">Goal {g.order} in the order; change it in Baseline</span>
      </div>
      <Field label="Goal" error={!g.title ? "Name the goal." : undefined}>
        <textarea rows={g.title.length > 60 ? 2 : 1} defaultValue={g.title} className={`${INPUT} h-auto py-1.5`} />
      </Field>
      <Field label="Measure: the number that shows it" error={!g.measure ? "Add a measure." : undefined}>
        <input defaultValue={g.measure} placeholder="For example: repeat orders a month" className={g.measure ? INPUT : BAD} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Target" error={!g.target ? "Add a target." : undefined}>
          <input defaultValue={g.target} className={g.target ? INPUT : BAD} />
        </Field>
        <Field label="By" error={!g.by ? "Pick a date." : undefined}>
          <input type="text" defaultValue={day(g.by)} placeholder="Pick a day" className={g.by ? INPUT : BAD} />
        </Field>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <button type="submit" className={PRIMARY} disabled={bad}>
          Save goal
        </button>
        <button type="button" className={BTN} onClick={onCancel}>
          Cancel
        </button>
        {bad && <span className="min-w-0 text-[13px] text-text2">A goal needs a measure, a target and a date.</span>}
      </div>
    </form>
  );
}

/** GB1 c: every header turned into fields at once. */
function GoalFields({ g, bad, changed }: { g: MkGoal; bad: boolean; changed: boolean }) { // MOCK-HOOK
  const v = bad ? { ...g, target: "Under 3%", by: "" } : changed && g.id === "g5" ? { ...g, title: "Fewer support chats" } : g;
  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-2">
        <OrderBadge n={g.order} />
        <textarea rows={v.title.length > 44 ? 3 : 1} defaultValue={v.title} aria-label="Goal" className={`${INPUT} h-auto resize-none py-1.5 font-[650]`} />
        {changed && <span className="flex-none text-[13px] font-[650] text-accent-ink">Changed</span>}
      </div>
      <div className="grid grid-cols-2 gap-2 pl-8">
        <input defaultValue={v.measure} aria-label="Measure" className={`${INPUT} col-span-2`} />
        <input defaultValue={v.target} aria-label="Target" className={INPUT} />
        <input defaultValue={day(v.by)} aria-label="By" placeholder="Pick a day" className={v.by ? INPUT : BAD} />
      </div>
      <p className="pl-8 text-[13px] text-text2">
        {!v.by ? <span className="text-warn">Pick a date to save.</span> : "Measure · target · by"}
        {"  "}
        <button type="button" className="ml-2 text-[13px] font-[650] text-text2 underline">
          Archive
        </button>
      </p>
    </div>
  );
}

function AddCard({ v, phase, hard, next, go }: { v: string; phase: string; hard: boolean; next: number; go: Sw["go"] }) { // MOCK-HOOK
  const adding = phase === "add";
  if (v === "d") {
    return (
      <li data-testid="add-goal" className="rounded-[var(--simple-card-radius)] border border-dashed border-line-strong bg-surface p-4">
        <form className="flex items-center gap-2" onSubmit={(e) => (e.preventDefault(), go({ phase: "result" }))}>
          <span className="text-[17px] text-text2">+</span>
          <input
            aria-label="New goal"
            defaultValue={phase === "mid" ? "Quieter bikes" : ""}
            placeholder="Add a goal: type its name, then Enter"
            className={`${INPUT} ${phase === "open" || phase === "mid" ? "border-2 border-accent" : ""}`}
          />
        </form>
        {phase === "mid" && <p className="mt-1.5 pl-6 text-[13px] text-text2">Enter adds it as goal {next}. Add its measure, target and date when you know them.</p>}
        {phase === "open" && <p className="mt-1.5 pl-6 text-[13px] text-text2">Type the goal&apos;s name. Only the name is needed now.</p>}
      </li>
    );
  }
  if (!adding)
    return (
      <li data-testid="add-goal" className="flex min-h-[120px] items-center justify-center rounded-[var(--simple-card-radius)] border border-dashed border-line-strong bg-surface p-4">
        <button type="button" className={BTN} onClick={() => go({ phase: "add" })}>
          + Add goal
        </button>
      </li>
    );
  return (
    <li data-testid="add-goal" className="rounded-[var(--simple-card-radius)] border-2 border-accent bg-surface p-4">
      <GoalForm
        g={{ id: "new", order: next, title: hard ? "Win back riders who paused for winter, starting with the ones who rode most last summer" : "Quieter bikes", measure: "", target: "", by: "" }}
        bad
        title="New goal"
        onSave={() => go({ phase: "rest" })}
        onCancel={() => go({ phase: "rest" })}
      />
    </li>
  );
}

/** GB1 b: the goal's fields in a panel at the side (a sheet on a phone). */
function SidePanel({ hard, next, go, g }: { hard: boolean; next: number; go: Sw["go"]; g: MkGoal }) { // MOCK-HOOK
  const adding = hard;
  const shown: MkGoal = adding ? { id: "new", order: next, title: "Win back riders who paused for winter, starting with the ones who rode most last summer", measure: "Paused riders who come back", target: "", by: "" } : { ...g, target: "Under 3%", by: "" };
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={() => go({ phase: "rest" })}>
      <aside role="dialog" aria-label={adding ? "New goal" : `Edit ${g.title}`} className="flex h-full w-full flex-col border-l border-line bg-surface p-5 shadow-lg sm:w-[440px]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <h2 className="text-[21px] font-[650] leading-7">{adding ? "New goal" : "Edit goal"}</h2>
          <button type="button" aria-label="Close" className={`${ICON} ml-auto`} onClick={() => go({ phase: "rest" })}>
            ✕
          </button>
        </div>
        <div className="mt-3 grid gap-3">
          <Field label="Goal">
            <textarea rows={3} defaultValue={shown.title} className={`${INPUT} h-auto py-1.5`} />
          </Field>
          <Field label="Measure: the number that shows it">
            <input defaultValue={shown.measure} className={INPUT} />
          </Field>
          <Field label="Target" error={!shown.target ? "Add a target." : undefined}>
            <input defaultValue={shown.target} placeholder="For example: 30%" className={shown.target ? INPUT : BAD} />
          </Field>
          <Field label="By" error="Pick a date.">
            <input defaultValue="" placeholder="Pick a day" className={BAD} />
          </Field>
          <Field label="Place in the order">
            <p className="mt-1 text-[15px] text-text2">Goal {shown.order}. The owner sets the order in Baseline.</p>
          </Field>
          {!adding && (
            <Field label="Features under it">
              <p className="mt-1 text-[15px] text-text2">Repair booking from the app, Battery health alerts, Spare-parts stock view</p>
            </Field>
          )}
        </div>
        <div className="mt-auto flex gap-2 border-t border-line pt-3">
          <button type="button" className={PRIMARY} disabled>
            Save goal
          </button>
          <button type="button" className={BTN} onClick={() => go({ phase: "rest" })}>
            Cancel
          </button>
          <span className="self-center text-[13px] text-text2">Needs a measure, a target and a date.</span>
        </div>
      </aside>
    </div>
  );
}

function Rows({ list, goals, sw, edits, ticking }: { list: MkFeature[]; goals: MkGoal[]; sw: Sw; edits: boolean; ticking: boolean }) { // MOCK-HOOK
  const { dec, v, phase, go } = sw;
  if (!list.length) return <p className="mt-2 text-[15px] text-text2">Nothing in the plan yet</p>;
  const name = (id: string) => goals.find((g) => g.id === id)?.title ?? "an archived goal";
  const ticked = (c: string) => ticking && phase === "mid" && ["F-4", "F-5", "F-6"].includes(c);
  return (
    <ul className="mt-2">
      {list.map((f) => {
        const lifted = dec === "gb3" && v === "a" && f.code === "F-5" && (phase === "open" || phase === "mid");
        const menu = dec === "gb3" && v === "b" && f.code === "F-5" && (phase === "open" || phase === "mid");
        const links = dec === "gb3" && v === "d" && f.code === "F-5" && (phase === "open" || phase === "mid");
        const others = f.goals.slice(1);
        return (
          <li
            key={f.code}
            data-testid="plan-feature"
            data-code={f.code}
            className={`relative flex items-center gap-2 border-b border-line py-[5px] text-[16px] leading-[22px] max-sm:flex-wrap max-sm:gap-y-1 ${lifted ? "[&>*:not(.mk-ghost)]:opacity-30" : ""} ${ticked(f.code) ? "bg-accent-soft" : ""}`}
          >
            {edits && dec === "gb3" && v === "a" && (
              <span aria-hidden title="Drag to another goal" className={`flex-none cursor-grab select-none text-[15px] ${lifted ? "text-accent-ink" : "text-text2"}`}>
                ⠿
              </span>
            )}
            {edits && ticking && <input type="checkbox" aria-label={`Pick ${f.name}`} defaultChecked={ticked(f.code)} className="h-4 w-4 flex-none accent-[var(--accent)]" />}
            <CodeTag code={f.code} title={f.name} />{" "}
            <span data-testid="plan-feature-name" className="min-w-0 flex-1">
              {f.name}
              {others.length > 0 && (
                <span title={`Also serves ${others.map(name).join(", ")}`} className="ml-1.5 inline-flex h-5 items-center whitespace-nowrap rounded-full border border-line-strong px-1.5 align-[1px] text-[12px] font-[650] text-text2">
                  +{others.length} {others.length === 1 ? "goal" : "goals"}
                </span>
              )}
            </span>
            <span className="flex flex-none gap-1 max-sm:order-last max-sm:basis-full max-sm:pl-[60px]">
              {f.ms.map((m) => {
                const k = MK_MILESTONES.findIndex((x) => x.code === m) + 1;
                return (
                  <span key={m} data-testid="plan-chip" title={msLabel(m)} className="inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-full px-2 text-[12px] font-[650]" style={{ background: `var(--simple-m${k}-tag)`, color: `var(--simple-m${k}-tag-ink)` }}>
                    <span>{m}</span>
                    <span>{MK_MILESTONES[k - 1].name}</span>
                  </span>
                );
              })}
            </span>
            <span data-testid="plan-feature-total" className="w-[56px] flex-none text-right text-[15px] tabular-nums text-text2">
              {wk(f.weeks)} wk
            </span>
            {lifted && phase === "open" && <DragGhost f={f} left="12px" top="-10px" phone="max-sm:!left-1 max-sm:w-full max-sm:max-w-none" />}
            {edits && dec === "gb3" && (v === "b" || v === "d") && (
              <span className="relative flex-none">
                <button type="button" aria-label={v === "b" ? `Move ${f.name}` : `Goals ${f.name} serves`} className={`${ICON} h-7 w-7 ${menu || links ? "border-line-strong bg-surface2" : ""}`} onClick={() => go({ phase: "open" })}>
                  {v === "b" ? "⋯" : "◎"}
                </button>
                {menu && <MoveMenu f={f} goals={goals} hover={phase === "mid"} go={go} />}
                {links && <LinksPopover f={f} goals={goals} mid={phase === "mid"} go={go} />}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** GB3 b: a feature's "Move to goal" menu, the goals in the owner's order. */
function MoveMenu({ f, goals, hover, go }: { f: MkFeature; goals: MkGoal[]; hover: boolean; go: Sw["go"] }) { // MOCK-HOOK
  return (
    <div role="menu" className={`${MENU} w-72`}>
      <p className="px-3 pb-1 pt-1 text-[13px] font-[650] text-text2">Move {f.name} to</p>
      {goals.map((g) => {
        const here = f.goals[0] === g.id;
        const serves = f.goals.includes(g.id) && !here;
        return (
          <button key={g.id} type="button" role="menuitem" disabled={here} className={`${ITEM} ${hover && g.id === "g5" ? "bg-surface2" : ""} disabled:text-text2`} onClick={() => go({ phase: "result" })}>
            <OrderBadge n={g.order} />
            <span className="min-w-0 flex-1 truncate">{g.title}</span>
            {here && <span className="text-[13px]">here now</span>}
            {serves && <span className="text-[13px] text-text2">also serves</span>}
          </button>
        );
      })}
      {hover && <p className="border-t border-line px-3 pb-1 pt-1.5 text-[13px] leading-[18px] text-text2">Its goals become Lower support load alone; Fewer bikes in repair is dropped.</p>}
    </div>
  );
}

/** GB3 d: the feature's goal links, as Baseline's "Goals it serves" holds them. */
function LinksPopover({ f, goals, mid, go }: { f: MkFeature; goals: MkGoal[]; mid: boolean; go: Sw["go"] }) { // MOCK-HOOK
  const main = mid ? "g5" : f.goals[0];
  return (
    <div role="dialog" aria-label={`Goals ${f.name} serves`} className={`${MENU} w-80 p-3`}>
      <p className="text-[15px] font-[650]">Goals {f.name} serves</p>
      <p className="mb-2 text-[13px] text-text2">Tick each goal it serves; pick the one it moves most. It sits in that bucket.</p>
      <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-3 gap-y-1 text-[14px]">
        <span className="text-[12px] font-[650] text-text2">Goal</span>
        <span className="text-[12px] font-[650] text-text2">Serves</span>
        <span className="text-[12px] font-[650] text-text2">Most</span>
        {goals.map((g) => (
          <div key={g.id} className="contents">
            <span className="truncate">
              {g.order}. {g.title}
            </span>
            <input type="checkbox" readOnly checked={f.goals.includes(g.id)} aria-label={`Serves ${g.title}`} className="h-4 w-4 justify-self-center accent-[var(--accent)]" />
            <span className="flex items-center gap-1 justify-self-start">
              <input type="radio" readOnly checked={main === g.id} aria-label={`Moves ${g.title} most`} className="h-4 w-4 flex-none appearance-none rounded-full border-2 border-line-strong bg-surface checked:border-[5px] checked:border-accent" />
              <span className={`w-9 text-[12px] font-[650] text-accent-ink ${main === g.id ? "" : "invisible"}`}>most</span>
            </span>
          </div>
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <button type="button" className={PRIMARY} onClick={() => go({ phase: "result" })}>
          Save links
        </button>
        <button type="button" className={BTN} onClick={() => go({ phase: "rest" })}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** GB3 a's hard case: the target is far below, so the drag waits at the window's edge while the page scrolls. */
function EdgeScroll({ f }: { f: MkFeature }) { // MOCK-HOOK
  return (
    <>
      <DragGhost f={f} left="calc(50% - 120px)" top="calc(100vh - 128px)" fixed />
      <div aria-hidden className="pointer-events-none fixed inset-x-0 bottom-0 z-30 lg:left-[232px] flex h-16 items-center justify-center border-t-2 border-dashed border-accent bg-accent-soft/90 text-[15px] font-[650] text-accent-ink max-sm:bottom-16">
        ↓ Scrolling down to goal 8, Cut bike delivery cost: keep holding at the edge
      </div>
    </>
  );
}

function MoveBar() { // MOCK-HOOK
  return (
    <div data-testid="move-bar" className="sticky bottom-0 z-40 -mx-1 mt-4 rounded-lg border border-line-strong bg-surface px-4 py-3 shadow-lg max-sm:bottom-[calc(64px+env(safe-area-inset-bottom))]">
      <div className="flex flex-wrap items-center gap-2 text-[15px]">
        <b className="font-[650]">3 features picked</b>
        <span className="hidden text-text2 sm:inline">Repair booking from the app, Battery health alerts, Spare-parts stock view</span>
        <span className="ml-auto flex items-center gap-2">
          <span className="text-text2">Move to</span>
          <select aria-label="Move to goal" defaultValue="g5" className="h-8 min-w-0 rounded-lg border border-line-strong bg-surface px-2 text-[14px]">
            <option value="g5">5 · Lower support load</option>
          </select>
          <button type="button" className={PRIMARY}>
            Move 3
          </button>
        </span>
      </div>
    </div>
  );
}

function DragGhost({ f, left, top, fixed, phone = "" }: { f: MkFeature; left: string; top: string; fixed?: boolean; phone?: string }) { // MOCK-HOOK
  return (
    <div aria-hidden data-testid="drag-ghost" className={`mk-ghost pointer-events-none ${fixed ? "fixed" : "absolute"} z-40 flex w-[420px] max-w-[80vw] ${phone} rotate-[-1.5deg] items-center gap-2 rounded-md border-2 border-accent bg-surface px-2 py-[5px] text-[16px] shadow-2xl`} style={{ left, top }}>
      <span className="text-[15px]">⠿</span>
      <CodeTag code={f.code} />
      <span className="flex-1">{f.name}</span>
      <span className="text-[15px] text-text2">{wk(f.weeks)} wk</span>
    </div>
  );
}

function ArchiveDialog({ v, goal, list, goals, hard, go, mid }: { v: string; goal: MkGoal; list: MkFeature[]; goals: MkGoal[]; hard: boolean; go: Sw["go"]; mid?: boolean }) { // MOCK-HOOK
  const ms = [...new Set(list.flatMap((f) => f.ms))].sort();
  const others = goals.filter((g) => g.id !== goal.id);
  const name = (id: string) => goals.find((g) => g.id === id)?.title ?? "";
  const n = list.length;
  const feats = `${n} ${n === 1 ? "feature" : "features"}`;
  const multi = list.filter((f) => f.goals.length > 1);
  return (
    <div data-backdrop="" className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4" onClick={() => go({ phase: "rest" })}>
      <div role="dialog" aria-modal="true" aria-label={`Archive ${goal.title}`} className="flex max-h-[88vh] w-full max-w-lg flex-col rounded-t-[var(--simple-card-radius)] border border-line bg-surface p-4 shadow-lg sm:rounded-[var(--simple-card-radius)]" onClick={(e) => e.stopPropagation()}>
        {v === "b" ? (
          <>
            <h2 className="text-[length:var(--simple-h2)] font-semibold leading-[var(--simple-h2-leading)]">Grow shop partners still has work</h2>
            <p className="mt-1 text-[15px] text-text2">
              A goal can be archived once no feature sits under it. It holds {feats} in {ms.map(msLabel).join(" and ")}. Move them to other goals first.
            </p>
            <ul className="mt-2 min-h-0 overflow-auto text-[15px]">
              {list.map((f) => (
                <li key={f.code} className="flex items-center gap-2 border-b border-line py-1">
                  <CodeTag code={f.code} /> {f.name}
                </li>
              ))}
            </ul>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="whitespace-nowrap text-[15px]">Move all {n} to</span>
              <select aria-label="Move all to goal" defaultValue="g1" className="h-8 min-w-0 max-w-full rounded-lg border-2 border-accent bg-surface px-2 text-[14px]">
                {others.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.order} · {g.title.length > 40 ? `${g.title.slice(0, 38)}…` : g.title}
                  </option>
                ))}
              </select>
              <button type="button" className={PRIMARY} onClick={() => go({ phase: "mid" })}>
                Move {n}
              </button>
              <button type="button" className={BTN} onClick={() => go({ phase: "rest" })}>
                Keep the goal
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 className="text-[length:var(--simple-h2)] font-semibold leading-[var(--simple-h2-leading)]">Archive Grow shop partners?</h2>
            <p className="mt-1 text-[15px] text-text2">
              It holds {feats} with work in {ms.map(msLabel).join(" and ")}. The milestones stay as planned; their work moves with the features.
            </p>
            {v === "a" ? (
              <div className="mt-3 grid gap-2 text-[15px]">
                {multi.length > 0 && (
                  <p>
                    {multi.length} {multi.length === 1 ? "serves" : "serve"} another goal too and {multi.length === 1 ? "goes" : "go"} there:{" "}
                    <span className="text-text2">{multi.map((f) => `${f.name} → ${name(f.goals.find((g) => g !== goal.id)!)}`).join("; ")}</span>
                  </p>
                )}
                <p className="font-[650]">The other {n - multi.length}:</p>
                <label className="flex flex-wrap items-center gap-2">
                  <input type="radio" name="to" defaultChecked className="h-4 w-4 accent-[var(--accent)]" /> <span className="whitespace-nowrap">Move to</span>
                  <select aria-label="Goal" defaultValue={mid ? "g1" : ""} className={`h-8 min-w-0 max-w-full rounded-lg border px-2 text-[14px] max-sm:basis-full ${mid ? "border-2 border-accent" : "border-warn"} bg-surface`}>
                    {!mid && <option value="">Pick a goal</option>}
                    {others.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.order} · {g.title.length > 40 ? `${g.title.slice(0, 38)}…` : g.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" name="to" className="h-4 w-4 accent-[var(--accent)]" /> Leave them with no goal (they show under No goal)
                </label>
                {mid && <p className="rounded-lg bg-accent-soft px-3 py-2 text-accent-ink">Faster first ride will hold {list.length - multi.length + 3} features. Undo puts every link back.</p>}
              </div>
            ) : (
              <ul className={`mt-3 min-h-0 overflow-auto text-[15px] ${hard ? "max-h-[52vh]" : ""}`}>
                {list.map((f) => {
                  const pick = f.goals.find((g) => g !== goal.id) ?? (mid ? PER_FEATURE[f.code] : undefined);
                  return (
                    <li key={f.code} className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line py-1">
                      <CodeTag code={f.code} />
                      <span className="min-w-0 flex-1 sm:truncate">{f.name}</span>
                      <select aria-label={`New goal for ${f.name}`} defaultValue={pick ?? ""} className={`h-8 flex-none max-sm:basis-full sm:w-48 rounded-lg border bg-surface px-2 text-[14px] ${pick ? "border-line-strong" : "border-warn"}`}>
                        <option value="">No goal</option>
                        {others.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.order} · {g.title.length > 24 ? `${g.title.slice(0, 22)}…` : g.title}
                          </option>
                        ))}
                      </select>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="mt-3 flex items-center gap-2">
              <button type="button" className={PRIMARY} disabled={v === "a" && !mid} onClick={() => go({ phase: "result" })}>
                Archive goal
              </button>
              <button type="button" className={BTN} onClick={() => go({ phase: "rest" })}>
                Cancel
              </button>
              {v === "a" && !mid && <span className="text-[13px] text-text2">Pick where they go.</span>}
              {v === "d" && <span className="text-[13px] text-text2">{mid ? "Each feature goes where you picked." : "Each starts at another goal it serves, else No goal."}</span>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Toast({ children }: { children: ReactNode }) { // MOCK-HOOK
  return (
    <div role="status" data-mk-toast="" className="z-30 mt-4 flex shadow-md sm:sticky sm:top-2 max-sm:fixed max-sm:inset-x-3 max-sm:bottom-[calc(76px+env(safe-area-inset-bottom))] items-center gap-3 rounded-lg border border-accent bg-accent-soft px-4 py-2.5 text-[15px] text-text">
      <span className="min-w-0 flex-1">{children}</span>
      <button type="button" className="flex-none font-[650] text-accent-ink underline">
        Undo
      </button>
    </div>
  );
}
