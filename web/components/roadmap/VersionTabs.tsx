"use client";

import Link from "next/link";

import type { DraftRoadmapSummary } from "@/lib/api/draft-roadmap";

/**
 * A version's page tabs, directly under its header (E2): Document and Items on a roadmap
 * version; Document and Roadmap on every PRD version (E1: the draft's items-only roadmap,
 * "Roadmap 4", or "Roadmap · deriving" / "Roadmap · queued" while it has no items yet).
 * Links, not buttons; the active one carries aria-current="page".
 */
export function VersionTabs({
  doc,
  n,
  kind,
  active,
  count,
  draft,
}: {
  doc: string;
  n: number;
  kind: string | null | undefined;
  active: "document" | "items" | "roadmap";
  /** The version's item count; while it loads the label is "Items". */
  count?: number;
  /** A PRD version's draft roadmap summary (VersionOut.draft_roadmap). */
  draft?: DraftRoadmapSummary | null;
}) {
  if (kind !== "roadmap" && kind !== "prd") return null;
  const base = `/documents/${doc}/v/${n}`;
  const tabs =
    kind === "prd"
      ? [
          { key: "document", label: "Document", href: base },
          { key: "roadmap", label: roadmapLabel(draft), href: `${base}/roadmap` },
        ]
      : [
          { key: "document", label: "Document", href: base },
          { key: "items", label: count == null ? "Items" : `Items ${count}`, href: `${base}/items` },
        ];
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

/** "Roadmap 4"; while there are no items, the status word of a derivation under way. */
function roadmapLabel(draft: DraftRoadmapSummary | null | undefined): string {
  if (draft?.items) return `Roadmap ${draft.items}`;
  if (draft?.status === "running") return "Roadmap · deriving";
  if (draft?.status === "queued") return "Roadmap · queued";
  return "Roadmap";
}
