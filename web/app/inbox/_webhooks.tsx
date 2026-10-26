"use client";

import { Button, LinkButton } from "@/components/ds";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";

import { isNew, type Act, type StatedNeed } from "./_needs";

type Notification = Schemas["NotificationOut"];
const KINDS = new Set<Notification["kind"]>(["webhook_paused", "webhook_url_changed"]);

const webhookOf = (n: Notification) => (typeof n.data?.webhook_id === "string" ? n.data.webhook_id : null);

/**
 * I1's Inbox rows, from the caller's notifications: "Webhook <name> paused: failing for 3
 * days" (the creator and owners; Open, Resume), "<Owner> paused your webhook <name>" and
 * "<Approver> changed where webhook <name> sends" (owners; Open). New until read, then Done.
 * Shown, not counted: the rail badge counts what the Inbox API counts.
 */
export function useWebhookRows(busy: string | null, act: Act, seenBefore: string | null | undefined): StatedNeed[] {
  const { can } = useMe();
  const q = useQuery("inbox|webhook-notifications", () => unwrap(api.GET("/v1/me/notifications")));
  const read = (n: Notification) => unwrap(api.POST("/v1/notifications/{notification_id}/read", { params: { path: { notification_id: n.id } } }));
  return (q.data ?? [])
    .filter((n) => KINDS.has(n.kind))
    .map((n) => {
      const id = webhookOf(n);
      const href = id ? `/settings/webhooks?webhook=${id}` : "/settings/webhooks";
      // The failing pause (the row's reason, as the API names it): Resume is offered.
      const failing = n.kind === "webhook_paused" && n.data?.reason === "failing";
      const key = `webhook-${n.id}`;
      const done = !!n.read_at;
      return {
        key,
        icon: "alert",
        kind: n.kind === "webhook_url_changed" ? "Webhook address" : "Webhook paused",
        item: (
          <span className="min-w-0 truncate" title={n.title}>
            {n.title}
          </span>
        ),
        context: <span className="text-text2">Settings › Webhooks</span>,
        at: n.created_at,
        state: done ? "done" : isNew(n.created_at, seenBefore) ? "new" : "open",
        counted: false,
        group: "webhooks",
        action: (
          <span className="flex flex-wrap justify-end gap-2">
            <LinkButton variant={done ? "ghost" : undefined} href={href} onClick={() => void (done ? undefined : read(n).catch(() => undefined))}>
              Open
            </LinkButton>
            {failing && !done && id && can("update_webhook") && (
              <Button
                variant="primary"
                disabled={busy === key}
                onClick={() =>
                  void act(key, async () => {
                    await unwrap(api.PATCH("/v1/webhooks/{webhook_id}", { params: { path: { webhook_id: id } }, body: { status: "active" } }));
                    await read(n);
                    await q.reload();
                  })
                }
              >
                Resume
              </Button>
            )}
          </span>
        ),
      };
    });
}
