'use client';

import { useParams } from '@/lib/nav';
import { Suspense } from 'react';

import { ImpactExplorer } from '@/app/impact/_explorer';
import { PageSkeleton } from '@/components/ds';

function Explorer() {
  const { id } = useParams<{ id: string }>();
  return <ImpactExplorer key={id} source={{ kind: 'entity', id }} />;
}

/** v2 screen 2: what-if from a baseline item: the outputs built on it (a preview). */
export default function EntityImpactPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Explorer />
    </Suspense>
  );
}
