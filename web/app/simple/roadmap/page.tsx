import { SimplePage, SimplePlaceholder } from "@/components/simple/SimplePage";

/** Simple's Roadmap (#723 S1): the screen arrives with S4; until then, /plan in Detailed. */
export default function SimpleRoadmap() {
  return (
    <SimplePage title="Roadmap">
      <SimplePlaceholder arrives="the company-wide roadmap as a timeline by quarter, a Gantt chart, a Now/Next/Later board and waterfall phases, grouped by goal, track or PRD." detailedHref="/plan" detailedLabel="The Plan" />
    </SimplePage>
  );
}
