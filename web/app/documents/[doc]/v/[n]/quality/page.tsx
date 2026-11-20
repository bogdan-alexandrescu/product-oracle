'use client';

import { useParams } from '@/lib/nav';
import { Suspense } from 'react';

import { QualityView } from '@/components/QualityView';
import { PageSkeleton } from '@/components/ds';

/** v2 screen 5: the quality evaluation of a PRD version (criteria, ratings, History). */
function Quality() {
  const { doc, n } = useParams<{ doc: string; n: string }>();
  return <QualityView key={`${doc}/${n}`} doc={doc} n={Number(n)} />;
}

export default function VersionQualityPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Quality />
    </Suspense>
  );
}
