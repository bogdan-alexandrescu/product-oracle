"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";

import { DocStatusChip } from "@/app/documents/_components/DocStatusChip";
import { ArtifactMenu } from "@/components/ArtifactMenu";
import { Icon, useDocumentDestination } from "@/components/ds";
import type { DocumentOut } from "@/lib/api/client";

/** The list a document belongs to: Plan for roadmaps (c7), Company › Strategy for a vision or strategy (H4), Company › Updates for updates (H8), Company › Market › Pricing for pricing memos (H9), PRDs for the rest. */
function home(doc?: DocumentOut) {
  if (doc?.kind === "roadmap") return { href: "/plan", label: "Plan" };
  if (doc?.kind === "vision" || doc?.kind === "strategy") return { href: "/company/strategy", label: "Company › Strategy" };
  if (doc?.kind === "update") return { href: "/company/updates", label: "Company › Updates" };
  // H9: a pricing memo belongs to Company › Market › Pricing.
  if (doc?.kind === "pricing") return { href: "/company/market?tab=pricing", label: "Company › Market › Pricing" };
  return { href: "/documents", label: "PRDs" };
}

/**
 * The crumb above a document page's title: back to the list. With `withTitle`, it also
 * names the document and its status (pages whose own title is something else, like a diff).
 */
export function DocCrumb({ doc, withTitle = true, mkPill }: { doc?: DocumentOut; withTitle?: boolean; mkPill?: ReactNode }) { // MOCK-HOOK mkPill: QV4 a's own status pill
  const h = home(doc);
  // The rail highlights the same list (Plan for a roadmap, Company for a strategy) once the kind is known.
  useDocumentDestination(doc?.slug, doc ? h.href : undefined);
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-sm">
      <Link href={h.href} className="inline-flex items-center gap-1 font-medium text-text2 hover:text-text">
        <Icon name="back" size={16} />
        {h.label}
      </Link>
      {withTitle && (
        <>
          <span aria-hidden className="text-text2">
            /
          </span>
          {doc ? (
            <Link href={`/documents/${doc.slug}`} className="min-w-0 truncate font-semibold text-text hover:underline">
              {doc.title}
            </Link>
          ) : (
            <span className="text-text2">…</span>
          )}
          {doc && (mkPill ?? <DocStatusChip status={doc.status} />)}{/* MOCK-HOOK */}
        </>
      )}
    </nav>
  );
}

/**
 * Bar under the shell's top edge: breadcrumb + document status + page tools + the ⋮ menu (#482).
 * `withTitle={false}`: the page's own title names the document and its status (the overview,
 * qa-docs-24), so the crumb only leads back. `openItem={false}`: the page has its own Open latest (qa-docs-27).
 */
export function DocToolbar({
  doc,
  children,
  withTitle = true,
  openItem = true,
}: {
  doc?: DocumentOut;
  children?: ReactNode;
  withTitle?: boolean;
  openItem?: boolean;
}) {
  const router = useRouter();
  return (
    <div className="sticky top-0 z-20 border-b border-line bg-bg">
      <div className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2 px-6 py-2 max-[600px]:px-2.5">
        <DocCrumb doc={doc} withTitle={withTitle} />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {children}
          {/* A deleted document is gone: back to its list. */}
          {doc && <ArtifactMenu doc={doc} openItem={openItem} onDeleted={() => router.push(home(doc).href)} />}
        </div>
      </div>
    </div>
  );
}
