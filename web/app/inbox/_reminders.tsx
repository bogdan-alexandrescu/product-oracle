"use client";

import { LinkButton } from "@/components/ds";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useQuery } from "@/lib/use-query";

import { isNew, type StatedNeed } from "./_needs";

type Notification = Schemas["NotificationOut"];

/**
 * Remind on a one-pager (owner, 2026-10-26): "<name> is waiting for your review of <PRD>",
 * the nudge a PRD's owner or decider sends each reviewer its submitted draft waits on (at
 * most once a day). Open goes to the one-pager and marks it read. Shown, not counted: the
 * review itself is the Inbox's counted row.
 */
export function useReminderRows(seenBefore: string | null | undefined): StatedNeed[] {
  const q = useQuery("inbox|review-reminders", () => unwrap(api.GET("/v1/me/notifications")));
  const read = (n: Notification) => unwrap(api.POST("/v1/notifications/{notification_id}/read", { params: { path: { notification_id: n.id } } }));
  return (q.data ?? [])
    .filter((n) => n.kind === "review_reminder")
    .map((n) => {
      const href = typeof n.data?.href === "string" ? n.data.href : "/simple/one-pagers";
      const waits = typeof n.data?.waits === "string" ? n.data.waits : null;
      const done = !!n.read_at;
      return {
        key: `reminder-${n.id}`,
        icon: "clock",
        kind: "Review reminder",
        item: (
          <span className="min-w-0 truncate" title={n.title}>
            {n.title}
          </span>
        ),
        context: <span className="text-text2">{waits ?? "One-pager"}</span>,
        at: n.created_at,
        state: done ? "done" : isNew(n.created_at, seenBefore) ? "new" : "open",
        counted: false,
        group: "reminders",
        action: (
          <LinkButton variant={done ? "ghost" : undefined} href={href} onClick={() => void (done ? undefined : read(n).catch(() => undefined))}>
            Open
          </LinkButton>
        ),
      };
    });
}
