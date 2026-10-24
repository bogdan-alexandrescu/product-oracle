"use client";

import Link from "next/link";
import { useState } from "react";

import { Button, Chip, DataTable, Empty, InfoTip, Panel, type Column } from "@/components/ds";
import { ErrorNote } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { useCompanyZone } from "@/lib/dates";
import { formatDate } from "@/lib/format";
import { useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";

import { MEMOS_KEY, MEMO_STATE, type Memo } from "./lib";
import { NewPricingMemo } from "./NewPricingMemo";

/**
 * Company › Market › Pricing (H9): the pricing memos, newest first, each with its state and
 * the decision the pricing owner made from it. Approvers and owners start one (New pricing
 * memo); the memo opens in the document page.
 */
export function Pricing() {
  const { can } = useMe();
  const zone = useCompanyZone();
  const mayCreate = can("start_draft", true) && can("create_run", true);
  const q = useQuery(MEMOS_KEY, () => unwrap(api.GET("/v1/pricing-memos")));
  const [creating, setCreating] = useState(false);

  const columns: Column<Memo>[] = [
    {
      key: "memo",
      header: "Memo",
      phone: "title",
      cell: (m) => (
        <Link href={`/documents/${m.slug}`} className="truncate font-medium text-text hover:underline" data-testid="memo-title">
          {m.title}
        </Link>
      ),
    },
    { key: "question", header: "Question", phone: "hide", cell: (m) => <span className="text-sm text-text2">{m.question ?? "—"}</span> },
    {
      key: "state",
      header: "State",
      width: "112px",
      phone: "meta",
      cell: (m) => (
        <span data-testid="memo-state" className="inline-flex">
          <Chip kind={MEMO_STATE[m.state].kind} dot>
            {MEMO_STATE[m.state].label}
          </Chip>
        </span>
      ),
    },
    {
      key: "decision",
      header: "Decision",
      width: "240px",
      phone: "hide",
      cell: (m) =>
        m.decision ? (
          <Link href={`/company/decisions?d=${m.decision.number}`} className="text-sm hover:underline" data-testid="memo-decision">
            <span className="font-mono font-semibold">D-{m.decision.number}</span> {m.decision.title}
            {m.decision.chosen_label && <span className="text-text2"> · {m.decision.chosen_label}</span>}
          </Link>
        ) : (
          <span className="text-sm text-text2">—</span>
        ),
    },
    { key: "updated", header: `Updated (${zone})`, width: "200px", phone: "hide", cell: (m) => <span className="tnum text-sm">{formatDate(m.updated_at)}</span> },
  ];

  return (
    <>
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      <Panel
        title="Pricing"
        count={q.data ? q.data.length : undefined}
        tools={
          <div className="flex items-center gap-2">
            <InfoTip label="pricing memos" align="end">
              A pricing memo sets out one pricing question, two to four options, the evidence and a research plan. It is input: the pricing owner
              decides the price in the decision log. Owners and approvers see memos.
            </InfoTip>
            {mayCreate && (
              <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
                New pricing memo
              </Button>
            )}
          </div>
        }
      >
        {q.data && q.data.length === 0 ? (
          <Empty testId="pricing-empty">No pricing memos yet</Empty>
        ) : (
          <DataTable
            label="Pricing memos"
            testId="pricing-table"
            columns={columns}
            rows={q.data}
            loading={q.loading}
            rowKey={(m) => m.slug}
            rowProps={(m) => ({ "data-testid": "memo-row", "data-slug": m.slug })}
          />
        )}
      </Panel>
      {creating && <NewPricingMemo onClose={() => setCreating(false)} />}
    </>
  );
}
