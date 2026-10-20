"use client";

import { useEffect, useId, useRef, useState } from "react";

import type { CitationOut } from "@/lib/api/client";
import { IGNORE_ATTR } from "@/lib/anchor";
import { formatDate, SOURCE_LABEL } from "@/lib/format";

/**
 * Inline citation: shows the source; hover or focus previews title and excerpt,
 * click pins the card open. The chip is excluded from comment anchoring text.
 */
export function CitationChip({ citeKey, citation, number }: { citeKey: string; citation?: CitationOut; number?: number }) {
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const cardId = useId();
  const open = hover || pinned;

  useEffect(() => {
    if (!pinned) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setPinned(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [pinned]);

  if (!citation) {
    return (
      <span {...{ [IGNORE_ATTR]: "" }} className="cite-chip cite-chip-missing" title={`Unknown citation ${citeKey}`}>
        ?
      </span>
    );
  }

  return (
    <span
      ref={ref}
      {...{ [IGNORE_ATTR]: "" }}
      className="relative inline-block align-baseline"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setPinned(false);
          setHover(false);
        }
      }}
    >
      <button
        type="button"
        className="cite-chip"
        aria-expanded={open}
        aria-describedby={open ? cardId : undefined}
        aria-label={`Citation ${number ?? ""}: ${SOURCE_LABEL[citation.source]}, ${citation.title ?? citation.ref}`}
        data-testid={`cite-${citeKey}`}
        onClick={() => setPinned((p) => !p)}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
      >
        {SOURCE_LABEL[citation.source]}
        {number != null && <span className="tnum text-text2">{number}</span>}
      </button>
      {open && (
        <span
          id={cardId}
          role="tooltip"
          className="absolute top-full left-0 z-30 block w-80 max-w-[calc(100vw-24px)] pt-1 text-left text-sm leading-5 font-normal text-text"
        >
          <span className="block rounded-panel border border-line bg-surface p-3 shadow-tip">
            <span className="mb-1 block text-[13px] font-semibold tracking-[0.02em] text-text2">
              {SOURCE_LABEL[citation.source]}
              {citation.retrieved_at && ` · retrieved ${formatDate(citation.retrieved_at)}`}
            </span>
            <span className="block font-semibold">{citation.title ?? citation.ref}</span>
            {citation.excerpt && (
              <span className="mt-2 block border-l-[3px] border-accent-mid pl-2 text-text2">“{citation.excerpt}”</span>
            )}
            <a
              href={citation.ref}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-accent-ink hover:underline"
            >
              Open source ↗
            </a>
          </span>
        </span>
      )}
    </span>
  );
}
