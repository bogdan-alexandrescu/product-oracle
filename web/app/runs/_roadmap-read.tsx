/**
 * prd-reads-working-draft: which company roadmap a PRD's run read, as the API words it
 * (RunSummary.roadmap_read: "Company roadmap, working draft (edited Nov 5, 2026, 11:40 PM
 * PST)" or "Company roadmap v7 (published Nov 4)").
 */
export function RoadmapRead({ text, className = "" }: { text: string; className?: string }) {
  return (
    <span className={`text-sm text-text2 ${className}`} data-testid="run-roadmap-read">
      Roadmap read: <span className="text-text">{text}</span>
    </span>
  );
}
