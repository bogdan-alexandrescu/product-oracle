'use client';

import Loading from './loading';
import { createFileRoute } from '@tanstack/react-router';
import { useParams } from '@/lib/nav';
import { Suspense } from 'react';

import { BeforeDrafting } from './_shell';
import { PageSkeleton } from '@/components/ds';

function Shell() {
  const { id } = useParams<{ id: string }>();
  // Keyed by the brief: a kept page never shows the previous brief's counts under this one (walk-brief).
  return <BeforeDrafting key={id} id={id} />;
}

/** Before drafting (C5): Oracle's questions about a brief, and whether it is ready to draft. */
function IntakePage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Shell />
    </Suspense>
  );
}

export const Route = createFileRoute('/intakes/$id/')({
  component: IntakePage,
  pendingComponent: Loading,
});
