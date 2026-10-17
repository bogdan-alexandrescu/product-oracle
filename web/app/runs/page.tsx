"use client";

import Link from "next/link";
import { useState } from "react";

import { Button, ErrorNote, Loading } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
import { hasRole, useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";

import { CHECKPOINT_LABEL, RunStatusBadge, usd } from "./_lib";
import { NewRunDialog } from "./_new-run-dialog";

export default function RunsPage() {
  const q = useQuery("runs", () => unwrap(api.GET("/v1/runs")));
  const { role } = useMe();
  const [open, setOpen] = useState(false);
  const runs = (q.data ?? []).filter((r) => r.status !== "draft");

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">Runs</h1>
        {hasRole(role, "approver") && (
          <Button variant="primary" onClick={() => setOpen(true)}>
            New run
          </Button>
        )}
      </div>
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {q.loading && <Loading />}
      {q.data && runs.length === 0 && (
        <div className="space-y-2 text-neutral-600">
          <p>
            No runs yet. Runs turn the baseline into a PRD draft: each one plans the work, gathers evidence from your
            sources and writes a cited draft for review.
          </p>
          <p>Started runs appear here with their status, cost estimate and the draft they produced.</p>
        </div>
      )}
      {runs.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
          <table className="w-full text-sm" data-testid="runs-table">
            <thead className="bg-neutral-50 text-left text-xs text-neutral-500">
              <tr>
                <th className="px-4 py-2 font-medium">Run</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 text-right font-medium">Estimate</th>
                <th className="px-4 py-2 text-right font-medium">Spent</th>
                <th className="px-4 py-2 font-medium">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200">
              {runs.map((r) => (
                <tr key={r.id} className="hover:bg-neutral-50" data-testid="run-row">
                  <td className="px-4 py-3">
                    <Link href={`/runs/${r.id}`} className="font-medium text-neutral-900 hover:underline">
                      {r.flow_title}
                    </Link>
                    {r.document_slug && <div className="font-mono text-[11px] text-neutral-400">{r.document_slug}</div>}
                  </td>
                  <td className="px-4 py-3">
                    <RunStatusBadge status={r.status} />
                    {r.waiting_on && <div className="mt-1 text-xs text-neutral-500">{CHECKPOINT_LABEL[r.waiting_on]}</div>}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-neutral-700">{usd(r.estimate_usd)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-neutral-700">{usd(r.spent_usd)}</td>
                  <td className="px-4 py-3 text-neutral-500">{formatDateTime(r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <NewRunDialog onClose={() => setOpen(false)} />}
    </div>
  );
}
