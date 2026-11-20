'use client';

import { createFileRoute } from '@tanstack/react-router';
import { useParams } from '@/lib/nav';
import { Suspense } from 'react';

import { OnePager } from './_one-pager';
import { PageSkeleton } from '@/components/ds';

function Doc() {
  const { doc } = useParams<{ doc: string }>();
  return <OnePager slug={doc} />;
}

function OnePagerPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Doc />
    </Suspense>
  );
}

export const Route = createFileRoute('/simple/one-pagers/$doc/')({ component: OnePagerPage });
