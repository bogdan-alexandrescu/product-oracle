"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cloneElement, isValidElement, Suspense, type ReactElement, type ReactNode } from "react";

import { InfoTip, PageHeader, PageTabsProvider, ScrollStrip } from "@/components/ds";
import { usePhone } from "@/components/ds/page-info";
import { useMe } from "@/lib/me";

import { COMPANY_TABS, type CompanyTab } from "./_tabs";

/** The tabs the signed-in member may see, in registry order. */
export function visibleTabs(can: ReturnType<typeof useMe>["can"]): CompanyTab[] {
  return COMPANY_TABS.filter((t) => !t.read || can(t.read, true));
}

/**
 * Company's tabs: a strip under the page title (PageHeader draws it, see the layout). On a
 * phone the tabs scroll sideways inside their strip; the page never does.
 */
export function CompanyNav() {
  const pathname = usePathname();
  const { can } = useMe();
  return (
    <nav aria-label="Company" data-testid="company-nav" className="rounded-panel border border-line bg-surface px-2 py-1.5 shadow-panel">
      {/* qa-company-33: the strip's edge stops at the last whole tab: no 12 px fade over the
          current tab when it ends at the edge, and no sliver of the next tab beside the
          chevron (the chevrons say there is more). */}
      <ScrollStrip
        itemsName="tabs"
        className="min-h-9"
        stripClassName="items-center gap-1 [--fade-l0:var(--cut-l,0px)]! [--fade-l1:var(--cut-l,0px)]! [--fade-r0:var(--cut-r,0px)]! [--fade-r1:var(--cut-r,0px)]!"
      >
        {visibleTabs(can).map((t) => {
          const on = pathname === t.href || pathname.startsWith(`${t.href}/`);
          return (
            <Link
              key={t.key}
              href={t.href}
              data-testid={t.testId}
              aria-current={on ? "page" : undefined}
              className={`flex h-8 flex-none items-center rounded-lg px-3 text-[15px] font-medium whitespace-nowrap ${
                on ? "bg-accent text-on-accent" : "text-text hover:bg-surface2"
              }`}
            >
              {t.label}
            </Link>
          );
        })}
      </ScrollStrip>
    </nav>
  );
}

/** The one (i) beside "Company", the same on every tab (qa-company-33). */
const COMPANY_INFO = (
  <InfoTip label="Company" align="start" side="bottom">
    What the whole company works from: the vision and product strategy, the decision log, the rituals and their pre-reads, the board and
    investor updates, the weekly metrics and the market.
  </InfoTip>
);

/** The primary button's own words, for its name and tooltip when it shows as an icon only. */
function compact(action: ReactNode): ReactNode {
  if (!isValidElement(action)) return action;
  const el = action as ReactElement<{ children?: ReactNode; title?: string; "aria-label"?: string }>;
  const words = typeof el.props.children === "string" ? el.props.children : undefined;
  return words ? cloneElement(el, { title: words, "aria-label": words }) : el;
}

/**
 * Every Company tab's header: the title "Company" with the same (i), status chips, and the
 * tab's one primary action. The title row is as tall as the primary button whether or not
 * the tab has one, so the tab strip under it never moves between tabs (qa-company-33). On
 * a phone the action sits at the end of the tab strip's row as a compact "+" button, not
 * on a row of its own above the tabs (qa-company-34).
 */
export function CompanyHeader({ status, action, testId }: { status?: ReactNode; action?: ReactNode; testId?: string }) {
  const phone = usePhone();
  const title = <span className="inline-flex min-h-10 items-center">Company</span>;
  if (!phone || !action) return <PageHeader title={title} info={COMPANY_INFO} status={status} action={action} testId={testId} />;
  return (
    <PageTabsProvider
      tabs={
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 flex-1">
            <Suspense fallback={<div className="h-12" />}>
              <CompanyNav />
            </Suspense>
          </div>
          <div
            data-testid="company-action"
            className="flex flex-none [&>button]:h-11 [&>button]:w-11 [&>button]:gap-0 [&>button]:px-0 [&>button]:text-[0px]"
          >
            {compact(action)}
          </div>
        </div>
      }
    >
      <PageHeader title={title} info={COMPANY_INFO} status={status} testId={testId} />
    </PageTabsProvider>
  );
}
