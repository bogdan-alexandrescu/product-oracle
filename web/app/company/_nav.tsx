"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cloneElement, isValidElement, Suspense, type ReactElement, type ReactNode } from "react";

import { Chip, InfoTip, PageHeader, PageTabsProvider, ScrollStrip, ViewOnly } from "@/components/ds";
import { useMe } from "@/lib/me";

import { COMPANY_TABS, type CompanyTab } from "./_tabs";

/** The tabs the signed-in member may see, in registry order. */
export function visibleTabs(can: ReturnType<typeof useMe>["can"]): CompanyTab[] {
  return COMPANY_TABS.filter((t) => !t.read || can(t.read, true));
}

/** The Company tab the page is in (Rituals for one ritual's occurrence too). */
function useCurrentTab(): CompanyTab | undefined {
  const pathname = usePathname();
  return COMPANY_TABS.find((t) => pathname === t.href || pathname.startsWith(`${t.href}/`));
}

/**
 * Company's tabs: a strip under the page title (PageHeader draws it, see the layout). On a
 * wider window the tabs scroll sideways inside their strip; on a phone they wrap onto a
 * second line, so every tab shows (qa-company-44), with the tab's add button, labelled, at
 * the end of the last line. Both by CSS, so the first paint is already the phone's and
 * nothing under the strip moves once the page has loaded (qa-company-34).
 */
export function CompanyNav({ action }: { action?: ReactNode }) {
  const pathname = usePathname();
  const { can } = useMe();
  return (
    <nav aria-label="Company" data-testid="company-nav" className="rounded-panel border border-line bg-surface px-2 py-1.5 shadow-panel">
      {/* qa-company-33: the strip's edge stops at the last whole tab: no 12 px fade over the
          current tab when it ends at the edge, and no sliver of the next tab beside the
          chevron (the chevrons say there is more). */}
      <ScrollStrip
        data-wrap="phone"
        itemsName="tabs"
        className="min-h-9"
        stripClassName="items-center gap-1 max-[600px]:flex-wrap [--fade-l0:var(--cut-l,0px)]! [--fade-l1:var(--cut-l,0px)]! [--fade-r0:var(--cut-r,0px)]! [--fade-r1:var(--cut-r,0px)]!"
      >
        {visibleTabs(can).map((t) => {
          const on = pathname === t.href || pathname.startsWith(`${t.href}/`);
          return (
            <Link
              key={t.key}
              href={t.href}
              data-testid={t.testId}
              aria-current={on ? "page" : undefined}
              className={`flex h-8 flex-none items-center rounded-lg px-3 text-[15px] font-medium whitespace-nowrap max-[600px]:px-2.5 ${
                on ? "bg-accent text-on-accent" : "text-text hover:bg-surface2"
              }`}
            >
              {t.label}
            </Link>
          );
        })}
        {action && (
          <div data-testid="company-action" className="ml-auto hidden flex-none max-[600px]:flex [&>button]:h-8 [&>button]:px-3">
            {action}
          </div>
        )}
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

/**
 * The primary button on a phone (qa-company-44): its words without the verb, beside the
 * plus ("+ Ritual" for "Add ritual", "+ Decision" for "Propose decision"); its name and
 * tooltip keep the whole words.
 */
function compact(action: ReactNode): ReactNode {
  if (!isValidElement(action)) return action;
  const el = action as ReactElement<{ children?: ReactNode; title?: string; "aria-label"?: string }>;
  const words = typeof el.props.children === "string" ? el.props.children : undefined;
  if (!words) return el;
  const rest = words.split(" ").slice(1).join(" ");
  const short = rest ? rest[0].toUpperCase() + rest.slice(1) : words;
  return cloneElement(el, { title: words, "aria-label": words, children: short });
}

/**
 * qa-company-45: a View only names its tab ("View only: Strategy"), so a member does not read
 * the whole of Company as read-only when one tab is.
 */
function tabStatus(status: ReactNode, tab: CompanyTab | undefined): ReactNode {
  if (!tab || !isValidElement(status) || status.type !== ViewOnly) return status;
  return (
    <Chip kind="na" data-testid="view-only">
      View only: {tab.label}
    </Chip>
  );
}

/**
 * Every Company tab's header: the title "Company" with the same (i), status chips, and the
 * tab's one primary action. The title row is as tall as the primary button whether or not
 * the tab has one, so the tab strip under it never moves between tabs (qa-company-33). On
 * a phone the action sits at the end of the tab strip, labelled in short ("+ Ritual"), not
 * on a row of its own above the tabs (qa-company-34, -44). Which of the two shows is CSS's
 * choice, not a phone check after loading, so the page never shifts once drawn.
 */
export function CompanyHeader({ status, action, testId }: { status?: ReactNode; action?: ReactNode; testId?: string }) {
  const tab = useCurrentTab();
  const title = <span className="inline-flex min-h-10 items-center">Company</span>;
  const shown = tabStatus(status, tab);
  if (!action) return <PageHeader title={title} info={COMPANY_INFO} status={shown} testId={testId} />;
  return (
    <PageTabsProvider
      tabs={
        <Suspense fallback={<div className="h-12" />}>
          <CompanyNav action={compact(action)} />
        </Suspense>
      }
    >
      <PageHeader title={title} info={COMPANY_INFO} status={shown} action={<div className="contents max-[600px]:hidden">{action}</div>} testId={testId} />
    </PageTabsProvider>
  );
}
