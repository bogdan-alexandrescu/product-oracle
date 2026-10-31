"use client";

import { useEffect, useState } from "react"; // MOCK-HOOK: useEffect

import { Button, type Column, DataTable, Dialog, Notice, Sheet } from "@/components/ds"; // MOCK-HOOK: Dialog
import { useMockHook } from "@/lib/mock-hook"; // MOCK-HOOK
import { ErrorNote } from "@/components/ui";
import { Field, SELECT_FIELD } from "@/app/settings/_components/fields";
import { api, unwrap } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

import { OnTop, Outcome, type Delivery, type EventType, type Webhook } from "./parts";

const STATUSES: { value: Delivery["status"]; label: string }[] = [
  { value: "succeeded", label: "Succeeded" },
  { value: "retrying", label: "Retrying" },
  { value: "failed", label: "Failed" },
  { value: "pending", label: "Pending" },
  { value: "withheld", label: "Withheld" },
];

/**
 * A webhook's Delivery log, newest first: When · Event · Status · HTTP · Time, filtered by
 * status and event type. A row opens the body sent, the headers (the signature truncated)
 * and the response, with Redeliver. Times are in the Company time zone.
 */
export function DeliveryLog({ hook, eventTypes, version, onChanged }: { hook: Webhook; eventTypes: EventType[]; version: number; onChanged: () => void }) {
  const [status, setStatus] = useState<Delivery["status"] | "">("");
  const [type, setType] = useState("");
  const [open, setOpen] = useState<Delivery | null>(null);
  const q = useQuery(`webhook-deliveries:${hook.id}:${status}:${type}:${version}`, () =>
    unwrap(
      api.GET("/v1/webhooks/{webhook_id}/deliveries", {
        params: { path: { webhook_id: hook.id }, query: { status: status || undefined, type: type || undefined } },
      }),
    ),
  );
  const qd4 = useMockHook("qd4"); // MOCK-HOOK: a cards, b open the log wide, c fewer columns
  const [wide, setWide] = useState(false); // MOCK-HOOK
  const openHook = useMockHook("open"); // MOCK-HOOK
  useEffect(() => { if (openHook === "1") setWide(true); }, [openHook]); // MOCK-HOOK
  const labelOf = (t: string) => (t === "webhook.test" ? "Test event" : eventTypes.find((e) => e.type === t)?.label ?? t); // MOCK-HOOK
  const columns: Column<Delivery>[] = qd4 === "c" ? [ // MOCK-HOOK: c, three columns that fit the panel
    { key: "when", header: "When", width: "38%", cell: (d) => <span className="tnum">{formatDateTime(d.last_at ?? d.created_at)}</span> }, // MOCK-HOOK
    { key: "event", header: "Event", cell: (d) => <span className="font-mono text-[13px] break-all whitespace-normal">{d.event_type}</span> }, // MOCK-HOOK
    { key: "status", header: "Status", width: "88px", cell: (d) => <Outcome d={d} /> }, // MOCK-HOOK
  ] : qd4 === "b" && wide ? [ // MOCK-HOOK: b, the full log has room for what each event means
    { key: "when", header: "When", width: "190px", cell: (d) => <span className="tnum">{formatDateTime(d.last_at ?? d.created_at)}</span> }, // MOCK-HOOK
    { key: "event", header: "Event", cell: (d) => <span className="flex flex-col"><span>{labelOf(d.event_type)}</span><span className="font-mono text-[13px] text-text2">{d.event_type}</span></span> }, // MOCK-HOOK
    { key: "status", header: "Status", width: "110px", cell: (d) => <Outcome d={d} /> }, // MOCK-HOOK
    { key: "http", header: "HTTP", width: "70px", align: "right", cell: (d) => <span className="tnum text-text2">{d.http_status ?? "–"}</span> }, // MOCK-HOOK
    { key: "time", header: "Time", width: "80px", align: "right", cell: (d) => <span className="tnum text-text2">{d.duration_ms != null ? `${d.duration_ms} ms` : "–"}</span> }, // MOCK-HOOK
    { key: "tries", header: "Tries", width: "60px", align: "right", cell: (d) => <span className="tnum text-text2">{d.attempts}</span> }, // MOCK-HOOK
  ] : [ // MOCK-HOOK
    { key: "when", header: "When", width: "34%", cell: (d) => <span className="tnum truncate">{formatDateTime(d.last_at ?? d.created_at)}</span> },
    { key: "event", header: "Event", cell: (d) => <span className="truncate font-mono text-[13px]" title={d.event_id}>{d.event_type}</span> },
    { key: "status", header: "Status", width: "88px", cell: (d) => <Outcome d={d} /> },
    {
      key: "http",
      header: "HTTP",
      width: "56px",
      align: "right",
      hideOnPhone: true,
      cell: (d) => (
        <span className="tnum text-text2" data-testid="delivery-http">
          {d.http_status ?? "–"}
        </span>
      ),
    },
    { key: "time", header: "Time", width: "64px", align: "right", hideOnPhone: true, cell: (d) => <span className="tnum text-text2">{d.duration_ms != null ? `${d.duration_ms} ms` : "–"}</span> },
  ];
  const filters = ( // MOCK-HOOK: the filters, shared by every variant
      <div className="grid grid-cols-2 gap-2">
        <Field label="Status">
          <select className={SELECT_FIELD} value={status} onChange={(e) => setStatus(e.target.value as Delivery["status"] | "")}>
            <option value="">All</option>
            {STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Event">
          <select className={SELECT_FIELD} value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All</option>
            <option value="webhook.test">webhook.test</option>
            {eventTypes.map((t) => (
              <option key={t.type} value={t.type}>
                {t.type}
              </option>
            ))}
          </select>
        </Field>
      </div>
  ); // MOCK-HOOK
  const rows = q.data?.items ?? []; // MOCK-HOOK
  const table = ( // MOCK-HOOK
        <DataTable label="Delivery log" columns={columns} rows={q.data?.items} loading={q.loading && !q.data} rowKey={(d) => d.id} onSelect={(_, d) => setOpen(d)} rowProps={() => ({ "data-testid": "delivery-row" })} empty="No deliveries yet" /> // MOCK-HOOK
  ); // MOCK-HOOK
  return (
    <div className="flex flex-col gap-2" data-testid="delivery-log">
      {qd4 !== "b" && filters} {/* MOCK-HOOK */}
      <p className="text-[13px] leading-[18px] text-text2">Times are in Company time.</p>
      {qd4 === "a" ? ( // MOCK-HOOK: a, each delivery a two-line card that fits the panel
        <ul className="flex flex-col divide-y divide-line rounded-lg border border-line" data-testid="delivery-cards"> {/* MOCK-HOOK */}
          {rows.length === 0 && <li className="px-3 py-2.5 text-sm text-text2">No deliveries yet</li>} {/* MOCK-HOOK */}
          {rows.map((d) => ( // MOCK-HOOK
            <li key={d.id}> {/* MOCK-HOOK */}
              <button type="button" data-testid="delivery-row" onClick={() => setOpen(d)} className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-surface2"> {/* MOCK-HOOK */}
                <span className="flex items-center gap-2"><span className="min-w-0 flex-1 font-semibold">{labelOf(d.event_type)}</span><Outcome d={d} /></span> {/* MOCK-HOOK */}
                <span className="tnum text-sm text-text2">{formatDateTime(d.last_at ?? d.created_at)}{d.http_status != null ? ` · HTTP ${d.http_status}` : ""}{d.duration_ms != null ? ` · ${d.duration_ms} ms` : ""}</span> {/* MOCK-HOOK */}
              </button> {/* MOCK-HOOK */}
            </li> // MOCK-HOOK
          ))} {/* MOCK-HOOK */}
        </ul> // MOCK-HOOK
      ) : qd4 === "b" ? ( // MOCK-HOOK: b, a summary here and the whole log in a wide window
        <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface2 p-3"> {/* MOCK-HOOK */}
          <p className="text-[15px]"><b className="tnum">{rows.length}</b> deliveries · <b className="tnum">{rows.filter((d) => d.status === "failed" || d.status === "retrying").length}</b> failed or retrying</p> {/* MOCK-HOOK */}
          {rows[0] && <p className="text-sm text-text2">Last: {labelOf(rows[0].event_type)}, {formatDateTime(rows[0].last_at ?? rows[0].created_at)}</p>} {/* MOCK-HOOK */}
          <span><Button onClick={() => setWide(true)} data-testid="open-delivery-log">Open the delivery log</Button></span> {/* MOCK-HOOK */}
          {wide && ( // MOCK-HOOK
            <Dialog title={`Delivery log · ${hook.name}`} size="lg" onClose={() => setWide(false)} cancelLabel="Close" testId="delivery-log-wide"> {/* MOCK-HOOK */}
              <div className="flex flex-col gap-2">{filters}<p className="text-[13px] text-text2">Times are in Company time.</p>{table}</div> {/* MOCK-HOOK */}
            </Dialog> // MOCK-HOOK
          )} {/* MOCK-HOOK */}
        </div> // MOCK-HOOK
      ) : q.error ? (
        <Notice tone="error">{q.error}</Notice>
      ) : (
        <DataTable
          label="Delivery log"
          columns={columns}
          rows={q.data?.items}
          loading={q.loading && !q.data}
          rowKey={(d) => d.id}
          onSelect={(_, d) => setOpen(d)}
          rowProps={() => ({ "data-testid": "delivery-row" })}
          empty="No deliveries yet"
        />
      )}
      <OnTop>
        <DeliverySheet
          hook={hook}
          delivery={open}
          onClose={() => setOpen(null)}
          onRedelivered={() => {
            setOpen(null);
            onChanged();
            void q.reload();
          }}
        />
      </OnTop>
    </div>
  );
}

function DeliverySheet({ hook, delivery, onClose, onRedelivered }: { hook: Webhook; delivery: Delivery | null; onClose: () => void; onRedelivered: () => void }) {
  const { can } = useMe();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!delivery) return null;
  const d = delivery;
  const ts = d.last_at ? Math.floor(Date.parse(d.last_at) / 1000) : null;
  const headers = [
    `webhook-id: ${d.event_id}`,
    ...(ts != null ? [`webhook-timestamp: ${ts}`] : []),
    "webhook-signature: v1,…",
    "content-type: application/json",
    "user-agent: ProductOracle-Webhooks/1",
  ];
  async function redeliver() {
    setBusy(true);
    setError(null);
    try {
      await unwrap(
        api.POST("/v1/webhooks/{webhook_id}/deliveries/{delivery_id}/redeliver", { params: { path: { webhook_id: hook.id, delivery_id: d.id } } }),
      );
      onRedelivered();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const pre = "max-h-60 overflow-auto rounded-lg bg-surface2 p-3 font-mono text-[13px] leading-5 whitespace-pre-wrap break-all";
  return (
    <Sheet open title="Delivery" onClose={onClose} testId="delivery-sheet">
      <div className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2 text-[15px]">
          <span className="font-mono text-[13px]">{d.event_type}</span>
          <Outcome d={d} />
          <span className="text-text2">
            {formatDateTime(d.last_at ?? d.created_at)} · Company time · attempt {d.attempts}
          </span>
        </div>
        <section>
          <h3 className="mb-1 text-[13px] font-semibold text-text2">Headers</h3>
          <pre className={pre} data-testid="delivery-headers">
            {headers.join("\n")}
          </pre>
        </section>
        <section>
          <h3 className="mb-1 text-[13px] font-semibold text-text2">Body sent</h3>
          <pre className={pre} data-testid="delivery-body">
            {d.body ? JSON.stringify(d.body, null, 2) : "Not sent yet"}
          </pre>
        </section>
        <section>
          <h3 className="mb-1 text-[13px] font-semibold text-text2">Response{d.http_status != null ? ` · HTTP ${d.http_status}` : d.error ? ` · ${d.error}` : ""}</h3>
          {/* Text only: a receiver's answer is never rendered as HTML. */}
          <pre className={pre} data-testid="delivery-response">
            {d.response_excerpt ?? "No response"}
          </pre>
        </section>
        {error && <ErrorNote>{error}</ErrorNote>}
        {can("redeliver_webhook_delivery") && (
          <div className="flex justify-end">
            <Button variant="primary" disabled={busy} onClick={() => void redeliver()}>
              {busy ? "Redelivering…" : "Redeliver"}
            </Button>
          </div>
        )}
      </div>
    </Sheet>
  );
}
