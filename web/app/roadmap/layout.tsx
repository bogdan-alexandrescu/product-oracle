import { Suspense, type ReactNode } from "react";

import { PageTabsProvider } from "@/components/ds";

import { PlanNav } from "../plan/_nav";

/**
 * fix4 qa-plan-16: Launches and Changelog are opened from the Plan's tab strip, so they keep
 * it (the Plan tab leads back; their own link is selected there), as every Plan tab does.
 */
export default function RoadmapLayout({ children }: { children: ReactNode }) {
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
