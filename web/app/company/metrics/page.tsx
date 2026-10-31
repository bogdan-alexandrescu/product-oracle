"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, useSyncExternalStore } from "react";

import { Button, Chip, type Column, DataTable, InfoTip, PageSkeleton, Panel, Sheet, Sparkline, Split, ViewOnly } from "@/components/ds";
import { ErrorNote } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";

import { CompanyEmpty } from "../_empty";
import { CompanyHeader } from "../_nav";
import { KIND_LABEL, SOURCE_LABEL, STATUS_KIND, STATUS_LABEL, VARIANCE_KIND, VARIANCE_LABEL, changeText, valueText, type Metric } from "./_components/lib";
import { MetricForm } from "./_components/MetricForm";
import { MetricInspector } from "./_components/MetricInspector";

const PHONE = "(max-width: 600px)";

function subscribePhone(onChange: () => void) {
  const mq = window.matchMedia(PHONE);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function useIsPhone(): boolean {
  return useSyncExternalStore(
    subscribePhone,
    () => window.matchMedia(PHONE).matches,
    () => false,
  );
}

export default function MetricsPage() {
  return (
    <Suspense fallback={<PageSkeleton bare />}>
      <Metrics />
    </Suspense>
  );
}

/**
 * Company › Metrics (H5): the numbers Oracle reads every week. Outputs first, each followed
 * by the inputs that drive it (indented); the inspector on the right (a sheet on a phone).
 * Approvers and owners add and change metrics; everyone else reads the page as View only.
 */
function Metrics() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { me, can } = useMe();
  const phone = useIsPhone();
  const [form, setForm] = useState<"add" | "edit" | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [archived, setArchived] = useState(false);
  const listQ = useQuery(`metrics|${archived}`, () => unwrap(api.GET("/v1/metrics", { params: { query: { include_archived: archived } } })), { keepPrevious: true });
  const rows = listQ.data ?? [];
  const writer = can("create_metric");
  // The metric's owner (any role) records the values of a metric typed by hand or by API: the
  // page is View only for them only when they own no such metric.
  const records = rows.some((m) => m.source !== "posthog" && m.status !== "archived" && can("record_metric_value", m.owner_id === me?.user_id));
  const goalsQ = useQuery("metric-goals", () => unwrap(api.GET("/v1/baseline/entities", { params: { query: { type: "goal", status: "confirmed" } } })));
  const peopleQ = useQuery(`metric-people|${writer}`, () =>
    writer ? unwrap(api.GET("/v1/people", { params: { query: { limit: 100 } } })) : Promise.resolve([] as Schemas["PersonOut"][]),
  );
  const goals = goalsQ.data ?? [];
  const picked = params.get("metric");
  const selected = rows.find((m) => m.id === picked) ?? (phone || picked ? undefined : rows[0]);
  const selectedId = picked ?? selected?.id ?? null;
  const detailQ = useQuery(
    `metric|${selectedId ?? "none"}`,
    () => (selectedId ? unwrap(api.GET("/v1/metrics/{metric_id}", { params: { path: { metric_id: selectedId } } })) : Promise.resolve(null)),
    { keepPrevious: true },
  );
  const detail = detailQ.data && detailQ.data.id === selectedId ? detailQ.data : null;

  const select = (m: Metric) => {
    router.replace(`${pathname}?metric=${m.id}`, { scroll: false });
    if (phone) setSheetOpen(true);
  };
  async function changed() {
    // qa4-company-4: a linked goal takes the metric's latest weekly value, so its distance to go is read again.
    await Promise.all([listQ.reload(), detailQ.reload(), goalsQ.reload()]);
  }

  // qa4-company-3: the Metric column takes the room left; in a narrow table (the inspector
  // beside it) Kind, Owner, Source and then the sparkline give way, so a name is not cut to "Ac…".
  const columns: Column<Metric>[] = [
    {
      key: "title",
      header: "Metric",
      phone: "title",
      cell: (m) => <span className={`truncate font-medium ${m.kind === "input" ? "pl-5 max-[600px]:pl-3" : ""}`}>{m.title}</span>,
    },
    { key: "kind", header: "Kind", width: "84px", phone: "hide", narrow: "mid", cell: (m) => <span className="text-sm text-text2">{KIND_LABEL[m.kind]}</span> },
    {
      key: "last",
      header: "Last week",
      width: "120px",
      phone: "meta",
      phoneLabel: "Last week",
      cell: (m) => (
        <span className="tnum text-sm" data-col="last">
          {valueText(m.last_week?.value, m.unit)}
        </span>
      ),
    },
    {
      key: "change",
      header: "Change",
      width: "140px",
      phone: "meta",
      cell: (m) =>
        m.change ? (
          <span className="flex min-w-0 items-center gap-1.5 text-sm" data-col="change">
            <span className="tnum truncate">{changeText(m.change.value, m.change.pct)}</span>
            {m.change.variance && <Chip kind={VARIANCE_KIND[m.change.variance]}>{VARIANCE_LABEL[m.change.variance]}</Chip>}
          </span>
        ) : (
          // qa4-company-42: on a phone the column has no header, so the dash says what it means.
          <span className="text-sm text-text2" data-col="change">
            <span className="max-[600px]:hidden">—</span>
            <span className="hidden max-[600px]:inline">No change yet</span>
          </span>
        ),
    },
    {
      key: "spark",
      header: "12 weeks",
      width: "116px",
      phone: "hide",
      narrow: "hide",
      cell: (m) => {
        const known = m.spark.filter((v): v is number => v != null);
        return known.length > 1 ? <Sparkline values={known} label={`Trend ${known.join(", ")}`} /> : <span className="text-sm text-text2">—</span>;
      },
    },
    { key: "owner", header: "Owner", width: "120px", phone: "hide", narrow: "mid", cell: (m) => <span className="truncate text-sm">{m.owner_name ?? "—"}</span> },
    { key: "source", header: "Source", width: "92px", phone: "hide", narrow: "wide", cell: (m) => <span className="text-sm text-text2">{SOURCE_LABEL[m.source]}</span> },
    {
      key: "state",
      header: "State",
      width: "104px",
      phone: "hide",
      cell: (m) => (
        <Chip kind={STATUS_KIND[m.status]} dot>
          {STATUS_LABEL[m.status]}
        </Chip>
      ),
    },
  ];

  const inspector = detail ? (
    <MetricInspector key={detail.id} metric={detail} metrics={rows} goals={goals} onEdit={() => setForm("edit")} onChanged={changed} />
  ) : null;

  return (
    <>
      <CompanyHeader
        status={!writer && !records && <ViewOnly />}
        action={
          // qa-company-20: while the empty state shows its own Add button, the header has none.
          writer &&
          !(listQ.data && rows.length === 0) && (
            <Button variant="primary" icon="plus" onClick={() => setForm("add")}>
              Add metric
            </Button>
          )
        }
      />
      {listQ.error && <ErrorNote>{listQ.error}</ErrorNote>}
      <Split inspector={!phone ? inspector : undefined}>
        <Panel
          title="Metrics"
          count={listQ.data ? rows.length : undefined}
          tools={
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-sm text-text2">
                <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
                Archived
              </label>
              <InfoTip label="metrics" align="end">
                The numbers Oracle reads every week, Monday to Sunday in the Company time zone. Outputs are results the company wants; inputs are
                numbers the team can move, listed under the output they drive. A week whose change is outside the normal range is a variance,
                and the metric&apos;s owner explains it in the Weekly metrics review.
              </InfoTip>
            </div>
          }
        >
          {listQ.data && rows.length === 0 ? (
            // qa-company-16: how this page relates to the goal values on Home, and what to add.
            <CompanyEmpty
              testId="metrics-empty"
              title="No metrics yet"
              action={
                writer ? (
                  <Button icon="plus" onClick={() => setForm("add")}>
                    Add your first metric
                  </Button>
                ) : undefined
              }
            >
              The goal values on Home come from each goal. Add a metric here to track a number every week, read from your product
              analytics, typed by hand or sent by API. A metric linked to a goal keeps that goal&apos;s current value up to date, and Oracle
              flags a week that changes more than usual.{writer ? "" : " Approvers and owners add metrics."}
            </CompanyEmpty>
          ) : (
            <DataTable
              label="Metrics"
              testId="metrics-table"
              columns={columns}
              rows={listQ.data ? rows : undefined}
              loading={listQ.loading}
              rowKey={(m) => m.id}
              selected={phone ? (sheetOpen ? (selected?.id ?? null) : null) : (selected?.id ?? null)}
              onSelect={(_, m) => select(m)}
              rowProps={(m) => ({ "data-testid": "metric-row", "data-kind": m.kind })}
            />
          )}
        </Panel>
      </Split>
      {phone && (
        <Sheet open={sheetOpen && !!detail} title="Metric" onClose={() => setSheetOpen(false)} testId="metric-sheet">
          {inspector}
        </Sheet>
      )}
      {form && writer && (
        <MetricForm
          metric={form === "edit" ? detail : null}
          metrics={rows}
          goals={goals}
          people={peopleQ.data ?? []}
          onClose={() => setForm(null)}
          onSaved={async (m) => {
            setForm(null);
            router.replace(`${pathname}?metric=${m.id}`, { scroll: false });
            await changed();
          }}
        />
      )}
    </>
  );
}
