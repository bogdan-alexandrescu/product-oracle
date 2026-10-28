"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { SegmentedControl } from "@/components/ds";
import { toast } from "@/components/ds/Toast";
import { QuestionRow, useQuestionActions, type Question } from "@/components/simple/questions/Questions";
import { SimpleEmpty, SimplePage } from "@/components/simple/SimplePage";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatInZone, useCompanyZone } from "@/lib/dates";
import { useQuery } from "@/lib/use-query";

import { DecidedItem } from "../meetings/_flow";

type Row = Schemas["SimpleDecisionRow"];
type Group = Schemas["SimpleMeetingGroup"];
type View = "list" | "board" | "meetings";

const VIEWS: { value: View; label: string }[] = [
  { value: "list", label: "List" },
  { value: "board", label: "Board" },
  { value: "meetings", label: "By meeting" },
];
/** The List shows this many questions waiting for you before "Show N more". */
const FIRST = 5;

/**
 * prd-questions: the PRDs' open questions read in as decisions, as a List (what waits for
 * you, soonest first; what waits for others; what is decided; then the meetings) or a Board
 * (Needs input, Recommended, Decided; tabs on a phone), or By meeting as before. The view is
 * remembered per person (preferences.simple_decisions_view; the API returns it as `view`).
 *
 * Simple S8 (#723): Decisions, direction B "By meeting": each meeting with its minutes
 * (summary, attendees, open questions, action items, what waits on whom) and the decisions
 * it took, newest first; then the decisions taken outside meetings. Filters by PRD, goal
 * and meeting are the page's ?prd=, ?goal= and ?meeting=; each decision is anchored #d-<n>.
 */
export function SimpleDecisions() {
  const params = useSearchParams();
  const router = useRouter();
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
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    const s = next.toString();
    router.replace(s ? `${pathname}?${s}` : pathname);
  };
  const d = q.data;
  // The person's pick this visit, else the remembered one the API returns, else List.
  const [picked, setPicked] = useState<View | null>(null);
  const view: View = picked ?? d?.view ?? "list";
  const pick = (v: View) => {
    setPicked(v);
    api
      .PATCH("/v1/me/preferences", { body: { simple_decisions_view: v } })
      .then((r) => {
        if (r.error) toast({ message: "Could not remember this view for next time" });
      })
      .catch(() => toast({ message: "Could not remember this view for next time" }));
  };
  const actions = useQuestionActions(() => q.reload());
  const questions = d?.questions ?? [];
  return (
    <SimplePage title="Decisions" lead="What waits on you first, then every decision beside the meeting that took it.">
      <SegmentedControl label="Show decisions as" value={view} onChange={pick} items={VIEWS.map((v) => ({ ...v, testId: `decisions-view-${v.value}` }))} />
      <div className="flex flex-wrap gap-3" role="group" aria-label="Filters">
        <Filter label="PRD" value={prd} options={d?.prds ?? []} onChange={(v) => set("prd", v)} all="All PRDs" />
        <Filter label="Goal" value={goal} options={d?.goals ?? []} onChange={(v) => set("goal", v)} all="All goals" />
        <Filter label="Meeting" value={meeting} options={d?.meeting_options ?? []} onChange={(v) => set("meeting", v)} all="All meetings" />
      </div>
      {q.loading && !d && <Loading />}
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {d && view === "list" && <QuestionList d={d} actions={actions} />}
      {d && view === "board" && <Board questions={questions} actions={actions} />}
      {d && view !== "board" && (
        <>
          {view === "list" && (d.meetings.length > 0 || d.other.length > 0) && <h2 className="simple-h2">Meetings and what they decided</h2>}
          {d.meetings.length === 0 && d.other.length === 0 && <SimpleEmpty testId="decisions-empty">No decision matches.</SimpleEmpty>}
          {d.meetings.map((g) => <MeetingGroup key={g.meeting.id} g={g} />)}
          {d.other.length > 0 && (
            <section className="simple-card" aria-label="Outside meetings">
              <h2 className="simple-h2">Outside meetings</h2>
              <Rows rows={d.other} />
            </section>
          )}
        </>
      )}
    </SimplePage>
  );
}

type Actions = ReturnType<typeof useQuestionActions>;

/** List: waiting for you (first five, then Show N more), waiting for others, decided. */
function QuestionList({ d, actions }: { d: Schemas["SimpleDecisionsOut"]; actions: Actions }) {
  const [all, setAll] = useState(false);
  const open = d.questions.filter((x) => x.column !== "decided");
  const mine = open.filter((x) => x.waiting_for_me && x.status === "proposed");
  const others = open.filter((x) => !mine.includes(x));
  const decided = d.questions.filter((x) => x.column === "decided");
  const shown = all ? mine : mine.slice(0, FIRST);
  return (
    <>
      {d.approvals_waiting > 0 && (
        <p className="simple-small" data-testid="decisions-approvals">
          Oracle&apos;s run approvals are in Detailed.{" "}
          <Link href="/inbox" className="font-semibold text-accent-ink hover:underline">
            Open them in Detailed
          </Link>
        </p>
      )}
      <section className="simple-card" aria-label="Waiting for you" data-testid="questions-mine">
        <h2 className="simple-h2">Waiting for you · {d.waiting_count}</h2>
        {mine.length === 0 ? (
          <p className="simple-small">Nothing waits on you.</p>
        ) : (
          <ul className="divide-y divide-border">
            {shown.map((x) => <QuestionRow key={x.id} q={x} mode="list" actions={actions} />)}
          </ul>
        )}
        {!all && mine.length > FIRST && (
          <button type="button" className="simple-button mt-2" onClick={() => setAll(true)}>
            Show {mine.length - FIRST} more
          </button>
        )}
      </section>
      {others.length > 0 && (
        <section className="simple-card" aria-label="Waiting for others" data-testid="questions-others">
          <h2 className="simple-h2">Waiting for others · {others.length}</h2>
          <ul className="divide-y divide-border">{others.map((x) => <QuestionRow key={x.id} q={x} mode="list" actions={actions} />)}</ul>
        </section>
      )}
      {decided.length > 0 && (
        <section className="simple-card" aria-label="Decided" data-testid="questions-decided">
          <h2 className="simple-h2">Decided · {decided.length}</h2>
          <ul className="divide-y divide-border">{decided.map((x) => <QuestionRow key={x.id} q={x} mode="decided" actions={actions} />)}</ul>
        </section>
      )}
    </>
  );
}

const COLUMNS: { key: Question["column"]; title: string }[] = [
  { key: "needs_input", title: "Needs input" },
  { key: "recommended", title: "Recommended" },
  { key: "decided", title: "Decided" },
];

/** Board: three columns by `column`, soonest first (the API's order); on a phone, one column at a time behind tabs. */
function Board({ questions, actions }: { questions: Question[]; actions: Actions }) {
  const [tab, setTab] = useState<Question["column"]>("needs_input");
  const of = (k: Question["column"]) => questions.filter((x) => x.column === k);
  return (
    <div data-testid="questions-board" className="flex flex-col gap-3">
      <div className="hidden max-[600px]:block">
        <SegmentedControl
          label="Column"
          fill
          value={tab}
          onChange={setTab}
          items={COLUMNS.map((c) => ({ value: c.key, label: c.title, count: of(c.key).length, testId: `board-tab-${c.key}` }))}
        />
      </div>
      <div className="grid grid-cols-3 gap-4 max-[900px]:grid-cols-1">
        {COLUMNS.map((c) => (
          // The wrapper hides a column on a phone (.simple-card sets its own display).
          <div key={c.key} className={`min-w-0 ${tab === c.key ? "" : "max-[600px]:hidden"}`}>
          <section aria-label={c.title} data-testid={`board-${c.key}`} className="simple-card h-full min-w-0">
            <h2 className="simple-h2">
              {c.title} <span className="simple-count tnum">{of(c.key).length}</span>
            </h2>
            {of(c.key).length === 0 ? (
              <p className="simple-small">None.</p>
            ) : (
              <ul className="divide-y divide-border">
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

function Filter({ label, value, options, onChange, all }: { label: string; value: string; options: Schemas["SimpleFilterOption"][]; onChange: (v: string) => void; all: string }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="simple-small">{label}</span>
      <select className="rounded border border-border bg-surface p-2" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{all}</option>
        {options.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
      </select>
    </label>
  );
}

function MeetingGroup({ g }: { g: Group }) {
  const zone = useCompanyZone();
  const m = g.meeting;
  const minutes = g.minutes;
  return (
    <section className="simple-card space-y-3" aria-label={m.title} data-testid="meeting-group">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="simple-h2">
          <Link href={`/simple/meetings/${m.id}`} className="hover:underline">{m.title}</Link>
        </h2>
        <span className="simple-small">{formatInZone(m.started_at, zone, { month: "short", day: "numeric", year: "numeric" })} · {m.prd.title}</span>
      </div>
      {minutes?.summary && <p>{minutes.summary}</p>}
      <p className="simple-small">Attendees: {m.attendees.map((a) => a.name).join(", ")}</p>
      {minutes && minutes.open_questions.length > 0 && (
        <div>
          <h3 className="font-semibold">Open questions</h3>
          <ul className="list-disc pl-5">{minutes.open_questions.map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
      )}
      {minutes && minutes.action_items.length > 0 && (
        <div>
          <h3 className="font-semibold">Action items</h3>
          <ul className="list-disc pl-5">
            {minutes.action_items.map((a, i) => <li key={i}>{a.title} · {a.owner_name ?? "no owner"}{a.due_date ? ` · by ${a.due_date}` : ""}</li>)}
          </ul>
        </div>
      )}
      {minutes && minutes.waits.length > 0 && (
        <div>
          <h3 className="font-semibold">What waits on whom</h3>
          <ul className="list-disc pl-5">{minutes.waits.map((w, i) => <li key={i}>{w.what}{w.on.length ? ` · on ${w.on.map((p) => p.name).join(", ")}` : ""}</li>)}</ul>
        </div>
      )}
      <h3 className="font-semibold">Decisions</h3>
      {g.decisions.length ? <Rows rows={g.decisions} /> : <p className="simple-small">None.</p>}
    </section>
  );
}

function Rows({ rows }: { rows: Row[] }) {
  const zone = useCompanyZone();
  return (
    <ul className="mt-2 divide-y divide-border">
      {rows.map((r) => (
        <DecidedItem key={r.id} id={`d-${r.number}`} testId="decision-row" flow={r.flow} className="justify-between py-2 target:bg-[var(--simple-edited)]">
          <span>
            <strong>D-{r.number}</strong> {r.title}
            {r.status !== "decided" && <span className="simple-small"> · {r.status}</span>}
          </span>
          <span className="simple-small">
            {r.approver?.name ?? "No approver"} · {formatInZone(r.decided_at ?? r.created_at, zone, { month: "short", day: "numeric" })}
          </span>
        </DecidedItem>
      ))}
    </ul>
  );
}
