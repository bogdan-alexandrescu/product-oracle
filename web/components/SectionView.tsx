"use client";

import { memo, useMemo, useState, type ReactNode } from "react";

import { AddEvidenceLink } from "@/components/AddEvidenceLink";
import { Button, Chip } from "@/components/ds";
import { MarkdownBody, type ExpandCtx, type Highlight } from "@/components/MarkdownBody";
import { RefineSection } from "@/components/RefineSection";
import { SectionReviewBar } from "@/components/SectionReviewBar";
import { LayerChip, Menu } from "@/components/review/parts";
import type { CitationOut, EntityOut, SectionOut, Verdict } from "@/lib/api/client";
import type { Block } from "@/lib/markdown";

const HEADING_CLASS: Record<number, string> = {
  1: "font-display text-[26px] leading-8 font-bold tracking-heading max-[600px]:text-[22px] max-[600px]:leading-7",
  2: "font-display text-xl leading-7 font-bold tracking-heading",
  3: "font-display tracking-heading text-lg leading-6 font-bold",
};

type Tool = "evidence" | "refine";

/**
 * One section of a version. The open section (one at a time) carries the review bar and a
 * ⋯ menu with Add evidence link and Refine section; a `nested` section (detail shown in
 * place inside a brief section) shows its content only and offers to review it in the
 * full document.
 */
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
  onReviewInFull,
  expand,
  nested = false,
  showLayer = true,
  headTools,
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
  /** Nested: open this section in the full document, where it has its own review bar. */
  onReviewInFull?: (key: string) => void;
  /** Brief view: Expand controls on links to detail sections (O1f). */
  expand?: ExpandCtx;
  /** A detail section shown in place inside a brief section. */
  nested?: boolean;
  /** Label the section Brief or Detail (versions that have a brief layer). */
  showLayer?: boolean;
  /** Extra controls in the head, before the ⋯ menu (the phone's Comments button). */
  headTools?: ReactNode;
}) {
  const Heading = (`h${Math.min(section.level, 3)}` as "h1" | "h2" | "h3");
  const locked = section.verdict?.verdict === "approved";
  // The tool picked from the ⋯ menu, shown under the review bar; a new pick remounts it.
  const [tool, setTool] = useState<{ kind: Tool; n: number } | null>(null);
  // Preselect the baseline item the section names (heading first, then its text).
  const suggested = useMemo(() => {
    if (!evidenceTargets) return null;
    const named = (text: string) =>
      evidenceTargets.find((e) => e.status !== "rejected" && text.toLowerCase().includes(e.title.toLowerCase()));
    return (named(section.heading) ?? named(section.body_text))?.id ?? null;
  }, [evidenceTargets, section.heading, section.body_text]);
  const canRefine = !!refine && !locked;
  const pick = (kind: Tool) => setTool((t) => ({ kind, n: (t?.n ?? 0) + 1 }));
  const close = () => setTool(null);

  return (
    <section
      id={`s-${section.section_key}`}
      data-section-key={section.section_key}
      tabIndex={-1}
      aria-labelledby={`h-${section.section_key}`}
      data-layer={section.layer}
      className={`min-w-0 scroll-mt-6 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
        nested ? "py-3" : "px-6 py-5 max-[600px]:px-4 max-[600px]:py-4"
      }`}
    >
      <div className="mb-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Heading
          id={`h-${section.section_key}`}
          className={`min-w-0 ${nested ? HEADING_CLASS[3] : HEADING_CLASS[Math.min(section.level, 3)]} text-text`}
        >
          {section.heading}
        </Heading>
        <LayerChip layer={showLayer ? section.layer : null} />
        {changedLock && (
          <span title="This section was approved in the previous version and has changed.">
            <Chip kind="warn">Changed after lock</Chip>
          </span>
        )}
        <span className="ml-auto flex flex-none items-center gap-1.5">
          {nested
            ? onReviewInFull && (
                <Button
                  variant="ghost"
                  onClick={() => onReviewInFull(section.section_key)}
                  aria-label={`Review ${section.heading} in the full document`}
                >
                  Review in full
                </Button>
              )
            : headTools}
          {!nested && (evidenceTargets || canRefine) && (
            <Menu label={`Actions for ${section.heading}`} icon="more" iconOnly>
              {(closeMenu) => (
                <span role="menu" aria-label={`Actions for ${section.heading}`} className="flex min-w-44 flex-col gap-0.5">
                  {evidenceTargets && (
                    <MenuItem
                      label={`Add evidence link to ${section.heading}`}
                      onClick={() => {
                        closeMenu();
                        pick("evidence");
                      }}
                    >
                      Add evidence link
                    </MenuItem>
                  )}
                  {canRefine && (
                    <MenuItem
                      label={`Refine section ${section.heading}`}
                      onClick={() => {
                        closeMenu();
                        pick("refine");
                      }}
                    >
                      Refine section
                    </MenuItem>
                  )}
                </span>
              )}
            </Menu>
          )}
        </span>
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
      {!nested && (
        <SectionReviewBar
          heading={section.heading}
          verdict={section.verdict}
          readOnly={readOnly}
          onSubmit={(v, note) => onVerdict(section.section_key, v, note)}
        />
      )}
      {!nested && tool?.kind === "evidence" && evidenceTargets && (
        <div className="mt-3" data-testid="section-evidence">
          <AddEvidenceLink
            key={`${suggested ?? ""}|${tool.n}`}
            entities={evidenceTargets}
            suggested={suggested}
            context={section.heading}
            defaultOpen
            onClose={close}
          />
        </div>
      )}
      {!nested && tool?.kind === "refine" && canRefine && (
        <RefineSection
          key={tool.n}
          doc={refine.doc}
          n={refine.n}
          sectionKey={section.section_key}
          heading={section.heading}
          defaultOpen
          onClose={close}
        />
      )}
    </section>
  );
});

function MenuItem({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-label={label}
      onClick={onClick}
      className="flex h-9 items-center rounded-lg px-2.5 text-left text-sm font-medium whitespace-nowrap text-text hover:bg-surface2"
    >
      {children}
    </button>
  );
}
