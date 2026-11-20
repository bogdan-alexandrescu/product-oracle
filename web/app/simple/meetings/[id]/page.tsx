'use client';

import { notFound, useParams } from '@/lib/nav';
import { Suspense } from 'react';

import { SIMPLE_MODE } from '@/lib/simple-mode';

import { MeetingScreen } from './_meeting';
import { PageSkeleton } from '@/components/ds';

function Body() {
  const { id } = useParams<{ id: string }>();
  return <MeetingScreen id={id} />;
}

/** Simple S8 (#723): one review meeting, full screen; once ended, its minutes. */
export default function SimpleMeeting() {
  if (!SIMPLE_MODE) notFound();
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Body />
    </Suspense>
  );
}
