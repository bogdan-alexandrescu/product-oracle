"use client";

import { useState } from "react";

import { Button, Sheet } from "@/components/ds";
import { ErrorNote } from "@/components/ui";
import { Field, INPUT, TEXTAREA } from "@/app/settings/_components/fields";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/use-query";

import { failureText, GROUPS, outcomeText, SecretOnce, type Delivery, type EventType, type Webhook } from "./parts";

/**
 * New webhook (I1): Name, URL, the events grouped Runs · Drafts · Approvals with "All" per
 * group; for owners, Include owners-and-approvers content with a required Why (Q2). Create,
 * then the secret once with Copy and Send test event. Fields stack in one column, so the
 * sheet reads the same on a phone.
 */
export function NewWebhookSheet({
  open,
  onClose,
  eventTypes,
  ownerChoices,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  eventTypes: EventType[];
  /** Owners only (Q2): may include owners-and-approvers content. */
  ownerChoices: boolean;
  onCreated: (hook: Webhook) => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [types, setTypes] = useState<string[]>([]);
  const [approvers, setApprovers] = useState(false);
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ webhook: Webhook; secret: string } | null>(null);

  function close() {
    setName("");
    setUrl("");
    setTypes([]);
    setApprovers(false);
    setWhy("");
    setError(null);
    setCreated(null);
    onClose();
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const out = await unwrap(
        api.POST("/v1/webhooks", {
          body: { name, url, event_types: types, include_approvers_content: approvers, reason: approvers ? why : null },
        }),
      );
      setCreated(out);
      onCreated(out.webhook);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  // qa4-settings-30: Create names what it still needs, not just greyed out.
  const missing = !name.trim()
    ? "Add a name"
    : !url.trim()
      ? "Add a URL"
      : types.length === 0
        ? "Pick at least one event"
        : approvers && !why.trim()
          ? "Say why it sends owners-and-approvers content"
          : null;
  const ready = !missing;

  return (
    <Sheet open={open} dialog title={created ? "Webhook created" : "New webhook"} onClose={close} testId="new-webhook-sheet">
      {created ? (
        <div className="flex flex-col gap-4 p-4">
          <p className="text-[15px]">
            <b>{created.webhook.name}</b> sends to {created.webhook.host}.
          </p>
          <SecretOnce secret={created.secret} />
          <TestEvent hook={created.webhook} />
          <div className="flex justify-end">
            <Button variant="primary" onClick={close}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="flex flex-col gap-4 p-4 sm:max-w-[640px]"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) void create();
          }}
        >
          <WebhookFields
            eventTypes={eventTypes}
            name={name}
            setName={setName}
            url={url}
            setUrl={setUrl}
            types={types}
            setTypes={setTypes}
            approvers={ownerChoices ? approvers : null}
            setApprovers={setApprovers}
            why={why}
            setWhy={setWhy}
            askWhy={approvers}
            autoFocus
          />
          {error && <ErrorNote>{error}</ErrorNote>}
          {/* qa4-settings-30: the footer stays in view while the events scroll. */}
          <div className="sticky bottom-0 z-[2] -mx-4 -mb-4 flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface px-4 py-3">
            {missing && (
              <span className="mr-auto text-[13px] leading-[18px] text-text2" data-testid="create-missing">
                {missing}
              </span>
            )}
            <Button onClick={close}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={!ready || busy}>
              {busy ? "Creating…" : "Create"}
            </Button>
          </div>
        </form>
      )}
    </Sheet>
  );
}

/** Send test event: a webhook.test event to this webhook only, now; its outcome in place. */
export function TestEvent({ hook, onSent }: { hook: Webhook; onSent?: (d: Delivery) => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Delivery | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function send() {
    setBusy(true);
    setError(null);
    try {
      const d = await unwrap(api.POST("/v1/webhooks/{webhook_id}/test", { params: { path: { webhook_id: hook.id } } }));
      setResult(d);
      onSent?.(d);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button onClick={() => void send()} disabled={busy}>
        {busy ? "Sending…" : result && (result.status === "failed" || result.status === "retrying") ? "Try again" : "Send test event"}
      </Button>
      {/* qa4-settings-25: a failure in words, never the raw error code. */}
      {result && (
        <span className="text-[15px] font-semibold" data-testid="test-result">
          {result.status === "failed" || result.status === "retrying" ? `✕ ${failureText(result, hook.host)}` : outcomeText(result)}
        </span>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}

/**
 * A webhook's Name, URL, its events grouped Runs · Drafts · Approvals with "All" per group,
 * and (owners: `approvers` not null) Include owners-and-approvers content with a Why.
 * New webhook and Edit webhook share them; they stack in one column on a phone too.
 */
export function WebhookFields({
  eventTypes,
  name,
  setName,
  url,
  setUrl,
  types,
  setTypes,
  approvers,
  setApprovers,
  why,
  setWhy,
  askWhy,
  autoFocus = false,
}: {
  eventTypes: EventType[];
  name: string;
  setName: (v: string) => void;
  url: string;
  setUrl: (v: string) => void;
  types: string[];
  setTypes: (f: (prev: string[]) => string[]) => void;
  /** null: no switch (not an owner). */
  approvers: boolean | null;
  setApprovers: (v: boolean) => void;
  why: string;
  setWhy: (v: string) => void;
  /** The switch changed: a Why is required. */
  askWhy: boolean;
  autoFocus?: boolean;
}) {
  const toggle = (t: string, on: boolean) => setTypes((prev) => (on ? [...new Set([...prev, t])] : prev.filter((x) => x !== t)));
  return (
    <>
      <Field label="Name">
        <input className={INPUT} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} data-autofocus={autoFocus || undefined} />
      </Field>
      <Field label="URL">
        <input className={INPUT} value={url} inputMode="url" placeholder="https://" onChange={(e) => setUrl(e.target.value)} />
      </Field>
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-[13px] leading-4 font-semibold tracking-[0.02em] text-text2">Events</legend>
        {GROUPS.map((g) => {
          const of = eventTypes.filter((t) => t.group === g.id);
          if (!of.length) return null;
          const all = of.every((t) => types.includes(t.type));
          return (
            <div key={g.id} className="flex flex-col gap-1.5" data-testid={`events-${g.id}`}>
              <label className="flex items-center gap-2 text-[15px] font-semibold">
                <input
                  type="checkbox"
                  aria-label={`All ${g.label}`}
                  className="size-4 accent-[var(--accent)]"
                  checked={all}
                  onChange={(e) => of.forEach((t) => toggle(t.type, e.target.checked))}
                />
                {g.label} <span className="font-normal text-text2">· All</span>
              </label>
              {of.map((t) => (
                <label key={t.type} className="flex items-start gap-2 pl-6 text-[15px]" title={t.type}>
                  <input
                    type="checkbox"
                    className="mt-1 size-4 flex-none accent-[var(--accent)]"
                    checked={types.includes(t.type)}
                    onChange={(e) => toggle(t.type, e.target.checked)}
                  />
                  <span className="min-w-0">{t.label}</span>
                </label>
              ))}
            </div>
          );
        })}
      </fieldset>
      {approvers !== null && (
        <div className="flex flex-col gap-2">
          <label className="inline-flex items-center gap-2 text-[15px] font-semibold">
            <input type="checkbox" role="switch" className="size-4 accent-[var(--accent)]" checked={approvers} onChange={(e) => setApprovers(e.target.checked)} />
            Include owners-and-approvers content
          </label>
          {/* qa4-settings-31: what is sent and who sees it, in plain words. */}
          <p className="text-[13px] leading-[18px] text-text2" data-testid="approvers-content-help">
            Also sends events that only owners and approvers can see in Oracle: updates, pricing memos, and their runs, checkpoints and
            approvals. Anyone who can read the receiving tool will see them. Turning it on or off needs a reason, which Oracle keeps with the change.
          </p>
          {askWhy && (
            <Field label="Why">
              <textarea className={TEXTAREA} rows={2} maxLength={500} value={why} onChange={(e) => setWhy(e.target.value)} />
            </Field>
          )}
        </div>
      )}
    </>
  );
}
