"use client";

import { useState } from "react";

import { Button, type Column, DataTable, Notice, Sheet } from "@/components/ds";
import { ErrorNote } from "@/components/ui";
import { Field, SELECT_FIELD } from "@/app/settings/_components/fields";
import { api, unwrap } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

import { Outcome, type Delivery, type EventType, type Webhook } from "./parts";

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
  const columns: Column<Delivery>[] = [
    { key: "when", header: "When", width: "40%", cell: (d) => <span className="tnum truncate">{formatDateTime(d.last_at ?? d.created_at)}</span> },
    { key: "event", header: "Event", cell: (d) => <span className="truncate font-mono text-[13px]" title={d.event_id}>{d.event_type}</span> },
    { key: "status", header: "Status", width: "88px", cell: (d) => <Outcome d={d} /> },
    { key: "time", header: "Time", width: "64px", align: "right", hideOnPhone: true, cell: (d) => <span className="tnum text-text2">{d.duration_ms != null ? `${d.duration_ms} ms` : "–"}</span> },
  ];
  return (
    <div className="flex flex-col gap-2" data-testid="delivery-log">
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
      {q.error ? (
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
