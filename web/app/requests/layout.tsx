import type { ReactNode } from "react";

import { PageTabsProvider } from "@/components/ds";

import { RequestsNav } from "./_nav";

/** Every Requests page: its tabs (Requests, New, Interviews) under the page title. */
export default function RequestsLayout({ children }: { children: ReactNode }) {
  return <PageTabsProvider tabs={<RequestsNav />}>{children}</PageTabsProvider>;
}
