"use client";

import { Chip, HoverCard } from "@/components/ds";
import type { CitationOut } from "@/lib/api/client";
import { IGNORE_ATTR } from "@/lib/anchor";
import { citationConfidence, citationHref, citationSourceLabel, formatDate, SOURCE_LABEL } from "@/lib/format";

/** The app's low-confidence chip, on a citation its writer marked low confidence. */
export function LowConfidence() {
  return (
    <Chip kind="warn" title="The writer marked this source low confidence" className="flex-none" data-testid="low-confidence">
      Low confidence
    </Chip>
  );
}

/**
 * Inline citation: shows the source; the shared card (#304) shows its title, date, excerpt
 * and link on hover, focus or tap. The chip is excluded from comment anchoring text.
 */
export function CitationChip({ citeKey, citation, number }: { citeKey: string; citation?: CitationOut; number?: number }) {
  if (!citation) {
    return (
      <span {...{ [IGNORE_ATTR]: "" }} className="cite-chip cite-chip-missing" title={`Unknown citation ${citeKey}`}>
        ?
      </span>
    );
  }
  const href = citationHref(citation);
  const confidence = citationConfidence(citation);

  return (
    <span {...{ [IGNORE_ATTR]: "" }} className="relative inline-block align-baseline">
      <HoverCard
        testId={`cite-${citeKey}`}
        className="cite-chip"
        unstyled
        label={[
          `Citation ${number ?? ""}: ${SOURCE_LABEL[citation.source]}`,
          citation.title ?? citation.ref,
          [citation.low_confidence && "low confidence", confidence].filter(Boolean).join(" "),
        ]
          .filter(Boolean)
          .join(", ")}
        trigger={
          <>
            {SOURCE_LABEL[citation.source]}
            {number != null && <span className="tnum text-text2">{number}</span>}
          </>
        }
      >
        <span className="mb-1 block text-[13px] font-semibold tracking-[0.02em] text-text2" data-testid="cite-source">
          {/* The writer's confidence beside the source, or its note when unscored (text). */}
          {citationSourceLabel(citation)}
          {citation.retrieved_at && ` · retrieved ${formatDate(citation.retrieved_at)}`}
        </span>
        {citation.low_confidence && (
          <span className="mb-1 block">
            <LowConfidence />
          </span>
        )}
        <span className="block font-semibold">{citation.title ?? citation.ref}</span>
        {citation.excerpt && <span className="mt-2 block border-l-[3px] border-accent-mid pl-2 text-text2">“{citation.excerpt}”</span>}
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-accent-ink hover:underline"
          >
            Open source ↗
          </a>
        ) : (
          // A baseline item named in free text: no link to open.
          <span className="mt-2 block font-mono text-[13px] text-text2" data-testid="cite-ref">
            {citation.ref}
          </span>
        )}
      </HoverCard>
    </span>
  );
}
