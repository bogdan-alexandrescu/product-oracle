'use client';

import { useParams } from '@/lib/nav';
import { Suspense } from 'react';

import { PublishView } from '@/components/PublishView';
import { PageSkeleton } from '@/components/ds';

function Publish() {
  const { doc } = useParams<{ doc: string }>();
  return <PublishView key={doc} doc={doc} />;
}

export default function PublishPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Publish />
    </Suspense>
  );
}
