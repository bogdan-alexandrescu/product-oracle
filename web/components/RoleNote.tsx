import { Chip, InfoTip } from "@/components/ds";
import type { Role } from "@/lib/me";

const NOTES: Partial<Record<Role, { label: string; note: string }>> = {
  viewer: {
    label: "Read only",
    note: "You have read-only access (viewer): you can read, compare and export, but not comment or review.",
  },
  commenter: {
    label: "Commenter",
    note: "You can comment and reply. Section verdicts and approval need the approver role.",
  },
};

/** What the signed-in role cannot do here: a chip, the detail behind (i); nothing for approvers and owners. */
export function RoleNote({ role }: { role: Role | null }) {
  const n = role ? NOTES[role] : undefined;
  if (!n) return null;
  return (
    <span role="note" data-testid="role-note" className="inline-flex items-center gap-1.5">
      <Chip kind="na">{n.label}</Chip>
      <InfoTip label="your role" align="start" side="bottom">
        {n.note}
      </InfoTip>
    </span>
  );
}
