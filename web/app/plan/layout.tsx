import { Suspense, type ReactNode } from "react";

import { PageTabsProvider } from "@/components/ds";

import { PlanNav } from "./_nav";

/**
 * Every Plan tab: the page title, Plan's tab strip under it, then the tab's content.
 * qa-plan-25: the title line is 40 px on every tab (the height of a primary action), so
 * the strip sits at the same height whether a tab's action is a primary button, a small
 * button or a segmented control, and switching tabs does not move the page.
 */
export default function PlanLayout({ children }: { children: ReactNode }) {
  return (
    <PageTabsProvider
      tabs={
        <Suspense fallback={<div className="h-12" />}>
          <PlanNav />
        </Suspense>
      }
    >
      <div data-plan-tabs-page className="contents min-[601px]:[&_[data-page-header]>h1]:py-1">
        {children}
      </div>
    </PageTabsProvider>
  );
}
