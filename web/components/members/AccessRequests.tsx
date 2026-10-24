"use client";

import { useState } from "react";

import { ActedCell, SETTLING, useActed } from "@/components/account/acted";
import { SELECT } from "@/app/settings/_components/fields";
import { Avatar, Button, Notice, Panel } from "@/components/ds";
import { api, unwrap } from "@/lib/api/client";
import type { Schemas } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
import { useMe, type Role } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

type AccessRequest = Schemas["AccessRequestOut"];

const LABEL: Record<Role, string> = { viewer: "Viewer", commenter: "Commenter", approver: "Approver", owner: "Owner" };

/**
 * A5: people from the company's email domains who signed in with Google without an invite
 * and wait for an owner (or an approver, as viewer or commenter). Shown only with one or
 * more pending. Approve makes an open invite (`onInvited` refreshes Open invites); the row
 * shows "Approved as <Role>" or "Declined" with Undo (reopen) while it settles. #370: drawn
 * only for a role that can read them; Approve, Decline and Undo only where it can use them.
 */
export function AccessRequests(props: { roles: Role[]; defaultRole: Role; onInvited: () => void }) {
  const { can } = useMe();
  return can("list_access_requests") ? <Requests {...props} /> : null;
}

function Requests({ roles, defaultRole, onInvited }: { roles: Role[]; defaultRole: Role; onInvited: () => void }) {
  const { can } = useMe();
  const canApprove = can("approve_access_request");
  const canDecline = can("decline_access_request");
  const q = useQuery("access-requests", () => unwrap(api.GET("/v1/access-requests")));
  const acts = useActed();
  const [chosen, setChosen] = useState<Record<string, Role>>({});
  const [error, setError] = useState<string | null>(null);
  const rows = q.data;
  if (!rows?.length || !roles.length || !(canApprove || canDecline)) return null;
  const preset = roles.includes(defaultRole) ? defaultRole : roles[0];

  async function reopen(r: AccessRequest) {
    setError(null);
    try {
      const back = await unwrap(api.POST("/v1/access-requests/{request_id}/reopen", { params: { path: { request_id: r.id } } }));
      q.setData((prev) => prev?.map((x) => (x.id === r.id ? back : x)));
      onInvited();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function decide(r: AccessRequest, action: "approve" | "decline") {
    setError(null);
    const role = chosen[r.id] ?? preset;
    try {
      const done =
        action === "approve"
          ? await unwrap(api.POST("/v1/access-requests/{request_id}/approve", { params: { path: { request_id: r.id } }, body: { role } }))
          : await unwrap(api.POST("/v1/access-requests/{request_id}/decline", { params: { path: { request_id: r.id } } }));
      if (action === "approve") onInvited();
      acts.mark(
        { key: r.id, outcome: action === "approve" ? `Approved as ${LABEL[role]}` : "Declined", undo: can("reopen_access_request") ? () => void reopen(done) : undefined },
        () => q.setData((prev) => prev?.filter((x) => x.id !== r.id)),
      );
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <Panel title="Access requests" count={rows.length}>
      <div data-testid="access-requests" className={`flex flex-col ${SETTLING}`}>
        {error && (
          <div className="p-3">
            <Notice tone="error">{error}</Notice>
          </div>
        )}
        <ul aria-label="Access requests">
          {rows.map((r) => (
            <li
              key={r.id}
              data-testid="access-row"
              {...acts.rowAttrs(r.id)}
              className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3 first:border-t-0"
            >
              <Avatar name={r.email} />
              <div className="min-w-0 flex-1 basis-56">
                <div className="truncate font-medium">{r.email}</div>
                <div className="text-[13px] text-text2">
                  Asked {formatDateTime(r.created_at)} · last seen {formatDateTime(r.last_seen_at)}
                </div>
                {r.note && <div className="text-[13px] text-text2">&ldquo;{r.note}&rdquo;</div>}
              </div>
              {acts.acted?.key === r.id ? (
                <ActedCell acted={acts.acted} onUndo={acts.undo} />
              ) : (
                <div className="flex items-center gap-1.5">
                  {canApprove && (
                    <>
                      <select
                        aria-label={`Role for ${r.email}`}
                        value={chosen[r.id] ?? preset}
                        onChange={(e) => setChosen((c) => ({ ...c, [r.id]: e.target.value as Role }))}
                        className={SELECT}
                      >
                        {roles.map((role) => (
                          <option key={role} value={role}>
                            {LABEL[role]}
                          </option>
                        ))}
                      </select>
                      <Button onClick={() => decide(r, "approve")}>
                        Approve
                      </Button>
                    </>
                  )}
                  {canDecline && (
                    <Button variant="ghost" onClick={() => decide(r, "decline")}>
                      Decline
                    </Button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}
