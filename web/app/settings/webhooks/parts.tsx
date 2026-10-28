"use client";

import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

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
  gone: "endpoint gone",
  creator_disabled: "creator removed",
  creator_demoted: "creator demoted",
};

/**
 * A sheet opened from the inspector, rendered at the page's top: inside the inspector's
 * column the rail stayed above it and covered its left side on a desktop.
 */
export function OnTop({ children }: { children: ReactNode }) {
  return typeof document === "undefined" ? null : createPortal(children, document.body);
}

/** The pause's reason in words: a revoked API token's reads as such, not "creator removed". */
function pausedWhy(hook: Webhook): string {
  if (hook.paused_reason === "creator_disabled" && hook.created_by_kind === "api_token") return "API token revoked";
  return hook.paused_reason ? PAUSED[hook.paused_reason] : "";
}

/** Active, Paused: <reason>, or Failing (active, every delivery failing). */
export function WebhookStatus({ hook }: { hook: Webhook }) {
  if (hook.status === "paused") {
    const why = pausedWhy(hook);
    return (
      <Chip kind="warn" dot data-state="paused">
        Paused{why ? `: ${why}` : ""}
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

/** "Just now", "2 min ago", "4 h ago", "3 days ago": how long ago `iso` was. */
export function ago(iso: string, now: number = Date.now()): string {
  const min = Math.floor((now - Date.parse(iso)) / 60_000);
  if (min < 1) return "Just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
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
