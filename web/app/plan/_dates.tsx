"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

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

/** What a date source applies to, in the Add dialog's words; the row's title names it. */
function forLabel(b: Basis) {
  if (b.item_key) return "One item";
  if (!b.tracker_key) return "Whole PRD";
  return (
    <span className="inline-flex items-center gap-1">
      Items of one tracker issue
      <InfoTip label="tracker issue">{b.tracker_key}</InfoTip>
    </span>
  );
}

/** A name still loading: the table's own loading bar, in place of the words. */
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const NameLoading = () => <span data-testid="name-loading" aria-label="Loading" className="inline-block h-3 w-24 animate-pulse rounded bg-line-strong align-middle" />;

/** F3 Plan › Dates: every schedule basis, grouped by PRD, with Verify, Reject and Withdraw. */
export function DatesTab() {
  const bases = useQuery("schedule-bases", () => unwrap(api.GET("/v1/schedule-bases")));
  const prds = useQuery("documents|prd", () => unwrap(api.GET("/v1/documents", { params: { query: { kind: "prd" } } })));
  const rights = useDateRights();
  // The items' titles, so a row names its item as people know it (not its key).
  // Every row's title, a draft's too: a roadmap still in review has no approved rows, and a
  // basis on one of its items is named, never shown by its key (qa4-plan-3).
  const plan = useQuery("plan|all|basis", () => unwrap(api.GET("/v1/plan", { params: { query: { scope: "all" } } })));
  // walkb-roadmap review 5e: an item of a roadmap read in Simple (one built from a PRD) is
  // named from that roadmap's items when the Plan has no row for it.
  const simple = useQuery("simple|roadmap|basis", () => unwrap(api.GET("/v1/simple/roadmap")));
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [picked, setPicked] = useState<Filter | null>(null);
  const [dialog, setDialog] = useState<{ kind: "record" } | { kind: "withdraw" | "reject"; basis: Basis } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // date-warnings-honest: a roadmap's "dates lack a basis" opens this tab filtered to its
  // PRD, with the dates that need one named.
  const params = useSearchParams();
  const wantedPrd = params.get("prd");
  const lacking = (params.get("dates") ?? "").split(",").filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  // Memoised: a new array each render would re-run the people lookup below without end.
  const rows = useMemo(() => bases.data?.filter((b) => !wantedPrd || b.prd_document_id === wantedPrd), [bases.data, wantedPrd]);
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
  const itemTitle = (prd: string, key: string) => {
    const named = [...(plan.data?.items ?? []), ...(simple.data?.items ?? [])].filter((i) => i.key === key);
    // Its own PRD's item; else the key's one name, when no two items with that key differ.
    const titles = new Set(named.map((i) => i.title));
    return named.find((i) => i.prd?.id === prd)?.title ?? (titles.size === 1 ? named[0].title : undefined);
  };
  // A PRD the documents list lacks is "a PRD" (a date source carries no name of its own).
  const prdTitle = (id: string) => prds.data?.find((d) => d.id === id)?.title ?? "a PRD";
  // The items a tracker issue's date source dates: those whose engineering records it.
  const trackerTitle = (key: string) => {
    const titles = new Set((plan.data?.items ?? []).filter((i) => i.engineering.records.some((r) => r.external_ref === key)).map((i) => i.title));
    return titles.size ? [...titles].join(", ") : undefined;
  };
  const namesLoading = plan.loading || simple.loading;
  // B-07: what a date source's date is for, as people know it; never a bare code.
  const subjectOf = (b: Basis) =>
    b.item_key
      ? (itemTitle(b.prd_document_id, b.item_key) ?? "an item")
      : b.tracker_key
        ? (trackerTitle(b.tracker_key) ?? "a tracker item")
        : prdTitle(b.prd_document_id);
  // The row's title: the date is in the Date column and the PRD in the group header, so a
  // whole-PRD source reads "The whole PRD"; a name still loading shows the loading bar.
  const rowSubject = (b: Basis) => {
    if (!b.item_key && !b.tracker_key) return "The whole PRD";
    if (namesLoading && !(b.item_key ? itemTitle(b.prd_document_id, b.item_key) : trackerTitle(b.tracker_key!))) return <NameLoading />;
    return capital(subjectOf(b));
  };
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
      header: "Date source",
      phone: "title",
      wrap: true,
      cell: (b) => (
        <span data-testid="basis-title">
          <span className="font-semibold">{rowSubject(b)}</span>{" "}
          <span className="text-text2">({b.reference})</span>
        </span>
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
      // qa4-plan-32: plain headers: the date the source supports, and what it applies to.
      header: "Date",
      phone: "meta",
      cell: (b) => formatDay(b.supports_date),
    },
    { key: "for", header: "Applies to", phone: "meta", wrap: true, cell: (b) => forLabel(b) },
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
      {(wantedPrd || lacking.length > 0) && (
        <p role="status" data-testid="dates-lacking-filter" className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-button bg-warn-bg px-3 py-2 text-sm text-warn">
          <span className="min-w-0 flex-1 font-medium">
            {lacking.length > 0
              ? `${lacking.length} date${lacking.length === 1 ? " needs" : "s need"} a date source: ${lacking.map(formatDay).join(", ")}. Add a date source for ${lacking.length === 1 ? "it" : "each"}, or take ${lacking.length === 1 ? "it" : "them"} out of the roadmap.`
              : ""}
            {wantedPrd && (
              <>
                {lacking.length > 0 ? " " : ""}Showing the date sources of {prds.loading && !prds.data ? <NameLoading /> : prdTitle(wantedPrd)}.
              </>
            )}
          </span>
          <Link href="/plan/dates" className="font-medium underline underline-offset-2">
            Show every date source
          </Link>
        </p>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {bases.error && <Notice tone="error">{bases.error}</Notice>}
      <DataTable<Basis>
        label="Date sources"
        testId="dates-table"
        columns={columns}
        rows={rows ? shown : undefined}
        loading={bases.loading}
        rowKey={(b) => b.id}
        group={(b) => b.prd_document_id}
        groupLabel={(g) => (prds.loading && !prds.data ? <NameLoading /> : capital(prdTitle(g)))}
        rowProps={(b) => ({
          "data-basis": b.reference,
          "data-status": b.status,
        })}
        detail={(b) => (reasonOf(b) ? <Reason basis={b} /> : null)}
        empty="No date sources yet."
      />
      {dialog?.kind === "record" && rights.data && (
        <DateBasisDialog rights={rights.data} onClose={() => setDialog(null)} onSaved={done} />
      )}
      {dialog?.kind === "withdraw" && <WithdrawBasisDialog basis={dialog.basis} subject={subjectOf(dialog.basis)} onClose={() => setDialog(null)} onDone={done} />}
      {dialog?.kind === "reject" && <RejectBasisDialog basis={dialog.basis} subject={subjectOf(dialog.basis)} onClose={() => setDialog(null)} onDone={done} />}
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
