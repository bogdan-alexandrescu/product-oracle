import { EmptyState } from "@/components/ui";

export default function BaselinePage() {
  return (
    <EmptyState title="Baseline">
      <p>No baseline yet. The baseline is what the workspace knows about the product: its goals, users, constraints and current priorities, distilled from your connected sources.</p>
      <p>Once sources are connected and indexed, the baseline appears here, each statement linked to where it came from.</p>
    </EmptyState>
  );
}
