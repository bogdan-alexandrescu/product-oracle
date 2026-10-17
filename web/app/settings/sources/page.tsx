import { EmptyState } from "@/components/ui";

export default function SourceSettingsPage() {
  return (
    <EmptyState title="Sources">
      <p>No sources connected yet. Connect the places your product knowledge lives so runs can cite them.</p>
      <p>Connected sources, their sync status and their settings will be managed here.</p>
    </EmptyState>
  );
}
