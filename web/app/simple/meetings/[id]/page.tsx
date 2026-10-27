import { MeetingChat } from "@/components/simple/chat/MeetingChat";
import { SimplePage, SimplePlaceholder } from "@/components/simple/SimplePage";
import type { RouteProps } from "@/lib/route-props";

/** One meeting (#723 S1): arrives with S8; until then, the rituals in Detailed, and S9's meeting chat on the right. */
export default async function SimpleMeeting({ params, searchParams }: RouteProps<{ id: string }>) {
  const { id } = await params;
  const session = (await searchParams).session;
  return (
    <SimplePage title="Meeting">
      <div className="grid gap-[var(--simple-gap)] min-[1000px]:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
        <SimplePlaceholder
          arrives="the meeting's one-pager, roadmap and open decisions, full screen with a clock, and its minutes."
          detailedHref="/company/rituals"
          detailedLabel="Company › Rituals"
        />
        <MeetingChat meetingId={id} sessionId={typeof session === "string" ? session : ""} />
      </div>
    </SimplePage>
  );
}
