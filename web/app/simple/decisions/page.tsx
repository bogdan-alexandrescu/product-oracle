'use client';

import { createFileRoute } from '@tanstack/react-router';
import { notFound } from '@/lib/nav';
import { Suspense } from 'react';

import { SIMPLE_MODE } from '@/lib/simple-mode';

import { SimpleDecisions } from './_decisions';
import { PageSkeleton } from '@/components/ds';

/** Simple S8 (#723): Decisions, direction B "By meeting". */
function SimpleDecisionsPage() {
  if (!SIMPLE_MODE) notFound();
  return (
    <Suspense fallback={<PageSkeleton />}>
      <SimpleDecisions />
    </Suspense>
  );
}

export const Route = createFileRoute('/simple/decisions/')({ component: SimpleDecisionsPage });
