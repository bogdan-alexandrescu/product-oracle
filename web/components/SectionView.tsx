"use client";

import { memo, useMemo } from "react";

import { AddEvidenceLink } from "@/components/AddEvidenceLink";

import { MarkdownBody, type ExpandCtx, type Highlight } from "@/components/MarkdownBody";
import { RefineSection } from "@/components/RefineSection";
import { SectionReviewBar } from "@/components/SectionReviewBar";
import { LayerBadge, LockIcon } from "@/components/ui";
import type { CitationOut, EntityOut, SectionOut, Verdict } from "@/lib/api/client";
import type { Block } from "@/lib/markdown";

const HEADING_CLASS: Record<number, string> = {
  1: "text-2xl font-semibold tracking-tight",
  2: "text-xl font-semibold tracking-tight",
  3: "text-base font-semibold",
};

export const SectionView = memo(function SectionView({
  section,
  blocks,
  citations,
  highlights,
  activeCommentId,
  readOnly,
  changedLock,
  evidenceTargets,
  refine,
  onHighlightClick,
  onVerdict,
  expand,
  nested = false,
  showLayer = true,
}: {
  section: SectionOut;
  blocks: Block[];
  citations: Map<string, { citation: CitationOut; number: number }>;
  highlights: Highlight[];
  activeCommentId: string | null;
  readOnly: boolean;
  changedLock: boolean;
  /** Baseline items a commenter may cite a public link on; undefined hides the control. */
  evidenceTargets?: EntityOut[];
  /** Set for approvers on the latest version: offers "Refine section" (never on locked ones). */
  refine?: { doc: string; n: number };
  onHighlightClick: (id: string) => void;
  onVerdict: (key: string, verdict: Verdict, note: string) => Promise<void>;
  /** Brief view: Expand controls on links to detail sections (O1f). */
  expand?: ExpandCtx;
  /** A detail section shown in place inside a brief section. */
  nested?: boolean;
  /** Label the section Brief or Detail (versions that have a brief layer). */
  showLayer?: boolean;
}) {
  const Heading = (`h${Math.min(section.level, 3)}` as "h1" | "h2" | "h3");
  const locked = section.verdict?.verdict === "approved";
  // Preselect the baseline item the section names (heading first, then its text).
  const suggested = useMemo(() => {
    if (!evidenceTargets) return null;
    const named = (text: string) =>
      evidenceTargets.find((e) => e.status !== "rejected" && text.toLowerCase().includes(e.title.toLowerCase()));
    return (named(section.heading) ?? named(section.body_text))?.id ?? null;
  }, [evidenceTargets, section.heading, section.body_text]);
  return (
    <section
      id={`s-${section.section_key}`}
      data-section-key={section.section_key}
      tabIndex={-1}
      aria-labelledby={`h-${section.section_key}`}
      data-layer={section.layer}
      className={`scroll-mt-24 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-neutral-300 ${
        nested ? "py-3" : "py-5"
      } ${section.level >= 3 && !nested ? "pl-4" : ""}`}
    >
      <div className="mb-2 flex items-baseline gap-2">
        <Heading
          id={`h-${section.section_key}`}
          className={`${nested ? HEADING_CLASS[3] : HEADING_CLASS[Math.min(section.level, 3)]} text-neutral-900`}
        >
          {section.heading}
        </Heading>
        <LayerBadge layer={showLayer ? section.layer : null} />
        {locked && (
          <span className="text-neutral-500" title="Locked: approved sections are reported as locked to the agent track">
            <LockIcon className="h-4 w-4" />
            <span className="sr-only">Locked</span>
          </span>
        )}
        <span className="ml-auto font-mono text-[11px] text-neutral-400">#{section.section_key}</span>
      </div>
      {changedLock && (
        <p className="mb-2 text-xs text-amber-800">This section was approved in the previous version and has changed.</p>
      )}
      <div className="doc-body" data-section-body={section.section_key}>
        <MarkdownBody
          blocks={blocks}
          highlights={highlights}
          activeId={activeCommentId}
          citations={citations}
          onHighlightClick={onHighlightClick}
          expand={expand}
        />
      </div>
      {evidenceTargets && (
        <div className="mt-3" data-testid="section-evidence">
          <AddEvidenceLink
            key={suggested ?? ""}
            entities={evidenceTargets}
            suggested={suggested}
            context={section.heading}
            quiet
          />
        </div>
      )}
      <SectionReviewBar
        heading={section.heading}
        verdict={section.verdict}
        readOnly={readOnly}
        onSubmit={(v, note) => onVerdict(section.section_key, v, note)}
      />
      {refine && !locked && (
        <div className="mt-2">
          <RefineSection doc={refine.doc} n={refine.n} sectionKey={section.section_key} heading={section.heading} />
        </div>
      )}
    </section>
  );
});
