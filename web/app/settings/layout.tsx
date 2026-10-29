import { Suspense, type ReactNode } from "react";

import { Page, PageTabsProvider } from "@/components/ds";

import { SettingsGate } from "./_gate";
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
        <Suspense fallback={<div className="h-12" />}>
          <SettingsGate>{children}</SettingsGate>
        </Suspense>
      </PageTabsProvider>
    </Page>
  );
}
