"use client";
// MOCK-HOOK: the whole file. Mock-ups for "Starting a PRD from Simple" (NP1), switched by
// ?np1=a|b|c|d, with &open=1, &phase=fill|ask|hard and &made=1 for each frame's state.

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { type ReactNode } from "react";

import { Chip } from "@/components/ds";
import { Icon } from "@/components/ds/Icon";
import { NEWPRD, type NewPrdQuestion } from "@/lib/api/mock/newprd";

export type Np1 = "a" | "b" | "c" | "d" | null; // MOCK-HOOK
export type NpState = { np1: Np1; open: boolean; phase: string | null; made: boolean }; // MOCK-HOOK

/** MOCK-HOOK: the switch, from the address (a link to the same page with new switches updates it). */
export function useNp(): NpState {
  const p = useSearchParams(); // MOCK-HOOK
  const v = p.get("np1"); // MOCK-HOOK
  return { np1: v === "a" || v === "b" || v === "c" || v === "d" ? v : null, open: p.get("open") === "1", phase: p.get("phase"), made: p.get("made") === "1" }; // MOCK-HOOK
}

const FIELD = "w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-[16px] leading-6 text-text placeholder:text-text2 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"; // MOCK-HOOK
const LABEL = "text-[15px] font-semibold text-text"; // MOCK-HOOK

/** MOCK-HOOK: the New PRD button (a: opens Detailed's form; b: opens the sheet). */
export function NewPrdButton({ np, from }: { np: NpState; from: "home" | "one-pagers" }) {
  if (np.np1 === "a")
    return (
      <Link href="/documents/new?kind=prd&from=simple" data-testid="np-new-prd" className={`simple-button ${from === "home" ? "" : "simple-button-primary"}`}>
        <Icon name="plus" size={18} /> New PRD
      </Link>
    );
  if (np.np1 === "b")
    return (
      <Link href={`/simple${from === "home" ? "" : "/one-pagers"}?np1=b&open=1`} data-testid="np-new-prd" className={`simple-button ${from === "home" ? "" : "simple-button-primary"}`}>
        <Icon name="plus" size={18} /> New PRD
      </Link>
    );
  return null;
}

/** MOCK-HOOK: the new PRD, once it drafts, as a One-pagers row (a, b, c, d: the result). */
export function MadeRow({ np }: { np: NpState }) {
  return (
    <li data-testid="one-pager-row" className="relative flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-accent-soft/40 py-3 last:border-b-0">
      <Link href="/simple/one-pagers" className="min-w-0 font-semibold break-words">
        {NEWPRD.title}
      </Link>
      <Chip kind="warn" dot>{NEWPRD.made.status}</Chip>
      <span className="simple-small">
        {np.np1 === "a" ? `${NEWPRD.made.eta} · 3 questions still open in Detailed` : `${NEWPRD.made.eta} · 1 question waits on ${NEWPRD.questions[4].later}`}
      </span>
      <span className="simple-small ml-auto">Updated just now</span>
    </li>
  );
}

/** MOCK-HOOK: Home's card for a PRD you started that is drafting (b's result). */
export function DraftingCard() {
  return (
    <section aria-label="PRDs you started" data-testid="np-drafting" className="simple-card">
      <header className="flex flex-wrap items-center gap-3">
        <span aria-hidden className="grid size-9 flex-none place-items-center rounded-full bg-accent-soft text-accent-ink">
          <Icon name="doc" size={20} />
        </span>
        <h2 className="simple-h2 flex-1">PRDs you started</h2>
        <Link href="/simple/one-pagers?np1=b&made=1" className="simple-link">
          All one-pagers
        </Link>
      </header>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-semibold">{NEWPRD.title}</span>
          <Chip kind="warn" dot>Drafting</Chip>
          <span className="simple-small">{NEWPRD.made.eta}</span>
        </div>
        <div aria-hidden className="h-2 overflow-hidden rounded-full bg-surface2">
          <div className="h-full w-[35%] rounded-full bg-accent" />
        </div>
        <ul className="simple-small flex flex-col gap-1">
          <li>4 of 6 questions answered. The draft is for {NEWPRD.goal}.</li>
          <li>
            &ldquo;{NEWPRD.questions[3].text}&rdquo; you did not know: the draft marks it as open.
          </li>
          <li>
            &ldquo;{NEWPRD.questions[4].text}&rdquo; waits on {NEWPRD.questions[4].later}; the draft updates when she answers.
          </li>
        </ul>
      </div>
    </section>
  );
}

/** One answered question, short, as the sheet and page list them. */
function Answered({ q }: { q: NewPrdQuestion }) {
  return (
    <li className="flex flex-col gap-0.5 border-b border-line py-2 last:border-b-0">
      <span className="text-[15px] font-semibold">{q.text}</span>
      {q.unknown ? (
        <span className="simple-small">
          <span className="simple-tag">I don&apos;t know</span> The draft marks it as open.
        </span>
      ) : q.later ? (
        <span className="simple-small">
          <span className="simple-tag">Later</span> Asked of {q.later}. The draft starts without it.
        </span>
      ) : (
        <span className="simple-small">{q.answer}</span>
      )}
    </li>
  );
}

function Steps({ at, of }: { at: number; of: number }) {
  return (
    <div className="flex items-center gap-1.5" aria-label={`Question ${at} of ${of}`}>
      {Array.from({ length: of }, (_, i) => (
        <span key={i} className={`h-1.5 flex-1 rounded-full ${i < at - 1 ? "bg-accent" : i === at - 1 ? "bg-accent/50" : "bg-surface2"}`} />
      ))}
    </div>
  );
}

/** b: the guided New PRD sheet: four fields, then Oracle's questions one at a time. */
export function NewPrdSheet({ np, back }: { np: NpState; back: string }) {
  if (np.np1 !== "b" || !np.open) return null;
  const phase = np.phase;
  const q = NEWPRD.questions;
  let body: ReactNode;
  let foot: ReactNode;
  if (phase === "ask" || phase === "hard") {
    const at = phase === "ask" ? 2 : 5;
    const cur = q[at - 1];
    body = (
      <div className="flex flex-col gap-4">
        <p className="simple-small">Oracle asks these before it drafts. Answer what you know; the rest can wait.</p>
        <Steps at={at} of={q.length} />
        <ul className="flex flex-col">{q.slice(0, at - 1).map((x) => <Answered key={x.id} q={x} />)}</ul>
        <div className="flex flex-col gap-2 rounded-2xl border border-accent/40 bg-accent-soft/30 p-4">
          <span className="simple-small tnum">
            Question {at} of {q.length}
          </span>
          <label htmlFor="np-answer" className="text-[18px] leading-7 font-semibold">
            {cur.text}
          </label>
          <span className="simple-small">{cur.why}</span>
          {phase === "ask" ? (
            <textarea id="np-answer" rows={3} className={FIELD} defaultValue={NEWPRD.typing} autoFocus />
          ) : (
            <div className="flex flex-col gap-2" data-testid="np-later">
              <span className={LABEL}>Ask someone to answer later</span>
              <ul className="flex flex-col rounded-xl border border-line bg-surface">
                {NEWPRD.people.map((p, i) => (
                  <li key={p} className={`flex items-center gap-2 px-3 py-2 ${i === 0 ? "bg-accent-soft text-accent-ink" : ""}`}>
                    <span aria-hidden className="grid size-7 place-items-center rounded-full bg-surface2 text-[12px] font-semibold">
                      {p.split(" ").map((w) => w[0]).join("")}
                    </span>
                    {p}
                    {i === 0 && <Icon name="check" size={16} className="ml-auto" />}
                  </li>
                ))}
              </ul>
              <span className="simple-small">She sees it on her Home. The draft starts now and updates when she answers.</span>
            </div>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            {phase === "ask" && <button type="button" className="simple-button simple-button-primary">Next question</button>}
            {phase === "hard" && <button type="button" className="simple-button simple-button-primary">Ask Priya Raman</button>}
            <button type="button" className="simple-button">I don&apos;t know</button>
            {phase === "ask" && <button type="button" className="simple-button">Ask someone later</button>}
          </div>
        </div>
      </div>
    );
    foot = (
      <>
        <span className="simple-small mr-auto">{phase === "ask" ? "1 answered" : "3 answered · 1 not known"}</span>
        <Link href={`${back}?np1=b&made=1`} className="simple-button">
          Draft with what I gave
        </Link>
      </>
    );
  } else {
    const filled = phase === "fill";
    body = (
      <div className="flex flex-col gap-4">
        <p className="simple-small">Say what it is in your own words. Oracle then asks a few questions, one at a time, and drafts it.</p>
        <label className="flex flex-col gap-1.5">
          <span className={LABEL}>Name</span>
          <input className={FIELD} placeholder="For example: Saved shipping addresses" defaultValue={filled ? NEWPRD.title : ""} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={LABEL}>The problem</span>
          <textarea rows={3} className={FIELD} placeholder="What goes wrong today, and for whom" defaultValue={filled ? NEWPRD.problem : ""} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={LABEL}>Who has it</span>
          <input className={FIELD} placeholder="The people this is for" defaultValue={filled ? NEWPRD.who.slice(0, 31) : ""} autoFocus={filled} />
        </label>
        <fieldset className="flex flex-col gap-1.5">
          <legend className={`${LABEL} mb-1.5`}>The goal it helps</legend>
          <div className="flex flex-wrap gap-2">
            {["Raise activation", "Grow paid conversion", "Not sure yet"].map((g) => (
              <span key={g} className={`simple-chip ${filled && g === NEWPRD.goal ? "border-accent! bg-accent-soft! text-accent-ink!" : ""}`}>
                {g}
              </span>
            ))}
          </div>
        </fieldset>
      </div>
    );
    foot = (
      <>
        <span className="simple-small mr-auto">Then 6 short questions</span>
        <Link href={`${back}?np1=b&open=1&phase=ask`} aria-disabled={!filled} className="simple-button simple-button-primary">
          Next
        </Link>
      </>
    );
  }
  return (
    <>
      <div aria-hidden className="fixed inset-0 z-40 bg-black/40" />
      <aside role="dialog" aria-modal="true" aria-label="New PRD" data-testid="np-sheet" className="fixed top-0 right-0 bottom-0 z-50 flex w-[520px] max-w-full flex-col border-l border-line bg-surface text-text shadow-tip max-[600px]:w-full">
        <header className="flex items-center gap-2 border-b border-line px-5 py-4">
          <h2 className="simple-h2 flex-1">{phase === "ask" || phase === "hard" ? NEWPRD.title : "New PRD"}</h2>
          <Link href={back} aria-label="Close" className="grid size-9 place-items-center rounded-lg text-text2 hover:bg-surface2">
            <Icon name="x" size={20} />
          </Link>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{body}</div>
        <footer className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3">{foot}</footer>
      </aside>
    </>
  );
}

/** c: "Start a PRD" on a goal card, and what it started there. */
export function GoalStart({ np, goal }: { np: NpState; goal: string }) {
  if (np.np1 !== "c") return null;
  if (np.made && goal === NEWPRD.goal)
    return (
      <p className="simple-small flex flex-wrap items-center gap-2" data-testid="np-goal-made">
        <span className="font-semibold text-text">{NEWPRD.title}</span>
        <Chip kind="warn" dot>Drafting</Chip>
      </p>
    );
  return (
    <Link href={`/simple/new-prd?np1=c&goal=${encodeURIComponent(goal)}`} data-testid="np-goal-start" className="simple-link inline-flex items-center gap-1 self-start">
      <Icon name="plus" size={16} /> Start a PRD for this goal
    </Link>
  );
}

/** c: the New PRD page, pre-filled from the goal, every question on one page. */
export function NewPrdPage({ np }: { np: NpState }) {
  const phase = np.phase;
  const q = NEWPRD.questions;
  const filled = phase === "ask" || phase === "hard";
  const shown = (i: number): { value: string; mark?: "unknown" | "later" } => {
    if (phase === "hard") {
      if (q[i].unknown) return { value: "", mark: "unknown" };
      if (q[i].later) return { value: "", mark: "later" };
      return { value: q[i].answer ?? "" };
    }
    if (phase === "ask") return { value: i === 0 ? (q[0].answer ?? "") : i === 1 ? NEWPRD.typing : "" };
    return { value: "" };
  };
  const answered = phase === "hard" ? 4 : phase === "ask" ? 1 : 0;
  return (
    <div className="simple-page pb-28" data-testid="np-page">
      <header className="flex flex-col gap-2">
        <Link href="/simple?np1=c" className="simple-link inline-flex items-center gap-1 self-start">
          <Icon name="chevron-left" size={16} /> Home
        </Link>
        <h1 className="simple-h1">New PRD for {NEWPRD.goal}</h1>
        <p className="simple-small">Oracle filled in what it could from the goal. Change what is wrong, answer what you know, and start the draft.</p>
      </header>
      <section className="simple-card" aria-label="What it is">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="simple-h2 flex-1">What it is</h2>
          <span className="simple-tag">From the goal</span>
        </div>
        <div className="grid grid-cols-2 gap-4 max-[900px]:grid-cols-1">
          <label className="flex flex-col gap-1.5">
            <span className={LABEL}>Name</span>
            <input className={FIELD} defaultValue={filled ? NEWPRD.title : ""} placeholder="Name it in a few words" />
          </label>
          <div className="flex flex-col gap-1.5">
            <span className={LABEL}>Goal</span>
            <span className="rounded-xl bg-surface2 px-3 py-2.5">
              <b>{NEWPRD.goal}</b> <span className="simple-small tnum">{NEWPRD.goalPath}</span>
            </span>
          </div>
          <label className="flex flex-col gap-1.5">
            <span className={LABEL}>The problem</span>
            <textarea rows={3} className={FIELD} defaultValue={filled ? NEWPRD.problem : "New people stop before their second week."} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={LABEL}>Who has it</span>
            <textarea rows={3} className={FIELD} defaultValue={filled ? NEWPRD.who : "People in their first two weeks"} />
          </label>
        </div>
      </section>
      <section className="simple-card" aria-label="Oracle's questions">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 className="simple-h2 flex-1">Oracle&apos;s questions</h2>
          <span className="simple-small">Answer any, in any order. Leave a box empty and the draft marks it as open.</span>
        </div>
        <ol className="flex flex-col gap-4">
          {q.map((x, i) => {
            const s = shown(i);
            return (
              <li key={x.id} className="flex flex-col gap-1.5 border-b border-line pb-4 last:border-b-0">
                <label htmlFor={`np-${x.id}`} className={LABEL}>
                  {i + 1}. {x.text}
                </label>
                <span className="simple-small">{x.why}</span>
                {s.mark ? (
                  <p className="flex flex-wrap items-center gap-2 rounded-xl bg-surface2 px-3 py-2.5">
                    <span className="simple-tag">{s.mark === "unknown" ? "I don't know" : "Later"}</span>
                    {s.mark === "unknown" ? "The draft marks it as open." : `Asked of ${x.later}. She sees it on her Home.`}
                    <button type="button" className="simple-link ml-auto">Undo</button>
                  </p>
                ) : (
                  <>
                    <textarea id={`np-${x.id}`} rows={2} className={FIELD} defaultValue={s.value} autoFocus={phase === "ask" && i === 1} />
                    {!s.value && (
                      <div className="flex flex-wrap gap-2">
                        <button type="button" className="simple-button-quiet simple-button">I don&apos;t know</button>
                        <button type="button" className="simple-button-quiet simple-button">Ask someone later</button>
                      </div>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ol>
      </section>
      <footer className="fixed right-0 bottom-0 left-0 z-30 border-t border-line bg-surface px-6 py-3 shadow-tip min-[601px]:left-[232px] max-[600px]:bottom-[64px]">
        <div className="mx-auto flex max-w-[944px] flex-wrap items-center gap-3">
          <span className="simple-small mr-auto tnum">
            {answered} of {q.length} answered{phase === "hard" ? " · 1 not known · 1 asked of Priya Raman" : ""}
          </span>
          <Link href="/simple?np1=c&made=1" className="simple-button simple-button-primary">
            Start the draft
          </Link>
        </div>
      </footer>
    </div>
  );
}

/** d: Ask Oracle's starter, under "Nothing yet". */
export function ChatStarter() {
  return (
    <div className="flex flex-col items-center gap-2 px-2 pb-3" data-testid="np-chat-starter">
      <span className="simple-small">Or start something:</span>
      <span className="simple-chip">Start a PRD</span>
    </div>
  );
}

function Bubble({ me, children, at }: { me?: boolean; children: ReactNode; at: string }) {
  return (
    <li className={`flex flex-col gap-2 ${me ? "items-end" : "items-start"}`}>
      <div className={`min-w-0 max-w-[94%] rounded-[14px] px-3 py-2 ${me ? "bg-accent-soft text-accent-ink" : "bg-surface2 text-text"}`}>
        <p className="mb-0.5 text-[13px] leading-[18px] text-text2">
          <b className="font-semibold text-text">{me ? "You" : "Oracle"}</b> · {at}
        </p>
        {children}
      </div>
    </li>
  );
}

function Chips({ items }: { items: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5 pt-1">
      {items.map((c) => (
        <span key={c} className="simple-chip bg-surface!">{c}</span>
      ))}
    </div>
  );
}

/** d: the chat where Oracle starts the PRD and asks the brief's questions. */
export function NewPrdChat({ np }: { np: NpState }) {
  const phase = np.phase;
  const q = NEWPRD.questions;
  const lines: ReactNode[] = [
    <Bubble key="ask" me at="2:10 PM">
      <p>{NEWPRD.chat.ask}</p>
    </Bubble>,
    <Bubble key="guess" at="2:10 PM">
      <p>{NEWPRD.chat.guess}</p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-xl border border-line bg-surface p-3 text-[15px]">
        <dt className="text-text2">Name</dt>
        <dd className="font-semibold">{NEWPRD.title}</dd>
        <dt className="text-text2">Problem</dt>
        <dd>{NEWPRD.problem}</dd>
        <dt className="text-text2">Who</dt>
        <dd>{NEWPRD.who}</dd>
        <dt className="text-text2">Goal</dt>
        <dd>{NEWPRD.goal}</dd>
      </dl>
      {!phase && <Chips items={["Looks right", "Change it"]} />}
    </Bubble>,
  ];
  if (phase) {
    lines.push(
      <Bubble key="ok" me at="2:11 PM">
        <p>Looks right</p>
      </Bubble>,
    );
    const upto = phase === "ask" ? 1 : phase === "hard" ? 5 : 6;
    const at = (i: number) => `2:${String(11 + i).padStart(2, "0")} PM`;
    for (let i = 0; i < upto; i++) {
      const x = q[i];
      const last = i === upto - 1 && phase !== "done";
      lines.push(
        <Bubble key={`q${i}`} at={at(i)}>
          <p>
            <span className="text-text2 tnum">{i + 1} of 6 · </span>
            {x.text}
          </p>
          {last && phase === "ask" && <Chips items={["I don't know", "Ask someone later"]} />}
        </Bubble>,
      );
      if (last && phase === "hard") {
        lines.push(
          <Bubble key="later" me at={at(i)}>
            <p>Ask someone later</p>
          </Bubble>,
          <Bubble key="who" at={at(i)}>
            <p>Who should answer it? I keep drafting, and add the answer when it comes.</p>
            <Chips items={NEWPRD.people.slice(0, 4)} />
          </Bubble>,
        );
        continue;
      }
      if (!last)
        lines.push(
          <Bubble key={`a${i}`} me at={at(i)}>
            <p>{x.unknown ? "I don't know" : x.later ? `Ask ${x.later} later` : x.answer}</p>
          </Bubble>,
        );
      if (x.unknown && !last)
        lines.push(
          <Bubble key={`n${i}`} at={at(i)}>
            <p>Fine. The draft marks the date as open, and I ask again when the plan has one.</p>
          </Bubble>,
        );
    }
    if (phase === "done")
      lines.push(
        <Bubble key="done" at="2:17 PM">
          <p>Thanks. I am drafting it now.</p>
          <div className="mt-2 flex flex-col gap-1.5 rounded-xl border border-line bg-surface p-3" data-testid="np-chat-made">
            <span className="flex flex-wrap items-center gap-2">
              <b>{NEWPRD.title}</b> <Chip kind="warn" dot>Drafting</Chip>
            </span>
            <span className="simple-small">{NEWPRD.made.eta}. 1 question waits on Priya Raman; 1 is marked open.</span>
            <Link href="/simple/one-pagers?np1=d&made=1" className="simple-link">
              Open in One-pagers
            </Link>
          </div>
        </Bubble>,
      );
  }
  return (
    <ol className="flex flex-col gap-3" aria-label="Messages" data-testid="np-chat">
      {lines}
    </ol>
  );
}
