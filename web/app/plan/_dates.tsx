"use client";

import { useEffect, useState } from "react";

import {
  Basis,
  DateBasisDialog,
  KIND_LABEL,
  RejectBasisDialog,
  WithdrawBasisDialog,
  useDateRights,
  verifyBasis,
} from "@/components/DateBasisDialog";
import { Button, Chip, DataTable, FilterChips, InfoTip, Notice, Page, PageHeader, type ChipKind, type Column } from "@/components/ds";
import { peopleByIds } from "@/components/PersonPicker";
import { api, unwrap } from "@/lib/api/client";
import { formatDay } from "@/lib/format";
import { errorMessage, useQuery } from "@/lib/use-query";

type Filter = "proposed" | "verified" | "withdrawn" | "all";
const STATUS: Record<Basis["status"], { label: string; kind: ChipKind }> = {
  proposed: { label: "Proposed", kind: "acc" },
  verified: { label: "Verified", kind: "pass" },
  withdrawn: { label: "Withdrawn", kind: "na" },
  rejected: { label: "Rejected", kind: "na" },
};

function forLabel(b: Basis, itemTitle: (prd: string, key: string) => string | undefined): string {
  if (b.item_key) return `Item: ${itemTitle(b.prd_document_id, b.item_key) ?? b.item_key}`;
  if (b.tracker_key) return `Items of ${b.tracker_key}`;
  return "The whole PRD";
}

/** F3 Plan › Dates: every schedule basis, grouped by PRD, with Verify, Reject and Withdraw. */
export function DatesTab() {
  const bases = useQuery("schedule-bases", () => unwrap(api.GET("/v1/schedule-bases")));
  const prds = useQuery("documents|prd", () => unwrap(api.GET("/v1/documents", { params: { query: { kind: "prd" } } })));
  const rights = useDateRights();
  // The items' titles, so Applies to names an item as people know it (not its key).
  // Every row's title, a draft's too: a roadmap still in review has no approved rows, and a
  // basis on one of its items is named, never shown by its key (qa4-plan-3).
  const plan = useQuery("plan|all|basis", () => unwrap(api.GET("/v1/plan", { params: { query: { scope: "all" } } })));
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
  // qa-plan-27: every filter chip carries its count.
  const count = (s: Basis["status"]) => (rows ? rows.filter((b) => b.status === s).length : null);
  const itemTitle = (prd: string, key: string) => plan.data?.items.find((i) => i.key === key && i.prd?.id === prd)?.title;
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

  const allColumns: Column<Basis>[] = [
    {
      key: "reference",
      header: "Reference",
      phone: "title",
      wrap: true,
      cell: (b) => <span className="font-semibold">{b.reference}</span>,
    },
    {
      key: "kind",
      header: "Kind",
      phone: "meta",
      cell: (b) => KIND_LABEL[b.kind],
    },
    {
      key: "date",
      // qa4-plan-32: plain headers: the date the source supports, and what it applies to.
      header: "Date",
      phone: "meta",
      cell: (b) => formatDay(b.supports_date),
    },
    { key: "for", header: "Applies to", phone: "meta", wrap: true, cell: (b) => forLabel(b, itemTitle) },
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
      // qa-plan-26: the last thing done to the basis, and who did it.
      cell: (b) =>
        b.status === "withdrawn" && b.withdrawn_at
          ? `Withdrawn by ${who(b.withdrawn_by)}, ${formatDay(b.withdrawn_at)}`
          : b.status === "rejected" && b.rejected_at
            ? `Rejected by ${who(b.rejected_by)}, ${formatDay(b.rejected_at)}`
            : b.status !== "proposed" && b.verified_at
              ? `Verified by ${who(b.verified_by)}, ${formatDay(b.verified_at)}`
              : `Proposed by ${who(b.proposed_by)}`,
    },
    {
      key: "actions",
      // qa-plan-46: the actions column is labelled like the others.
      header: "Actions",
      phone: "action",
      cell: (b) =>
        !verifies ? null : b.status === "proposed" ? (
          <div className="flex gap-1">
            <Button variant="solid" onClick={() => verify(b)}>
              Verify
            </Button>
            {/* fix4 qa-plan-20: row actions are outlined buttons, never plain grey text. */}
            <Button variant="secondary" onClick={() => setDialog({ kind: "reject", basis: b })}>
              Reject
            </Button>
          </div>
        ) : b.status === "verified" ? (
          <Button variant="secondary" onClick={() => setDialog({ kind: "withdraw", basis: b })}>
            Withdraw
          </Button>
        ) : null,
    },
  ];
  // The actions column only for those who may act (it would be an empty, labelled column otherwise).
  const columns = verifies ? allColumns : allColumns.filter((c) => c.key !== "actions");

  const done = async () => {
    setDialog(null);
    await bases.reload();
  };

  return (
    <Page>
      {/* qa-plan-25: every Plan tab is titled Plan; the open tab names the page. */}
      <PageHeader
        title="Plan"
        info={
          <InfoTip label="Dates" align="start" side="bottom">
            Every date on the plan rests on an estimate, a capacity plan or a commitment. The engineering lead verifies
            each one before a date rests on it.
          </InfoTip>
        }
        // fix4 qa-plan-59: summary chips by the title, as the other Plan tabs have ("1 verified · 1 withdrawn").
        status={
          rows && (
            <span data-testid="dates-summary" className="contents">
              {rows.length === 0 ? (
                <Chip kind="acc">No dates yet</Chip>
              ) : (
                (["proposed", "verified", "withdrawn", "rejected"] as const)
                  .filter((st) => count(st))
                  .map((st) => (
                    <Chip key={st} kind="acc">
                      {count(st)} {STATUS[st].label.toLowerCase()}
                    </Chip>
                  ))
              )}
            </span>
          )
        }
        action={
          rights.data?.rights ? (
            <Button variant="primary" icon="plus" onClick={() => setDialog({ kind: "record" })}>
              Add a date source
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
          // fix4 qa-plan-19: one row (it scrolls sideways on a phone); a filter with nothing in it
          // is an ordinary chip reading 0, not one that looks disabled (it shows an empty table).
          oneRow
          items={[
            { value: "proposed", label: "Proposed", count: count("proposed") },
            { value: "verified", label: "Verified", count: count("verified") },
            { value: "withdrawn", label: "Withdrawn", count: count("withdrawn") },
            { value: "all", label: "All", count: rows ? rows.length : null },
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
        detail={(b) => (reasonOf(b) ? <Reason basis={b} /> : null)}
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

/**
 * qa-plan-26: why a basis was withdrawn or rejected, on its own full-width line under the row.
 * qa-plan-46: a styled sub-row of that row (an inset, tinted box with a rule on its left), so
 * it reads as part of the basis above it, not a stray line under the table.
 */
const reasonOf = (b: Basis) => (b.status === "withdrawn" ? b.withdrawn_reason : b.status === "rejected" ? b.rejected_reason : null) || null;

function Reason({ basis: b }: { basis: Basis }) {
  const reason = reasonOf(b);
  if (!reason) return null;
  return (
    <p data-testid={b.status === "withdrawn" ? "withdrawn-reason" : "rejected-reason"} data-reason-for={b.reference} className="rounded-r-lg border-l-2 border-line-strong bg-surface2 px-3 py-1.5 text-sm break-words text-text2">
      <span className="font-semibold text-text">{b.status === "withdrawn" ? "Why it was withdrawn" : "Why it was rejected"}:</span> {reason}
    </p>
  );
}
