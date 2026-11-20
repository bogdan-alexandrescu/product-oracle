'use client';

import { useParams } from '@/lib/nav';
import { Suspense } from 'react';

import { ReportDetail } from '../_report';
import { PageSkeleton } from '@/components/ds';

function Detail() {
  const { id } = useParams<{ id: string }>();
  return <ReportDetail id={id} />;
}

export default function ReportPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Detail />
    </Suspense>
  );
}
