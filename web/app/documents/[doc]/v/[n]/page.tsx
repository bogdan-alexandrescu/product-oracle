'use client';

import { useParams } from '@/lib/nav';
import { Suspense } from 'react';

import { VersionView } from '@/components/VersionView';
import { PageSkeleton } from '@/components/ds';

function Version() {
  const { doc, n } = useParams<{ doc: string; n: string }>();
  return <VersionView key={`${doc}/${n}`} doc={doc} n={Number(n)} />;
}

export default function VersionPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Version />
    </Suspense>
  );
}
