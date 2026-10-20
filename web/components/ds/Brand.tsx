"use client";

import { useId, type CSSProperties } from "react";

import "./brand.css";

/**
 * The Product Oracle mark (I3, 2026-10-19): Compass, a needle in a ring, drawn from
 * docs/product-oracle-v2/design/brand/. `sky` is the white to #7dd3fc gradient for the
 * navy rail; `current` follows currentColor (on pages, the --brand-mark token in brand.css).
 * Under 24 px the compact cut is drawn: no ticks, solid needle, heavier ring.
 */
export function Mark({
  size,
  tone = "current",
  compact,
  label,
  className,
}: {
  size: number;
  tone?: "sky" | "current";
  compact?: boolean;
  /** Accessible name; without one the mark is decorative (aria-hidden). */
  label?: string;
  className?: string;
}) {
  // Each inline copy gets its own gradient id: a shared id would resolve to the first
  // copy in the document, which may sit in a hidden subtree and then paints nothing.
  const id = useSafeId();
  const cut = compact ?? size < 24;
  const ink = tone === "sky" ? `url(#${id})` : "currentColor";
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      className={className}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      {tone === "sky" && <SkyGradient id={id} />}
      {cut ? (
        <>
          <circle cx="16" cy="16" r="13" fill="none" stroke={ink} strokeWidth="3" />
          <path d="M22 6 L18.3 18.3 L9.5 26 L13.7 13.7 Z" fill={ink} />
        </>
      ) : (
        <>
          <circle cx="16" cy="16" r="12.5" fill="none" stroke={ink} strokeWidth="1.6" opacity=".5" />
          <g stroke={ink} strokeWidth="1.5" opacity=".5" strokeLinecap="round">
            <line x1="16" y1="1.5" x2="16" y2="4.5" />
            <line x1="30.5" y1="16" x2="27.5" y2="16" />
            <line x1="16" y1="30.5" x2="16" y2="27.5" />
            <line x1="1.5" y1="16" x2="4.5" y2="16" />
          </g>
          <path d="M20.5 6.5 L17.6 17.6 L10.5 25.5 L14.4 14.4 Z" fill={ink} opacity=".45" />
          <path d="M20.5 6.5 L17.6 17.6 L14.4 14.4 Z" fill={ink} />
        </>
      )}
    </svg>
  );
}

/** useId, reduced to characters that are safe inside url(#…). */
function useSafeId(): string {
  return `m${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
}

/** userSpaceOnUse on purpose: a bounding-box gradient has no box on a straight line, so ticks would vanish. */
function SkyGradient({ id }: { id: string }) {
  return (
    <defs>
      <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="32" y2="32">
        <stop offset="0" stopColor="#ffffff" />
        <stop offset="1" stopColor="#7dd3fc" />
      </linearGradient>
    </defs>
  );
}

/** The browser-tab icon (app/icon.svg): the compact sky mark on a navy rounded square. */
export function FaviconMark({ size = 32 }: { size?: number }) {
  const id = useSafeId();
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden>
      <SkyGradient id={`${id}s`} />
      <defs>
        <linearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0b3a7a" />
          <stop offset="1" stopColor="#06101e" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="7" fill={`url(#${id}b)`} />
      <g transform="translate(3 3) scale(.8125)">
        <circle cx="16" cy="16" r="13" fill="none" stroke={`url(#${id}s)`} strokeWidth="3" />
        <path d="M22 6 L18.3 18.3 L9.5 26 L13.7 13.7 Z" fill={`url(#${id}s)`} />
      </g>
    </svg>
  );
}

/** "Product Oracle" in the display face, 650, -0.02em; "Oracle" in `accent` (the accent token by default). */
export function Wordmark({ className = "", accent }: { className?: string; accent?: string }) {
  const style: CSSProperties | undefined = accent ? { color: accent } : undefined;
  return (
    <span className={`font-display font-[650] tracking-[-0.02em] whitespace-nowrap ${className}`}>
      Product{" "}
      <span className={accent ? undefined : "text-accent"} style={style}>
        Oracle
      </span>
    </span>
  );
}
