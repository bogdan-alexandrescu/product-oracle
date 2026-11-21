'use client';

import { createFileRoute } from '@tanstack/react-router';
import { Suspense } from 'react';

import { PresentMode } from '@/components/PresentMode';
import { useParams, useSearchParams } from '@/lib/nav';
import { PageSkeleton } from '@/components/ds';

function Present() {
  const { doc, n } = useParams<{ doc: string; n: string }>();
  const q = useSearchParams();
  const slide = Number(q.get('slide') ?? undefined);
  return (
    <PresentMode
      key={`${doc}/${n}`}
      doc={doc}
      n={Number(n)}
      presenter={q.get('view') === 'presenter'}
      start={Number.isInteger(slide) && slide > 0 ? slide : 1}
    />
  );
}

function PresentPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Present />
    </Suspense>
  );
}

export const Route = createFileRoute('/documents/$doc/v/$n/present/')({ component: PresentPage });
