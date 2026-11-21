'use client';

import { createFileRoute } from '@tanstack/react-router';
import { useParams } from '@/lib/nav';
import { Suspense } from 'react';

import { RunDetail } from '../_run-detail';
import { PageSkeleton } from '@/components/ds';

function Detail() {
  const { id } = useParams<{ id: string }>();
  return <RunDetail id={id} />;
}

function RunPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Detail />
    </Suspense>
  );
}

export const Route = createFileRoute('/runs/$id/')({ component: RunPage });
