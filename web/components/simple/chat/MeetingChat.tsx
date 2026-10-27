"use client";

import { useEffect } from "react";

import { api, unwrap } from "@/lib/api/client";
import { formatInZone, useCompanyZone } from "@/lib/dates";
import { useQuery } from "@/lib/use-query";

/**
 * Simple S8 (#723): a small stand-in for the meeting's chat (another lane replaces it with
 * the real chat at this path, same props): its title and the meeting's decisions, newest
 * first, read again every few seconds.
 */
export function MeetingChat({ meetingId, sessionId }: { meetingId: string; sessionId: string }) {
  const zone = useCompanyZone();
  const q = useQuery(`simple-meeting-chat|${meetingId}`, () =>
    unwrap(api.GET("/v1/simple/meetings/{meeting_id}", { params: { path: { meeting_id: meetingId } } })),
  );
  const { reload } = q;
  useEffect(() => {
    const t = window.setInterval(() => void reload(), 3000);
    return () => window.clearInterval(t);
  }, [reload]);
  const rows = q.data?.meeting_decisions ?? [];
  return (
    <section aria-label="Chat" data-session={sessionId} className="simple-card">
      <h2 className="simple-h2">Chat</h2>
      {rows.length === 0 ? (
        <p className="simple-small">Nothing decided yet.</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {rows.map((d) => (
            <li key={d.id} className="simple-small">
              D-{d.number} · {d.title} · {formatInZone(d.at, zone, { hour: "numeric", minute: "2-digit" })}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
