import { SimplePage, SimplePlaceholder } from "@/components/simple/SimplePage";

/** Simple's Priorities (#723 S1): the screen arrives with S6; until then, /priorities in Studio. */
export default function SimplePriorities() {
  return (
    <SimplePage title="Priorities">
      <SimplePlaceholder arrives="a ranked list you can reorder, a value/effort grid and goal buckets." studioHref="/priorities" studioLabel="Priorities" />
    </SimplePage>
  );
}
