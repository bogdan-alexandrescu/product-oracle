'use client';

import { useParams } from '@/lib/nav';
import { Suspense } from 'react';

import { InterviewDetail } from './_detail';
import { PageSkeleton, PageTabsProvider } from '@/components/ds';

function Detail() {
  const { id } = useParams<{ id: string }>();
  // qa-work-44: one way back, "← Interviews": the Requests tabs are not drawn under the interview's name.
  return (
    <PageTabsProvider tabs={null}>
      <InterviewDetail id={id} />
    </PageTabsProvider>
  );
}

/** A customer interview (C3): its approved questions, transcript, snapshot and requests. */
export default function InterviewPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Detail />
    </Suspense>
  );
}
