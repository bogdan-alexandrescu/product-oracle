"use client";

import Link from "next/link";

import { MeetingChat } from "@/components/simple/chat/MeetingChat";
import { SimplePage } from "@/components/simple/SimplePage";
import { api, unwrap } from "@/lib/api/client";
import { useQuery } from "@/lib/use-query";

/** qa-simple-decide-11: the chat's own page names its meeting and leads back to it; "Meeting chat" once. */
export function MeetingChatPage({ id, session }: { id: string; session: string }) {
  const q = useQuery(`simple-meeting|${id}`, () => unwrap(api.GET("/v1/simple/meetings/{meeting_id}", { params: { path: { meeting_id: id } } })));
  const m = q.data;
  return (
    <SimplePage
      title="Meeting chat"
      lead={
        m ? (
          <span data-testid="meeting-chat-of">
            The chat of <strong>{m.title}</strong>
            {m.status === "ended" ? " (ended)" : ""} ·{" "}
            <Link className="font-semibold text-accent-ink hover:underline" href={`/simple/meetings/${id}`}>
              Back to the meeting
            </Link>
          </span>
        ) : undefined
      }
    >
      <MeetingChat meetingId={id} sessionId={session || m?.session_id || ""} heading={false} />
    </SimplePage>
  );
}
