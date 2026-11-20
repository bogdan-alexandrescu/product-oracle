'use client';

import { createFileRoute } from '@tanstack/react-router';
import { useParams } from '@/lib/nav';
import { Suspense } from 'react';

import { VersionView } from '@/components/VersionView';
import { PageSkeleton } from '@/components/ds';

function Version() {
  const { doc, n } = useParams<{ doc: string; n: string }>();
  return <VersionView key={`${doc}/${n}`} doc={doc} n={Number(n)} />;
}

function VersionPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Version />
    </Suspense>
  );
}

export const Route = createFileRoute('/documents/$doc/v/$n/')({ component: VersionPage });
