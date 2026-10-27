"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";

import { SimpleEmpty, SimplePage } from "@/components/simple/SimplePage";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatInZone, useCompanyZone } from "@/lib/dates";
import { useQuery } from "@/lib/use-query";

import { DecidedItem } from "../meetings/_flow";

type Row = Schemas["SimpleDecisionRow"];
type Group = Schemas["SimpleMeetingGroup"];

/**
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
  return (
    <SimplePage title="Decisions" lead="Every decision, newest first, beside the meeting that took it.">
      <div className="flex flex-wrap gap-3" role="group" aria-label="Filters">
        <Filter label="PRD" value={prd} options={d?.prds ?? []} onChange={(v) => set("prd", v)} all="All PRDs" />
        <Filter label="Goal" value={goal} options={d?.goals ?? []} onChange={(v) => set("goal", v)} all="All goals" />
        <Filter label="Meeting" value={meeting} options={d?.meeting_options ?? []} onChange={(v) => set("meeting", v)} all="All meetings" />
      </div>
      {q.loading && !d && <Loading />}
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {d && (
        <>
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
