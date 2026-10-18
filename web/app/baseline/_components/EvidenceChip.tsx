"use client";

import { useEffect, useId, useRef, useState } from "react";

import type { EvidenceOut } from "@/lib/api/client";
import { formatDate } from "@/lib/format";

import { ConfidenceBadge, DEFAULT_LOW, sourceKindLabel } from "./common";

const FACTOR_LABEL: Record<string, string> = {
  source: "Source",
  freshness: "Freshness",
  mentions: "Mentions",
  goal_impact: "Goal impact",
};
const FACTOR_ORDER = ["source", "freshness", "mentions", "goal_impact"];

type Factor = { value?: unknown; weight?: unknown };

function breakdownOf(ev: EvidenceOut): [string, Factor][] {
  const raw = (ev.confidence_factors as { breakdown?: Record<string, Factor> } | undefined)?.breakdown;
  if (!raw || typeof raw !== "object") return [];
  return Object.entries(raw).sort(
    ([a], [b]) => (FACTOR_ORDER.indexOf(a) + 1 || 99) - (FACTOR_ORDER.indexOf(b) + 1 || 99),
  );
}

const fmt = (v: unknown) => (typeof v === "number" ? v.toFixed(2) : "—");

/**
 * One piece of evidence: source kind and confidence. Hover or focus previews the
 * card (excerpt, ref, link, factor breakdown); click pins it open, as CitationChip does.
 */
export function EvidenceChip({ evidence, low = DEFAULT_LOW }: { evidence: EvidenceOut; low?: number }) {
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const cardId = useId();
  const open = hover || pinned;
  const label = sourceKindLabel(evidence.source_kind);
  const factors = breakdownOf(evidence);

  useEffect(() => {
    if (!pinned) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setPinned(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [pinned]);

  return (
    <span
      ref={ref}
      className="relative inline-block"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          // Close the card only, not the panel around it.
          e.preventDefault();
          setPinned(false);
          setHover(false);
        }
      }}
    >
      <button
        type="button"
        data-testid="evidence-chip"
        aria-expanded={open}
        aria-describedby={open ? cardId : undefined}
        aria-label={`Evidence: ${label}, confidence ${evidence.confidence != null ? evidence.confidence.toFixed(2) : "not scored"}`}
        onClick={() => setPinned((p) => !p)}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
        className="inline-flex items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-2 py-1 text-xs text-neutral-700 hover:border-neutral-300 hover:bg-neutral-50"
      >
        {label}
        <ConfidenceBadge value={evidence.confidence} low={low} />
      </button>
      {open && (
        <span
          id={cardId}
          role="tooltip"
          className="absolute top-full left-0 z-30 block w-80 pt-1 text-left text-sm leading-snug text-neutral-800"
        >
          <span className="block rounded-md border border-neutral-200 bg-white p-3 shadow-lg">
            <span className="mb-1 block text-xs text-neutral-500">
              {label}
              {evidence.retrieved_at && ` · retrieved ${formatDate(evidence.retrieved_at)}`}
            </span>
            {(evidence.source_item?.title || evidence.ref) && (
              <span className="block font-medium">{evidence.source_item?.title ?? evidence.ref}</span>
            )}
            {evidence.ref && evidence.source_item?.title && evidence.ref !== evidence.source_item.title && (
              <span className="block font-mono text-[11px] text-neutral-500">{evidence.ref}</span>
            )}
            {evidence.excerpt && (
              <span className="mt-2 block border-l-2 border-neutral-200 pl-2 text-neutral-600 italic">
                “{evidence.excerpt}”
              </span>
            )}
            {evidence.source_item_private && (
              <span className="mt-2 block rounded bg-neutral-50 px-2 py-1 text-xs text-neutral-600" data-testid="private-note">
                From another person&apos;s private source: you see the excerpt, not the item.
              </span>
            )}
            {factors.length > 0 && (
              <span className="mt-2 block">
                <table className="w-full text-xs" aria-label="Confidence factors">
                  <thead className="text-neutral-500">
                    <tr>
                      <th className="py-0.5 text-left font-medium">Factor</th>
                      <th className="py-0.5 text-right font-medium">Value</th>
                      <th className="py-0.5 text-right font-medium">Weight</th>
                    </tr>
                  </thead>
                  <tbody>
                    {factors.map(([name, f]) => (
                      <tr key={name} className="border-t border-neutral-100">
                        <td className="py-0.5">{FACTOR_LABEL[name] ?? name}</td>
                        <td className="py-0.5 text-right tabular-nums">{fmt(f.value)}</td>
                        <td className="py-0.5 text-right tabular-nums">{fmt(f.weight)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </span>
            )}
            {evidence.url && (
              <a
                href={evidence.url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-block text-xs text-neutral-700 underline underline-offset-2 hover:text-neutral-950"
              >
                Open source ↗
              </a>
            )}
          </span>
        </span>
      )}
    </span>
  );
}
