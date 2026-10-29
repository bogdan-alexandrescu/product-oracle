import { Suspense, type ReactNode } from "react";

import { PageTabsProvider } from "@/components/ds";

import { SettingsNav } from "../settings/_nav";

/** Evidence search lives under Settings › Sources: the rail shows Settings, the tabs Sources. */
export default function SourcesLayout({ children }: { children: ReactNode }) {
  return (
    <PageTabsProvider
      section="Settings"
      tabs={
        <Suspense fallback={<div className="h-12" />}>
          <SettingsNav />
        </Suspense>
      }
    >
      {children}
    </PageTabsProvider>
  );
}
