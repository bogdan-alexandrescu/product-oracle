import type { Role } from "@/lib/me";

const NOTES: Partial<Record<Role, string>> = {
  viewer: "You have read-only access (viewer): you can read, compare and export, but not comment or review.",
  commenter: "You can comment and reply. Section verdicts and approval need the approver role.",
};

/** A short note on what the signed-in role cannot do here; nothing for approvers and owners. */
export function RoleNote({ role }: { role: Role | null }) {
  const note = role ? NOTES[role] : undefined;
  if (!note) return null;
  return (
    <p
      role="note"
      data-testid="role-note"
      className="mb-3 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-700"
    >
      {note}
    </p>
  );
}
