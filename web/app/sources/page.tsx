import { EmptyState } from "@/components/ui";

export default function SourcesPage() {
  return (
    <EmptyState title="Sources">
      <p>No sources yet. Sources are the material the workspace learns from, such as documents, chat threads and meeting notes.</p>
      <p>Indexed sources and what was extracted from them appear here.</p>
    </EmptyState>
  );
}
