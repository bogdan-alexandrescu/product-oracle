import { SimplePage, SimplePlaceholder } from "@/components/simple/SimplePage";

/** Simple's Meetings (#723 S1): the screen arrives with S8; until then, /company/rituals in Studio. */
export default function SimpleMeetings() {
  return (
    <SimplePage title="Meetings">
      <SimplePlaceholder arrives="guided review meetings: the one-pager, the roadmap and the open decisions on one screen, with a clock and minutes at the end." studioHref="/company/rituals" studioLabel="Company › Rituals" />
    </SimplePage>
  );
}
