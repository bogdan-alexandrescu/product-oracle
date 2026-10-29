import { Suspense, type ReactNode } from "react";

import { PageTabsProvider } from "@/components/ds";

import { RequestsStateProvider } from "./_components/RequestsState";
import { RequestsNav } from "./_nav";

/**
 * Every Requests page: its tabs (All requests, To decide, Themes, Interviews). PageHeader draws
 * them under the title row; on a phone they come first, at the top of every Requests page
 * (qa-shell-33), whatever the page's header holds. The tabs share their filters, ticked
 * requests, selection and themes (RequestsStateProvider), so moving between them keeps them.
 */
export default function RequestsLayout({ children }: { children: ReactNode }) {
  // The shared state reads the session's queries, so it renders on the client only.
  return (
    <Suspense fallback={null}>
      <RequestsStateProvider>
        <PageTabsProvider tabs={<RequestsNav where="header" />}>
          <div className="hidden px-2.5 pt-3 max-[600px]:block">
            <Suspense fallback={null}>
              <RequestsNav where="top" />
            </Suspense>
          </div>
          {children}
        </PageTabsProvider>
      </RequestsStateProvider>
    </Suspense>
  );
}
