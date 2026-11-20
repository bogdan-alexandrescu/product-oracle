'use client';

import { useParams } from '@/lib/nav';
import { Suspense } from 'react';

import { DocumentOverview } from '@/components/DocumentOverview';
import { PageSkeleton } from '@/components/ds';

function Overview() {
  const { doc } = useParams<{ doc: string }>();
  return <DocumentOverview doc={doc} />;
}

export default function DocumentPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Overview />
    </Suspense>
  );
}
