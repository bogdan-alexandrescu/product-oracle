'use client';

import { useParams } from '@/lib/nav';
import { Suspense } from 'react';

import { ImpactExplorer } from '@/app/impact/_explorer';
import { PageSkeleton } from '@/components/ds';

function Explorer() {
  const { doc, n } = useParams<{ doc: string; n: string }>();
  return <ImpactExplorer key={`${doc}/${n}`} source={{ kind: 'version', doc, n: Number(n) }} />;
}

/** v2 screen 2: what a PRD version changes for the outputs built on earlier versions (a preview). */
export default function VersionImpactPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Explorer />
    </Suspense>
  );
}
