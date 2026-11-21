'use client';

import { createFileRoute } from '@tanstack/react-router';
import { useParams } from '@/lib/nav';
import { Suspense } from 'react';

import { OccurrenceDetail } from '../_components/OccurrenceDetail';
import { PageSkeleton } from '@/components/ds';

function Detail() {
  const { occurrence } = useParams<{ occurrence: string }>();
  return <OccurrenceDetail id={occurrence} />;
}

/** One ritual occurrence, inside the Company shell with the Rituals tab selected. */
function OccurrencePage() {
  return (
    <Suspense fallback={<PageSkeleton bare />}>
      <Detail />
    </Suspense>
  );
}

export const Route = createFileRoute('/company/rituals/$occurrence/')({
  component: OccurrencePage,
});
