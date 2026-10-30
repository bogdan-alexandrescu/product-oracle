"use client";

import { useState } from "react";

import { Button, Sheet } from "@/components/ds";
import { ErrorNote } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/use-query";

import { WebhookFields } from "./NewWebhookSheet";
import type { EventType, Webhook } from "./parts";

/**
 * Edit webhook: its Name, URL and events, sent with PATCH; for owners (`ownerChoices`), the
 * owners-and-approvers switch, on or off, with a required Why when it changes (Q2). The API
 * tells owners when an approver changes where a webhook sends.
 */
export function EditWebhookSheet({
  hook,
  open,
  onClose,
  eventTypes,
  ownerChoices,
  onSaved,
}: {
  hook: Webhook;
  open: boolean;
  onClose: () => void;
  eventTypes: EventType[];
  ownerChoices: boolean;
  onSaved: (hook: Webhook) => void;
}) {
  return (
    <Sheet open={open} dialog title="Edit webhook" onClose={onClose} testId="edit-webhook-sheet">
      {/* Mounted while open only, so each opening starts from the webhook as it is now. */}
      {open && <EditForm hook={hook} eventTypes={eventTypes} ownerChoices={ownerChoices} onClose={onClose} onSaved={onSaved} />}
    </Sheet>
  );
}

function EditForm({
  hook,
  eventTypes,
  ownerChoices,
  onClose,
  onSaved,
}: {
  hook: Webhook;
  eventTypes: EventType[];
  ownerChoices: boolean;
  onClose: () => void;
  onSaved: (hook: Webhook) => void;
}) {
  const [name, setName] = useState(hook.name);
  const [url, setUrl] = useState(hook.url);
  const [types, setTypes] = useState<string[]>(hook.event_types);
  const [approvers, setApprovers] = useState(hook.include_approvers_content);
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const switched = approvers !== hook.include_approvers_content;
  const ready = name.trim() && url.trim() && types.length > 0 && (!switched || why.trim());

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const out = await unwrap(
        api.PATCH("/v1/webhooks/{webhook_id}", {
          params: { path: { webhook_id: hook.id } },
          body: {
            name: name.trim(),
            url: url.trim(),
            event_types: types,
            ...(switched ? { include_approvers_content: approvers, reason: why.trim() } : {}),
          },
        }),
      );
      onSaved(out);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-4 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) void save();
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
        askWhy={switched}
        autoFocus
      />
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!ready || busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}
