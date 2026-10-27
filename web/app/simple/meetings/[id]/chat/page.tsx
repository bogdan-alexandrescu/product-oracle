import { MeetingChat } from "@/components/simple/chat/MeetingChat";
import { SimplePage } from "@/components/simple/SimplePage";
import type { RouteProps } from "@/lib/route-props";

/** Simple S9 (#723): one meeting's shared chat on its own page; S8's meeting screen renders the same MeetingChat in its right column. */
export default async function SimpleMeetingChat({ params, searchParams }: RouteProps<{ id: string }>) {
  const { id } = await params;
  const session = (await searchParams).session;
  return (
    <SimplePage title="Meeting chat">
      <MeetingChat meetingId={id} sessionId={typeof session === "string" ? session : ""} />
    </SimplePage>
  );
}
