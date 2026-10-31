"use client";

// MOCK-HOOK: the whole file. Mock-ups only (mk-agentqs, decision AQ1): where a run agent's
// questions are asked. `?aq1=a|b|c|d` picks the proposal, `&aqs=rest|open|mid|next|done` the state,
// `&aqn=many` the hard case (eleven questions, some long).

import { createContext, useContext, useState, type ReactNode } from "react";

import { Button, Chip } from "@/components/ds";
import {
  AGENT_QS_FEATURES,
  AGENT_QS_NEXT_STEP,
  AGENT_QS_RUN,
  AGENT_QS_STOP,
  agentQuestions,
  type AgentQuestion,
} from "@/lib/api/mock/agent-questions";

export type AqVariant = "a" | "b" | "c" | "d";
type AqState = "rest" | "open" | "mid" | "next" | "done";

function readParams(): { variant: AqVariant | null; state: AqState; many: boolean } {
  if (typeof window === "undefined") return { variant: null, state: "rest", many: false };
  const p = new URLSearchParams(window.location.search);
  const v = p.get("aq1");
  const s = p.get("aqs");
  return {
    variant: v === "a" || v === "b" || v === "c" || v === "d" ? v : null,
    state: s === "open" || s === "mid" || s === "next" || s === "done" ? s : "rest",
    many: p.get("aqn") === "many",
  };
}

/** The question the story follows: the architect's send-path question. */
const FOCUS = "aq-1";

type Store = {
  variant: AqVariant | null;
  many: boolean;
  qs: AgentQuestion[];
  opened: string | null;
  picked: Record<string, string>;
  note: Record<string, string>;
  setOpened: (id: string | null) => void;
  pick: (id: string, option: string) => void;
  setNote: (id: string, text: string) => void;
  save: (id: string) => void;
  change: (id: string) => void;
};

const Ctx = createContext<Store | null>(null);

function initial() {
  const { variant, state, many } = readParams();
  const qs = agentQuestions(many).map((q) => ({ ...q }));
  const picked: Record<string, string> = {};
  const note: Record<string, string> = {};
  let opened: string | null = null;
  if (state === "open" || state === "mid") opened = FOCUS;
  if (state === "mid") {
    picked[FOCUS] = "build";
    note[FOCUS] = "The checkout team owns it from Nov 16";
  }
  if (state === "done" || state === "next") {
    const q = qs.find((x) => x.id === FOCUS)!;
    q.answer = { option: "build", by: "you", at: "just now", note: "The checkout team owns it from Nov 16" };
    // c: the saved card stays open under its row, so who answered and where it goes are seen.
    if (variant === "c") opened = FOCUS;
  }
  return { variant, many, qs, picked, note, opened, state };
}

export function AgentQsProvider({ children }: { children: ReactNode }) {
  const [init] = useState(initial);
  const [qs, setQs] = useState(init.qs);
  const [opened, setOpened] = useState<string | null>(init.opened);
  const [picked, setPicked] = useState(init.picked);
  const [note, setNoteMap] = useState(init.note);
  const store: Store = {
    variant: init.variant,
    many: init.many,
    qs,
    opened,
    picked,
    note,
    setOpened,
    pick: (id, option) => {
      setPicked((m) => ({ ...m, [id]: option }));
      setOpened(id);
    },
    setNote: (id, text) => setNoteMap((m) => ({ ...m, [id]: text })),
    save: (id) => {
      setQs((all) => all.map((q) => (q.id === id ? { ...q, answer: { option: picked[id] ?? q.recommended, by: "you", at: "just now", note: note[id] || undefined } } : q)));
      setOpened(null);
    },
    change: (id) => {
      setQs((all) => all.map((q) => (q.id === id ? { ...q, answer: null } : q)));
      setOpened(id);
    },
  };
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function useAgentQs(): Store | null {
  return useContext(Ctx);
}

/** The variant in the URL, read once (before any provider). */
export function aqVariant(): AqVariant | null {
  return readParams().variant;
}

const about = (q: AgentQuestion) => (q.feature ? AGENT_QS_FEATURES[q.feature] ?? q.feature : "the whole set");
const roleWord = (q: AgentQuestion) => (q.role === "analyst" ? "Analyst" : "Architect");
const optionLabel = (q: AgentQuestion, key: string) => q.options.find((o) => o.key === key)?.label ?? key;

/** Where an answer goes, said once per answered card. */
function Reaches({ q }: { q: AgentQuestion }) {
  return (
    <p className="text-[13px] text-text2" data-testid="aq-reaches">
      Goes to <b className="font-semibold text-text">{AGENT_QS_NEXT_STEP}</b>, the next step, with this stop&apos;s decision. Its agent reads it as settled.
      {q.answer?.by === "you" && " You can change it until you decide the stop."}
    </p>
  );
}

/**
 * One question: who asks and about what, the options as buttons (the agent's pick marked),
 * a note and Save once an option is picked; answered, the pick with who and when.
 */
export function QuestionCard({ q, compact = false, showAbout = true, big = false }: { q: AgentQuestion; compact?: boolean; showAbout?: boolean; big?: boolean }) {
  const s = useAgentQs()!;
  const open = s.opened === q.id;
  const chosen = s.picked[q.id];
  if (q.answer) {
    return (
      <div className="flex flex-col gap-1 rounded-button border border-line bg-surface px-3 py-2" data-testid="aq-card" data-state="answered">
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-text2">
          <Chip kind="pass">Answered</Chip>
          <span>
            {roleWord(q)} asked{showAbout && <> · About {about(q)}</>}
          </span>
        </div>
        <p className="text-sm text-text">{q.question}</p>
        <p className="text-sm">
          <span aria-hidden className="text-pass">✓ </span>
          <b className="font-semibold">{optionLabel(q, q.answer.option)}</b>
          {q.answer.option === q.recommended && <span className="text-text2"> (the agent&apos;s pick)</span>}
          {q.answer.note && <span className="text-text2"> · “{q.answer.note}”</span>}
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-[13px] text-text2" data-testid="aq-who">
            Answered by {q.answer.by === "you" ? "you" : q.answer.by} · {q.answer.at}
          </span>
          {q.answer.by === "you" && (
            <button type="button" className="text-[13px] font-semibold text-accent-ink underline" onClick={() => s.change(q.id)}>
              Change
            </button>
          )}
        </div>
        <Reaches q={q} />
      </div>
    );
  }
  return (
    <div
      className={`flex flex-col gap-2 rounded-button border bg-surface px-3 py-3 ${open ? "border-accent shadow-[0_0_0_1px_var(--accent)]" : "border-line"}`}
      data-testid="aq-card"
      data-state={open ? "open" : "unanswered"}
    >
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-text2">
        <Chip kind="warn" dot>
          Needs an answer
        </Chip>
        <span>
          {roleWord(q)} asks{showAbout && <> · About {about(q)}</>}
        </span>
      </div>
      <p className={`${big ? "text-lg" : "text-[15px]"} font-semibold text-text`}>{q.question}</p>
      {(open || big) && <p className="text-sm text-text2">Why: {q.why}</p>}
      <div role="radiogroup" aria-label={q.question} className={`flex gap-2 ${compact && !open ? "flex-wrap" : "flex-col"}`}>
        {q.options.map((o) => {
          const on = chosen === o.key;
          return (
            <button
              key={o.key}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => s.pick(q.id, o.key)}
              className={`flex min-h-10 flex-col items-start rounded-button border px-3 py-1.5 text-left text-sm hover:border-accent ${on ? "border-accent bg-accent-soft" : "border-line-strong bg-surface"}`}
            >
              <span className="flex flex-wrap items-center gap-2 font-medium">
                <span aria-hidden className={`inline-block size-3.5 rounded-full border-2 ${on ? "border-accent bg-accent" : "border-line-strong"}`} />
                {o.label}
                {o.key === q.recommended && <Chip kind="acc">Agent&apos;s pick</Chip>}
              </span>
              {(open || big) && <span className="pl-5.5 text-[13px] text-text2">{o.detail}</span>}
            </button>
          );
        })}
      </div>
      {chosen ? (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-[13px] text-text2">
            Note for the next agent (optional)
            <input
              className="h-9 rounded-button border border-line-strong bg-surface px-2 text-sm text-text"
              value={s.note[q.id] ?? ""}
              onChange={(e) => s.setNote(q.id, e.target.value)}
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="solid" onClick={() => s.save(q.id)}>
              Save answer
            </Button>
            <Button variant="ghost" onClick={() => s.pick(q.id, "")}>
              Clear
            </Button>
            <span className="text-[13px] text-text2">Goes to {AGENT_QS_NEXT_STEP} with this stop&apos;s decision.</span>
          </div>
        </div>
      ) : (
        <p className="text-[13px] text-text2">
          Not answered by the time you decide: {AGENT_QS_NEXT_STEP} goes with the agent&apos;s pick.
          {open && !big && s.variant === "a" && (
            <>
              {" "}
              <button type="button" className="font-semibold text-accent-ink underline" onClick={() => s.setOpened(null)}>
                Hide why
              </button>
            </>
          )}
          {!open && !big && (
            <>
              {" "}
              <button type="button" className="font-semibold text-accent-ink underline" onClick={() => s.setOpened(q.id)}>
                Why they ask
              </button>
            </>
          )}
        </p>
      )}
    </div>
  );
}

const openCount = (qs: AgentQuestion[]) => qs.filter((q) => !q.answer).length;

/** AQ1 a: the questions as cards at the top of the stop's review page. */
export function AgentQsTop() {
  const s = useAgentQs();
  if (!s || s.variant !== "a") return null;
  const open = s.qs.filter((q) => !q.answer);
  const done = s.qs.filter((q) => q.answer);
  return (
    <section className="mb-4 rounded-panel border border-line bg-surface2 p-3" aria-label="Questions from the agents" data-testid="aq-top">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold">Questions from the agents</h2>
        <span className="tnum text-sm text-text2">
          {open.length} open · {done.length} answered
        </span>
        <span className="text-[13px] text-text2">Answer here before you decide; each answer goes to {AGENT_QS_NEXT_STEP} with the decision.</span>
      </div>
      <div className="grid grid-cols-2 items-start gap-2 max-[900px]:grid-cols-1">
        {open.map((q) => (
          <QuestionCard key={q.id} q={q} compact />
        ))}
      </div>
      {done.length > 0 && (
        <h3 className="mt-3 mb-1 text-sm font-semibold text-text2">Answered</h3>
      )}
      {done.length > 0 && (
        <div className="grid grid-cols-2 items-start gap-2 max-[900px]:grid-cols-1">
          {done.map((q) => (
            <QuestionCard key={q.id} q={q} />
          ))}
        </div>
      )}
    </section>
  );
}

/** AQ1 c: the chip in a feature row's reasons that opens its questions under the row. */
export function AgentQsRowChip({ feature }: { feature: string }) {
  const s = useAgentQs();
  if (!s || s.variant !== "c") return null;
  const qs = s.qs.filter((q) => q.feature === feature);
  if (!qs.length) return null;
  const n = openCount(qs);
  const isOpen = qs.some((q) => q.id === s.opened);
  return (
    <button
      type="button"
      aria-expanded={isOpen}
      onClick={() => s.setOpened(isOpen ? null : (qs.find((q) => !q.answer) ?? qs[0]).id)}
      className={`inline-flex min-h-6 items-center gap-1 rounded-full px-2 text-[13px] font-semibold ${n ? "bg-accent-soft text-accent-ink" : "bg-pass-bg text-pass"}`}
      data-testid="aq-row-chip"
    >
      {n ? `${n} question${n > 1 ? "s" : ""} ▾` : `✓ ${qs.length} answered`}
    </button>
  );
}

/** AQ1 c: under the row, its open questions (only while its chip is open). */
export function AgentQsRowPanel({ feature }: { feature: string }) {
  const s = useAgentQs();
  if (!s || s.variant !== "c") return null;
  const qs = s.qs.filter((q) => q.feature === feature);
  if (!qs.some((q) => q.id === s.opened)) return null;
  return (
    <div className="flex flex-col gap-2 border-t border-line bg-surface2 px-3 py-3 pl-12 max-[600px]:pl-3" data-testid="aq-row-panel">
      {qs.map((q) => (
        <QuestionCard key={q.id} q={q} showAbout={false} />
      ))}
    </div>
  );
}

/** AQ1 c: questions about the whole set have no row; they sit as one line above the table. */
export function AgentQsSetLine() {
  const s = useAgentQs();
  if (!s || s.variant !== "c") return null;
  const qs = s.qs.filter((q) => !q.feature);
  if (!qs.length) return null;
  const open = qs.some((q) => q.id === s.opened);
  return (
    <div className="rounded-panel border border-line bg-surface px-3 py-2" data-testid="aq-set-line">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold">About the whole set</span>
        <AgentQsSetChip ids={qs.map((q) => q.id)} />
        {qs
          .filter((q) => q.answer)
          .map((q) => (
            <span key={q.id} className="text-[13px] text-text2" data-testid="aq-set-who">
              {optionLabel(q, q.answer!.option)} · by {q.answer!.by} · {q.answer!.at}
            </span>
          ))}
        <span className="text-[13px] text-text2">Questions about one feature are on its row.</span>
      </div>
      {open && (
        <div className="mt-2 flex flex-col gap-2">
          {qs.map((q) => (
            <QuestionCard key={q.id} q={q} showAbout={false} />
          ))}
        </div>
      )}
    </div>
  );
}

function AgentQsSetChip({ ids }: { ids: string[] }) {
  const s = useAgentQs()!;
  const qs = s.qs.filter((q) => ids.includes(q.id));
  const n = openCount(qs);
  const isOpen = qs.some((q) => q.id === s.opened);
  return (
    <button
      type="button"
      aria-expanded={isOpen}
      onClick={() => s.setOpened(isOpen ? null : (qs.find((q) => !q.answer) ?? qs[0]).id)}
      className={`inline-flex min-h-6 items-center gap-1 rounded-full px-2 text-[13px] font-semibold ${n ? "bg-accent-soft text-accent-ink" : "bg-pass-bg text-pass"}`}
    >
      {n ? `${n} question${n > 1 ? "s" : ""} ▾` : `✓ ${qs.length} answered`}
    </button>
  );
}

/** AQ1 c: the count beside the page title, so a row's questions are not missed. */
export function AgentQsHeaderCount() {
  const s = useAgentQs();
  if (!s || (s.variant !== "c" && s.variant !== "b")) return null;
  const n = openCount(s.qs);
  if (s.variant === "b")
    return (
      <a href="/inbox?aq1=b" className="text-sm font-semibold text-accent-ink underline" data-testid="aq-inbox-link">
        {n ? `${n} questions from the agents wait in your Inbox` : "Agents' questions: all answered"}
      </a>
    );
  return (
    <Chip kind={n ? "acc" : "pass"} data-testid="aq-header-count">
      {n ? `${n} open questions on rows` : "Questions answered"}
    </Chip>
  );
}

/**
 * AQ1 d: before the stop opens, its open questions one at a time; the stop opens once each is
 * answered or left to the agent's pick.
 */
export function AgentQsGate() {
  const s = useAgentQs();
  const [skipped, setSkipped] = useState<string[]>([]);
  const [shut, setShut] = useState(() => readParams().state === "done");
  if (!s || s.variant !== "d") return null;
  const open = s.qs.filter((q) => !q.answer && !skipped.includes(q.id));
  // Questions someone else answered before are not asked again, nor counted.
  const earlier = s.qs.filter((q) => q.answer && q.answer.by !== "you");
  const asks = s.qs.filter((q) => !earlier.includes(q));
  const total = asks.length;
  if (shut || open.length === 0) {
    const mine = s.qs.filter((q) => q.answer?.by === "you").length;
    const left = s.qs.filter((q) => !q.answer).length;
    const others = earlier.map((q) => `${q.answer!.by} (${q.answer!.at})`).join(", ");
    return (
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-panel border border-line bg-surface px-3 py-2 text-sm" data-testid="aq-gate-done">
        <span aria-hidden className="text-pass">✓</span>
        <span>
          <b className="font-semibold">Agents&apos; questions:</b> {mine} answered by you{others ? `, ${earlier.length} earlier by ${others}` : ""}{left ? `, ${left} left to the agent's pick` : ""}. They go to{" "}
          {AGENT_QS_NEXT_STEP} with your decision.
        </span>
        <button type="button" className="font-semibold text-accent-ink underline" onClick={() => setShut(false)}>
          See answers
        </button>
      </div>
    );
  }
  const q = s.qs.find((x) => x.id === s.opened && !x.answer) ?? open[0];
  const index = asks.indexOf(q) + 1;
  return (
    <div className="fixed inset-0 z-40 grid grid-cols-1 place-items-center bg-black/40 p-4 max-[600px]:items-end max-[600px]:p-0" data-testid="aq-gate">
      <div role="dialog" aria-modal aria-label="Before you open this stop" className="flex max-h-[90vh] w-full max-w-[640px] min-w-0 flex-col gap-3 overflow-auto rounded-panel bg-surface p-5 shadow-xl max-[600px]:rounded-b-none">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <h2 className="text-lg font-semibold">Before you open this stop</h2>
          <span className="tnum text-sm text-text2">
            Question {index} of {total}
          </span>
        </div>
        <p className="text-sm text-text2">
          The agents of {AGENT_QS_RUN} · {AGENT_QS_STOP} asked {s.qs.length} questions: {total} for you
          {earlier.length > 0 && <>, {earlier.length} answered earlier by {Array.from(new Set(earlier.map((x) => x.answer!.by))).join(" and ")}</>}. Answer each, or leave it to the agent&apos;s pick; then the stop opens.
        </p>
        <div className="flex flex-col gap-1">
          <div className="flex gap-1" aria-hidden>
            {asks.map((x) => (
              <span key={x.id} className={`h-1.5 flex-1 rounded-full ${x.answer ? "bg-pass" : x.id === q.id ? "bg-accent" : "bg-line-strong"}`} />
            ))}
          </div>
          <span className="flex flex-wrap gap-x-3 text-[12px] text-text2">
            <span><span aria-hidden className="mr-1 inline-block h-1.5 w-3 rounded-full bg-pass" />Answered</span>
            <span><span aria-hidden className="mr-1 inline-block h-1.5 w-3 rounded-full bg-accent" />This one</span>
            <span><span aria-hidden className="mr-1 inline-block h-1.5 w-3 rounded-full bg-line-strong" />Still to come</span>
          </span>
        </div>
        <QuestionCard q={q} big />
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <Button variant="ghost" onClick={() => setSkipped((x) => [...x, q.id])}>
            Leave it to the agent&apos;s pick
          </Button>
          <span className="ml-auto text-[13px] text-text2">{open.length} left</span>
          <Button variant="ghost" onClick={() => setShut(true)}>
            Open the stop now
          </Button>
        </div>
      </div>
    </div>
  );
}

/** AQ1 b: the Inbox's own rows, one per open question, answered in place. */
export function AgentQsInbox() {
  const s = useAgentQs();
  if (!s || s.variant !== "b") return null;
  return (
    <div className="px-4 pt-3" data-testid="aq-inbox">
      <h3 className="mb-1 flex items-baseline gap-2 text-sm font-semibold">
        Questions from run agents <span className="tnum font-normal text-text2">{openCount(s.qs)} open</span>
        <span className="text-[13px] font-normal text-text2">Not counted in “waiting” above: each is settled with its stop’s decision, not on its own.</span>
      </h3>
      <div role="table" aria-label="Questions from run agents" className="rounded-panel border border-line">
        {[...s.qs.filter((q) => !q.answer), ...s.qs.filter((q) => q.answer)].map((q) => {
          const open = s.opened === q.id;
          return (
            <div key={q.id} role="row" className="border-b border-line last:border-b-0">
              <div className="grid grid-cols-[minmax(0,1fr)_auto_190px_auto] items-center gap-3 px-3 py-2 max-[600px]:flex max-[600px]:flex-wrap max-[600px]:gap-1">
                <span role="cell" className="min-w-0 max-[600px]:basis-full">
                  <span className="block text-sm font-medium" title={q.question}>
                    {q.question}
                  </span>
                  <span className="text-[13px] text-text2">
                    {roleWord(q)} · About {about(q)}
                    {q.answer && <> · Goes to {AGENT_QS_NEXT_STEP} with the stop&apos;s decision</>}
                  </span>
                </span>
                <span role="cell" className="min-w-0 text-[13px] whitespace-nowrap text-text2 max-[600px]:whitespace-normal">
                  {AGENT_QS_RUN} · {AGENT_QS_STOP}
                </span>
                <span role="cell" className="text-[13px]">
                  {q.answer ? (
                    <span className="text-pass">
                      ✓ {q.answer.by === "you" ? "You" : q.answer.by} · {q.answer.at}
                    </span>
                  ) : (
                    <Chip kind="warn" dot>
                      Needs an answer
                    </Chip>
                  )}
                </span>
                <span role="cell">
                  <Button onClick={() => s.setOpened(open ? null : q.id)} aria-expanded={open}>
                    {q.answer ? "See" : open ? "Close" : "Answer"}
                  </Button>
                </span>
              </div>
              {open && (
                <div className="bg-surface2 px-3 py-3">
                  <QuestionCard q={q} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
