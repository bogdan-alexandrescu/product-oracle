import { Chip, type ChipKind } from "@/components/ds";
import type { DocumentOut } from "@/lib/api/client";
import { DOC_STATUS_LABEL } from "@/lib/format";

const KIND: Record<DocumentOut["status"], ChipKind> = { draft: "na", in_review: "acc", approved: "pass" };

/** A document's status as a ds Chip (draft, in review, approved). */
export function DocStatusChip({ status, hero = false, dot = false }: { status: DocumentOut["status"]; hero?: boolean; dot?: boolean }) {
  return (
    <Chip kind={KIND[status]} hero={hero} dot={dot} data-status={status}>
      {DOC_STATUS_LABEL[status]}
    </Chip>
  );
}
