import { EmptyState } from "@/components/ui";

export default function RunsPage() {
  return (
    <EmptyState title="Runs">
      <p>No runs yet. Runs turn the baseline into a PRD draft: each one plans the work, gathers evidence from your sources and writes a cited draft for review.</p>
      <p>Started runs appear here with their status, cost estimate and the draft they produced.</p>
    </EmptyState>
  );
}
