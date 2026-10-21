"use client";

import Link from "next/link";

/**
 * A version's page tabs, directly under its header (E2): Document and Items on a roadmap
 * version. Links, not buttons; the active one carries aria-current="page". E1 adds the PRD
 * variant (Document and Roadmap) here.
 */
export function VersionTabs({
  doc,
  n,
  kind,
  active,
  count,
}: {
  doc: string;
  n: number;
  kind: string | null | undefined;
  active: "document" | "items" | "roadmap";
  /** The version's item count; while it loads the label is "Items". */
  count?: number;
}) {
  if (kind !== "roadmap") return null;
  const base = `/documents/${doc}/v/${n}`;
  const tabs = [
    { key: "document", label: "Document", href: base },
    { key: "items", label: count == null ? "Items" : `Items ${count}`, href: `${base}/items` },
  ] as const;
  return (
    <nav aria-label="Version tabs" data-testid="version-tabs" className="mb-3 flex min-w-0 items-center gap-1 border-b border-line">
      {tabs.map((t) => {
        const on = t.key === active;
        return (
          <Link
            key={t.key}
            href={t.href}
            data-testid={`version-tab-${t.key}`}
            aria-current={on ? "page" : undefined}
            className={`tnum -mb-px flex h-10 flex-none items-center border-b-2 px-3 text-[15px] font-semibold whitespace-nowrap max-[639px]:h-11 ${
              on ? "border-accent text-text" : "border-transparent text-text2 hover:text-text"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
