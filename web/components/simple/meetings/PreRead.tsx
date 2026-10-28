"use client";

import Link from "next/link";

import { SimpleEmpty, SimpleSection } from "@/components/simple/SimplePage";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatInZone, useCompanyZone } from "@/lib/dates";
import { useQuery } from "@/lib/use-query";

type Upcoming = Schemas["SimpleUpcomingMeeting"];
type Row = Schemas["SimpleDecisionRow"];

/** The open decisions of Simple's Decisions page (GET /v1/simple/decisions), newest first. */
export function openDecisions(d: Schemas["SimpleDecisionsOut"]): Row[] {
  const rows = [...d.meetings.flatMap((g) => g.decisions), ...d.other].filter((r) => r.status === "proposed");
  return [...new Map(rows.map((r) => [r.id, r])).values()].sort((a, b) => b.number - a.number);
}

/**
 * The walk (M1): a scheduled review's pre-read in Simple, where Home's "Open pre-read" lands
 * (Meetings, `?pre_read=` the occurrence): the review, who comes, and the product decisions
 * still open as Simple's Decisions page reads them (its PRD's once the meeting is started),
 * each opening there. Never Detailed's ritual pre-read, never a run's approvals.
 */
export function PreRead({ review }: { review: Upcoming }) {
  const zone = useCompanyZone();
  const q = useQuery(`simple-pre-read|${review.occurrence_id ?? review.ritual_id}|${review.meeting_id ?? ""}`, async () => {
    // A started review is about one PRD: its decisions; before, every open one.
    const prd = review.meeting_id
      ? (await unwrap(api.GET("/v1/simple/meetings/{meeting_id}", { params: { path: { meeting_id: review.meeting_id } } }))).prd.slug
      : undefined;
    return openDecisions(await unwrap(api.GET("/v1/simple/decisions", { params: { query: { prd } } })));
  });
  return (
    <SimpleSection title="Pre-read" testId="meetings-pre-read">
      <p>
        <strong>{review.ritual_title}</strong> ·{" "}
        <span className="tnum">{formatInZone(review.due_at, zone, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span> · {review.length_min} min
      </p>
      {review.attendees.length > 0 && <p className="simple-small">Attendees: {review.attendees.map((a) => a.name).join(", ")}</p>}
      <h3 className="mt-3 font-semibold">Open decisions</h3>
      {q.loading && !q.data && <Loading />}
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {q.data && q.data.length === 0 && <SimpleEmpty testId="pre-read-decisions-empty">No decision is open.</SimpleEmpty>}
      {q.data && q.data.length > 0 && (
        <ul className="mt-2 space-y-1" aria-label="Open decisions">
          {q.data.map((d) => (
            <li key={d.id} data-testid="pre-read-decision" className="[overflow-wrap:anywhere]">
              <Link className="font-semibold text-accent-ink hover:underline" href={`/simple/decisions#d-${d.number}`}>
                D-{d.number}
              </Link>{" "}
              {d.title}
            </li>
          ))}
        </ul>
      )}
    </SimpleSection>
  );
}
