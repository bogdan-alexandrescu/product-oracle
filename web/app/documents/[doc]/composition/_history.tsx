"use client";

import { Chip, Panel } from "@/components/ds";
import { formatDate } from "@/lib/format";
import { useMe } from "@/lib/me";

import { diffLine, titler, type InspectorOut } from "./_lib";

const STATUS: Record<InspectorOut["revisions"][number]["status"], { label: string; kind: "pass" | "acc" | "na" | "warn" }> = {
  working: { label: "Working", kind: "warn" },
  confirmed: { label: "Confirmed", kind: "pass" },
  published: { label: "Published", kind: "acc" },
  superseded: { label: "Superseded", kind: "na" },
};

/** The revision history (revisions[], newest first). */
export function HistoryTab({ data }: { data: InspectorOut }) {
  const { me } = useMe();
  const titleOf = titler(data.current?.modules, data.working?.modules, data.recommendation?.modules);
  return (
    <Panel title="History" count={data.revisions.length}>
      {data.revisions.length === 0 ? (
        // qa-docs-46: say how a revision comes to be.
        <div data-testid="history-empty" className="px-4 py-8 text-center">
          <p className="font-medium">No revisions yet</p>
          <p className="mt-1 text-sm text-text2">An approver makes the first revision by choosing Use these modules on the Modules tab and confirming.</p>
        </div>
      ) : (
        <ol>
          {data.revisions.map((r) => (
            <li key={r.id} data-testid={`revision-${r.number}`} className="flex flex-wrap items-start gap-x-3 gap-y-1 border-b border-line px-4 py-3 last:border-b-0">
              <span className="tnum font-display text-lg font-bold">Revision {r.number}</span>
              <Chip kind={STATUS[r.status].kind}>{STATUS[r.status].label}</Chip>
              {data.current?.id === r.id && <Chip kind="now">in force</Chip>}
              <span className="text-sm text-text2">
                {[r.decided_by ? (r.decided_by === me?.user_id ? "You" : "A teammate") : null, r.decided_at ? formatDate(r.decided_at) : null].filter(Boolean).join(" · ")}
                {r.parent_number != null ? ` · after revision ${r.parent_number}` : ""}
                {r.document_version_id && r.status === "published" ? " · pinned to a document version" : ""}
              </span>
              <span className="min-w-0 basis-full text-[15px]">
                {r.reason && <q>{r.reason}</q>}
                {diffLine(r.diff, titleOf) && <span className="ml-2 text-sm text-text2">{diffLine(r.diff, titleOf)}</span>}
                {r.diff.material && (
                  <Chip kind="warn" className="ml-2">
                    Changes sections
                  </Chip>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
