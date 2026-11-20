'use client';

import { createFileRoute } from '@tanstack/react-router';
import { useParams } from '@/lib/nav';
import { Suspense } from 'react';

import { ImpactExplorer } from '@/app/impact/_explorer';
import { PageSkeleton } from '@/components/ds';

function Explorer() {
  const { id } = useParams<{ id: string }>();
  return <ImpactExplorer key={id} source={{ kind: 'change', id }} />;
}

/** v2 screen 2: the outputs a recorded change marked Potentially stale. */
function ChangeImpactPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Explorer />
    </Suspense>
  );
}

export const Route = createFileRoute('/impact/changes/$id/')({ component: ChangeImpactPage });
