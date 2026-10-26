"use client";

import { useState } from "react";

import { Button, Chip, type ChipKind } from "@/components/ds";
import { INPUT } from "@/app/settings/_components/fields";
import type { Schemas } from "@/lib/api/client";

export type Webhook = Schemas["WebhookOut"];
export type Delivery = Schemas["DeliveryOut"];
export type EventType = Schemas["EventTypeOut"];

export const GROUPS: { id: EventType["group"]; label: string }[] = [
  { id: "runs", label: "Runs" },
  { id: "drafts", label: "Drafts" },
  { id: "approvals", label: "Approvals" },
];

const PAUSED: Record<NonNullable<Webhook["paused_reason"]>, string> = {
  manual: "by hand",
  failing: "failing",
  gone: "gone (410)",
  creator_disabled: "creator removed",
  creator_demoted: "creator demoted",
};

/** Active, Paused: <reason>, or Failing (active, every delivery failing). */
export function WebhookStatus({ hook }: { hook: Webhook }) {
  if (hook.status === "paused") {
    return (
      <Chip kind="warn" dot data-state="paused">
        Paused{hook.paused_reason ? `: ${PAUSED[hook.paused_reason]}` : ""}
      </Chip>
    );
  }
  if (hook.failing_since) {
    return (
      <Chip kind="crit" dot data-state="failing">
        Failing
      </Chip>
    );
  }
  return (
    <Chip kind="pass" dot data-state="active">
      Active
    </Chip>
  );
}

/** "✓ 200", "✕ 500", "✕ connect", "Pending", "Withheld". */
export function outcomeText(d: { status: string; http_status?: number | null; error?: string | null }): string {
  if (d.status === "succeeded") return `✓ ${d.http_status ?? ""}`.trim();
  if (d.status === "pending") return "Pending";
  if (d.status === "withheld") return "Withheld";
  return `✕ ${d.http_status ?? d.error ?? ""}`.trim();
}

export function Outcome({ d }: { d: { status: string; http_status?: number | null; error?: string | null } }) {
  const kind: ChipKind = d.status === "succeeded" ? "pass" : d.status === "pending" || d.status === "withheld" ? "na" : d.status === "retrying" ? "warn" : "crit";
  return (
    <Chip kind={kind} data-state={d.status} title={d.status === "retrying" ? "Retrying" : undefined}>
      {outcomeText(d)}
    </Chip>
  );
}

/**
 * The signing secret, shown once (create, rotate): a read-only copy field and the warning.
 * Nothing keeps it: closing the sheet drops it.
 */
export function SecretOnce({ secret }: { secret: string }) {
  const [copied, setCopied] = useState(false);
  async function copy(input: HTMLInputElement | null) {
    let ok = false;
    try {
      await navigator.clipboard.writeText(secret);
      ok = true;
    } catch {
      input?.select();
      ok = document.execCommand?.("copy") ?? false;
    }
    setCopied(ok);
  }
  return (
    <div className="flex flex-col gap-2" data-testid="secret-once">
      <label htmlFor="webhook-secret" className="text-[13px] leading-4 font-semibold tracking-[0.02em] text-text2">
        Signing secret
      </label>
      <div className="flex gap-2">
        <input id="webhook-secret" readOnly value={secret} className={`${INPUT} font-mono text-[13px]`} onFocus={(e) => e.currentTarget.select()} />
        <Button onClick={(e) => void copy(e.currentTarget.parentElement?.querySelector("input") ?? null)}>{copied ? "Copied" : "Copy"}</Button>
      </div>
      <p className="text-sm font-semibold text-warn">Copy it now. Oracle won&apos;t show it again.</p>
    </div>
  );
}
