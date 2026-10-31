"use client";

import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Button, Chip, type ChipKind } from "@/components/ds";
import { TEXTAREA } from "@/app/settings/_components/fields";
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

/** The API's delivery error codes (oracle/webhooks/outbox.py) in a few words, for a chip. */
const ERROR_SHORT: Record<string, string> = {
  connect: "No answer",
  timeout: "Too slow",
  tls: "Not secure",
  not_public: "Not public",
  redirect: "Redirect",
  too_large: "Too big",
};

/** "✓ 200", "✕ 500", "✕ No answer", "Pending", "Withheld": never a raw error code (qa4-settings-25). */
export function outcomeText(d: { status: string; http_status?: number | null; error?: string | null }): string {
  if (d.status === "succeeded") return `✓ ${d.http_status ?? ""}`.trim();
  if (d.status === "pending") return "Pending";
  if (d.status === "withheld") return "Withheld";
  if (d.http_status != null) return `✕ ${d.http_status}`;
  return `✕ ${(d.error && ERROR_SHORT[d.error]) ?? (d.status === "retrying" ? "Retrying" : "Failed")}`;
}

/** A failed send in a sentence: "Couldn't reach hooks.example.com", "hooks.example.com answered 500". */
export function failureText(d: { http_status?: number | null; error?: string | null }, host: string): string {
  switch (d.error) {
    case "connect":
      return `Couldn't reach ${host}`;
    case "timeout":
      return `${host} took too long to answer`;
    case "tls":
      return `Couldn't make a secure link to ${host}`;
    case "not_public":
      return `${host} isn't a public address`;
    case "redirect":
      return `${host} sent a redirect; Oracle doesn't follow them`;
    case "too_large":
      return "The event was too big to send";
  }
  return d.http_status != null ? `${host} answered ${d.http_status}` : `Couldn't send to ${host}`;
}

/** An event type's plain label, as the New webhook form shows it (qa4-settings-26). */
export function eventLabel(type: string, eventTypes: EventType[]): string {
  if (type === "webhook.test") return "Test event";
  return eventTypes.find((t) => t.type === type)?.label ?? type;
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
  async function copy(input: HTMLTextAreaElement | null) {
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
      <div className="flex items-start gap-2">
        {/* qa4-settings-29: the whole secret, wrapped, never cut off in a narrow field. */}
        <textarea
          id="webhook-secret"
          readOnly
          rows={2}
          value={secret}
          className={`${TEXTAREA} resize-none font-mono text-[13px] break-all`}
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button onClick={(e) => void copy(e.currentTarget.parentElement?.querySelector("textarea") ?? null)}>{copied ? "Copied" : "Copy"}</Button>
      </div>
      <p className="text-sm font-semibold text-warn">Copy it now. Oracle won&apos;t show it again.</p>
    </div>
  );
}
