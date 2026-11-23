'use client';

import { createFileRoute } from '@tanstack/react-router';
import { notFound, useSearchParams } from '@/lib/nav'; // MOCK-HOOK (useSearchParams)
import { Suspense } from 'react';

import { WithFeatureMarks } from '@/components/current-state/CurrentState';

import { SIMPLE_MODE } from '../_flag';
import { SimpleRoadmap } from './_roadmap';
import { ReMock } from './_re-mock'; // MOCK-HOOK

/** Simple S4 (#723): the company-wide roadmap (direction "A · Wall"). */
function SimpleRoadmapPage() {
  if (!SIMPLE_MODE) notFound();
  const mk = useSearchParams(); // MOCK-HOOK
  if (mk.get('re1') || mk.get('re2') || mk.get('re3')) return <ReMock />; // MOCK-HOOK
  return (
    <Suspense>
      <WithFeatureMarks>
        <SimpleRoadmap />
      </WithFeatureMarks>
    </Suspense>
  );
}

export const Route = createFileRoute('/simple/roadmap/')({ component: SimpleRoadmapPage });
