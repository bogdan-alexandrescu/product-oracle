"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { DocStatusChip } from "@/app/documents/_components/DocStatusChip";
import { Icon, useDocumentDestination } from "@/components/ds";
import type { DocumentOut } from "@/lib/api/client";

/** The list a document belongs to: Roadmap for roadmaps, PRDs for the rest. */
function home(doc?: DocumentOut) {
  return doc?.kind === "roadmap" ? { href: "/roadmap", label: "Roadmap" } : { href: "/documents", label: "PRDs" };
}

/**
 * The crumb above a document page's title: back to the list. With `withTitle`, it also
 * names the document and its status (pages whose own title is something else, like a diff).
 */
export function DocCrumb({ doc, withTitle = true }: { doc?: DocumentOut; withTitle?: boolean }) {
  const h = home(doc);
  // The rail highlights the same list (Roadmap for a roadmap) once the kind is known.
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
          {doc && <DocStatusChip status={doc.status} />}
        </>
      )}
    </nav>
  );
}

/** Bar under the shell's top edge: breadcrumb + document status + page tools. */
export function DocToolbar({ doc, children }: { doc?: DocumentOut; children?: ReactNode }) {
  return (
    <div className="sticky top-0 z-20 border-b border-line bg-bg">
      <div className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2 px-6 py-2 max-[600px]:px-2.5">
        <DocCrumb doc={doc} />
        <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div>
      </div>
    </div>
  );
}
