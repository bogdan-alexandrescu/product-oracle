'use client';

import { useParams } from '@/lib/nav';
import { Suspense } from 'react';

import { BriefDetail } from '../_brief-detail';
import { PageSkeleton } from '@/components/ds';

function Detail() {
  const { id } = useParams<{ id: string }>();
  return <BriefDetail id={id} />;
}

export default function BriefPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Detail />
    </Suspense>
  );
}
