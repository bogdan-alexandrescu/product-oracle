"use client";

import Link from "next/link";
import { notFound, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

import { Button, PageSkeleton } from "@/components/ds";
import { PreRead } from "@/components/simple/meetings/PreRead";
import { StartSheet } from "@/components/simple/meetings/StartSheet";
import { SimpleEmpty, SimplePage, SimpleSection } from "@/components/simple/SimplePage";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useCompanyZone } from "@/lib/dates";
import { zoneName } from "@/lib/format";
import { useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";

import { SIMPLE_MODE } from "../_flag";
import { LINK, momentWords } from "./_flow";

/** qa-simple-decide-33: a 44 px tap area on a phone. */
const TAP = "inline-flex items-center max-[600px]:min-h-11";

/**
 * Simple S8 (#723): Meetings, direction B: the scheduled reviews (from rituals) to start,
 * the live meetings to join, and past ones with their minutes' summary. "Start a review"
 * opens the start sheet. Upcoming is the one list of scheduled reviews: Home's "Next review
 * meeting" is its first row and the rail's Meetings count is its rows not started plus the
 * live meetings; Home's Start opens here (`?start=` the ritual) with the sheet open. Start shows
 * where the row's can_start says (owners and the ritual's owner). Home's "Open pre-read" opens
 * here (`?pre_read=` the occurrence) with that review's pre-read on top (PreRead).
 */
export default function SimpleMeetings() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Meetings />
    </Suspense>
  );
}

function Meetings() {
  const zone = useCompanyZone();
  const { can } = useMe();
  const q = useQuery("simple-meetings-page", () => unwrap(api.GET("/v1/simple/meetings")));
  const [sheet, setSheet] = useState<{ occurrence?: string; ritual?: Schemas["SimpleUpcomingMeeting"] } | null>(null);
  const params = useSearchParams();
  const startParam = params.get("start");
  // Home's "Open pre-read" (`?pre_read=` the occurrence): that review's pre-read, here in Simple.
  const preReadParam = params.get("pre_read");
  const preRead = preReadParam ? q.data?.upcoming.find((x) => x.occurrence_id === preReadParam) : undefined;
  const [opened, setOpened] = useState(false);
  // Home's Start meeting (`?start=` its ritual): the sheet opens on that review, once.
  if (startParam && !opened && q.data) {
    setOpened(true);
    const o = q.data.upcoming.find((x) => x.ritual_id === startParam && !x.meeting_id && x.can_start);
    if (o) setSheet(o.occurrence_id ? { occurrence: o.occurrence_id } : { ritual: o });
  }
  if (!SIMPLE_MODE) notFound();
  // qa-simple-decide-50: the zone is said once, in the lead; the rows show the day and time.
  // qa-simple-decide-31: the one day-and-time format of Meetings, a meeting and Decisions.
  const when = (at: string) => momentWords(at, zone);
  // qa-simple-decide-8: Start review only for who may start one (an owner, or a review's own owner).
  const mayStart = can("start_simple_meeting", !!q.data?.upcoming.some((o) => o.can_start));
  // The live reviews are listed under Live only (qa-simple-decide-34).
  const liveIds = new Set((q.data?.live ?? []).map((m) => m.id));
  const upcoming = (q.data?.upcoming ?? []).filter((o) => !o.meeting_id || !liveIds.has(o.meeting_id));
  return (
    <SimplePage
      title="Meetings"
      lead={
        // qa-simple-decide-38: a one-line lead, as on Decisions; qa-simple-decide-34: one verb, "Start review".
        <span className="flex flex-wrap items-center gap-3">
          <span>Start a review of a PRD, join the one that is on, and read past minutes. Times are in {zoneName(zone)}.</span>
          {mayStart ? (
            <Button variant="primary" onClick={() => setSheet({})}>Start review</Button>
          ) : (
            <span className="simple-small" data-testid="meetings-start-why">An owner or a review&apos;s owner starts reviews; join one when it is on.</span>
          )}
        </span>
      }
    >
      {q.loading && !q.data && <Loading />}
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {q.data && (
        <>
          {preRead && <PreRead review={preRead} />}
          {preReadParam && !preRead && <SimpleEmpty testId="meetings-pre-read-gone">This review is no longer scheduled.</SimpleEmpty>}
          <SimpleSection title="Live" testId="meetings-live">
            {q.data.live.length === 0 && <p className="simple-meta" data-testid="meetings-live-empty">No meeting is on now.</p>}
            <ul className="space-y-2">
              {q.data.live.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    <strong>{m.title}</strong> · started {when(m.started_at)} by {m.presenter.name} · {m.decisions} {m.decisions === 1 ? "decision" : "decisions"}
                  </span>
                  <Link className={`${LINK} ${TAP}`} href={`/simple/meetings/${m.id}`}>Join</Link>
                </li>
              ))}
            </ul>
          </SimpleSection>
          <SimpleSection title="Upcoming" testId="meetings-upcoming">
            {upcoming.length === 0 && <SimpleEmpty testId="meetings-upcoming-empty">No review is scheduled. Rituals in Detailed schedule them.</SimpleEmpty>}
            <ul className="space-y-2">
              {upcoming.map((o) => (
                <li key={o.occurrence_id ?? `${o.ritual_id}|${o.due_at}`} data-testid="meetings-upcoming-row" className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    <strong>{o.ritual_title}</strong> · {when(o.due_at)} · {o.length_min} min · {o.attendees.map((a) => a.name).join(", ")}
                    {/* qa-simple-decide-37: its pre-read and agenda before it starts. */}
                    {o.occurrence_id ? (
                      <>
                        {" · "}
                        <Link className="font-semibold text-accent-ink hover:underline" href={`/simple/meetings?pre_read=${o.occurrence_id}`} data-testid="meetings-pre-read-link">
                          Pre-read and agenda
                        </Link>
                      </>
                    ) : (
                      <span className="simple-small"> · Pre-read not ready yet</span>
                    )}
                  </span>
                  {o.meeting_id ? (
                    <Link className="font-semibold text-accent-ink hover:underline" href={`/simple/meetings/${o.meeting_id}`}>Open</Link>
                  ) : o.can_start ? (
                    <Button onClick={() => setSheet(o.occurrence_id ? { occurrence: o.occurrence_id } : { ritual: o })}>Start review</Button>
                  ) : null}
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
                    <Link className={`${LINK} ${TAP}`} href={`/simple/meetings/${m.id}`}>{m.title}</Link> · {when(m.ended_at ?? m.started_at)} · {m.decisions} {m.decisions === 1 ? "decision" : "decisions"}
                  </p>
                  {m.summary ? <p className="simple-small">{m.summary}</p> : <p className="simple-small">Minutes not sent yet.</p>}
                  <Link className={`${LINK} ${TAP}`} href={`/simple/decisions?meeting=${m.id}`} data-testid="meetings-its-decisions">Its decisions</Link>
                </li>
              ))}
            </ul>
          </SimpleSection>
        </>
      )}
      <StartSheet open={!!sheet} onClose={() => setSheet(null)} occurrence={sheet?.occurrence} ritual={sheet?.ritual} origin="one_pager" />
    </SimplePage>
  );
}
