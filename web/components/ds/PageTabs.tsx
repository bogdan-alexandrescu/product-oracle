"use client";

import { usePathname } from "next/navigation";
import { createContext, useContext, type ReactNode } from "react";

const TabsContext = createContext<ReactNode>(null);
const SectionContext = createContext<string | null>(null);

/**
 * A section's own tabs (Settings: Members, Connections, ...), given once by the section's
 * layout and drawn by every PageHeader inside it, under the title row (I3 rule 3: title
 * and status stay top-left).
 */
export function PageTabsProvider({ tabs, section, children }: { tabs: ReactNode; section?: string; children: ReactNode }) {
  return (
    <TabsContext.Provider value={tabs}>
      <SectionContext.Provider value={section ?? null}>{children}</SectionContext.Provider>
    </TabsContext.Provider>
  );
}

/**
 * qa-shell-20: the section whose tabs these are ("Settings"), when its layout names it: every
 * PageHeader inside then heads the page with the section's name, as Plan's and Company's do;
 * the tab strip names the tab, and the browser tab both (AppShell's DocumentTitle).
 */
export function SectionTitle({ children }: { children: ReactNode }) {
  const section = useContext(SectionContext);
  // Only the section's own tabs (/settings/members); a page inside a tab (a template) keeps its title.
  const tab = /^\/[^/]+(\/[^/]+)?\/?$/.test(usePathname() ?? "");
  return <>{section && tab ? section : children}</>;
}

/** The tabs of the enclosing PageTabsProvider, if any, as the header's last line. */
export function PageTabs() {
  const tabs = useContext(TabsContext);
  if (!tabs) return null;
  return <div className="order-4 min-w-0 basis-full">{tabs}</div>;
}
