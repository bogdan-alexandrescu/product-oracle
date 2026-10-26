import { SimplePage, SimplePlaceholder } from "@/components/simple/SimplePage";

/** Simple's Decisions (#723 S1): the screen arrives with S8; until then, /company/decisions in Studio. */
export default function SimpleDecisions() {
  return (
    <SimplePage title="Decisions">
      <SimplePlaceholder arrives="every decision taken in meetings and across Simple, newest first, linked from the items it changed." studioHref="/company/decisions" studioLabel="Company › Decisions" />
    </SimplePage>
  );
}
