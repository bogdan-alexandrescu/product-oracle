import { Outlet, createFileRoute } from '@tanstack/react-router';
import { Suspense } from 'react';

import { Page, PageTabsProvider } from '@/components/ds';

import { CompanyNav } from './_nav';

/** Every Company page: the page, its tabs under the title (Strategy, Decisions, Rituals, Updates, Metrics, Market). */
function CompanyLayout() {
  return (
    <Page>
      <PageTabsProvider
        tabs={
          <Suspense fallback={<div className="h-12" />}>
            <CompanyNav />
          </Suspense>
        }
      >
        <Outlet />
      </PageTabsProvider>
    </Page>
  );
}

export const Route = createFileRoute('/company')({ component: CompanyLayout });
