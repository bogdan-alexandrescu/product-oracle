"use client";

import { useState } from "react";

import { Button, DataTable, Empty, InfoTip, Panel, confirmInPage, type Column } from "@/components/ds";
import { ErrorNote, INPUT } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { addDays, todayIn, useCompanyZone } from "@/lib/dates";
import { formatDate } from "@/lib/format";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

import { RowMenu, RowMenuItem } from "../../updates/_components/RowMenu";
import { DealDialog } from "./DealDialog";
import { ImportDialog } from "./ImportDialog";
import { alternativeLabel, alternativeOf, REASONS, RESULTS, type Deal, type Reason, type Result } from "./lib";

type Period = "all" | "90" | "180" | "365";
const PERIODS: { value: Period; label: string }[] = [
  { value: "all", label: "Any time" },
  { value: "90", label: "Last 3 months" },
  { value: "180", label: "Last 6 months" },
  { value: "365", label: "Last 12 months" },
];

/**
 * Company › Market › Win and loss (H9; owners and approvers): one deal's result and its main
 * reason per row, entered here or imported from a CSV file. No contact details: an account
 * is the label as given, and Oracle never looks it up.
 */
export function WinLoss() {
  const zone = useCompanyZone();
  // #370: each control is drawn only when its operation is allowed.
  const { can } = useMe();
  const mayAdd = can("create_deal_outcome");
  const mayImport = can("import_deal_outcomes");
  const mayEdit = can("update_deal_outcome");
  const mayDelete = can("delete_deal_outcome");
  const [result, setResult] = useState<Result | "">("");
  const [reason, setReason] = useState<Reason | "">("");
  const [period, setPeriod] = useState<Period>("all");
  const [alternative, setAlternative] = useState("");
  // H7's alternatives, archived ones too: an old record keeps its link and stays findable.
  const mayListAlternatives = can("list_competitors");
  const alternatives = useQuery(`competitors|all|${mayListAlternatives}`, () =>
    mayListAlternatives ? unwrap(api.GET("/v1/competitors", { params: { query: { include_archived: true } } })) : Promise.resolve([]),
  );
  const from = period === "all" ? undefined : addDays(todayIn(zone), -Number(period));
  const query = { result: result || undefined, reason: reason || undefined, from, competitor_id: alternative || undefined };
  const q = useQuery(`deal-outcomes|${result}|${reason}|${from ?? ""}|${alternative}`, () => unwrap(api.GET("/v1/deal-outcomes", { params: { query } })), { keepPrevious: true });
  const [editing, setEditing] = useState<Deal | "new" | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove(d: Deal) {
    const yes = await confirmInPage({
      action: "Delete record",
      message: `Delete ${RESULTS[d.result]} · ${d.account} · ${formatDate(d.decided_on)}? Memos already written keep their counts.`,
      destructive: true,
    });
    if (!yes) return;
    try {
      await unwrap(api.DELETE("/v1/deal-outcomes/{outcome_id}", { params: { path: { outcome_id: d.id } } }));
      q.reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const columns: Column<Deal>[] = [
    { key: "decided", header: `Decided on (${zone})`, width: "200px", phone: "hide", cell: (d) => <span className="tnum text-sm">{formatDate(d.decided_on)}</span> },
    { key: "result", header: "Result", width: "120px", phone: "title", cell: (d) => <span className="font-medium" data-testid="deal-result">{RESULTS[d.result]}</span> },
    { key: "account", header: "Account", phone: "hide", cell: (d) => <span className="truncate text-sm" data-testid="deal-account">{d.account}</span> },
    { key: "plan", header: "Plan", width: "120px", phone: "hide", cell: (d) => <span className="text-sm">{d.plan ?? "—"}</span> },
    { key: "reason", header: "Reason", width: "180px", phone: "meta", cell: (d) => <span className="text-sm" data-testid="deal-reason">{REASONS[d.reason]}</span> },
    { key: "alternative", header: "Alternative", width: "160px", phone: "hide", cell: (d) => <span className="text-sm text-text2" data-testid="deal-alternative">{alternativeOf(d) ?? "—"}</span> },
  ];
  if (mayEdit || mayDelete) {
    columns.push({
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      width: "56px",
      phone: "action",
      cell: (d) => (
        <RowMenu label={`Actions for ${d.account}`}>
          {(close) => (
            <>
              {mayEdit && (
                <RowMenuItem
                  onClick={() => {
                    close();
                    setEditing(d);
                  }}
                >
                  Edit
                </RowMenuItem>
              )}
              {mayDelete && (
                <RowMenuItem
                  onClick={() => {
                    close();
                    void remove(d);
                  }}
                >
                  Delete
                </RowMenuItem>
              )}
            </>
          )}
        </RowMenu>
      ),
    });
  }

  return (
    <>
      {(q.error || error) && <ErrorNote>{q.error ?? error}</ErrorNote>}
      <Panel
        title="Win and loss"
        count={q.data ? q.data.length : undefined}
        tools={
          <div className="flex flex-wrap items-center gap-2">
            <InfoTip label="win and loss" align="end">
              One deal&apos;s result and its main reason: Won, Lost, No decision or Churned. Enter it here or import a CSV file. No contact details;
              Oracle never looks an account up. Pricing memos count these records. Owners and approvers see them.
            </InfoTip>
            {mayAdd && (
              <Button icon="plus" onClick={() => setEditing("new")}>
                Add
              </Button>
            )}
            {mayImport && <Button onClick={() => setImporting(true)}>Import CSV</Button>}
          </div>
        }
      >
        <div className="flex flex-wrap items-end gap-3 border-b border-line px-4 py-3 max-[600px]:px-3">
          <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
            Result
            <select className={`${INPUT} w-40`} value={result} onChange={(e) => setResult(e.target.value as Result | "")}>
              <option value="">Any result</option>
              {(Object.keys(RESULTS) as Result[]).map((r) => (
                <option key={r} value={r}>
                  {RESULTS[r]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
            Reason
            <select className={`${INPUT} w-48`} value={reason} onChange={(e) => setReason(e.target.value as Reason | "")}>
              <option value="">Any reason</option>
              {(Object.keys(REASONS) as Reason[]).map((r) => (
                <option key={r} value={r}>
                  {REASONS[r]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
            Period
            <select className={`${INPUT} w-44`} value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
              {PERIODS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          {alternatives.data && alternatives.data.length > 0 && (
            <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
              Alternative
              <select className={`${INPUT} w-48`} value={alternative} onChange={(e) => setAlternative(e.target.value)}>
                <option value="">Any alternative</option>
                {alternatives.data.map((c) => (
                  <option key={c.id} value={c.id}>
                    {alternativeLabel(c)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {q.data && q.data.length === 0 ? (
          <Empty testId="deals-empty">No win or loss records{result || reason || alternative || period !== "all" ? " match" : " yet"}</Empty>
        ) : (
          <DataTable
            label="Win and loss"
            testId="deals-table"
            columns={columns}
            rows={q.data}
            loading={q.loading}
            rowKey={(d) => d.id}
            rowProps={() => ({ "data-testid": "deal-row" })}
          />
        )}
      </Panel>
      {editing && (
        <DealDialog
          deal={editing === "new" ? null : editing}
          alternatives={alternatives.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            q.reload();
          }}
        />
      )}
      {importing && (
        <ImportDialog
          onClose={() => setImporting(false)}
          onImported={() => {
            setImporting(false);
            q.reload();
          }}
        />
      )}
    </>
  );
}
