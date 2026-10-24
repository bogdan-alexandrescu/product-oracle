"use client";

import { useState } from "react";

import { SELECT } from "@/app/settings/_components/fields";
import { Button, Chip } from "@/components/ds";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import type { Role } from "@/lib/me";
import { errorMessage } from "@/lib/use-query";
import { invalidateWaiting, waitingChanged } from "@/lib/waiting";

import type { Need } from "./_needs";

type AccessRequest = Schemas["InboxAccessRequest"];

const ROLE_WORD: Record<Role, string> = { viewer: "Viewer", commenter: "Commenter", approver: "Approver", owner: "Owner" };

/**
 * A5 (#203 part 3, AC 24): the people who asked to join, for owners and approvers, one row
 * each: "Access request", "<email> asks to join", the note, then the role select (preset to
 * the company's default role, the caller's roles only), Approve and Decline. A decided row
 * stays in place with "Approved as <Role> ✓" or "Declined", out of the count at once, until
 * the tab or filter changes (I3); then it leaves. Inbox and Home draw the same rows.
 */
export function useAccessRequestRows(requests: AccessRequest[], reload: () => Promise<unknown>) {
  const [chosen, setChosen] = useState<Record<string, Role>>({});
  const [settled, setSettled] = useState<ReadonlyMap<string, { r: AccessRequest; label: string }>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function decide(r: AccessRequest, action: "approve" | "decline") {
    const role = chosen[r.id] ?? r.default_role;
    const path = { params: { path: { request_id: r.id } } };
    setBusy(r.id);
    setErrors((m) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== r.id)));
    try {
      if (action === "approve") await unwrap(api.POST("/v1/access-requests/{request_id}/approve", { ...path, body: { role } }));
      else await unwrap(api.POST("/v1/access-requests/{request_id}/decline", path));
      setSettled((m) => new Map(m).set(r.id, { r, label: action === "approve" ? `Approved as ${ROLE_WORD[role]} ✓` : "Declined" }));
      // The rail badge re-reads with the reload, as after any Inbox action.
      invalidateWaiting();
      void reload();
      waitingChanged();
    } catch (e) {
      setErrors((m) => ({ ...m, [r.id]: errorMessage(e) }));
    } finally {
      setBusy(null);
    }
  }

  /** The tab or filter changed: what was decided here leaves. */
  function moveSettled() {
    setSettled(new Map());
  }

  const live = requests.filter((r) => !settled.has(r.id));
  // Oldest first, as the API lists them: a decided row keeps its place.
  const all = [...live, ...[...settled.values()].map((s) => s.r)].sort((a, b) => a.requested_at.localeCompare(b.requested_at));
  const rows: Need[] = all.map((r) => {
    const done = settled.get(r.id);
    const error = errors[r.id];
    return {
      key: `access-request-${r.id}`,
      icon: "user",
      kind: "Access request",
      item: (
        <>
          <span className="min-w-0 truncate" title={r.email}>
            {r.email} asks to join
          </span>
          {done && (
            <Chip kind={done.label === "Declined" ? "line" : "pass"} data-testid="access-settled">
              {done.label}
            </Chip>
          )}
        </>
      ),
      context: error ? (
        <span role="alert" className="block truncate font-medium text-crit" title={error}>
          {error}
        </span>
      ) : (
        <span className="block truncate text-text2" title={r.note ?? undefined}>
          {r.note ? <>&ldquo;{r.note}&rdquo;</> : "No note"}
        </span>
      ),
      at: r.requested_at,
      ...(done ? { counted: false } : {}),
      action: done ? null : (
        <>
          <select
            aria-label={`Role for ${r.email}`}
            value={chosen[r.id] ?? r.default_role}
            disabled={busy === r.id}
            onChange={(e) => setChosen((c) => ({ ...c, [r.id]: e.target.value as Role }))}
            className={SELECT}
          >
            {r.roles.map((role) => (
              <option key={role} value={role}>
                {ROLE_WORD[role]}
              </option>
            ))}
          </select>
          <Button variant="primary" disabled={busy === r.id} onClick={() => decide(r, "approve")}>
            Approve
          </Button>
          <Button variant="ghost" disabled={busy === r.id} onClick={() => decide(r, "decline")}>
            Decline
          </Button>
        </>
      ),
    };
  });

  return { rows, moveSettled };
}
