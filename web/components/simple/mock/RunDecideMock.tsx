"use client";
// MOCK-HOOK: mk-rundecide mock-ups only (throwaway branch, never merged). Every export here is
// a proposal for "A run's decisions and the PRD's approval", switched by the page address:
// ?rd1=a|b|c (run decisions in Decisions), ?rd2=a|b|c (approving the run's PRD review),
// ?rd3=a|b|c (the PRD's Decisions needed), plus &open=1, &phase=mid|done|next, &many=1, &draft=1.

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

import { Icon } from "@/components/ds/Icon";
import { NEEDED, NEEDED_MORE, RD_STATE, RUN_MAIN, RUNS_MORE, type MockRun, type Needed, type RunStop } from "@/lib/api/mock/rundecide";

/** MOCK-HOOK: the address's switches, read after mount (no Suspense needed). */
export function useMk() {
  const [p, setP] = useState<URLSearchParams | null>(null);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- MOCK-HOOK: the address is only readable after mount
  useEffect(() => setP(new URLSearchParams(window.location.search)), []);
  return {
    ready: !!p,
    rd1: p?.get("rd1") ?? "",
    rd2: p?.get("rd2") ?? "",
    rd3: p?.get("rd3") ?? "",
    open: p?.get("open") === "1",
    phase: p?.get("phase") ?? "",
    many: p?.get("many") === "1",
    draft: p?.get("draft") === "1",
  };
}

/** MOCK-HOOK: what one mock part did, for the others on the page (the PRD's status, the meeting's list). */
const bus = new EventTarget();
function useBus<T>(name: string): T | null {
  const [v, setV] = useState<T | null>(null);
  useEffect(() => {
    const f = (e: Event) => setV((e as CustomEvent<T>).detail);
    bus.addEventListener(name, f);
    return () => bus.removeEventListener(name, f);
  }, [name]);
  return v;
}
function emit(name: string, detail: unknown) {
  bus.dispatchEvent(new CustomEvent(name, { detail }));
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** MOCK-HOOK: "Tue Oct 20". */
export function day(iso: string) {
  const d = new Date(`${iso}T12:00:00Z`);
  return `${DAY[d.getUTCDay()]}\u00a0${MON[d.getUTCMonth()]}\u00a0${d.getUTCDate()}`;
}

/** MOCK-HOOK: a built row's moment as its own day, in the workspace's time zone (as the built rows show it). */
// eslint-disable-next-line no-restricted-syntax -- MOCK-HOOK: the built rows show the workspace zone (Pacific in the mock data)
const PT = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" });
function localDay(at: string) {
  const p = Object.fromEntries(PT.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

function runs(many: boolean): MockRun[] {
  return many ? [RUN_MAIN, ...RUNS_MORE] : [RUN_MAIN];
}

function Mark({ children }: { children: ReactNode }) {
  return (
    <span className="ml-1.5 inline-flex h-5 items-center rounded-md bg-accent-soft px-1.5 align-[2px] text-[12px] leading-4 font-semibold text-accent-ink">
      {children}
    </span>
  );
}

/** MOCK-HOOK: one stop of a run as a decision row, with its name and day (and, opened, its trail). */
function StopRow({ run, s, open, mark, showRun, onPrd }: { run: MockRun; s: RunStop; open: boolean; mark?: boolean; showRun?: boolean; onPrd?: boolean }) {
  const [shown, setShown] = useState(open);
  return (
    <li className="flex !items-start gap-[14px] border-t border-line py-[14px] first:border-t-0 first:pt-0 last:pb-0" data-testid="run-stop-row">
      <span aria-hidden className="simple-ico simple-ico-done">
        <Icon name="check" size={20} stroke={1.7} />
      </span>
      <span className="simple-rb flex-1">
        <span className="break-words">
          <b className="font-[650]">
            {s.stop}: {s.outcome.toLowerCase()}
          </b>
          {mark && <Mark>from a run</Mark>}
        </span>
        <span className="simple-meta">
          {[showRun ? `${run.name}, ${run.prd}` : null, s.note, `${s.who} (${s.role})`, day(s.day)].filter(Boolean).join(" · ")}
        </span>
        {s.trail && !shown && (
          <button type="button" className="simple-more !mt-1 !text-left" onClick={() => setShown(true)}>
            Sent back once, then approved. Show what happened
          </button>
        )}
        {s.trail && shown && (
          <ol className="mt-2 space-y-1.5 border-l-2 border-line pl-3" aria-label="What happened">
            {s.trail.map((t, i) => (
              <li key={i} className="simple-small">
                <b className="font-[650]">{t.what}</b> by {t.who} · {day(t.day)}
                {t.note && <span className="block text-text2">“{t.note}”</span>}
              </li>
            ))}
            <li className="flex flex-wrap gap-x-4">
              {!onPrd && (
                <Link href={`/simple/one-pagers/${run.prdSlug}`} className="simple-link">
                  Open {run.prd}
                </Link>
              )}
              <button type="button" className="simple-more !mt-0" onClick={() => setShown(false)}>
                Hide what happened
              </button>
            </li>
          </ol>
        )}
      </span>
    </li>
  );
}

/** MOCK-HOOK RD1 a: a Runs group on Simple › Decisions, one block per run. */
export function RdRunsGroup() {
  const mk = useMk();
  if (mk.rd1 !== "a") return null;
  return (
    <section className="simple-card" aria-label="Runs" data-testid="rd1-runs">
      <header className="flex flex-wrap items-baseline gap-x-3">
        <h2 className="simple-h2 flex-1">Runs</h2>
        <span className="simple-meta">Stops people approved while Oracle drafted a plan</span>
      </header>
      {runs(mk.many).map((r) => (
        <div key={r.id} className="mt-4 border-t border-line pt-4 first-of-type:border-t-0">
          <h3 className="text-[18px] leading-[26px] font-[650]">
            {r.name} <span className="simple-meta font-normal">· {r.prd} · {r.stops.length} decisions</span>
          </h3>
          <ul className="mt-2">
            {r.stops.map((s) => (
              <StopRow key={s.id} run={r} s={s} open={mk.open && s.id === "r2"} />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

type OtherRow = { id: string; number: number; code?: string | null; title: string; chosen?: string | null; approver?: { name: string } | null; decided_at?: string | null; created_at: string };

/** MOCK-HOOK RD1 b: run stops mixed into "Outside meetings" by date, each marked "from a run". */
export function RdMixed({ other }: { other: OtherRow[] }) {
  const mk = useMk();
  if (mk.rd1 !== "b") return null;
  type Item = { at: string; node: ReactNode };
  const items: Item[] = [
    ...other.map((r) => ({
      at: localDay(r.decided_at ?? r.created_at),
      node: (
        <li key={r.id} className="flex !items-start gap-[14px] border-t border-line py-[14px] first:border-t-0 first:pt-0 last:pb-0">
          <span aria-hidden className="simple-ico simple-ico-done">
            <Icon name="check" size={20} stroke={1.7} />
          </span>
          <span className="simple-rb flex-1">
            <span className="break-words">
              <span className="simple-code">{r.code ?? `D-${r.number}`}</span> <b className="font-[650]">{r.title}</b>
            </span>
            <span className="simple-meta">{[r.chosen, r.approver?.name ?? "No approver", day(localDay(r.decided_at ?? r.created_at))].filter(Boolean).join(" · ")}</span>
          </span>
        </li>
      ),
    })),
    ...runs(mk.many).flatMap((r) => r.stops.map((s) => ({ at: s.day, node: <StopRow key={s.id} run={r} s={s} open={mk.open && s.id === "r2"} mark showRun /> }))),
  ].sort((a, b) => b.at.localeCompare(a.at));
  return (
    <section className="simple-card" aria-label="Outside meetings" data-testid="rd1-mixed">
      <h2 className="simple-h2">Outside meetings</h2>
      <ul>{items.map((i) => i.node)}</ul>
    </section>
  );
}

/** MOCK-HOOK RD1 c: Decisions lists none; one line says where they are. */
export function RdPrdOnlyNote() {
  const mk = useMk();
  if (mk.rd1 !== "c") return null;
  return (
    <p className="simple-plumb" data-testid="rd1-note">
      <Icon name="flag" size={16} stroke={1.7} />
      <span>
        What people approved in a run is on that run&apos;s PRD, under &ldquo;Decided in its run&rdquo;.{" "}
        <Link href="/simple/one-pagers/usage-alerts?rd1=c" className="font-[650] text-accent-ink hover:underline">
          Usage alerts PRD
        </Link>
      </span>
    </p>
  );
}

/** MOCK-HOOK RD1 c: the PRD's own "Decided in its run" section. */
export function RdPrdRunSection() {
  const mk = useMk();
  const [open, setOpen] = useState(false);
  if (mk.rd1 !== "c") return null;
  const shown = open || mk.open;
  return (
    <section className="simple-card" aria-label="Decided in its run" data-testid="rd1-prd">
      <header className="flex flex-wrap items-baseline gap-x-3">
        <h2 className="simple-h2 flex-1">Decided in its run</h2>
        <span className="simple-meta">
          {RUN_MAIN.name} · {RUN_MAIN.stops.length} decisions
        </span>
      </header>
      {shown ? (
        <ul className="mt-3">
          {RUN_MAIN.stops.map((s) => (
            <StopRow key={s.id} run={RUN_MAIN} s={s} open={false} onPrd />
          ))}
        </ul>
      ) : (
        <button type="button" className="simple-more" onClick={() => setOpen(true)}>
          Show the {RUN_MAIN.stops.length} decisions: feature set, engineering check, order, PRD review, dates
        </button>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ RD2 */

/** MOCK-HOOK RD2: the PRD's status words while a run's review is on it. */
export function RdStatus() {
  const mk = useMk();
  const live = useBus<string>("rd2-done");
  if (!mk.rd2 && mk.rd1 !== "c" && !mk.rd3) return null;
  const done = mk.phase === "done" || !!live;
  const approved = done && (mk.rd2 === "a" || mk.rd2 === "b");
  return approved ? (
    <span data-testid="rd2-status" className="inline-flex h-6 items-center gap-[5px] rounded-xl bg-pass-bg px-[9px] text-[13px] leading-[18px] font-semibold whitespace-nowrap text-pass">
      <Icon name="check" size={16} stroke={1.7} />
      Approved
    </span>
  ) : (
    <span data-testid="rd2-status" className="inline-flex h-6 items-center rounded-xl bg-warn-bg px-[9px] text-[13px] leading-[18px] font-semibold whitespace-nowrap text-warn">
      In review
    </span>
  );
}

/** MOCK-HOOK RD2: the run's PRD review, as the approver meets it on the PRD. */
export function RdReviewBar() {
  const mk = useMk();
  const [step, setStep0] = useState<"" | "open" | "done" | "next">("");
  const setStep = (x: typeof step) => {
    setStep0(x);
    if (x === "done") emit("rd2-done", mk.rd2);
  };
  if (!mk.rd2) return null;
  const st = step || (mk.phase === "done" ? "done" : mk.phase === "next" ? "next" : mk.open ? "open" : "");
  const v = mk.rd2;
  const box = "rounded-[14px] border border-line bg-surface p-4 shadow-sm";
  const draftNote = mk.draft && (
    <p className="simple-small mt-2 rounded-lg bg-warn-bg px-3 py-2 text-warn" data-testid="rd2-draft">
      Draft 4 has 3 changes from Thursday&apos;s review meeting, listed at the side. They are not in version 3 and stay unapproved.
    </p>
  );
  if (st === "done") {
    return (
      <section className={box} aria-label="The run's PRD review" data-testid="rd2-bar">
        <p className="flex items-start gap-2.5">
          <span className="simple-ico simple-ico-done" aria-hidden>
            <Icon name="check" size={20} stroke={1.7} />
          </span>
          <span className="simple-rb">
            {v === "a" && (
              <>
                <b className="font-[650]">You approved version 3.</b>
                <span className="simple-meta">The PRD reads Approved everywhere. {RUN_MAIN.name} goes on to its dates · Admin · Fri Oct 30</span>
              </>
            )}
            {v === "b" && (
              <>
                <b className="font-[650]">You approved the PRD, version 3.</b>
                <span className="simple-meta">Second of two steps · {RUN_MAIN.name} goes on to its dates · Admin · Fri Oct 30</span>
              </>
            )}
            {v === "c" && (
              <>
                <b className="font-[650]">You approved the run&apos;s review. The PRD is still in review.</b>
                <span className="simple-meta">{RUN_MAIN.name} goes on to its dates. The PRD is approved only in its review meeting.</span>
              </>
            )}
          </span>
        </p>
        {v === "a" && draftNote}
        {v === "c" && <p className="simple-small mt-2">To approve the PRD, use Start review above.</p>}
      </section>
    );
  }
  if (st === "next") {
    return (
      <section className={box} aria-label="The run's PRD review" data-testid="rd2-bar">
        <p className="simple-meta inline-flex items-center gap-1.5">
          <Icon name="check" size={16} stroke={1.7} /> Run review approved by you (Admin) · Fri Oct 30
        </p>
        <h2 className="simple-h2 mt-2">Next stop: approve the PRD</h2>
        <p className="simple-small">Approving makes version 3 the PRD everyone builds from. To change it first, use Start review above.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="simple-button simple-button-primary" onClick={() => setStep("done")}>Approve the PRD</button>
        </div>
      </section>
    );
  }
  return (
    <section className={box} aria-label="The run's PRD review" data-testid="rd2-bar">
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-[260px] flex-1">
          <b className="font-[650]">{RUN_MAIN.name} waits for your review of version 3.</b>
          <span className="simple-meta block">
            {v === "a" && "Approving it approves this version of the PRD too."}
            {v === "b" && "Approving lets the run go on. Approving the PRD comes right after, as its own step."}
            {v === "c" && "Approving lets the run go on. The PRD itself is approved only in its review meeting."}
          </span>
        </p>
        <button type="button" className="simple-button">Send back</button>
        <button type="button" className="simple-button simple-button-primary" onClick={() => setStep("open")} aria-expanded={st === "open"}>
          Approve
        </button>
      </div>
      {st === "open" && (
        <div className="mt-3 rounded-[12px] border border-line-strong bg-surface2 p-3" role="dialog" aria-label="Approve the review">
          <label className="simple-small block font-[650]" htmlFor="rd2-note">
            Note for the run (optional)
          </label>
          <textarea id="rd2-note" className="mt-1 w-full rounded-lg border border-line-strong bg-surface p-2 text-[15px]" rows={2} defaultValue={mk.phase === "mid" ? "Good to build from version 3." : ""} />
          <p className="simple-small mt-2">
            {v === "a" && "This approves the run's review and version 3 of the PRD. It will read Approved everywhere."}
            {v === "b" && "This approves the run's review. Next you are asked to approve the PRD."}
            {v === "c" && "This approves the run's review only. The PRD stays In review until its meeting approves it."}
          </p>
          {v === "a" && draftNote}
          <div className="mt-2 flex gap-2">
            <button type="button" className="simple-button simple-button-primary" onClick={() => setStep(v === "b" ? "next" : "done")}>
              {v === "a" ? "Approve review and PRD" : "Approve review"}
            </button>
            <button type="button" className="simple-button simple-button-quiet" onClick={() => setStep("")}>Cancel</button>
          </div>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ RD3 */

const ANSWER = "Not in the first release; look again in the spring";
const AT = "Fri Oct 30, 6:42 PM";

/** MOCK-HOOK RD3: one decision needed, decided the way the built questions are (Decide as recommended, Another answer, Ask Oracle). */
function NeededRow({ n, decided, open, onOpen, onDecide, onCancel, showPrd }: { n: Needed; decided?: string; open?: boolean; onOpen?: () => void; onDecide?: (answer: string) => void; onCancel?: () => void; showPrd?: boolean }) {
  const late = n.due < "2026-11-04";
  const [text, setText] = useState(open ? ANSWER : "");
  return (
    <li className="flex flex-wrap !items-start gap-[14px] border-t border-line py-[14px] first:border-t-0 first:pt-0 last:pb-0" data-testid="needed-row">
      <span aria-hidden className={`simple-ico ${decided ? "simple-ico-done" : ""}`}>
        <Icon name={decided ? "check" : "flag"} size={20} stroke={1.7} />
      </span>
      <span className="simple-rb min-w-[220px] flex-1">
        <span className="break-words">
          <span className="simple-code">{n.code}</span> <b className="font-[650]">{n.title}</b>
        </span>
        {decided ? (
          <span className="simple-meta">{decided}</span>
        ) : (
          <span className="simple-meta">
            <span className={late ? "font-semibold text-crit" : ""}>Due {day(n.due)}</span> · {n.mine ? "You decide" : `${n.owner} decides`}
            {showPrd ? " · Usage alerts PRD" : ""}
            {n.rec ? ` · Recommended: ${n.rec}` : ""}
          </span>
        )}
        {!decided && onDecide && !open && (
          <span className="mt-2 flex flex-wrap items-center gap-2">
            {n.rec && (
              <button type="button" className={`simple-button ${n.mine ? "simple-button-primary" : ""}`} onClick={() => onDecide(n.rec!)}>
                {n.mine ? "Decide as recommended" : `Decide for ${n.owner}`}
              </button>
            )}
            <button type="button" className="simple-button" onClick={onOpen}>Another answer</button>
            <button type="button" className="simple-button simple-button-quiet">Ask Oracle</button>
          </span>
        )}
        {open && !decided && (
          <span className="mt-2 flex flex-wrap items-center gap-2" role="group" aria-label={`Another answer for ${n.code}`}>
            <input className="simple-select min-w-[220px] flex-1" placeholder="Your answer" aria-label="Your answer" value={text} onChange={(e) => setText(e.target.value)} />
            <button type="button" className="simple-button simple-button-primary" onClick={() => onDecide?.(text || "Decided")}>Decide</button>
            <button type="button" className="simple-button simple-button-quiet" onClick={onCancel}>Cancel</button>
          </span>
        )}
      </span>
      {decided && <button type="button" className="simple-button simple-button-quiet">Undo</button>}
    </li>
  );
}

/** MOCK-HOOK RD3: the PRD's decisions needed, with one answered another way (open) or decided (done). */
function NeededList({ list, who, showPrd, onDecided }: { list: Needed[]; who: string; showPrd?: boolean; onDecided?: () => void }) {
  const mk = useMk();
  const [open, setOpen] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, string>>({});
  const target = list[0]?.code;
  const preset = mk.phase === "done" && target ? { [target]: ANSWER } : {};
  const answers = { ...preset, ...done };
  const isOpen = (c: string) => open === c || (mk.open && !answers[c] && c === target);
  return (
    <ul>
      {list.map((n) => (
        <NeededRow
          key={n.code}
          n={n}
          showPrd={showPrd}
          open={isOpen(n.code)}
          decided={answers[n.code] ? `${answers[n.code]} · ${who} · ${AT}` : undefined}
          onOpen={() => setOpen(n.code)}
          onCancel={() => setOpen(null)}
          onDecide={(answer) => {
            setDone((d) => ({ ...d, [n.code]: answer }));
            setOpen(null);
            emit("rd3-decided", { code: n.code, title: n.title, answer });
            if (onDecided) {
              RD_STATE.decided += 1;
              onDecided();
            }
          }}
        />
      ))}
    </ul>
  );
}

/** MOCK-HOOK RD3 b: the meeting's "All decisions" lists what its agenda decided. */
export function RdMeetingDecided({ fallback }: { fallback: ReactNode }) {
  const mk = useMk();
  const live = useBus<{ code: string; title: string; answer: string }>("rd3-decided");
  const d = live ?? (mk.rd3 && mk.phase === "done" ? { code: NEEDED[0]!.code, title: NEEDED[0]!.title, answer: ANSWER } : null);
  if (!d) return <>{fallback}</>;
  return (
    <ul className="mt-2 space-y-2">
      <li data-testid="meeting-decision">
        <strong>{d.code}</strong> {d.title}
        <span className="block text-sm text-text-faint">{d.answer} · Admin · Oct 30, 6:42 PM</span>
      </li>
    </ul>
  );
}

/** MOCK-HOOK RD2 hard case (&draft=1): the PRD's draft and its changes in the side panel. */
export function RdDraftChip() {
  return <span className="text-[14px] font-semibold text-text">draft in progress</span>;
}
const DRAFT_CHANGES = [
  { line: "What we will build", text: "Weekly alert digest: send on Monday mornings, not Friday", who: "Priya Shah" },
  { line: "Not doing", text: "Add: alerts in the mobile app", who: "Marco Ruiz" },
  { line: "Outcomes", text: "Tickets about surprise limits: to 30 a month, not 40", who: "Lena Ford" },
];
export function RdDraftNotes({ fallback }: { fallback: ReactNode }) {
  const mk = useMk();
  if (!mk.draft) return <>{fallback}</>;
  return (
    <ul className="mt-2 space-y-3" data-testid="rd2-draft-notes">
      {DRAFT_CHANGES.map((c) => (
        <li key={c.text} className="rounded-[12px] border border-line bg-surface p-3">
          <span className="simple-meta block">{c.line} · draft 4 · Thursday&apos;s review meeting</span>
          <span className="block text-[15px] leading-[22px]">{c.text}</span>
          <span className="simple-meta block">{c.who}</span>
        </li>
      ))}
    </ul>
  );
}

/** MOCK-HOOK RD3 a: Simple Home's "Waiting for you" carries the PRD's decisions the person owns. */
export function RdHomeWaiting({ onDecided }: { onDecided?: () => void }) {
  const mk = useMk();
  if (mk.rd3 !== "a") return null;
  const mine = NEEDED.filter((n) => n.mine);
  return (
    <section className="simple-card" aria-label="Decisions you own in a PRD" data-testid="rd3-home">
      <header className="flex flex-wrap items-baseline gap-x-3">
        <h2 className="simple-h2 flex-1">Waiting for you: Usage alerts PRD</h2>
        <span className="simple-meta">{mine.length} decisions you own · also on its review meeting&apos;s agenda</span>
      </header>
      <div className="mt-3">
        <NeededList list={mine} who="Admin" onDecided={onDecided} />
      </div>
    </section>
  );
}

/** MOCK-HOOK RD3 a, b: the meeting's agenda lists the PRD's decisions needed, soonest first. */
export function RdAgenda({ fallback }: { fallback: ReactNode }) {
  const mk = useMk();
  if (mk.rd3 !== "a" && mk.rd3 !== "b") return <>{fallback}</>;
  return (
    <div data-testid="rd3-agenda">
      <p className="simple-meta mb-2">From the Usage alerts PRD&apos;s &ldquo;Decisions needed&rdquo; · {NEEDED.length} decisions · due by {day(NEEDED[NEEDED.length - 1]!.due)}</p>
      <NeededList list={NEEDED} who="Admin, in this meeting" />
    </div>
  );
}

/** MOCK-HOOK RD3 c: a section per PRD on Simple › Decisions (&many=1: three PRDs). */
export function RdPrdSections() {
  const mk = useMk();
  if (mk.rd3 !== "c") return null;
  const prds = [{ prd: "Usage alerts PRD", slug: "usage-alerts", list: NEEDED }, ...(mk.many ? NEEDED_MORE : [])];
  return (
    <>
      {prds.map((p, i) => (
        <section key={p.slug} className="simple-card" aria-label={`Decisions needed: ${p.prd}`} data-testid={i === 0 ? "rd3-section" : "rd3-section-more"}>
          <header className="flex flex-wrap items-baseline gap-x-3">
            <h2 className="simple-h2 flex-1">{p.prd}: decisions needed</h2>
            <span className="simple-meta">
              {p.list.length} open · {p.list.filter((n) => n.mine).length} yours ·{" "}
              <Link href={`/simple/one-pagers/${p.slug}`} className="simple-link">
                Open the PRD
              </Link>
            </span>
          </header>
          <div className="mt-3">
            <NeededList list={p.list} who="Admin" />
          </div>
        </section>
      ))}
    </>
  );
}
