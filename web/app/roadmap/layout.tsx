import { Outlet, createFileRoute } from '@tanstack/react-router';
import { Suspense } from 'react';

import { PageTabsProvider } from '@/components/ds';

import { PlanNav } from '../plan/_nav';

/**
 * fix4 qa-plan-16: Launches and Changelog are opened from the Plan's tab strip, so they keep
 * it (the Plan tab leads back; their own link is selected there), as every Plan tab does.
 */
function RoadmapLayout() {
  return (
    <PageTabsProvider
      tabs={
        <Suspense fallback={<div className="h-12" />}>
          <PlanNav />
        </Suspense>
      }
    >
      {/* qa-plan-25: the Plan tabs' title line, so the strip does not move between them. */}
      <div data-plan-tabs-page className="contents min-[601px]:[&_[data-page-header]>h1]:py-1">
        <Outlet />
      </div>
    </PageTabsProvider>
  );
}

export const Route = createFileRoute('/roadmap')({ component: RoadmapLayout });
