"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

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
 * The card is fixed to the viewport, so the inspector's rounded clip never cuts it.
 */
export function EvidenceChip({ evidence, low = DEFAULT_LOW }: { evidence: EvidenceOut; low?: number }) {
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<CSSProperties>({ top: 0, left: 0, visibility: "hidden" });
  const cardId = useId();
  const open = hover || pinned;
  const label = sourceKindLabel(evidence.source_kind);
  const factors = breakdownOf(evidence);

  useLayoutEffect(() => {
    if (!hover && !pinned) return;
    const place = () => {
      const r = btn.current?.getBoundingClientRect();
      if (!r) return;
      const w = Math.min(320, window.innerWidth - 16);
      const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
      const below = window.innerHeight - r.bottom;
      // Above the chip when the room below is short and there is more above.
      setPos(
        below < 300 && r.top > below
          ? { bottom: window.innerHeight - r.top, left, width: w, maxHeight: r.top - 8 }
          : { top: r.bottom, left, width: w, maxHeight: below - 8 },
      );
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [hover, pinned]);

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
        ref={btn}
        type="button"
        data-testid="evidence-chip"
        aria-expanded={open}
        aria-describedby={open ? cardId : undefined}
        aria-label={`Evidence: ${label}, confidence ${evidence.confidence != null ? evidence.confidence.toFixed(2) : "not scored"}`}
        onClick={() => setPinned((p) => !p)}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
        className={`inline-flex h-8 max-w-full flex-none items-center gap-2 rounded-lg border bg-surface pr-1 pl-2.5 text-sm font-semibold whitespace-nowrap hover:bg-surface2 ${
          open ? "border-accent" : "border-line-strong"
        }`}
      >
        {label}
        <ConfidenceBadge value={evidence.confidence} low={low} />
      </button>
      {open && (
        <span
          id={cardId}
          role="tooltip"
          style={pos}
          className="fixed z-50 block overflow-y-auto py-1 text-left text-sm leading-5 font-normal text-text"
        >
          <span className="block rounded-button border border-line bg-surface p-3.5 shadow-tip">
            <span className="tnum mb-1 block text-[13px] font-semibold text-text2">
              {label}
              {evidence.retrieved_at && ` · retrieved ${formatDate(evidence.retrieved_at)}`}
            </span>
            {(evidence.source_item?.title || evidence.ref) && (
              <span className="block font-semibold">{evidence.source_item?.title ?? evidence.ref}</span>
            )}
            {evidence.ref && evidence.source_item?.title && evidence.ref !== evidence.source_item.title && (
              <span className="block truncate font-mono text-[13px] text-text2">{evidence.ref}</span>
            )}
            {evidence.excerpt && (
              <span className="mt-2 block border-l-2 border-accent pl-2.5 text-text2">
                “{evidence.excerpt}”
              </span>
            )}
            {evidence.note && (
              <span className="mt-2 block text-[13px]" data-testid="evidence-note">
                Note: {evidence.note}
              </span>
            )}
            {evidence.link && (
              <span className="mt-2 block rounded-lg bg-surface2 px-2 py-1 text-[13px] text-text2" data-testid="public-link-note">
                Public link, visible to everyone · fetched {formatDate(evidence.link.fetched_at)}
                {evidence.link.last_modified && ` · page updated ${formatDate(evidence.link.last_modified)}`}
              </span>
            )}
            {evidence.source_item_private && (
              <span className="mt-2 block rounded-lg bg-warn-bg px-2 py-1 text-[13px] text-warn" data-testid="private-note">
                From another person&apos;s private source: you see the excerpt, not the item.
              </span>
            )}
            {factors.length > 0 && (
              <span className="mt-2 block">
                <table className="w-full text-[13px]" aria-label="Confidence factors">
                  <thead className="text-text2">
                    <tr>
                      <th className="py-0.5 text-left font-semibold">Factor</th>
                      <th className="py-0.5 text-right font-semibold">Value</th>
                      <th className="py-0.5 text-right font-semibold">Weight</th>
                    </tr>
                  </thead>
                  <tbody>
                    {factors.map(([name, f]) => (
                      <tr key={name} className="border-t border-line">
                        <td className="py-0.5">{FACTOR_LABEL[name] ?? name}</td>
                        <td className="py-0.5 text-right tnum">{fmt(f.value)}</td>
                        <td className="py-0.5 text-right tnum">{fmt(f.weight)}</td>
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
                className="mt-2 inline-block text-[13px] font-semibold text-accent-ink underline underline-offset-2"
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
