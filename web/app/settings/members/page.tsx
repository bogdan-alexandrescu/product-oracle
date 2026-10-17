import { EmptyState } from "@/components/ui";

export default function MembersPage() {
  return (
    <EmptyState title="Members">
      <p>No members to show yet. Members are the people in this workspace and their roles: owner, approver, commenter or viewer.</p>
      <p>Owners will be able to invite people and change roles here.</p>
    </EmptyState>
  );
}
