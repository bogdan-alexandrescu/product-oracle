"use client";

import { memo, useMemo } from "react";

import { AddEvidenceLink } from "@/components/AddEvidenceLink";
import { Chip } from "@/components/ds";
import { MarkdownBody, type ExpandCtx, type Highlight } from "@/components/MarkdownBody";
import { RefineSection } from "@/components/RefineSection";
import { SectionReviewBar } from "@/components/SectionReviewBar";
import { LayerChip, LockedChip } from "@/components/review/parts";
import type { CitationOut, EntityOut, SectionOut, Verdict } from "@/lib/api/client";
import type { Block } from "@/lib/markdown";

const HEADING_CLASS: Record<number, string> = {
  1: "font-display text-[26px] leading-8 font-bold tracking-[-0.02em] max-[600px]:text-[22px] max-[600px]:leading-7",
  2: "font-display text-xl leading-7 font-bold tracking-[-0.01em]",
  3: "font-display text-lg leading-6 font-bold",
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
      className={`min-w-0 scroll-mt-6 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
        nested ? "py-3" : "px-6 py-5 max-[600px]:px-4"
      } ${section.level >= 3 && !nested ? "pl-10 max-[600px]:pl-6" : ""}`}
    >
      <div className="mb-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Heading
          id={`h-${section.section_key}`}
          className={`min-w-0 ${nested ? HEADING_CLASS[3] : HEADING_CLASS[Math.min(section.level, 3)]} text-text`}
        >
          {section.heading}
        </Heading>
        <LayerChip layer={showLayer ? section.layer : null} />
        {locked && <LockedChip />}
        {changedLock && (
          <span title="This section was approved in the previous version and has changed.">
            <Chip kind="warn">Changed after lock</Chip>
          </span>
        )}
        <span className="ml-auto truncate font-mono text-[13px] text-text2 max-[600px]:hidden">#{section.section_key}</span>
      </div>
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
        <div className="mt-1.5">
          <RefineSection doc={refine.doc} n={refine.n} sectionKey={section.section_key} heading={section.heading} />
        </div>
      )}
    </section>
  );
});
