import { Suspense, type ReactNode } from "react";

import { Page, PageTabsProvider } from "@/components/ds";

import { CompanyNav } from "./_nav";

/** Every Company page: the page, its tabs under the title (Strategy, Decisions, Rituals, Updates, Metrics, Market). */
export default function CompanyLayout({ children }: { children: ReactNode }) {
  return (
    <Page>
      <PageTabsProvider
        tabs={
          <Suspense fallback={<div className="h-12" />}>
            <CompanyNav />
          </Suspense>
        }
      >
        {children}
      </PageTabsProvider>
    </Page>
  );
}
