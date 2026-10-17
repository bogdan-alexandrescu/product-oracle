"use client";

import { memo } from "react";

import { MarkdownBody, type Highlight } from "@/components/MarkdownBody";
import { SectionReviewBar } from "@/components/SectionReviewBar";
import { LockIcon } from "@/components/ui";
import type { CitationOut, SectionOut, Verdict } from "@/lib/api/client";
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
  onHighlightClick,
  onVerdict,
}: {
  section: SectionOut;
  blocks: Block[];
  citations: Map<string, { citation: CitationOut; number: number }>;
  highlights: Highlight[];
  activeCommentId: string | null;
  readOnly: boolean;
  changedLock: boolean;
  onHighlightClick: (id: string) => void;
  onVerdict: (key: string, verdict: Verdict, note: string) => Promise<void>;
}) {
  const Heading = (`h${Math.min(section.level, 3)}` as "h1" | "h2" | "h3");
  const locked = section.verdict?.verdict === "approved";
  return (
    <section
      id={`s-${section.section_key}`}
      data-section-key={section.section_key}
      tabIndex={-1}
      aria-labelledby={`h-${section.section_key}`}
      className={`scroll-mt-24 rounded-lg py-5 outline-none focus-visible:ring-2 focus-visible:ring-neutral-300 ${
        section.level >= 3 ? "pl-4" : ""
      }`}
    >
      <div className="mb-2 flex items-baseline gap-2">
        <Heading id={`h-${section.section_key}`} className={`${HEADING_CLASS[Math.min(section.level, 3)]} text-neutral-900`}>
          {section.heading}
        </Heading>
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
        />
      </div>
      <SectionReviewBar
        heading={section.heading}
        verdict={section.verdict}
        readOnly={readOnly}
        onSubmit={(v, note) => onVerdict(section.section_key, v, note)}
      />
    </section>
  );
});
