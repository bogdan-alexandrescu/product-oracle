'use client';

import { createFileRoute } from '@tanstack/react-router';
import { useParams } from '@/lib/nav';
import { Suspense } from 'react';

import { ReportDetail } from '../_report';
import { PageSkeleton } from '@/components/ds';

function Detail() {
  const { id } = useParams<{ id: string }>();
  return <ReportDetail id={id} />;
}

function ReportPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Detail />
    </Suspense>
  );
}

export const Route = createFileRoute('/plan/reports/$id/')({ component: ReportPage });
