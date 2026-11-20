'use client';

import { Suspense } from 'react';

import { useParams, useSearchParams } from '@/lib/nav';

import { ReviewShell } from './_shell';
import { PageSkeleton } from '@/components/ds';

function Shell() {
  const { id, checkpoint } = useParams<{ id: string; checkpoint: string }>();
  const item = useSearchParams().getAll('item');
  return (
    <ReviewShell runId={id} checkpointId={checkpoint} item={item.length === 1 ? item[0] : null} />
  );
}

/**
 * The shared review route (C7): `/runs/<id>/review/<checkpoint id>` loads the run and its
 * checkpoint and opens the view of the checkpoint's kind (./_shell.tsx VIEWS); any other
 * kind goes to the run page's decision. `?item=<key>` selects a row on arrival.
 */
export default function ReviewPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Shell />
    </Suspense>
  );
}
