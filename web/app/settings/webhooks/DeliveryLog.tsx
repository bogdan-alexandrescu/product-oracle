"use client";

import { useState } from "react";

import { Button, Sheet } from "@/components/ds";
import { ErrorNote, LoadError } from "@/components/ui";
import { Field, SELECT_FIELD } from "@/app/settings/_components/fields";
import { api, unwrap } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

import { answerText, eventLabel, failureText, OnTop, Outcome, type Delivery, type EventType, type Webhook } from "./parts";

const STATUSES: { value: Delivery["status"]; label: string }[] = [
  { value: "succeeded", label: "Succeeded" },
  { value: "retrying", label: "Retrying" },
  { value: "failed", label: "Failed" },
  { value: "pending", label: "Pending" },
  { value: "withheld", label: "Withheld" },
];

/**
 * A webhook's Delivery log, newest first, filtered by status and event type. QD4 a (cards and
 * fields): each delivery is a two-line card that fits the side panel, what happened in words
 * with its status, then the time, HTTP code and time taken. A card opens the body sent, the headers (the signature truncated)
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
  const rows = q.data?.items;
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
            <option value="webhook.test">{eventLabel("webhook.test", eventTypes)}</option>
            {eventTypes.map((t) => (
              <option key={t.type} value={t.type}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {q.error ? (
        <LoadError what="the deliveries" error={q.error} onRetry={() => void q.reload()} />
      ) : (
        <ul aria-label="Delivery log" data-testid="delivery-cards" className="flex flex-col divide-y divide-line rounded-lg border border-line">
          {!rows ? (
            <li className="px-3 py-2.5 text-sm text-text2">Loading deliveries…</li>
          ) : rows.length === 0 ? (
            <li className="px-3 py-2.5 text-sm text-text2">No deliveries yet</li>
          ) : (
            rows.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  data-testid="delivery-row"
                  onClick={() => setOpen(d)}
                  className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-surface2 focus-visible:outline-2 focus-visible:outline-accent"
                >
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 font-semibold break-words">{eventLabel(d.event_type, eventTypes)}</span>
                    <Outcome d={d} />
                  </span>
                  <span className="tnum text-sm text-text2" data-testid="delivery-facts">
                    {formatDateTime(d.last_at ?? d.created_at)}
                    {d.http_status != null && (
                      <>
                        {" · "}
                        <span data-testid="delivery-http" title={`HTTP ${d.http_status}`}>
                          {answerText(d.http_status)}
                        </span>
                      </>
                    )}
                    {d.duration_ms != null ? ` · ${d.duration_ms} ms` : ""}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
      <OnTop>
        <DeliverySheet
          hook={hook}
          eventTypes={eventTypes}
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

function DeliverySheet({
  hook,
  eventTypes,
  delivery,
  onClose,
  onRedelivered,
}: {
  hook: Webhook;
  eventTypes: EventType[];
  delivery: Delivery | null;
  onClose: () => void;
  onRedelivered: () => void;
}) {
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
          <span className="font-semibold">{eventLabel(d.event_type, eventTypes)}</span>
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
          <h3 className="mb-1 text-[13px] font-semibold text-text2">
            Response{d.http_status != null ? ` · ${answerText(d.http_status)}` : d.error ? ` · ${failureText(d, d.host ?? hook.host)}` : ""}
          </h3>
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
