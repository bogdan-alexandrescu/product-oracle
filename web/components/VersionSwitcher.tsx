"use client";

import { useRouter } from "next/navigation";

import type { VersionSummary } from "@/lib/api/client";
import { formatDate } from "@/lib/format";

/** Native select of the document's versions; navigates on change. */
export function VersionSwitcher({
  doc,
  versions,
  current,
  hrefFor = (n) => `/documents/${doc}/v/${n}`,
  label = "Version",
}: {
  doc: string;
  versions: VersionSummary[];
  current: number;
  hrefFor?: (n: number) => string;
  label?: string;
}) {
  const router = useRouter();
  const latest = versions.at(-1)?.number;
  return (
    <label className="flex items-center gap-2 text-sm text-neutral-600">
      <span className="sr-only sm:not-sr-only">{label}</span>
      <select
        aria-label={label}
        value={current}
        onChange={(e) => router.push(hrefFor(Number(e.target.value)))}
        className="rounded-md border border-neutral-300 bg-white py-1 pr-7 pl-2 text-sm text-neutral-900"
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
