"use client";

import { createContext, useContext, type ReactNode } from "react";

const TabsContext = createContext<ReactNode>(null);

/**
 * A section's own tabs (Settings: Members, Connections, ...), given once by the section's
 * layout and drawn by every PageHeader inside it, under the title row (I3 rule 3: title
 * and status stay top-left).
 */
export function PageTabsProvider({ tabs, children }: { tabs: ReactNode; children: ReactNode }) {
  return <TabsContext.Provider value={tabs}>{children}</TabsContext.Provider>;
}

/** The tabs of the enclosing PageTabsProvider, if any, as the header's last line. */
export function PageTabs() {
  const tabs = useContext(TabsContext);
  if (!tabs) return null;
  return <div className="order-4 min-w-0 basis-full">{tabs}</div>;
}
