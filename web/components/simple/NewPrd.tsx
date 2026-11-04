"use client";

// Simple's New PRD (NP1 "Guided sheet"): four short fields, then Oracle's brief questions one
// at a time, then the draft. It makes the same brief (POST /v1/intakes) and run Detailed's New
// PRD makes, so a PRD started here opens in Detailed too.

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { Chip } from "@/components/ds";
import { Icon } from "@/components/ds/Icon";
import { findPeople, peopleByIds, type Person } from "@/components/PersonPicker";
import { useConfirmedGoals } from "@/components/NewDraft";
import { CarriedList, NO_REPLACES, ReplacesField, replacesBody, replacesReady, type Replaces } from "@/components/simple/NewPrdReplaces";
import { dmy } from "@/components/simple/PrdTimeline";
import { api, ApiError, unwrap, type Schemas } from "@/lib/api/client";
import { dayIn, useCompanyZone } from "@/lib/dates";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

type Question = Schemas["StakeholderQuestionOut"];
type Intake = Schemas["ProductIntakeOut"];
/** What the person did with a question in the sheet. */
type Given = { kind: "answer"; text: string } | { kind: "unknown" } | { kind: "later"; name: string };

/** How many questions the sheet asks before it drafts. */
const ASK = 6;
const PROBLEM_MIN = 20;

/** Why Oracle asks, in one plain line, by the question's kind (the API's own reason names
 * the kind of gap and its weight, Detailed's words). */
const WHY: Partial<Record<Question["category"], string>> = {
  customer_user: "So the draft says who the first release is for.",
  pain_evidence: "The draft shows the problem is real.",
  goal_alignment: "The draft says which goal it moves.",
  success_metric: "The draft needs one number to watch.",
  differentiation: "The draft says why people would pick it.",
  alternatives: "The draft says what else was weighed.",
  constraints: "Limits change what fits in the first release.",
  blockers: "The draft lists what it waits on.",
  economic_benefit: "The draft says what it is worth.",
  effort_cost: "The draft says roughly what it costs.",
  security_privacy: "Privacy limits go in the draft's rules.",
  ownership: "The draft names who builds it.",
  non_goals: "The draft says what is left out.",
  release_rollout: "The draft says how it goes out, and back.",
  evaluation_criteria: "The draft says how it is checked before launch.",
  third_party_policy: "Other companies' limits go in the draft's rules.",
  configurability_scaling: "The draft says how big it must grow.",
};

const FIELD =
  "w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-[16px] leading-6 text-text placeholder:text-text2 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30";
const LABEL = "text-[15px] font-semibold text-text";

/** Who may start a PRD here: whoever may make the brief and start its draft. */
export function useCanStartPrd(): boolean {
  const { can } = useMe();
  return can("create_intake") && can("start_intake_run");
}

export function NewPrdButton({ primary, onOpen }: { primary?: boolean; onOpen: () => void }) {
  return (
    <button type="button" data-testid="np-new-prd" className={`simple-button ${primary ? "simple-button-primary" : ""}`} onClick={onOpen}>
      <Icon name="plus" size={18} /> New PRD
    </button>
  );
}

/** The brief's text: the problem, then who has it (the API reads one brief). */
function briefOf(problem: string, who: string): string {
  const p = problem.trim();
  const w = who.trim();
  return w ? `${p}\n\nWho has it: ${w}` : p;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function Steps({ at, of }: { at: number; of: number }) {
  return (
    <div className="flex items-center gap-1.5" role="img" aria-label={`Question ${at} of ${of}`} data-testid="np-steps">
      {Array.from({ length: of }, (_, i) => (
        <span key={i} className={`h-1.5 flex-1 rounded-full ${i < at - 1 ? "bg-accent" : i === at - 1 ? "bg-accent/50" : "bg-surface2"}`} />
      ))}
    </div>
  );
}

/** One question already dealt with, short, as the sheet lists them above the current one. */
function Answered({ q, given }: { q: Question; given: Given }) {
  return (
    <li className="flex flex-col gap-0.5 border-b border-line py-2 last:border-b-0" data-testid="np-answered">
      <span className="text-[15px] font-semibold">{q.prompt}</span>
      {given.kind === "unknown" ? (
        <span className="simple-small">
          <span className="simple-tag">I don&apos;t know</span> The draft marks it as open.
        </span>
      ) : given.kind === "later" ? (
        <span className="simple-small">
          <span className="simple-tag">Later</span> Asked of {given.name}. The draft starts without it.
        </span>
      ) : (
        <span className="simple-small">{given.text}</span>
      )}
    </li>
  );
}

/** The guided New PRD sheet: four fields, then Oracle's questions one at a time. */
/** Mounted while open: each opening starts afresh. */
export function NewPrdSheet({ onClose, onStarted }: { onClose: () => void; onStarted: () => void }) {
  const { me, can } = useMe();
  const goals = useConfirmedGoals();
  const [name, setName] = useState("");
  const [problem, setProblem] = useState("");
  const [who, setWho] = useState("");
  // The goals ticked, any number; null once "Not sure yet" is picked (it clears them, a goal
  // clears it). The sheet opens with nothing picked, "Not sure yet" included.
  const [picks, setPicks] = useState<string[] | null>([]);
  // The approved PRD this one replaces, and its area (optional).
  const [replaces, setReplaces] = useState<Replaces>(NO_REPLACES);
  const [intake, setIntake] = useState<Schemas["IntakeOut"] | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [given, setGiven] = useState<Given[]>([]);
  const [answer, setAnswer] = useState("");
  const [asking, setAsking] = useState(false);
  const [people, setPeople] = useState<Person[] | null>(null);
  const [picked, setPicked] = useState<Person | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The questions the draft waits on, when the person may not go on without them. */
  const [held, setHeld] = useState<string[] | null>(null);
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const locked = [document.documentElement, document.body];
    const was = locked.map((el) => el.style.overflow);
    for (const el of locked) el.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      locked.forEach((el, i) => (el.style.overflow = was[i]!));
      back?.focus?.();
    };
  }, [onClose]);

  useEffect(() => {
    if (!asking || people) return;
    findPeople("")
      .then((rows) => setPeople(rows.filter((p) => p.can_write && p.user_id !== me?.user_id)))
      .catch((e) => setError(errorMessage(e)));
  }, [asking, people, me?.user_id]);

  // The question on screen stays in view as the answered ones stack up above it.
  const asked = given.length;
  useEffect(() => {
    if (!intake) return;
    panel.current?.querySelector('[data-testid="np-question"]')?.scrollIntoView({ block: "end" });
  }, [intake, asked, asking, people]);

  const at = given.length; // the question on screen, from 0
  const current = intake ? questions[at] : undefined;
  const ready = name.trim().length > 0 && briefOf(problem, who).length >= PROBLEM_MIN && replacesReady(replaces);

  async function start() {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const out = await unwrap(
        api.POST("/v1/intakes", {
          body: {
            title: name.trim(),
            brief: briefOf(problem, who),
            source_ids: [],
            ai_extraction: true,
            batch_size: ASK,
            goal_ids: picks ?? [],
            out_of_scope: [],
            prd_answers: null,
            request_ids: [],
            replaces: replacesBody(replaces),
          },
        }),
      );
      const id = out.intake.id;
      // The first batch, as asked when the brief was made; none asked yet: ask one now.
      let batch = out.batch.current != null ? await unwrap(api.GET("/v1/intakes/{intake_id}/question-batch", { params: { path: { intake_id: id }, query: { batch: out.batch.current } } })) : null;
      if (!batch || batch.questions.length === 0) {
        batch = await unwrap(api.POST("/v1/intakes/{intake_id}/question-batches", { params: { path: { intake_id: id } }, body: { size: ASK, assign: {} } })).catch(() => null);
      }
      setQuestions((batch?.questions ?? []).map((c) => c.question).filter((q) => q.status === "asked").slice(0, ASK));
      setIntake(out.intake);
      onStarted();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function reply(kind: "answer" | "dont_know" | "delegate") {
    if (!current || busy) return;
    if (kind === "answer" && !answer.trim()) return;
    if (kind === "delegate" && !picked) return;
    setBusy(true);
    setError(null);
    try {
      await unwrap(
        api.POST("/v1/questions/{question_id}/answers", {
          params: { path: { question_id: current.id } },
          body: { kind, body: kind === "answer" ? answer.trim() : null, delegated_to: kind === "delegate" ? picked!.user_id : null, evidence_ids: [] },
        }),
      );
      setGiven((g) => [...g, kind === "answer" ? { kind: "answer", text: answer.trim() } : kind === "dont_know" ? { kind: "unknown" } : { kind: "later", name: picked!.name }]);
      setAnswer("");
      setHeld(null);
      setAsking(false);
      setPicked(null);
      onStarted();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  /** Draft with what I gave: the brief's run, estimated and started. A critical blocker still
   * open is drafted as open, its risk accepted, when the person may accept it (an owner, B4);
   * anyone else is told which questions the draft waits on. */
  async function draft() {
    if (!intake || busy) return;
    setBusy(true);
    setError(null);
    setHeld(null);
    const path = { params: { path: { intake_id: intake.id } } };
    try {
      const body = { knobs: { depth: "standard" as const, roles: {}, checkpoints: {} } };
      let run;
      try {
        run = await unwrap(api.POST("/v1/intakes/{intake_id}/runs", { ...path, body }));
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 409) throw e;
        const summary = await unwrap(api.GET("/v1/intakes/{intake_id}/summary", path));
        const blocking = summary.readiness.blocking_gap_ids;
        if (blocking.length === 0) throw e;
        // Every blocker is critical: only an owner may accept its risk.
        if (!can("decide_knowledge_gap", false)) {
          setHeld(blocking.map((id) => questions.find((q) => q.gap_id === id)?.prompt ?? summary.gaps.find((g) => g.id === id)?.statement ?? "A critical question"));
          return;
        }
        for (const gap_id of blocking)
          await unwrap(
            api.POST("/v1/gaps/{gap_id}/decisions", {
              params: { path: { gap_id } },
              body: { decision: "accept_risk", rationale: "Drafted with what was given: the draft marks it as open." },
            }),
          );
        run = await unwrap(api.POST("/v1/intakes/{intake_id}/runs", { ...path, body }));
      }
      const runPath = { params: { path: { run_id: run.id } } };
      const estimate = await unwrap(api.POST("/v1/runs/{run_id}/estimate", runPath));
      await unwrap(api.POST("/v1/runs/{run_id}/start", runPath));
      if (estimate.needs_approval && can("approve_run")) await unwrap(api.POST("/v1/runs/{run_id}/approve", runPath));
      onStarted();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const answered = given.filter((g) => g.kind === "answer").length;
  const unknown = given.filter((g) => g.kind === "unknown").length;
  const later = given.filter((g) => g.kind === "later").length;
  const left = questions.length - given.length;
  const tally = [
    `${answered} answered`,
    unknown > 0 ? `${unknown} not known` : null,
    later > 0 ? `${later} asked of someone` : null,
    left > 0 ? `${left} left` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  let body;
  let foot;
  if (!intake) {
    const goalList = goals.data ?? [];
    body = (
      <form
        id="np-form"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <p className="simple-small">Say what it is in your own words. Oracle then asks a few questions, one at a time, and drafts it.</p>
        <label className="flex flex-col gap-1.5">
          <span className={LABEL}>Name</span>
          <input className={FIELD} placeholder="For example: Saved shipping addresses" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={LABEL}>The problem</span>
          <textarea rows={3} className={FIELD} placeholder="What goes wrong today, and for whom" value={problem} maxLength={3500} onChange={(e) => setProblem(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={LABEL}>Who has it</span>
          <input className={FIELD} placeholder="The people this is for" value={who} maxLength={400} onChange={(e) => setWho(e.target.value)} />
        </label>
        <fieldset className="flex flex-col gap-1.5">
          <legend className={`${LABEL} mb-1.5`}>The goals it helps</legend>
          <div className="flex flex-wrap gap-2">
            {[...goalList.map((g) => ({ id: g.id as string | null, name: g.title })), { id: null, name: "Not sure yet" }].map((g) => {
              const on = g.id === null ? picks === null : !!picks?.includes(g.id);
              return (
                <button
                  key={g.id ?? "none"}
                  type="button"
                  aria-pressed={on}
                  className={`simple-chip ${on ? "border-accent! bg-accent! font-semibold text-on-accent!" : ""}`}
                  onClick={() => {
                    const id = g.id;
                    setPicks((p) => (id === null ? null : p?.includes(id) ? p.filter((x) => x !== id) : [...(p ?? []), id]));
                  }}
                >
                  {on && <Icon name="check" size={16} />}
                  {g.name}
                </button>
              );
            })}
          </div>
        </fieldset>
        <ReplacesField value={replaces} onChange={setReplaces} field={FIELD} label={LABEL} />
      </form>
    );
    foot = (
      <>
        <span className="simple-small mr-auto">Then up to {ASK} short questions</span>
        <button type="submit" form="np-form" aria-disabled={!ready || busy} className="simple-button simple-button-primary">
          {busy ? "Starting…" : "Next"}
        </button>
      </>
    );
  } else {
    body = (
      <div className="flex flex-col gap-4">
        <p className="simple-small">Oracle asks these before it drafts. Answer what you know; the rest can wait.</p>
        {intake.carried && <CarriedList carried={intake.carried} />}
        {questions.length > 0 && <Steps at={Math.min(at + 1, questions.length)} of={questions.length} />}
        {given.length > 0 && (
          <ul className="flex flex-col">
            {given.map((g, i) => (
              <Answered key={questions[i]!.id} q={questions[i]!} given={g} />
            ))}
          </ul>
        )}
        {current ? (
          <div className="flex flex-col gap-2 rounded-2xl border border-accent/40 bg-accent-soft/30 p-4" data-testid="np-question">
            <span className="simple-small tnum">
              Question {at + 1} of {questions.length}
            </span>
            <label htmlFor="np-answer" className="text-[18px] leading-7 font-semibold">
              {current.prompt}
            </label>
            <span className="simple-small" data-testid="np-why">
              {WHY[current.category] ?? current.rationale}
            </span>
            {asking ? (
              <div className="flex flex-col gap-2" data-testid="np-later">
                <span className={LABEL} id="np-later-label">
                  Ask someone to answer later
                </span>
                {people == null ? (
                  <span className="simple-small">Loading people…</span>
                ) : (
                  <ul className="flex max-h-72 flex-col overflow-y-auto rounded-xl border border-line bg-surface" aria-labelledby="np-later-label">
                    {people.map((p) => {
                      const on = picked?.user_id === p.user_id;
                      return (
                        <li key={p.user_id}>
                          <button
                            type="button"
                            aria-pressed={on}
                            className={`flex w-full items-center gap-2 px-3 py-2 text-left ${on ? "bg-accent-soft text-accent-ink" : "hover:bg-surface2"}`}
                            onClick={() => setPicked(p)}
                          >
                            <span aria-hidden className="grid size-7 flex-none place-items-center rounded-full bg-surface2 text-[12px] font-semibold">
                              {initials(p.name)}
                            </span>
                            {p.name}
                            {on && <Icon name="check" size={16} className="ml-auto" />}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <span className="simple-small">They see it on their Home. The draft starts now and updates when they answer.</span>
              </div>
            ) : (
              <textarea id="np-answer" rows={3} className={FIELD} value={answer} maxLength={4000} onChange={(e) => setAnswer(e.target.value)} autoFocus />
            )}
            <div className="flex flex-wrap gap-2 pt-1">
              {asking ? (
                <button type="button" className="simple-button simple-button-primary" aria-disabled={!picked || busy} onClick={() => void reply("delegate")}>
                  {picked ? `Ask ${picked.name}` : "Ask"}
                </button>
              ) : (
                <button type="button" className="simple-button simple-button-primary" aria-disabled={!answer.trim() || busy} onClick={() => void reply("answer")}>
                  Next question
                </button>
              )}
              <button type="button" className="simple-button" aria-disabled={busy} onClick={() => void reply("dont_know")}>
                I don&apos;t know
              </button>
              {!asking && (
                <button type="button" className="simple-button" onClick={() => setAsking(true)}>
                  Ask someone later
                </button>
              )}
            </div>
          </div>
        ) : (
          <p className="simple-small" data-testid="np-all-asked">
            {questions.length === 0 ? "Oracle has no questions for now." : "That was the last question."} Draft it when you are ready.
          </p>
        )}
      </div>
    );
    foot = (
      <>
        <span className="simple-small mr-auto" data-testid="np-tally">
          {questions.length > 0 ? tally : "No questions"}
        </span>
        <button type="button" className={`simple-button ${current ? "" : "simple-button-primary"}`} aria-disabled={busy} onClick={() => void draft()} data-testid="np-draft">
          {busy ? "Working…" : "Draft with what I gave"}
        </button>
      </>
    );
  }

  return (
    <>
      <div aria-hidden className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />
      <aside
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="New PRD"
        data-testid="np-sheet"
        className="fixed top-0 right-0 bottom-0 z-50 flex w-[520px] max-w-full flex-col border-l border-line bg-surface text-text shadow-tip max-[600px]:w-full"
      >
        <header className="flex items-center gap-2 border-b border-line px-5 py-4">
          <h2 className="simple-h2 min-w-0 flex-1 break-words">{intake ? intake.title : "New PRD"}</h2>
          <button type="button" aria-label="Close" className="grid size-9 place-items-center rounded-lg text-text2 hover:bg-surface2" onClick={onClose}>
            <Icon name="x" size={20} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {body}
          {error && (
            <p role="alert" className="simple-small mt-3 text-danger">
              {error}
            </p>
          )}
          {held && (
            <div role="alert" className="simple-small mt-3 flex flex-col gap-1" data-testid="np-held">
              <span>{held.length === 1 ? "This needs" : "These need"} an answer before it can draft:</span>
              <ul className="list-disc pl-5">
                {held.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
              <span>Or ask an owner to draft it.</span>
            </div>
          )}
        </div>
        <footer className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3">{foot}</footer>
      </aside>
    </>
  );
}

/** A PRD I started that has no PRD yet: its brief, the questions asked, who each waits on. */
export type Started = {
  intake: Intake;
  questions: Question[];
  gaps: Map<string, Schemas["KnowledgeGapOut"]>;
  people: Map<string, Person>;
  /** Changed in the last few minutes, when it was read. */
  fresh: boolean;
  /** The goals it serves, by name, as picked. */
  goals: string[];
};

const GONE = new Set<Intake["status"]>(["archived"]);

async function loadStarted(me: string): Promise<Started[]> {
  const goals = await unwrap(api.GET("/v1/baseline/entities", { params: { query: { type: "goal" } } })).catch(() => []);
  const intakes = (await unwrap(api.GET("/v1/intakes", { params: { query: { limit: 200 } } })))
    .filter((i) => i.author_id === me && !i.document_id && !GONE.has(i.status))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 3);
  const rows = await Promise.all(
    intakes.map(async (intake) => {
      const query = { intake_id: intake.id, limit: 200 };
      const [questions, gaps, summary] = await Promise.all([
        unwrap(api.GET("/v1/questions", { params: { query } })),
        unwrap(api.GET("/v1/gaps", { params: { query } })),
        unwrap(api.GET("/v1/intakes/{intake_id}/summary", { params: { path: { intake_id: intake.id } } })),
      ]);
      const named = summary.intake.goal_ids.map((id) => goals.find((g) => g.id === id)?.title).filter((t): t is string => !!t);
      return { intake, goals: named, questions: questions.filter((q) => q.batch != null && q.status !== "withdrawn" && q.status !== "draft"), gaps: new Map(gaps.map((g) => [g.id, g])) };
    }),
  );
  const people = await peopleByIds(rows.flatMap((r) => r.questions.filter((q) => q.status === "delegated").map((q) => q.asked_to))).catch(() => new Map<string, Person>());
  const now = Date.now();
  return rows.map((r) => ({ ...r, people, fresh: now - Date.parse(r.intake.updated_at) < 5 * 60 * 1000 }));
}

/** The PRDs I started that are not PRDs yet (Home's card and the One-pagers rows). */
export function useStartedPrds(enabled: boolean) {
  const { me } = useMe();
  return useQuery(`simple|started-prds|${me?.user_id ?? ""}`, () => (enabled && me?.user_id ? loadStarted(me.user_id) : Promise.resolve([] as Started[])));
}

/** "A", "A and B", "A, B and C". */
function andList(names: string[]): string {
  return names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function drafting(s: Started): boolean {
  return s.intake.status === "converted";
}

function StatusChip({ s }: { s: Started }) {
  return drafting(s) ? (
    <Chip kind="warn" dot>
      Drafting
    </Chip>
  ) : (
    <Chip dot>Not drafted yet</Chip>
  );
}

function waitsOn(s: Started): string | null {
  const later = s.questions.filter((q) => q.status === "delegated");
  if (later.length === 0) return null;
  const names = [...new Set(later.map((q) => (q.asked_to && s.people.get(q.asked_to)?.name) || "someone"))];
  return `${plural(later.length, "question")} ${later.length === 1 ? "waits" : "wait"} on ${names.join(" and ")}`;
}

/** Home's "PRDs you started" card: each one drafting, how far its questions got, what is open. */
export function StartedCard({ started: all }: { started: Started[] }) {
  // Home lists the ones drafting; a brief not drafted yet waits on One-pagers (and in Detailed).
  const started = all.filter(drafting);
  if (started.length === 0) return null;
  return (
    <section aria-label="PRDs you started" data-testid="np-started" className="simple-card">
      <header className="flex flex-wrap items-center gap-3">
        <span aria-hidden className="grid size-9 flex-none place-items-center rounded-full bg-accent-soft text-accent-ink">
          <Icon name="doc" size={20} />
        </span>
        <h2 className="simple-h2 flex-1">PRDs you started</h2>
        <Link href="/simple/one-pagers" className="simple-link">
          All one-pagers
        </Link>
      </header>
      {started.map((s) => {
        const answered = s.questions.filter((q) => q.status === "answered").length;
        const goal = andList(s.goals);
        const unknown = s.questions.filter((q) => q.status === "asked" && q.gap_id && s.gaps.get(q.gap_id)?.status === "unknown");
        const notYet = s.questions.filter((q) => q.status === "asked" && !unknown.includes(q));
        return (
          <div key={s.intake.id} className="flex flex-col gap-2" data-testid="np-started-row">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-semibold">{s.intake.title}</span>
              <StatusChip s={s} />
            </div>
            <ul className="simple-small flex flex-col gap-1">
              <li>
                {answered} of {plural(s.questions.length, "question")} answered.{goal ? ` The draft is for ${goal}.` : ""}
              </li>
              {unknown.map((q) => (
                <li key={q.id}>&ldquo;{q.prompt}&rdquo; you did not know: the draft marks it as open.</li>
              ))}
              {s.questions
                .filter((q) => q.status === "delegated")
                .map((q) => (
                  <li key={q.id}>
                    &ldquo;{q.prompt}&rdquo; waits on {(q.asked_to && s.people.get(q.asked_to)?.name) || "someone"}; the draft updates when they answer.
                  </li>
                ))}
              {notYet.map((q) => (
                <li key={q.id}>&ldquo;{q.prompt}&rdquo; was not answered yet: the draft marks it as open.</li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

/** One-pagers' rows for the PRDs I started, above the PRDs, until each is a PRD. */
export function StartedRows({ started }: { started: Started[] }) {
  const zone = useCompanyZone();
  return (
    <>
      {started.map((s) => {
        const waits = waitsOn(s);
        return (
          <li key={s.intake.id} data-testid="one-pager-started" className="relative flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-accent-soft/40 py-3 last:border-b-0">
            <Link href={`/intakes/${s.intake.id}`} className="min-w-0 font-semibold break-words after:absolute after:inset-0 after:content-[''] hover:underline">
              {s.intake.title}
            </Link>
            <StatusChip s={s} />
            {s.goals.length > 0 && (
              <span className="simple-small" data-testid="one-pager-started-goals">
                For {andList(s.goals)}
              </span>
            )}
            {waits && <span className="simple-small">{waits}</span>}
            <span className="simple-small ml-auto">{s.fresh ? "Updated just now" : `Updated ${dmy(dayIn(s.intake.updated_at, zone))}`}</span>
          </li>
        );
      })}
    </>
  );
}
