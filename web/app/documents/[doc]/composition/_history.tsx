"use client";

import { Chip, Empty, Panel } from "@/components/ds";
import { formatDate } from "@/lib/format";
import { useMe } from "@/lib/me";

import { diffLine, type InspectorOut } from "./_lib";

const STATUS: Record<InspectorOut["revisions"][number]["status"], { label: string; kind: "pass" | "acc" | "na" | "warn" }> = {
  working: { label: "Working", kind: "warn" },
  confirmed: { label: "Confirmed", kind: "pass" },
  published: { label: "Published", kind: "acc" },
  superseded: { label: "Superseded", kind: "na" },
};

/** The revision history (revisions[], newest first). */
export function HistoryTab({ data }: { data: InspectorOut }) {
  const { me } = useMe();
  return (
    <Panel title="History" count={data.revisions.length}>
      {data.revisions.length === 0 ? (
        <Empty>No revisions yet</Empty>
      ) : (
        <ol>
          {data.revisions.map((r) => (
            <li key={r.id} data-testid={`revision-${r.number}`} className="flex flex-wrap items-start gap-x-3 gap-y-1 border-b border-line px-4 py-3 last:border-b-0">
              <span className="tnum font-display text-lg font-bold">{r.number}</span>
              <Chip kind={STATUS[r.status].kind}>{STATUS[r.status].label}</Chip>
              {data.current?.id === r.id && <Chip kind="now">in force</Chip>}
              <span className="text-sm text-text2">
                {[r.decided_by ? (r.decided_by === me?.user_id ? "You" : "A teammate") : null, r.decided_at ? formatDate(r.decided_at) : null].filter(Boolean).join(" · ")}
                {r.parent_number != null ? ` · from rev ${r.parent_number}` : ""}
                {r.document_version_id && r.status === "published" ? " · pinned to a document version" : ""}
              </span>
              <span className="min-w-0 basis-full text-[15px]">
                {r.reason && <q>{r.reason}</q>}
                {diffLine(r.diff) && <span className="ml-2 font-mono text-[13px] text-text2">{diffLine(r.diff)}</span>}
                {r.diff.material && (
                  <Chip kind="warn" className="ml-2">
                    material
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
