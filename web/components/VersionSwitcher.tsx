"use client";

import { useRouter } from "next/navigation";

import { SegmentedControl } from "@/components/ds";
import type { VersionSummary } from "@/lib/api/client";
import { formatDate } from "@/lib/format";

/** Up to this many versions show as a segmented control; more as a select. */
const MAX_SEGMENTS = 6;

/**
 * The document's versions. `segments`: v1 · v2 · v3 links (B1's switcher), falling back to
 * the select when there are many; `select` (default): a native select that navigates on change.
 */
export function VersionSwitcher({
  doc,
  versions,
  current,
  hrefFor = (n) => `/documents/${doc}/v/${n}`,
  label = "Version",
  variant = "select",
}: {
  doc: string;
  versions: VersionSummary[];
  current: number;
  hrefFor?: (n: number) => string;
  label?: string;
  variant?: "select" | "segments";
}) {
  const router = useRouter();
  const latest = versions.at(-1)?.number;
  if (variant === "segments" && versions.length <= MAX_SEGMENTS) {
    return (
      <SegmentedControl
        label={label}
        value={String(current)}
        items={versions.map((v) => ({
          value: String(v.number),
          href: hrefFor(v.number),
          label: (
            <span
              className="font-mono"
              title={`v${v.number} · ${formatDate(v.created_at)}${v.approved_at ? " · approved" : v.number === latest ? " · latest" : ""}`}
            >
              v{v.number}
            </span>
          ),
        }))}
      />
    );
  }
  return (
    <label className="flex items-center gap-2 text-sm font-semibold text-text2">
      <span className="sr-only sm:not-sr-only">{label}</span>
      <select
        aria-label={label}
        value={current}
        onChange={(e) => router.push(hrefFor(Number(e.target.value)))}
        className="tnum h-9 rounded-button border border-line-strong bg-surface pr-7 pl-2.5 text-sm font-medium text-text"
      >
        {[...versions].reverse().map((v) => (
          <option key={v.number} value={v.number}>
            v{v.number} · {formatDate(v.created_at)}
            {v.approved_at ? " · approved" : v.number === latest ? " · latest" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}
