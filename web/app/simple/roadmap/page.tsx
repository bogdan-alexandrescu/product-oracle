'use client';

import { createFileRoute } from '@tanstack/react-router';
import { notFound } from '@/lib/nav';
import { Suspense } from 'react';

import { WithFeatureMarks } from '@/components/current-state/CurrentState';

import { SIMPLE_MODE } from '../_flag';
import { SimpleRoadmap } from './_roadmap';

/** Simple S4 (#723): the company-wide roadmap (direction "A · Wall"). */
function SimpleRoadmapPage() {
  if (!SIMPLE_MODE) notFound();
  return (
    <Suspense>
      <WithFeatureMarks>
        <SimpleRoadmap />
      </WithFeatureMarks>
    </Suspense>
  );
}

export const Route = createFileRoute('/simple/roadmap/')({ component: SimpleRoadmapPage });
