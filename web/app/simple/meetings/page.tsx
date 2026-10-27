"use client";

import Link from "next/link";
import { notFound } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ds";
import { StartSheet } from "@/components/simple/meetings/StartSheet";
import { SimpleEmpty, SimplePage, SimpleSection } from "@/components/simple/SimplePage";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { formatInZone, useCompanyZone } from "@/lib/dates";
import { useQuery } from "@/lib/use-query";

import { SIMPLE_MODE } from "../_flag";

/**
 * Simple S8 (#723): Meetings, direction B: the scheduled reviews (from rituals) to start,
 * the live meetings to join, and past ones with their minutes' summary. "Start a review"
 * opens the start sheet.
 */
export default function SimpleMeetings() {
  const zone = useCompanyZone();
  const q = useQuery("simple-meetings-page", () => unwrap(api.GET("/v1/simple/meetings")));
  const [sheet, setSheet] = useState<{ occurrence?: string } | null>(null);
  if (!SIMPLE_MODE) notFound();
  const when = (at: string) => formatInZone(at, zone, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return (
    <SimplePage title="Meetings" lead={<Button variant="primary" onClick={() => setSheet({})}>Start a review</Button>}>
      {q.loading && !q.data && <Loading />}
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {q.data && (
        <>
          <SimpleSection title="Live" testId="meetings-live">
            {q.data.live.length === 0 && <SimpleEmpty testId="meetings-live-empty">No meeting is on now.</SimpleEmpty>}
            <ul className="space-y-2">
              {q.data.live.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    <strong>{m.title}</strong> · started {when(m.started_at)} by {m.presenter.name} · {m.decisions} {m.decisions === 1 ? "decision" : "decisions"}
                  </span>
                  <Link className="font-semibold text-accent-ink hover:underline" href={`/simple/meetings/${m.id}`}>Join</Link>
                </li>
              ))}
            </ul>
          </SimpleSection>
          <SimpleSection title="Upcoming" testId="meetings-upcoming">
            {q.data.upcoming.length === 0 && <SimpleEmpty testId="meetings-upcoming-empty">No review is scheduled. Rituals in Detailed schedule them.</SimpleEmpty>}
            <ul className="space-y-2">
              {q.data.upcoming.map((o) => (
                <li key={o.occurrence_id} className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    <strong>{o.ritual_title}</strong> · {when(o.due_at)} · {o.length_min} min · {o.attendees.map((a) => a.name).join(", ")}
                  </span>
                  {o.meeting_id ? (
                    <Link className="font-semibold text-accent-ink hover:underline" href={`/simple/meetings/${o.meeting_id}`}>Open</Link>
                  ) : (
                    <Button onClick={() => setSheet({ occurrence: o.occurrence_id })}>Start review</Button>
                  )}
                </li>
              ))}
            </ul>
          </SimpleSection>
          <SimpleSection title="Past" testId="meetings-past">
            {q.data.past.length === 0 && <SimpleEmpty testId="meetings-past-empty">No meeting yet.</SimpleEmpty>}
            <ul className="space-y-3">
              {q.data.past.map((m) => (
                <li key={m.id} className="space-y-1">
                  <p>
                    <Link className="font-semibold text-accent-ink hover:underline" href={`/simple/meetings/${m.id}`}>{m.title}</Link> · {when(m.ended_at ?? m.started_at)} · {m.decisions} {m.decisions === 1 ? "decision" : "decisions"}
                  </p>
                  {m.summary ? <p className="simple-small">{m.summary}</p> : <p className="simple-small">Minutes not sent yet.</p>}
                  <Link className="simple-small underline" href={`/simple/decisions?meeting=${m.id}`}>Its decisions</Link>
                </li>
              ))}
            </ul>
          </SimpleSection>
        </>
      )}
      <StartSheet open={!!sheet} onClose={() => setSheet(null)} occurrence={sheet?.occurrence} origin="one_pager" />
    </SimplePage>
  );
}
