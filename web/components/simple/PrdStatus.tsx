'use client';

import { DocStatusChip } from '@/app/documents/_components/DocStatusChip';
import { Chip } from '@/components/ds';
import type { Schemas } from '@/lib/api/client';

/**
 * qa-simple-prd-9: a PRD's status as its one-pager heads it: the approved version, and when a
 * newer draft is in progress, both ("Approved draft 3 · draft in progress"). qa-simple-prd-p3-16:
 * the One-pagers list and a one-pager's header read it from the same summary. #1915: a version
 * reads "draft 3" here as in a feature's "From <PRD> (draft 3)".
 */
export function PrdStatus({ d }: { d: Schemas['DocumentSummary'] }) {
  if (d.approved_version && d.status !== 'approved')
    return (
      <Chip kind="pass" dot data-status="approved">
        Approved draft {d.approved_version} ·{' '}
        {d.status === 'in_review' ? 'changes in review' : 'draft in progress'}
      </Chip>
    );
  return (
    <DocStatusChip
      status={d.status}
      dot
      label={
        d.status === 'approved' && d.approved_version
          ? `Approved draft ${d.approved_version}`
          : undefined
      }
    />
  );
}
