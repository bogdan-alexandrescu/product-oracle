'use client';

import { createFileRoute } from '@tanstack/react-router';
import { notFound } from '@/lib/nav';
import { Suspense } from 'react';

import { SIMPLE_MODE } from '../_flag';
import { GoalMapPage } from './_map';

/** Simple › Goal map (build-goal-map): goals, the guardrail and areas by milestone ("Ladder by area lanes"). */
function SimpleGoalMapPage() {
  if (!SIMPLE_MODE) notFound();
  return (
    <Suspense>
      <GoalMapPage />
    </Suspense>
  );
}

export const Route = createFileRoute('/simple/goals/')({ component: SimpleGoalMapPage });
