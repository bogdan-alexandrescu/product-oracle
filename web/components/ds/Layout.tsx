import type { ReactNode } from "react";

import { Icon, type IconName } from "./Icon";
import { PageInfo } from "./page-info";
import { PageTabs, SectionTitle } from "./PageTabs";

/**
 * The page under the shell's top bar. Every screen uses it, so the title, status and
 * primary action sit in the same place everywhere (I3 rule 3).
 */
export function Page({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`min-w-0 px-6 pb-6 max-[600px]:px-2.5 max-[600px]:pb-24 ${className}`}>{children}</div>;
}

/**
 * Title and status top-left, one primary action top-right.
 * `back` renders above the title as a small crumb link (a document's PRDs, a run's Runs).
 * `info`: the page's info tip, right after the title; on a phone, beside the phone header's title.
 * Inside a PageTabsProvider (Settings), the section's tabs follow as the last line.
 */
export function PageHeader({
  title,
  suffix,
  status,
  action,
  back,
  backInline = false,
  info,
  testId,
  phoneTitle = false,
  statusBelow = false,
}: {
  title: ReactNode;
  /** Right after the title, small: "v3". */
  suffix?: ReactNode;
  /** Status chips. */
  status?: ReactNode;
  /** The one primary action. */
  action?: ReactNode;
  back?: ReactNode;
  /**
   * `back` sits on the title row, before the title, instead of on a line of its own above it,
   * so the title stays where it is on the pages it leads back from (qa-plan-11).
   */
  backInline?: boolean;
  /** An InfoTip about the page (qa-shell-22). */
  info?: ReactNode;
  testId?: string;
  /** The H1 shows on a phone too, wrapping (a long document title the phone header cuts, qa-docs-68). */
  phoneTitle?: boolean;
  /**
   * Off a phone, the status chips take a line of their own under the title and the actions, so
   * the actions stay on the title's line however long the chips are (a run's page, qa-work-22).
   */
  statusBelow?: boolean;
}) {
  // One flat wrapping row. The status chips take their full width (flex-auto, not a 0 basis)
  // so they drop to a line of their own when the title and the actions leave no room for
  // them, instead of being squeezed until a chip's text wraps. On a phone the phone header
  // draws the title, so the H1 is kept for screen readers only, and the status chips and the
  // action share the line when the chips fit at their full width; otherwise the action drops
  // below them.
  return (
    <header
      data-testid={testId}
      data-page-header
      className="flex min-h-16 flex-wrap items-center gap-x-3 gap-y-2 py-3 max-[600px]:min-h-0 max-[600px]:py-3"
    >
      {back && (
        <div data-page-back className={`flex min-h-6 items-center text-sm text-text2 ${backInline ? "flex-none" : "basis-full"}`}>
          {back}
        </div>
      )}
      <h1
        className={`min-w-0 font-display text-[28px] leading-8 font-bold tracking-heading ${
          phoneTitle ? "break-words max-[600px]:text-[22px] max-[600px]:leading-7" : "max-[600px]:sr-only"
        }`}
      >
        {/* qa-shell-20: under a section's tabs the H1 is the section's name (SectionTitle). */}
        <SectionTitle>{title}</SectionTitle>
        {suffix && <span data-title-suffix className="ml-1.5 align-baseline font-display text-lg font-semibold tracking-normal text-text2">{suffix}</span>}
      </h1>
      {info && <PageInfo info={info} />}
      <div
        className={`flex min-w-0 flex-auto flex-wrap items-center gap-2 ${status ? "" : "max-[600px]:hidden"} ${
          statusBelow ? "min-[601px]:order-last min-[601px]:basis-full" : ""
        }`}
      >
        {status}
      </div>
      {action && <div className="ml-auto flex max-w-full flex-none flex-wrap items-center justify-end gap-2">{action}</div>}
      <PageTabs />
    </header>
  );
}

/**
 * Master and detail: the table left, the inspector right (below on a phone). `wide`: the
 * inspector goes below the table under about 1320 px rather than 1100 px, for a table that
 * needs the room beside the 44 px Ask strip (Plan's Item column at 1280 px). `byRoom`: the
 * inspector sits beside the table only while the Split itself is 920 px wide or more (a
 * container query), which is where it went beside before on a window over 1100 px with the
 * Ask panel closed; with the 400 px panel docked it goes below until the table has its room.
 */
export function Split({
  children,
  inspector,
  wide = false,
  byRoom = false,
}: {
  children: ReactNode;
  inspector?: ReactNode;
  wide?: boolean;
  byRoom?: boolean;
}) {
  if (!inspector) return <div className="flex min-w-0 flex-col gap-4">{children}</div>;
  const cols = byRoom
    ? "grid-cols-1 @min-[920px]:grid-cols-[minmax(0,1fr)_380px]"
    : `grid-cols-[minmax(0,1fr)_380px] max-[1100px]:grid-cols-1 ${wide ? "max-[1320px]:grid-cols-1" : ""}`;
  const sticky = byRoom ? "xl:@min-[920px]:sticky xl:@min-[920px]:top-4" : wide ? "min-[1321px]:sticky min-[1321px]:top-4" : "xl:sticky xl:top-4";
  const grid = (
    <div className={`grid items-start gap-4 max-[600px]:gap-3 ${cols}`}>
      <div className="flex min-w-0 flex-col gap-4 max-[600px]:gap-3">{children}</div>
      <div className={`min-w-0 ${sticky}`}>{inspector}</div>
    </div>
  );
  return byRoom ? <div className="@container min-w-0">{grid}</div> : grid;
}

/** A white panel with a hairline border; `title` adds B1's 48 px panel head. */
export function Panel({
  title,
  count,
  tools,
  children,
  className = "",
  testId,
  as: As = "section",
  bodyClassName = "",
  busy,
}: {
  title?: ReactNode;
  count?: ReactNode;
  /** Right side of the head: chips, filters, a secondary action. */
  tools?: ReactNode;
  children?: ReactNode;
  className?: string;
  testId?: string;
  as?: "section" | "div";
  bodyClassName?: string;
  /** aria-busy: what the panel draws may still change (its tools wait on the capabilities). */
  busy?: boolean;
}) {
  return (
    <As
      data-testid={testId}
      aria-label={typeof title === "string" ? title : undefined}
      aria-busy={busy}
      className={`min-w-0 rounded-panel border border-line bg-surface shadow-panel ${className}`}
    >
      {(title || tools) && (
        <div className="flex min-h-12 flex-wrap items-center gap-2.5 border-b border-line px-4 py-2">
          {title && <h2 className="font-display text-lg leading-6 font-bold tracking-heading">{title}</h2>}
          {count != null && (
            <span data-testid="panel-count" className="tnum font-display tracking-heading text-lg leading-6 font-bold text-accent-ink">
              {count}
            </span>
          )}
          <span className="flex-1" />
          {tools && <div className="flex flex-wrap items-center gap-2">{tools}</div>}
        </div>
      )}
      <div className={bodyClassName}>{children}</div>
    </As>
  );
}

/**
 * qa-shell-8: the one not-found (and failed-page) pattern: the page's title as its H1, an
 * icon, one sentence and the ways on (Back to PRDs, Go to Home) close under it. A wrong URL,
 * a missing document, version or run, and the error page all draw it.
 */
export function NotFoundPanel({
  title,
  icon = "search",
  testId,
  back,
  children,
  actions,
}: {
  title: string;
  icon?: IconName;
  testId?: string;
  back?: ReactNode;
  /** What happened, a sentence or two. */
  children: ReactNode;
  /** The ways on: links or buttons. */
  actions?: ReactNode;
}) {
  return (
    <Page>
      <PageHeader title={title} back={back} />
      <Panel testId={testId} bodyClassName="flex flex-col items-center gap-3 px-4 pt-10 pb-8 text-center">
        <span aria-hidden className="grid size-12 place-items-center rounded-full bg-accent-soft text-accent-ink">
          <Icon name={icon} size={24} />
        </span>
        <div data-testid="not-found-text" className="flex max-w-prose flex-col gap-1 text-[15px] text-text2">
          {children}
        </div>
        {actions && <div className="mt-1 flex flex-wrap justify-center gap-2">{actions}</div>}
      </Panel>
    </Page>
  );
}

/**
 * qa-shell-10: what a page draws while it loads, in its shapes: a title bar and two panels,
 * so it does not jump into place. `bare`: without the page's padding, inside a section's
 * layout (Settings, Company) that draws the page already.
 */
export function PageSkeleton({ bare = false }: { bare?: boolean }) {
  const shapes = (
    <div role="status" aria-label="Loading" aria-busy="true" data-testid="page-skeleton" className="flex flex-col gap-4">
      <div className="flex min-h-16 items-center py-3">
        <span className="block h-8 w-56 max-w-full animate-pulse rounded bg-surface2 max-[600px]:h-6" />
      </div>
      <span className="block h-40 animate-pulse rounded-panel border border-line bg-surface2" />
      <span className="block h-64 animate-pulse rounded-panel border border-line bg-surface2" />
    </div>
  );
  return bare ? shapes : <Page>{shapes}</Page>;
}

/** A small caps-like label ("Goal", "Sources"): 13 px, text2. */
export function Label({ children, className = "", id }: { children: ReactNode; className?: string; id?: string }) {
  return (
    <span id={id} className={`text-[13px] leading-4 font-semibold tracking-[0.02em] text-text2 ${className}`}>
      {children}
    </span>
  );
}

/** Empty state: the title of what will appear, nothing more (rule 1); `icon` draws it above. */
export function Empty({ children, testId, icon }: { children: ReactNode; testId?: string; icon?: IconName }) {
  if (icon) {
    return (
      <div data-testid={testId} className="flex flex-col items-center gap-3 px-4 py-12 text-center">
        <span aria-hidden className="grid size-12 place-items-center rounded-full bg-accent-soft text-accent-ink">
          <Icon name={icon} size={24} />
        </span>
        <p className="text-[15px] font-semibold text-text2">{children}</p>
      </div>
    );
  }
  return (
    <p data-testid={testId} className="px-4 py-8 text-center text-[15px] text-text2">
      {children}
    </p>
  );
}

/** Notices: an error, a warning, or a one-line result of an action; with `action`, the buttons sit at its end. */
export function Notice({
  tone = "info",
  action,
  testId,
  children,
}: {
  tone?: "info" | "error" | "pass" | "warn";
  action?: ReactNode;
  testId?: string;
  children: ReactNode;
}) {
  const cls =
    tone === "error"
      ? "bg-crit-bg text-crit"
      : tone === "pass"
        ? "bg-pass-bg text-pass"
        : tone === "warn"
          ? "bg-warn-bg text-warn"
          : "bg-accent-soft text-accent-ink";
  const role = tone === "error" ? "alert" : "status";
  if (action) {
    return (
      <div
        role={role}
        data-testid={testId}
        className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-button px-3 py-2 text-sm font-medium ${cls}`}
      >
        <span className="min-w-0 flex-1">{children}</span>
        <span className="inline-flex flex-wrap gap-1.5">{action}</span>
      </div>
    );
  }
  return (
    <p role={role} data-testid={testId} className={`rounded-button px-3 py-2 text-sm font-medium ${cls}`}>
      {children}
    </p>
  );
}
