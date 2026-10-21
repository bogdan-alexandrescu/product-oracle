import { Suspense, type ReactNode } from "react";

import { PageTabsProvider } from "@/components/ds";

import { PlanNav } from "./_nav";

/** Every Plan tab: the page title, Plan's tab strip under it, then the tab's content. */
export default function PlanLayout({ children }: { children: ReactNode }) {
  return (
    <PageTabsProvider
      tabs={
        <Suspense fallback={<div className="h-12" />}>
          <PlanNav />
        </Suspense>
      }
    >
      {children}
    </PageTabsProvider>
  );
}
