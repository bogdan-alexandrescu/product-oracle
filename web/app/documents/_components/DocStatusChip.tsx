import { Chip, type ChipKind } from "@/components/ds";
import type { DocumentOut } from "@/lib/api/client";
import { DOC_STATUS_LABEL } from "@/lib/format";

const KIND: Record<DocumentOut["status"], ChipKind> = { draft: "na", in_review: "acc", approved: "pass" };

/** A document's status as a ds Chip (draft, in review, approved). */
export function DocStatusChip({
  status,
  hero = false,
  dot = false,
  label,
}: {
  status: DocumentOut["status"];
  hero?: boolean;
  dot?: boolean;
  /** Another word for the status where the page uses one (Publish: "Published"). */
  label?: string;
}) {
  return (
    <Chip kind={KIND[status]} hero={hero} dot={dot} data-status={status}>
      {label ?? DOC_STATUS_LABEL[status]}
    </Chip>
  );
}
