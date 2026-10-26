"use client";

import { useState } from "react";

import { ConfirmDialog } from "@/components/account/ConfirmDialog";
import { Button, Inspector, InspectorRow, InspectorSection, Sheet } from "@/components/ds";
import { ErrorNote } from "@/components/ui";
import { Field, INPUT } from "@/app/settings/_components/fields";
import { api, unwrap } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
import { useMe } from "@/lib/me";
import { errorMessage } from "@/lib/use-query";

import { DeliveryLog } from "./DeliveryLog";
import { TestEvent } from "./NewWebhookSheet";
import { SecretOnce, WebhookStatus, type EventType, type Webhook } from "./parts";

/**
 * The selected webhook: its settings; Send test event, Rotate secret (a confirm naming the
 * 24-hour overlap), Pause or Resume, Delete (confirm by name), Take over (owners, on a
 * paused webhook of someone else); then its Delivery log.
 */
export function WebhookInspector({
  hook,
  eventTypes,
  onChanged,
  onDeleted,
}: {
  hook: Webhook;
  eventTypes: EventType[];
  onChanged: (hook: Webhook) => void;
  onDeleted: () => void;
}) {
  const { can } = useMe();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<"rotate" | "delete" | null>(null);
  const [endOld, setEndOld] = useState(false);
  const [typed, setTyped] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  // Bumped when a delivery was added here, so the log reads again.
  const [version, setVersion] = useState(0);
  const path = { params: { path: { webhook_id: hook.id } } };
  const labels = new Map(eventTypes.map((t) => [t.type, t.label]));

  async function run<T>(call: () => Promise<T>, after: (out: T) => void) {
    setBusy(true);
    setError(null);
    try {
      after(await call());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const pause = (status: "active" | "paused") =>
    run(() => unwrap(api.PATCH("/v1/webhooks/{webhook_id}", { ...path, body: { status } })), onChanged);
  const rotate = () =>
    run(
      () => unwrap(api.POST("/v1/webhooks/{webhook_id}/rotate-secret", { ...path, body: { end_old_now: endOld } })),
      (out) => {
        setAsking(null);
        setEndOld(false);
        setSecret(out.secret);
        onChanged(out.webhook);
      },
    );
  const remove = () =>
    run(
      () => unwrap(api.DELETE("/v1/webhooks/{webhook_id}", path)),
      () => {
        setAsking(null);
        onDeleted();
      },
    );
  const takeOver = () => run(() => unwrap(api.POST("/v1/webhooks/{webhook_id}/take-over", path)), onChanged);

  return (
    <Inspector testId="webhook-inspector" label={`Webhook ${hook.name}`} eyebrow="Webhook · selected" title={hook.name} chips={<WebhookStatus hook={hook} />}>
      <InspectorSection label="Settings">
        <InspectorRow value={<span className="font-normal">{hook.host}</span>}>Sends to</InspectorRow>
        <p className="mb-2 truncate font-mono text-[13px] text-text2" title={hook.url}>
          {hook.url}
        </p>
        <InspectorRow value={<span data-testid="secret-hint">…{hook.secret_hint}</span>}>Signing secret</InspectorRow>
        <InspectorRow value={<span className="font-normal text-text2">{formatDateTime(hook.secret_rotated_at)}</span>}>Secret made</InspectorRow>
        <InspectorRow value={hook.created_by.name}>Created by</InspectorRow>
        <InspectorRow value={hook.api_version}>API version</InspectorRow>
        <InspectorRow value={hook.include_approvers_content ? "On" : "Off"}>Owners-and-approvers content</InspectorRow>
        <div className="mt-2 text-[13px] leading-[18px] text-text2">
          {hook.event_types.length} event{hook.event_types.length === 1 ? "" : "s"}:{" "}
          {hook.event_types.map((t) => labels.get(t) ?? t).join(" · ")}
        </div>
      </InspectorSection>
      {can("update_webhook") && (
        <InspectorSection label="Actions">
          <div className="flex flex-col gap-3">
            <TestEvent hook={hook} onSent={() => setVersion((v) => v + 1)} />
            <div className="flex flex-wrap gap-2">
              {can("rotate_webhook_secret") && (
                <Button disabled={busy} onClick={() => setAsking("rotate")}>
                  Rotate secret
                </Button>
              )}
              {hook.status === "active" ? (
                <Button disabled={busy} icon="pause" onClick={() => void pause("paused")}>
                  Pause
                </Button>
              ) : (
                <Button disabled={busy} onClick={() => void pause("active")}>
                  Resume
                </Button>
              )}
              {hook.can_take_over && (
                <Button disabled={busy} onClick={() => void takeOver()}>
                  Take over
                </Button>
              )}
              {can("delete_webhook") && (
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() => {
                    setTyped("");
                    setAsking("delete");
                  }}
                >
                  Delete
                </Button>
              )}
            </div>
            {error && !asking && <ErrorNote>{error}</ErrorNote>}
          </div>
        </InspectorSection>
      )}
      <InspectorSection label="Delivery log">
        <DeliveryLog hook={hook} eventTypes={eventTypes} version={version} onChanged={() => setVersion((v) => v + 1)} />
      </InspectorSection>

      <ConfirmDialog
        open={asking === "rotate"}
        title="Rotate the signing secret?"
        subject={hook.name}
        testId="rotate-dialog"
        confirmLabel="Rotate"
        pendingLabel="Rotating…"
        confirmVariant="solid"
        pending={busy}
        error={error}
        onClose={() => setAsking(null)}
        onConfirm={() => void rotate()}
        consequences={[
          { icon: "lock", text: "Oracle makes a new secret and shows it once." },
          {
            icon: "clock",
            text: endOld ? "The old secret stops signing now: update the receiver first." : "For 24 hours both the old and the new secret sign each call; then only the new one does.",
          },
        ]}
      >
        <label className="flex items-center gap-2 text-[15px]">
          <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={endOld} onChange={(e) => setEndOld(e.target.checked)} />
          End the old one now
        </label>
      </ConfirmDialog>
      <ConfirmDialog
        open={asking === "delete"}
        title="Delete this webhook?"
        subject={hook.name}
        testId="delete-dialog"
        confirmLabel="Delete"
        pendingLabel="Deleting…"
        pending={busy}
        error={error}
        waiting={typed.trim() === hook.name ? null : "Delete"}
        onClose={() => setAsking(null)}
        onConfirm={() => void remove()}
        consequences={[
          { icon: "x", text: "Oracle stops sending to it at once." },
          { icon: "doc", text: "Its secret and its delivery log are deleted with it." },
        ]}
      >
        <Field label="Type the webhook's name">
          <input className={INPUT} value={typed} onChange={(e) => setTyped(e.target.value)} />
        </Field>
      </ConfirmDialog>
      <Sheet open={!!secret} title="New signing secret" onClose={() => setSecret(null)} testId="rotated-secret-sheet">
        {secret && (
          <div className="flex flex-col gap-4 p-4">
            <SecretOnce secret={secret} />
            <TestEvent hook={hook} onSent={() => setVersion((v) => v + 1)} />
            <div className="flex justify-end">
              <Button variant="primary" onClick={() => setSecret(null)}>
                Done
              </Button>
            </div>
          </div>
        )}
      </Sheet>
    </Inspector>
  );
}
