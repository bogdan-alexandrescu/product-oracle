import { SimplePage, SimplePlaceholder } from "@/components/simple/SimplePage";

/** One meeting (#723 S1): arrives with S8; until then, the rituals in Studio. */
export default function SimpleMeeting() {
  return (
    <SimplePage title="Meeting">
      <SimplePlaceholder
        arrives="the meeting's one-pager, roadmap and open decisions, full screen with a clock, and its minutes."
        studioHref="/company/rituals"
        studioLabel="Company › Rituals"
      />
    </SimplePage>
  );
}
