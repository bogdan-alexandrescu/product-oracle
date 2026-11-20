'use client';

import { useParams } from '@/lib/nav';
import { Suspense } from 'react';

import { OnePager } from './_one-pager';
import { PageSkeleton } from '@/components/ds';

function Doc() {
  const { doc } = useParams<{ doc: string }>();
  return <OnePager slug={doc} />;
}

export default function OnePagerPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Doc />
    </Suspense>
  );
}
