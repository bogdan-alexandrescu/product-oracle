'use client';

import { Suspense } from 'react';

import { DiffView } from '@/components/DiffView';
import { useParams, useSearchParams } from '@/lib/nav';
import { PageSkeleton } from '@/components/ds';

function num(v: string | null): number | undefined {
  const n = Number(v ?? undefined);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function Diff() {
  const { doc } = useParams<{ doc: string }>();
  const q = useSearchParams();
  return <DiffView doc={doc} from={num(q.get('from'))} to={num(q.get('to'))} />;
}

export default function DiffPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Diff />
    </Suspense>
  );
}
