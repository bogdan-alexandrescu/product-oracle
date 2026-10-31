"use client";

import { useState } from "react";

import { NewRunDialog } from "@/app/runs/_new-run-dialog";
import { Button, Icon } from "@/components/ds";
import { api, unwrap } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
import { useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";

/**
 * S4 Freshness: "N new items since draft k, refresh?" on a PRD's latest draft. Only the
 * draft's author learns the number (sources are private, S5); Refresh opens the Baseline to
 * PRD run dialog on this PRD, and the new run reads the sources as they are now.
 */
export function DraftNewItems({ doc, slug, n }: { doc: string; slug: string; n: number }) {
  const { can } = useMe();
  const [open, setOpen] = useState(false);
  const q = useQuery(`draft-new-items|${doc}|${n}`, () =>
    unwrap(api.GET("/v1/documents/{doc}/versions/{n}/new-items", { params: { path: { doc, n } } })).catch(() => null),
  );
  const count = q.data?.visible ? (q.data.count ?? 0) : 0;
  // The count is of items new, changed or deleted since the sources the draft read (its run's
  // pin, which can be well before the draft was written), so the line names that moment.
  const asOf = q.data?.as_of ?? null;
  if (count === 0) return null;
  return (
    <div
      role="status"
      data-testid="draft-new-items"
      className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-button bg-accent-soft px-3 py-2 text-sm font-medium text-accent-ink"
    >
      <Icon name="sources" size={16} />
      <p className="min-w-0 flex-1">
        {count} new or changed item{count === 1 ? "" : "s"} in your sources since draft v{n} read them
        {asOf ? ` (${formatDateTime(asOf)})` : ""}
      </p>
      {/* create_run's handler wants an owner only to update a draft run; a new run lets approvers in. */}
      {can("create_run", true) && (
        <Button aria-haspopup="dialog" onClick={() => setOpen(true)}>
          Refresh
        </Button>
      )}
      {open && <NewRunDialog onClose={() => setOpen(false)} start={{ flow: "baseline_to_prd", document: slug, title: "Refresh draft" }} />}
    </div>
  );
}
