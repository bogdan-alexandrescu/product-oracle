"use client";

import { useEffect, useState } from "react";

import {
  Basis,
  DateBasisDialog,
  KIND_LABEL,
  RejectBasisDialog,
  WithdrawBasisDialog,
  shortDay,
  useDateRights,
  verifyBasis,
} from "@/components/DateBasisDialog";
import { Button, Chip, DataTable, FilterChips, Notice, Page, PageHeader, type ChipKind, type Column } from "@/components/ds";
import { peopleByIds } from "@/components/PersonPicker";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage, useQuery } from "@/lib/use-query";

type Filter = "proposed" | "verified" | "withdrawn" | "all";
const STATUS: Record<Basis["status"], { label: string; kind: ChipKind }> = {
  proposed: { label: "Proposed", kind: "acc" },
  verified: { label: "Verified", kind: "pass" },
  withdrawn: { label: "Withdrawn", kind: "na" },
  rejected: { label: "Rejected", kind: "na" },
};

function forLabel(b: Basis): string {
  if (b.item_key) return `Item ${b.item_key}`;
  if (b.tracker_key) return `Items of ${b.tracker_key}`;
  return "Whole PRD";
}

/** F3 Plan › Dates: every schedule basis, grouped by PRD, with Verify, Reject and Withdraw. */
export function DatesTab() {
  const bases = useQuery("schedule-bases", () => unwrap(api.GET("/v1/schedule-bases")));
  const prds = useQuery("documents|prd", () => unwrap(api.GET("/v1/documents", { params: { query: { kind: "prd" } } })));
  const rights = useDateRights();
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [picked, setPicked] = useState<Filter | null>(null);
  const [dialog, setDialog] = useState<{ kind: "record" } | { kind: "withdraw" | "reject"; basis: Basis } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = bases.data;
  useEffect(() => {
    if (!rows) return;
    const ids = rows.flatMap((b) => [b.proposed_by, b.verified_by, b.withdrawn_by, b.rejected_by]);
    peopleByIds(ids)
      .then((people) => setNames(new Map([...people].map(([id, p]) => [id, p.name]))))
      .catch(() => setNames(new Map()));
  }, [rows]);

  const verifies = rights.data?.rights === "verify";
  const waiting = (rows ?? []).filter((b) => b.status === "proposed").length;
  const filter: Filter = picked ?? (verifies && waiting ? "proposed" : "all");
  const shown = (rows ?? []).filter((b) => filter === "all" || b.status === filter);
  const prdTitle = (id: string) => prds.data?.find((d) => d.id === id)?.title ?? "PRD";
  const who = (id: string | null | undefined) => (id ? (names.get(id) ?? "a member") : "a member");

  async function verify(b: Basis) {
    setError(null);
    try {
      await verifyBasis(b);
      await bases.reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const columns: Column<Basis>[] = [
    {
      key: "reference",
      header: "Reference",
      phone: "title",
      wrap: true,
      cell: (b) => (
        <div>
          <span className="font-semibold">{b.reference}</span>
          {b.status === "withdrawn" && b.withdrawn_at && (
            <p data-testid="withdrawn-reason" className="text-sm text-text2">
              Withdrawn by {who(b.withdrawn_by)}, {shortDay(b.withdrawn_at)}
              {b.withdrawn_reason ? `: ${b.withdrawn_reason}` : ""}
            </p>
          )}
          {b.status === "rejected" && b.rejected_at && (
            <p className="text-sm text-text2">
              Rejected by {who(b.rejected_by)}, {shortDay(b.rejected_at)}: {b.rejected_reason}
            </p>
          )}
        </div>
      ),
    },
    {
      key: "kind",
      header: "Kind",
      phone: "meta",
      cell: (b) => KIND_LABEL[b.kind],
    },
    {
      key: "date",
      header: "Supports",
      phone: "meta",
      cell: (b) => shortDay(b.supports_date),
    },
    { key: "for", header: "For", phone: "meta", cell: (b) => forLabel(b) },
    {
      key: "status",
      header: "Status",
      phone: "meta",
      cell: (b) => (
        <Chip kind={STATUS[b.status].kind} dot data-status={b.status}>
          {STATUS[b.status].label}
        </Chip>
      ),
    },
    {
      key: "by",
      header: "By",
      phone: "meta",
      wrap: true,
      cell: (b) =>
        b.status === "proposed"
          ? `Proposed by ${who(b.proposed_by)}`
          : b.verified_at
            ? `Verified by ${who(b.verified_by)}, ${shortDay(b.verified_at)}`
            : `Proposed by ${who(b.proposed_by)}`,
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      phone: "action",
      cell: (b) =>
        !verifies ? null : b.status === "proposed" ? (
          <div className="flex gap-1">
            <Button variant="solid" onClick={() => verify(b)}>
              Verify
            </Button>
            <Button variant="ghost" onClick={() => setDialog({ kind: "reject", basis: b })}>
              Reject
            </Button>
          </div>
        ) : b.status === "verified" ? (
          <Button variant="ghost" onClick={() => setDialog({ kind: "withdraw", basis: b })}>
            Withdraw
          </Button>
        ) : null,
    },
  ];

  const done = async () => {
    setDialog(null);
    await bases.reload();
  };

  return (
    <Page>
      <PageHeader
        title="Dates"
        action={
          rights.data?.rights ? (
            <Button variant="primary" icon="plus" onClick={() => setDialog({ kind: "record" })}>
              Record basis
            </Button>
          ) : null
        }
      />
      <div className="mb-3">
        <FilterChips<Filter>
          label="Status"
          testId="dates-filter"
          value={filter}
          onChange={setPicked}
          items={[
            { value: "proposed", label: "Proposed", count: waiting },
            { value: "verified", label: "Verified" },
            { value: "withdrawn", label: "Withdrawn" },
            { value: "all", label: "All" },
          ]}
        />
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {bases.error && <Notice tone="error">{bases.error}</Notice>}
      <DataTable<Basis>
        label="Date bases"
        testId="dates-table"
        columns={columns}
        rows={rows ? shown : undefined}
        loading={bases.loading}
        rowKey={(b) => b.id}
        group={(b) => b.prd_document_id}
        groupLabel={(g) => prdTitle(g)}
        rowProps={(b) => ({
          "data-basis": b.reference,
          "data-status": b.status,
        })}
        empty="No date bases here yet."
      />
      {dialog?.kind === "record" && rights.data && (
        <DateBasisDialog rights={rights.data} onClose={() => setDialog(null)} onSaved={done} />
      )}
      {dialog?.kind === "withdraw" && <WithdrawBasisDialog basis={dialog.basis} onClose={() => setDialog(null)} onDone={done} />}
      {dialog?.kind === "reject" && <RejectBasisDialog basis={dialog.basis} onClose={() => setDialog(null)} onDone={done} />}
    </Page>
  );
}
