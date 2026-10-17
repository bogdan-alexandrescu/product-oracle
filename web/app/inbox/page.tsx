import { EmptyState } from "@/components/ui";

export default function InboxPage() {
  return (
    <EmptyState title="Inbox">
      <p>Nothing waiting on you. Checkpoints that need a decision, such as a run waiting for budget approval or a draft ready for review, land here.</p>
      <p>You will see each item with what it needs from you and a link to act on it.</p>
    </EmptyState>
  );
}
