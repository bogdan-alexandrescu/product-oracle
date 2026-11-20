'use client';

import { useParams } from '@/lib/nav';
import { Suspense } from 'react';

import { PublicCheck } from '@/components/share/PublicCheck';
import { PageSkeleton } from '@/components/ds';

function Check() {
  const { doc } = useParams<{ doc: string }>();
  return <PublicCheck doc={doc} />;
}

/** O5: the Public check, the review list beside the exact page a link holder sees. */
export default function PublicCheckPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Check />
    </Suspense>
  );
}
