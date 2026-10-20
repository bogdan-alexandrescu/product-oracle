import { Suspense, type ReactNode } from "react";

import { Page, PageTabsProvider } from "@/components/ds";

import { SettingsNav } from "./_nav";

/** Every settings page: the page (title, Settings tabs under it, table, inspector). */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <Page>
      <PageTabsProvider
        tabs={
          <Suspense fallback={<div className="h-12" />}>
            <SettingsNav />
          </Suspense>
        }
      >
        {children}
      </PageTabsProvider>
    </Page>
  );
}
