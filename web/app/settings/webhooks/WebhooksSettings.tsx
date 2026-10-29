"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { Button, type Column, DataTable, Icon, InfoTip, Notice, PageHeader, Panel, Split } from "@/components/ds";
import { api, unwrap } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
import { useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";

import { NewWebhookSheet } from "./NewWebhookSheet";
import { ago, outcomeText, WebhookStatus, type Webhook } from "./parts";
import { WebhookInspector } from "./WebhookInspector";

/**
 * Settings › Webhooks (I1): an approver's own webhooks, every one for an owner (Q1). B1
 * Split: the one-line table left, the selected webhook's inspector right (below it on a
 * phone, where the table keeps Name and Status). `?webhook=<id>` selects one (the Inbox's
 * Open).
 */
export function WebhooksSettings() {
  const { can } = useMe();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [creating, setCreating] = useState(false);
  const hooksQ = useQuery("webhooks", () => unwrap(api.GET("/v1/webhooks")));
  const typesQ = useQuery("webhook-event-types", () => unwrap(api.GET("/v1/webhook-event-types")));
  const selectedId = params.get("webhook");
  // Created by and take over are an owner's view: the owner-only operation says who that is (#370).
  const ownerView = can("take_over_webhook");
  const hooks = hooksQ.data;
  const selected = hooks?.find((h) => h.id === selectedId) ?? null;

  const select = (id: string | null) => router.replace(id ? `${pathname}?webhook=${id}` : pathname, { scroll: false });
  const replace = (hook: Webhook) => hooksQ.setData((prev) => prev?.map((h) => (h.id === hook.id ? hook : h)));

  const columns: Column<Webhook>[] = [
    {
      key: "name",
      header: "Name",
      phone: "title",
      cell: (h) => (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-medium" title={h.name}>
            {h.name}
          </span>
          {h.include_approvers_content && (
            <span title="Owners-and-approvers content on" className="inline-flex flex-none text-text2" data-testid="approvers-content-lock">
              <Icon name="lock" size={16} />
              <span className="sr-only">Owners-and-approvers content on</span>
            </span>
          )}
        </span>
      ),
    },
    { key: "host", header: "Host", width: "22%", phone: "hide", cell: (h) => <span className="block truncate font-mono text-[13px]">{h.host}</span> },
    { key: "events", header: "Events", width: "76px", align: "right", phone: "hide", cell: (h) => <span className="tnum">{h.event_types.length}</span> },
    { key: "status", header: "Status", width: "160px", phone: "meta", cell: (h) => <WebhookStatus hook={h} /> },
    {
      key: "last",
      header: "Last delivery",
      width: "150px",
      phone: "hide",
      cell: (h) =>
        h.last_delivery ? (
          <span className="tnum truncate" title={h.last_delivery.at ? formatDateTime(h.last_delivery.at) : undefined}>
            {outcomeText(h.last_delivery)}
            {h.last_delivery.at && <span className="text-text2"> · {ago(h.last_delivery.at)}</span>}
          </span>
        ) : (
          <span className="text-text2">None yet</span>
        ),
    },
    ...(ownerView
      ? [{ key: "by", header: "Created by", width: "130px", phone: "hide" as const, cell: (h: Webhook) => <span className="truncate">{h.created_by.name}</span> }]
      : []),
  ];

  return (
    <>
      <PageHeader
        title="Webhooks"
        info={
          <InfoTip label="Webhooks" align="start" side="bottom">
            Oracle posts each event as signed JSON (Standard Webhooks: webhook-id, webhook-timestamp, webhook-signature). Check the
            signature with the secret and refuse a timestamp more than 5 minutes off; the runbook (docs/ops-webhooks.md) has a verify
            example. Payloads carry ids, states, titles, names and links, never document text.
          </InfoTip>
        }
        action={
          can("create_webhook") && (
            <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
              New webhook
            </Button>
          )
        }
      />
      <p className="-mt-2 mb-4 text-[15px] text-text2">Tell your other tools when runs, drafts and approvals change.</p>
      <Split
        inspector={
          selected && (
            <WebhookInspector
              key={selected.id}
              hook={selected}
              eventTypes={typesQ.data ?? []}
              onChanged={(h) => {
                replace(h);
                void hooksQ.reload();
              }}
              onDeleted={() => {
                select(null);
                void hooksQ.reload();
              }}
            />
          )
        }
      >
        <Panel title="Webhooks" count={hooks?.length}>
          {hooksQ.error ? (
            <div className="p-4">
              <Notice tone="error">{hooksQ.error}</Notice>
            </div>
          ) : (
            <DataTable
              label="Webhooks"
              columns={columns}
              rows={hooks}
              loading={hooksQ.loading && !hooks}
              rowKey={(h) => h.id}
              selected={selected?.id ?? null}
              onSelect={(id) => select(id)}
              rowProps={() => ({ "data-testid": "webhook-row" })}
              empty={
                <span data-testid="webhooks-empty" className="flex flex-col items-center gap-3">
                  <span>No webhooks yet. Add one to tell Slack, Zapier or your own tools when runs change.</span>
                  {can("create_webhook") && (
                    <Button icon="plus" onClick={() => setCreating(true)}>
                      New webhook
                    </Button>
                  )}
                </span>
              }
            />
          )}
        </Panel>
      </Split>
      <NewWebhookSheet
        open={creating}
        onClose={() => {
          setCreating(false);
          void hooksQ.reload();
        }}
        eventTypes={typesQ.data ?? []}
        ownerChoices={ownerView}
        onCreated={(h) => hooksQ.setData((prev) => [...(prev ?? []), h])}
      />
    </>
  );
}
