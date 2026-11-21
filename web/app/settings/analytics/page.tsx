'use client';

import { createFileRoute } from '@tanstack/react-router';
import { Suspense } from 'react';

import { AnalyticsSettings } from './AnalyticsSettings';
import { PageSkeleton } from '@/components/ds';

function AnalyticsPage() {
  return (
    <Suspense fallback={<PageSkeleton bare />}>
      <AnalyticsSettings />
    </Suspense>
  );
}

export const Route = createFileRoute('/settings/analytics/')({ component: AnalyticsPage });
