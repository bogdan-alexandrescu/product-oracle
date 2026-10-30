"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { Icon } from "@/components/ds/Icon";
import { toast } from "@/components/ds/Toast";
import { QuestionRow, useQuestionActions, useSourceLine, type Question } from "@/components/simple/questions/Questions";
import { SimpleEmpty, SimplePage } from "@/components/simple/SimplePage";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { calendarDay, useCompanyZone } from "@/lib/dates";
import { zoneName } from "@/lib/format";
import { useQuery } from "@/lib/use-query";

import { DecidedItem, LINK, momentWords } from "../meetings/_flow";

type Row = Schemas["SimpleDecisionRow"];
type Group = Schemas["SimpleMeetingGroup"];
type View = "list" | "board" | "meetings";

/** qa-simple-decide-35: the lead follows the view. */
const LEADS: Record<View, string> = {
  list: "What waits for you, soonest first. Then every decision, beside the meeting that took it.",
  board: "The PRDs' questions by where they stand: needing input, recommended, decided.",
  meetings: "Every decision, beside the meeting that took it, newest meeting first.",
};

const VIEWS: { value: View; label: string }[] = [
  { value: "list", label: "List" },
  { value: "board", label: "Board" },
  { value: "meetings", label: "By meeting" },
];
/** The List shows this many questions waiting for you before "Show N more". */
const FIRST = 5;

/**
 * prd-questions, kept to the owner's pick A "Imported as decisions" (simple-v3
 * decide/prd-decisions.html, frame A1): the filters (PRD, Goal, Meeting); "Waiting for you"
 * with its count and where the questions were read, the first five rows and "Show N more";
 * then every decision beside the meeting that took it, and those taken outside meetings (a
 * decided question keeps its code and answer); the run-approvals note at the foot. The owner's
 * own addition: a compact List | Board | By meeting switch at the filters' end (Board: Needs
 * input, Recommended, Decided; tabs on a phone). The view is remembered per person
 * (preferences.simple_decisions_view; the API returns it as `view`). Filters are the page's
 * ?prd=, ?goal= and ?meeting=; each decision is anchored #d-<n>.
 */
export function SimpleDecisions() {
  const params = useSearchParams();
  const pathname = usePathname();
  const prd = params.get("prd") ?? "";
  const goal = params.get("goal") ?? "";
  const meeting = params.get("meeting") ?? "";
  const q = useQuery(`simple-decisions|${prd}|${goal}|${meeting}`, () =>
    unwrap(api.GET("/v1/simple/decisions", { params: { query: { prd: prd || undefined, goal: goal || undefined, meeting: meeting || undefined } } })),
    { keepPrevious: true },
  );
  // An anchor (#d-12) scrolls once its decision is drawn.
  const loaded = !!q.data;
  useEffect(() => {
    if (!loaded || !window.location.hash) return;
    document.getElementById(window.location.hash.slice(1))?.scrollIntoView({ block: "center" });
  }, [loaded]);
  const set = (key: string, value: string) => {
    // The address as it is now, written at once (Next keeps useSearchParams in step): a
    // second filter changed right after the first keeps the first's change.
    const next = new URLSearchParams(window.location.search);
    if (value) next.set(key, value);
    else next.delete(key);
    const s = next.toString();
    window.history.replaceState(null, "", s ? `${pathname}?${s}` : pathname);
  };
  const d = q.data;
  // The person's pick this visit, else the remembered one the API returns, else List.
  // qa-simple-decide-36: the view is in the address (?view=), like the filters.
  const inUrl = params.get("view");
  const [picked, setPicked] = useState<View | null>(null);
  const view: View = picked ?? (VIEWS.some((x) => x.value === inUrl) ? (inUrl as View) : null) ?? d?.view ?? "list";
  const pick = (v: View) => {
    setPicked(v);
    set("view", v === "list" ? "" : v);
    api
      .PATCH("/v1/me/preferences", { body: { simple_decisions_view: v } })
      .then((r) => {
        if (r.error) toast({ message: "Could not remember this view for next time" });
      })
      .catch(() => toast({ message: "Could not remember this view for next time" }));
  };
  const actions = useQuestionActions(() => q.reload());
  const questions = d?.questions ?? [];
  const filtered = !!(prd || goal || meeting);
  const clear = () => {
    window.history.replaceState(null, "", inUrl ? `${pathname}?view=${inUrl}` : pathname);
  };
  // qa-simple-decide-20: the API leaves out an open decision a shown meeting lists as its open question.
  const other = d?.other ?? [];
  const zone = useCompanyZone();
  return (
    <SimplePage title="Decisions" lead={`${LEADS[view]} Dates are in ${zoneName(zone)}.`}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap gap-3 max-[600px]:w-full" role="group" aria-label="Filters">
          <Filter label="PRD" value={prd} options={d?.prds ?? []} onChange={(v) => set("prd", v)} all="All PRDs" />
          <Filter label="Goal" value={goal} options={d?.goals ?? []} onChange={(v) => set("goal", v)} all="All goals" />
          <Filter label="Meeting" value={meeting} options={d?.meeting_options ?? []} onChange={(v) => set("meeting", v)} all="All meetings" />
        </div>
        <ViewSwitch value={view} onChange={pick} />
      </div>
      {q.loading && !d && <Loading />}
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {d && view === "list" && <QuestionList d={d} actions={actions} filtered={filtered} onClear={clear} />}
      {d && view === "board" && <Board questions={questions} actions={actions} />}
      {d && view !== "board" && (
        <>
          {d.meetings.length === 0 && other.length === 0 && (
            <SimpleEmpty testId="decisions-empty">
              No decision matches.{" "}
              {filtered && <ClearFilters onClear={clear} />}
            </SimpleEmpty>
          )}
          {d.meetings.map((g) => (
            <MeetingGroup key={g.meeting.id} g={g} filtered={!!(prd || goal)} rowNumbers={new Set([...d.meetings.flatMap((x) => x.decisions), ...other].map((r) => r.number))} />
          ))}
          {other.length > 0 && (
            <section className="simple-card" aria-label="Outside meetings">
              <h2 className="simple-h2">Outside meetings</h2>
              <Rows rows={other} />
            </section>
          )}
        </>
      )}
      {d && d.approvals_waiting > 0 && (
        <p className="simple-plumb" data-testid="decisions-approvals">
          <Icon name="flag" size={16} stroke={1.7} />
          {/* qa-simple-decide-29: plain words, no internal terms. */}
          <span>
            {d.approvals_waiting === 1 ? "1 approval for Oracle's own work waits" : `${d.approvals_waiting} approvals for Oracle's own work wait`} in your Inbox. They are not product decisions, so they are not listed or counted here.{" "}
            <Link href="/inbox" className="font-[650] text-accent-ink hover:underline">
              Open the Inbox (it leaves Simple)
            </Link>
          </span>
        </p>
      )}
    </SimplePage>
  );
}

/** qa-simple-decide-26: the empty message's way out when the filters match nothing. */
function ClearFilters({ onClear }: { onClear: () => void }) {
  return (
    <button type="button" className="simple-button" data-testid="decisions-clear-filters" onClick={onClear}>
      Clear filters
    </button>
  );
}

/** The mock-up's compact segmented switch (full width on a phone). */
function Seg<V extends string>({ label, value, items, onChange, className = "" }: { label: string; value: V; items: { value: V; label: string; count?: number; testId: string }[]; onChange: (v: V) => void; className?: string }) {
  return (
    <div role="group" aria-label={label} className={`simple-seg ${className}`}>
      {items.map((v) => (
        <button key={v.value} type="button" data-testid={v.testId} aria-pressed={v.value === value} onClick={() => onChange(v.value)}>
          {v.label}
          {v.count != null && <span className="tnum"> {v.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** List | Board | By meeting (the owner's addition to A). */
function ViewSwitch({ value, onChange }: { value: View; onChange: (v: View) => void }) {
  return <Seg label="Show decisions as" value={value} onChange={onChange} items={VIEWS.map((v) => ({ ...v, testId: `decisions-view-${v.value}` }))} />;
}

type Actions = ReturnType<typeof useQuestionActions>;

/** A card of questions: the round flag icon, its title, the count and (Waiting for you) where they were read. */
function QuestionCard({ label, testId, questions, count, source, children }: { label: string; testId: string; questions: Question[]; count: number; source?: boolean; children: ReactNode }) {
  const line = useSourceLine(questions);
  return (
    <section className="simple-card" aria-label={label} data-testid={testId}>
      <header className="flex flex-wrap items-center gap-3">
        <span aria-hidden className="simple-ico">
          <Icon name="flag" size={20} stroke={1.7} />
        </span>
        <h2 className="simple-h2 min-w-0 flex-1">{label}</h2>
        {count > 0 && (
          <span data-testid={`${testId}-count`} className="simple-count tnum">
            {count}
          </span>
        )}
        {source && line && (
          <span data-testid="questions-source" className="simple-meta max-[600px]:w-full">
            {line}
          </span>
        )}
      </header>
      {children}
    </section>
  );
}

/** List: waiting for you (first five, then Show N more), then waiting for others; decided ones sit with the meeting that took them, or outside meetings. */
function QuestionList({ d, actions, filtered, onClear }: { d: Schemas["SimpleDecisionsOut"]; actions: Actions; filtered: boolean; onClear: () => void }) {
  const [all, setAll] = useState(false);
  const open = d.questions.filter((x) => x.column !== "decided");
  // qa-simple-decide-15: only what the person can act on waits for them (a viewer: nothing).
  const mine = open.filter((x) => x.waiting_for_me && x.status === "proposed" && (x.can.decide || x.can.propose));
  const others = open.filter((x) => !mine.includes(x));
  const shown = all ? mine : mine.slice(0, FIRST);
  return (
    <>
      <QuestionCard label="Waiting for you" testId="questions-mine" questions={mine.length ? mine : open} count={Math.min(d.waiting_count, mine.length)} source>
        {mine.length === 0 ? (
          <p className="simple-meta">
            Nothing waits on you. {filtered && <ClearFilters onClear={onClear} />}
          </p>
        ) : (
          <ul>
            {shown.map((x) => <QuestionRow key={x.id} q={x} mode="list" actions={actions} />)}
          </ul>
        )}
        {mine.length > FIRST && (
          <button type="button" className="simple-more" aria-expanded={all} onClick={() => setAll((x) => !x)}>
            {all ? "Show fewer" : `Show ${mine.length - FIRST} more`}
          </button>
        )}
      </QuestionCard>
      {others.length > 0 && (
        <QuestionCard label="Waiting for others" testId="questions-others" questions={others} count={others.length}>
          <ul>{others.map((x) => <QuestionRow key={x.id} q={x} mode="list" actions={actions} forOthers />)}</ul>
        </QuestionCard>
      )}
    </>
  );
}

const COLUMNS: { key: Question["column"]; title: string; tab: string }[] = [
  { key: "needs_input", title: "Needs input", tab: "Needs input" },
  { key: "recommended", title: "Recommended", tab: "Recommended" },
  // qa-simple-decide-21: the Board holds the PRDs' questions; decisions taken elsewhere are under By meeting.
  { key: "decided", title: "Decided questions", tab: "Decided" },
];

/** Two columns (901-1599 px): Needs input over Decided on the left, Recommended down the right (its extra height goes to the second row). */
const TWO_COLUMN_PLACE: Record<Question["column"], string> = {
  needs_input: "min-[901px]:max-[1599px]:col-start-1 min-[901px]:max-[1599px]:row-start-1",
  recommended: "min-[901px]:max-[1599px]:col-start-2 min-[901px]:max-[1599px]:row-span-2 min-[901px]:max-[1599px]:row-start-1",
  decided: "min-[901px]:max-[1599px]:col-start-1 min-[901px]:max-[1599px]:row-start-2",
};

/** Board: three columns by `column`, soonest first (the API's order); on a phone, one column at a time behind tabs. */
function Board({ questions, actions }: { questions: Question[]; actions: Actions }) {
  const [tab, setTab] = useState<Question["column"]>("needs_input");
  const of = (k: Question["column"]) => questions.filter((x) => x.column === k);
  return (
    <div data-testid="questions-board" className="flex flex-col gap-3">
      <div className="hidden max-[600px]:block">
        {/* qa-simple-decide-4: short tab names that fit a 390 px phone (the column's own heading is the long one). */}
        <Seg label="Column" value={tab} onChange={setTab} className="min-w-0 [&>button]:min-w-0 [&>button]:px-1.5" items={COLUMNS.map((c) => ({ value: c.key, label: c.tab, count: of(c.key).length, testId: `board-tab-${c.key}` }))} />
      </div>
      {/* qa-simple-decide-22: two wider columns from 901 px, three from 1600 px; qa-simple-decide-13:
          with two, Decided questions sits straight under Needs input (no gap beside Recommended);
          fix4 review: the columns stay in reading order (Needs input, Recommended, Decided), so
          one column (up to 900 px) and a screen reader read them so too. */}
      <div className="grid grid-cols-1 items-start gap-4 min-[901px]:grid-cols-2 min-[901px]:max-[1599px]:grid-rows-[auto_1fr] min-[1600px]:grid-cols-3">
        {COLUMNS.map((c) => (
          // The wrapper hides a column on a phone (.simple-card sets its own display).
          <div key={c.key} className={`min-w-0 ${TWO_COLUMN_PLACE[c.key]} ${tab === c.key ? "" : "max-[600px]:hidden"}`} data-column={c.key}>
            <section aria-label={c.title} data-testid={`board-${c.key}`} className="simple-card simple-narrow min-w-0">
              {/* qa-simple-decide-33: on a phone the tab above already names the column and its count. */}
              <header className="flex items-center gap-3 max-[600px]:hidden">
                <h2 className="simple-h2 min-w-0 flex-1">{c.title}</h2>{" "}
                <span className="simple-count tnum">{of(c.key).length}</span>
              </header>
              {of(c.key).length === 0 ? (
                <p className="simple-meta">None.</p>
              ) : (
                <ul>
                  {of(c.key).map((x) => <QuestionRow key={x.id} q={x} mode={c.key} actions={actions} />)}
                </ul>
              )}
            </section>
          </div>
        ))}
      </div>
    </div>
  );
}

/** A filter: its label over the mock-up's box (a native select, the chevron drawn over it). */
function Filter({ label, value, options, onChange, all }: { label: string; value: string; options: Schemas["SimpleFilterOption"][]; onChange: (v: string) => void; all: string }) {
  return (
    <label className="flex flex-col gap-1 max-[600px]:min-w-[160px] max-[600px]:flex-1">
      <span className="simple-meta">{label}</span>
      <span className="relative flex">
        {/* qa-simple-decide-11: a dated meeting name keeps the filters' row: the box is capped, the list shows it whole, the box's title too. */}
        <select className="simple-select max-[600px]:w-full max-[600px]:min-w-0 min-[601px]:max-w-[220px] text-ellipsis" title={options.find((o) => o.id === value)?.title ?? all} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{all}</option>
          {options.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
        </select>
        <span aria-hidden className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-text">
          <Icon name="chevron-down" size={18} stroke={1.7} />
        </span>
      </span>
    </label>
  );
}

function MeetingGroup({ g, filtered, rowNumbers }: { g: Group; filtered: boolean; rowNumbers: Set<number> }) {
  const zone = useCompanyZone();
  const m = g.meeting;
  const minutes = g.minutes;
  return (
    <section className="simple-card" aria-label={m.title} data-testid="meeting-group">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="simple-h2 min-w-0 flex-1">
          <Link href={`/simple/meetings/${m.id}`} className={LINK}>{m.title}</Link>
        </h2>
        {/* qa-simple-decide-11: two reviews of one PRD told apart by their day and "live". */}
        <span className="simple-meta" data-testid="meeting-group-when">{[momentWords(m.started_at, zone, true), m.status === "live" ? "live" : null, m.prd.title].filter(Boolean).join(" · ")}</span>
      </div>
      {minutes?.summary && <p>{minutes.summary}</p>}
      {filtered && (
        <p className="simple-meta" data-testid="meeting-group-filtered">
          {/* qa-simple-decide-12 */}
          Filtered: {g.decisions.length} {g.decisions.length === 1 ? "decision of this meeting matches" : "decisions of this meeting match"}.
        </p>
      )}
      <p className="simple-meta">Attendees: {m.attendees.map((a) => a.name).join(", ")}</p>
      {minutes && minutes.open_questions.length > 0 && (
        <div>
          <h3 className="text-[18px] leading-[26px] font-[650]">Open questions</h3>
          <ul className="list-disc pl-5">
            {minutes.open_questions.map((x) => {
              // An open decision the minutes name ("D-3: ...") is listed here only (qa-simple-decide-20):
              // it takes the decision's anchor, so the pre-read's D-3 link lands on it.
              const n = /^D-(\d+):/.exec(x)?.[1];
              const anchor = n && !rowNumbers.has(Number(n)) ? `d-${n}` : undefined;
              return (
                <li key={x} id={anchor} className={anchor ? "target:bg-[var(--simple-edited)]" : undefined}>
                  {x}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {minutes && minutes.action_items.length > 0 && (
        <div>
          <h3 className="text-[18px] leading-[26px] font-[650]">Action items</h3>
          <ul className="list-disc pl-5">
            {minutes.action_items.map((a, i) => <li key={i}>{a.title} · {a.owner_name ?? "no owner"}{a.due_date ? ` · by ${calendarDay(a.due_date, { weekday: "short" })} ${calendarDay(a.due_date)}` : ""}</li>)}
          </ul>
        </div>
      )}
      {minutes && minutes.waits.length > 0 && (
        <div>
          <h3 className="text-[18px] leading-[26px] font-[650]">What waits on whom</h3>
          <ul className="list-disc pl-5">{minutes.waits.map((w, i) => <li key={i}>{w.what}{w.on.length ? ` · on ${w.on.map((p) => p.name).join(", ")}` : ""}</li>)}</ul>
        </div>
      )}
      <h3 className="text-[18px] leading-[26px] font-[650]">Decisions</h3>
      {g.decisions.length ? <Rows rows={g.decisions} /> : <p className="simple-meta">None.</p>}
    </section>
  );
}

/** qa-simple-decide-19: a decision's state in plain words. */
const STATUS_WORDS: Record<string, string> = { proposed: "waiting for a decider", superseded: "replaced", rejected: "declined", withdrawn: "withdrawn" };

/** Decisions taken: the round check (an open one, the flag), "<code> <title>" (a PRD's question keeps its code), then its answer, who decides and the day. */
function Rows({ rows }: { rows: Row[] }) {
  const zone = useCompanyZone();
  return (
    <ul>
      {rows.map((r) => {
        const done = r.status === "decided";
        // qa-simple-decide-19: a question decided in a meeting shows as one decided outside it:
        // its code, its title, then the answer, as the API sends them (never read out of the title).
        const code = r.code ?? `D-${r.number}`;
        const { title, chosen } = r;
        return (
          <DecidedItem
            key={r.id}
            id={`d-${r.number}`}
            testId="decision-row"
            flow={r.flow}
            className="!items-start !gap-[14px] border-t border-line py-[14px] first:border-t-0 first:pt-0 last:pb-0 target:bg-[var(--simple-edited)]"
          >
            <span aria-hidden className={`simple-ico ${done ? "simple-ico-done" : ""}`}>
              <Icon name={done ? "check" : "flag"} size={20} stroke={1.7} />
            </span>
            <span className="simple-rb flex-1">
              <span className="break-words">
                <span className="simple-code">{code}</span> <b className="font-[650]">{title}</b>
              </span>
              <span className="simple-meta">
                {[chosen, r.approver?.name ?? "No approver", momentWords(r.decided_at ?? r.created_at, zone, true), done ? null : STATUS_WORDS[r.status] ?? "open"]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </span>
          </DecidedItem>
        );
      })}
    </ul>
  );
}
