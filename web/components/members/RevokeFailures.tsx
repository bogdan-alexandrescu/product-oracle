"use client";

import { useState } from "react";

import { Button, Chip, InfoTip, InspectorSection } from "@/components/ds";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
import { errorMessage } from "@/lib/use-query";
import { invalidateWaiting, loadInbox, waitingChanged } from "@/lib/waiting";

type Inbox = Schemas["InboxOut"];
type Revoke = NonNullable<Inbox["revoke_failures"]>[number];
type Access = NonNullable<Inbox["access_failures"]>[number];

/** One thing Oracle could not take away: a removed member's provider access, or an invite's Google access. */
export type RevokeFailure = { id: string; email: string; title: string; why: string; dismiss: boolean };

export const REVOKE_FAILURES = "revoke-failures";

/** pass-f F-48: the Inbox's "Couldn't revoke" and "Access not removed" items, by email. */
export async function loadRevokeFailures(): Promise<RevokeFailure[]> {
  const inbox = await loadInbox();
  const revokes = (inbox.revoke_failures ?? []).map((f: Revoke) => ({
    id: f.id,
    email: f.member_email ?? "",
    title: f.title,
    why: [f.last_error, `tried ${f.attempts} time${f.attempts === 1 ? "" : "s"}`].filter(Boolean).join(" · "),
    dismiss: true,
  }));
  const access = (inbox.access_failures ?? [])
    .filter((f: Access) => f.kind === "iap_revoke")
    .map((f: Access) => ({
      id: f.id,
      email: f.email,
      title: `${f.owed}: ${f.email}`,
      why: [f.last_error, `since ${formatDateTime(f.created_at)}`, `tried ${f.attempts} times`].filter(Boolean).join(" · "),
      dismiss: false,
    }));
  return [...revokes, ...access];
}

/** The badge on a removed member's or an invite's row: leads to its items below. */
export function RevokeBadge({ failures, email }: { failures: RevokeFailure[]; email: string }) {
  const n = failures.filter((f) => f.email === email).length;
  if (!n) return null;
  return (
    <button
      type="button"
      data-testid="revoke-badge"
      aria-label={`Couldn't revoke ${email}'s access: show`}
      onClick={() => document.querySelector(`[data-testid="${REVOKE_FAILURES}"]`)?.scrollIntoView({ block: "center" })}
      className="rounded-full"
    >
      <Chip kind="crit" wrap>
        Couldn&apos;t revoke
      </Chip>
    </button>
  );
}

/** The list of what Oracle could not revoke, each with the Inbox's Retry and Dismiss. */
export function RevokeFailuresSection({ failures, onChanged }: { failures: RevokeFailure[]; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!failures.length) return null;
  async function act(id: string, what: "retry" | "dismiss") {
    setBusy(id);
    setError(null);
    try {
      const path = { params: { path: { follow_up_id: id } } };
      await unwrap(
        what === "retry"
          ? api.POST("/v1/member-follow-ups/{follow_up_id}/retry", path)
          : api.POST("/v1/member-follow-ups/{follow_up_id}/dismiss", path),
      );
      invalidateWaiting();
      onChanged();
      waitingChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <InspectorSection label="Couldn't revoke" testId={REVOKE_FAILURES}>
      <ul aria-label="Couldn't revoke" className="-my-1 flex flex-col">
        {failures.map((f) => (
          <li key={f.id} data-testid="revoke-failure" className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line py-2 first:border-t-0">
            <span className="inline-flex min-w-0 flex-1 basis-48 items-center gap-1.5 break-words">
              <span className="min-w-0">{f.title}</span>
              {f.why && (
                <InfoTip label="why" align="start">
                  {f.why}
                </InfoTip>
              )}
            </span>
            <span className="inline-flex gap-1">
              <Button disabled={busy !== null} onClick={() => void act(f.id, "retry")}>
                Retry
              </Button>
              {f.dismiss && (
                <Button variant="ghost" disabled={busy !== null} onClick={() => void act(f.id, "dismiss")}>
                  Dismiss
                </Button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="text-[13px] font-medium text-crit">
          {error}
        </p>
      )}
    </InspectorSection>
  );
}
