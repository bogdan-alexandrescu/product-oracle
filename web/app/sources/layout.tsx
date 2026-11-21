import { Outlet, createFileRoute } from '@tanstack/react-router';
import { Suspense } from 'react';

import { PageTabsProvider } from '@/components/ds';

import { SettingsNav } from '../settings/_nav';

/** Evidence search lives under Settings › Sources: the rail shows Settings, the tabs Sources. */
function SourcesLayout() {
  return (
    <PageTabsProvider
      tabs={
        <Suspense fallback={<div className="h-12" />}>
          <SettingsNav />
        </Suspense>
      }
    >
      <Outlet />
    </PageTabsProvider>
  );
}

export const Route = createFileRoute('/sources')({ component: SourcesLayout });
