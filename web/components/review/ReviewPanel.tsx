"use client";

import { useId, useState, type ComponentProps, type ReactNode } from "react";

import { ResolutionPanel, type GoTo } from "@/components/FeedbackPanel";
import { JobsPanel } from "@/components/JobsPanel";
import { ReportsPanel } from "@/components/ReportsPanel";
import { Icon, Inspector, InspectorRow, Label } from "@/components/ds";
import { FeedbackList } from "@/components/review/FeedbackList";
import { TabBar } from "@/components/review/parts";
import { ErrorNote, Loading, SpecStateBadge } from "@/components/ui";
import type { CitationOut, VersionOut } from "@/lib/api/client";
import { citationHref, formatDateTime, SOURCE_LABEL } from "@/lib/format";

export type PanelTab = "feedback" | "sources" | "history";

type FeedbackProps = Omit<ComponentProps<typeof FeedbackList>, "entries"> & {
  entries: ComponentProps<typeof FeedbackList>["entries"] | null;
  error: string | null;
};

/**
 * The review panel (I3 PRD navigation, 2026-10-20): Reviewed / Locked / Open feedback in
 * the head, then three tabs. Feedback: comments, suggestions and reviews in one list.
 * Sources: the version's sources. History: Resolutions, Reports and Jobs, each folding.
 * `variant="side"`: sticky beside the section, capped at the viewport and scrolling inside,
 * so a tall card's foot is always reachable; "sheet": the phone's Review sheet.
 */
export function ReviewPanel({
  version,
  doc,
  n,
  stats,
  tab,
  setTab,
  feedback,
  openFeedback,
  refreshKey,
  shortcuts,
  variant,
  goTo,
}: {
  version: VersionOut | undefined;
  doc: string;
  n: number;
  stats: { reviewed: number; total: number; locked: number; lockedLabel?: string; openFeedback: number | null };
  tab: PanelTab;
  setTab: (t: PanelTab) => void;
  feedback: FeedbackProps;
  /** The Feedback tab's count: open feedback (the one definition, lib/feedback.ts). */
  openFeedback: number | null;
  refreshKey: number;
  shortcuts?: ReactNode;
  variant: "side" | "sheet";
  /** Section links in History open here. */
  goTo?: GoTo;
}) {
  const uid = useId();
  const idFor = (t: PanelTab) => `${uid}-${t}`;
  const tabs: { id: PanelTab; label: string; count?: number | null }[] = [
    { id: "feedback", label: "Feedback", count: openFeedback },
    { id: "sources", label: "Sources", count: version ? version.citations.length : null },
    { id: "history", label: "History" },
  ];
  const { entries, error, ...list } = feedback;
  return (
    <Inspector
      label="Review panel"
      testId={variant === "side" ? "review-panel" : "review-panel-sheet"}
      eyebrow={`Review · v${n}`}
      action={shortcuts}
      className={
        variant === "side"
          ? "min-[1101px]:flex min-[1101px]:min-h-0 min-[1101px]:flex-col"
          : "rounded-none border-0 shadow-none max-[600px]:rounded-none"
      }
      head={
        version && (
          <dl className="mt-2.5 flex flex-wrap gap-x-7 gap-y-2">
            {(
              [
                ["Reviewed", `${stats.reviewed}/${stats.total}`, "stat-reviewed"],
                [stats.lockedLabel ?? "Locked", stats.locked, "stat-locked"],
                ["Open feedback", stats.openFeedback ?? "–", "stat-open-feedback"],
              ] as const
            ).map(([label, value, testId]) => (
              <div key={label} data-testid={testId} className="flex flex-col-reverse">
                <dt className="text-[13px] leading-4 font-semibold tracking-[0.02em] text-hero-text2">{label}</dt>
                <dd className="tnum font-display text-[34px] leading-10 font-bold tracking-[-0.03em]">{value}</dd>
              </div>
            ))}
          </dl>
        )
      }
    >
      <div className={`flex-none px-5 pt-1 max-[600px]:px-4 ${variant === "sheet" ? "sticky top-0 z-[1] bg-surface" : ""}`}>
        <TabBar label="Review panel" size="sm" tabs={tabs} value={tab} onChange={setTab} idFor={idFor} />
      </div>
      <div
        role="tabpanel"
        id={`${idFor(tab)}-panel`}
        aria-labelledby={idFor(tab)}
        data-testid="review-tabpanel"
        className={`relative min-w-0 px-5 py-3.5 max-[600px]:px-4 ${
          variant === "side" ? "min-[1101px]:min-h-0 min-[1101px]:flex-1 min-[1101px]:overflow-y-auto min-[1101px]:overscroll-contain" : ""
        }`}
      >
        {tab === "feedback" &&
          (error ? <ErrorNote>{error}</ErrorNote> : !entries ? <Loading /> : <FeedbackList entries={entries} {...list} />)}
        {tab === "sources" && version && <SourcesTab version={version} />}
        {tab === "history" && <HistoryTab doc={doc} n={n} refreshKey={refreshKey} goTo={goTo} />}
      </div>
    </Inspector>
  );
}

/** E1 (owner, 2026-10-20): sources an edit added to a spec are listed apart from Oracle's. */
const ADDED_SOURCE_LABEL = "Proposed · added in an edit";

function sourceRow(c: CitationOut, number: number) {
  const href = citationHref(c);
  return (
    <li key={c.id} className="flex min-h-8 min-w-0 items-center gap-2.5 text-sm max-[639px]:min-h-11">
      <span className="tnum w-5 flex-none text-right font-semibold text-text2">{number}</span>
      <span className="flex-none text-[13px] font-semibold text-text2">{SOURCE_LABEL[c.source]}</span>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          title={c.title ?? c.ref}
          className="min-w-0 truncate font-medium text-text underline-offset-2 hover:underline"
        >
          {c.title ?? c.ref}
        </a>
      ) : (
        // A baseline item named in free text (source oracle): its ref on hover, no link.
        <span title={c.ref} className="min-w-0 truncate font-medium text-text">
          {c.title ?? c.ref}
        </span>
      )}
    </li>
  );
}

function SourcesTab({ version }: { version: VersionOut }) {
  const id = useId();
  // Numbered as the document numbers them: Oracle's sources first, then the added ones.
  const oracle = version.citations.filter((c) => !c.added);
  const added = version.citations.filter((c) => c.added);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col text-sm" data-testid="version-info">
        <InspectorRow value={<span className="text-sm font-medium">{formatDateTime(version.created_at)}</span>}>Imported</InspectorRow>
        {version.snapshot && (
          <InspectorRow
            value={
              // A timestamp reads like every other date; anything else (a snapshot label) stays as given.
              Number.isNaN(Date.parse(version.snapshot)) ? (
                <span className="font-mono text-[13px] font-medium">{version.snapshot}</span>
              ) : (
                <span className="text-sm font-medium" title={version.snapshot}>
                  {formatDateTime(version.snapshot)}
                </span>
              )
            }
          >
            Sources as of
          </InspectorRow>
        )}
      </div>
      {version.citations.length === 0 ? (
        <p className="text-sm text-text2">No sources cited</p>
      ) : (
        <>
          {oracle.length > 0 && (
            <section className="flex flex-col gap-1" aria-labelledby={added.length ? `${id}-oracle` : undefined}>
              {added.length > 0 && (
                <Label id={`${id}-oracle`} className="py-1">
                  Sources
                </Label>
              )}
              <ol className="flex flex-col" aria-label="Sources" data-testid="sources-list">
                {oracle.map((c, i) => sourceRow(c, i + 1))}
              </ol>
            </section>
          )}
          {added.length > 0 && (
            <section
              className="flex flex-col gap-2 border-t border-line pt-3"
              aria-labelledby={`${id}-added`}
              data-testid="added-sources"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Label id={`${id}-added`}>Added sources</Label>
                <SpecStateBadge state={{ label: added[0].state_label ?? ADDED_SOURCE_LABEL, decided: false, added: true }} />
              </div>
              <ol className="flex flex-col" aria-label="Added sources">
                {added.map((c, i) => sourceRow(c, oracle.length + i + 1))}
              </ol>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function HistoryTab({ doc, n, refreshKey, goTo }: { doc: string; n: number; refreshKey: number; goTo?: GoTo }) {
  // ?tab=reports (where applying a next draft lands, C1e): Reports opens on What changed.
  const [landed] = useState(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("tab") === "reports");
  return (
    <div className="flex flex-col" data-testid="history">
      <Fold title="Resolutions" testId="history-resolutions">
        <ResolutionPanel doc={doc} n={n} refreshKey={refreshKey} goTo={goTo} />
      </Fold>
      <Fold title="Reports" testId="history-reports">
        <ReportsPanel doc={doc} n={n} refreshKey={refreshKey} initialTab={landed ? "changes" : "resolution"} />
      </Fold>
      <Fold title="Jobs" testId="history-jobs">
        <JobsPanel doc={doc} version={n} refreshKey={refreshKey} />
      </Fold>
    </div>
  );
}

/** A headed part of History that folds. */
function Fold({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  const id = useId();
  return (
    <section aria-labelledby={`${id}-h`} data-testid={testId} className="border-b border-line py-2 last:border-b-0">
      <h3 id={`${id}-h`}>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${id}-b`}
          onClick={() => setOpen((o) => !o)}
          className="flex min-h-9 w-full items-center gap-1.5 text-left font-display text-[15px] font-bold tracking-heading text-text max-[639px]:min-h-11"
        >
          <Icon name={open ? "chevron-down" : "chevron-right"} size={16} className="text-text2" />
          {title}
        </button>
      </h3>
      <div id={`${id}-b`} hidden={!open} className="pt-1 pb-2">
        {children}
      </div>
    </section>
  );
}
