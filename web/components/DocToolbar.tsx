import Link from "next/link";
import type { ReactNode } from "react";

import { DocStatusBadge } from "@/components/ui";
import type { DocumentOut } from "@/lib/api/client";

/** Sticky bar under the app header: breadcrumb + document status + page actions. */
export function DocToolbar({ doc, children }: { doc?: DocumentOut; children?: ReactNode }) {
  return (
    <div className="sticky top-0 z-20 border-b border-neutral-200 bg-white/95 backdrop-blur">
      <div className="mx-auto flex min-h-14 max-w-[1400px] flex-wrap items-center gap-x-4 gap-y-2 px-6 py-2">
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-sm">
          <Link href="/documents" className="text-neutral-500 hover:text-neutral-900">
            Documents
          </Link>
          <span className="text-neutral-300">/</span>
          {doc ? (
            <Link href={`/documents/${doc.slug}`} className="truncate font-medium text-neutral-900 hover:underline">
              {doc.title}
            </Link>
          ) : (
            <span className="text-neutral-400">…</span>
          )}
          {doc && <DocStatusBadge status={doc.status} />}
        </nav>
        <div className="ml-auto flex flex-wrap items-center gap-3">{children}</div>
      </div>
    </div>
  );
}
