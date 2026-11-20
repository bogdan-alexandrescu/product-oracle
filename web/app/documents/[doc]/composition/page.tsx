'use client';

import { useParams } from '@/lib/nav';
import { Suspense } from 'react';

import { CompositionView } from './_view';
import { PageSkeleton } from '@/components/ds';

function Composition() {
  const { doc } = useParams<{ doc: string }>();
  return <CompositionView key={doc} doc={doc} />;
}

export default function CompositionPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Composition />
    </Suspense>
  );
}
