"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Notice } from "@/components/ds";
import type { Schemas } from "@/lib/api/client";
import { membersApi } from "@/lib/api/members-types";
import { formatDay } from "@/lib/format";
import { errorMessage } from "@/lib/use-query";

type Approval = Schemas["TokenApprovalOut"];

/**
 * A5 (#203 part 3): a member's live section verdicts and version approvals (GET
 * /v1/members/{id}/approvals), each linking to its document: what the inspector's Holds
 * counts and what a removal's "Lapses for good" ends. `kind` keeps one of the two.
 */
export function MemberApprovals({ memberId, kind }: { memberId: string; kind?: Approval["kind"] }) {
  const [rows, setRows] = useState<Approval[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    membersApi.approvals(memberId).then(
      (r) => alive && setRows(r),
      (e) => alive && setError(errorMessage(e)),
    );
    return () => {
      alive = false;
    };
  }, [memberId]);
  if (error) return <Notice tone="error">{error}</Notice>;
  if (!rows) return <span className="block h-3 w-2/3 animate-pulse rounded bg-surface2" />;
  const shown = kind ? rows.filter((a) => a.kind === kind) : rows;
  return (
    <ul data-testid="member-approvals" aria-label="Approvals" className="flex flex-col text-[15px]">
      {shown.map((a) => (
        <li key={`${a.kind}:${a.document}:${a.version}:${a.section_key ?? ""}`} className="flex flex-wrap items-baseline gap-x-1.5 border-t border-line py-1.5 first:border-t-0">
          <span>{a.kind === "section" ? "Section approval" : "Version approval"}</span>
          <span className="text-text2">·</span>
          <Link href={`/documents/${a.document}`} className="font-mono text-[13px] font-semibold text-accent-ink hover:underline">
            {a.document} v{a.version}
          </Link>
          {a.section_key && <span className="font-mono text-[13px] text-text2">#{a.section_key}</span>}
          {a.approved_at && <span className="text-[13px] text-text2">{formatDay(a.approved_at)}</span>}
        </li>
      ))}
      {shown.length === 0 && <li className="text-text2">None</li>}
    </ul>
  );
}
