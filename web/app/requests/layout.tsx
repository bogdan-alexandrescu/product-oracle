import { Suspense, type ReactNode } from "react";

import { PageTabsProvider } from "@/components/ds";

import { RequestsNav } from "./_nav";

/**
 * Every Requests page: its tabs (All requests, To decide, Themes, Interviews). PageHeader draws
 * them under the title row; on a phone they come first, at the top of every Requests page
 * (qa-shell-33), whatever the page's header holds.
 */
export default function RequestsLayout({ children }: { children: ReactNode }) {
  return (
    <PageTabsProvider tabs={<RequestsNav where="header" />}>
      <div className="hidden px-2.5 pt-3 max-[600px]:block">
        <Suspense fallback={null}>
          <RequestsNav where="top" />
        </Suspense>
      </div>
      {children}
    </PageTabsProvider>
  );
}
