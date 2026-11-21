'use client';

import { createFileRoute } from '@tanstack/react-router';
import { useParams } from '@/lib/nav';
import { Suspense } from 'react';

import { BriefDetail } from '../_brief-detail';
import { PageSkeleton } from '@/components/ds';

function Detail() {
  const { id } = useParams<{ id: string }>();
  return <BriefDetail id={id} />;
}

function BriefPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Detail />
    </Suspense>
  );
}

export const Route = createFileRoute('/briefs/$id/')({ component: BriefPage });
