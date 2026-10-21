"use client";

import { useRef, useState, type FormEvent } from "react";

import { Field, INPUT, SELECT } from "@/app/settings/_components/fields";
import {
  Avatar,
  Button,
  Chip,
  DataTable,
  InfoTip,
  Inspector,
  InspectorRow,
  InspectorSection,
  Notice,
  PageHeader,
  Panel,
  Split,
  type Column,
} from "@/components/ds";
import { api, unwrap, type Invite, type Member } from "@/lib/api/client";
import { formatDate } from "@/lib/format";
import { hasRole, useMe, type Role } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

const ROLES: { role: Role; label: string; can: string }[] = [
  { role: "owner", label: "Owner", can: "everything, plus members, invites and company settings" },
  { role: "approver", label: "Approver", can: "sets section verdicts, imports and approves versions" },
  { role: "commenter", label: "Commenter", can: "comments, replies and resolves their own threads" },
  { role: "viewer", label: "Viewer", can: "reads documents, versions, diffs, feedback and exports" },
];
const LABEL = Object.fromEntries(ROLES.map((r) => [r.role, r.label])) as Record<Role, string>;
const INVITE_FORM = "invite-form";

function RoleSelect({
  value,
  label,
  disabled,
  onChange,
  id,
}: {
  value: Role;
  label: string;
  disabled?: boolean;
  onChange: (role: Role) => void;
  id?: string;
}) {
  return (
    <select
      id={id}
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as Role)}
      className={SELECT}
    >
      {ROLES.map((r) => (
        <option key={r.role} value={r.role}>
          {r.label}
        </option>
      ))}
    </select>
  );
}

const pageTip = (
  <InfoTip label="roles" align="start" side="bottom">
    Everyone who signs in to this company&apos;s Oracle has one role. Owners see members, change roles and invite people.
    Removing someone disables them: they can no longer sign in, their connections and sources are revoked and their
    approvals stop counting for good. History keeps their name, and an owner can restore them.
  </InfoTip>
);

/** Settings > Members: the people of this company's Oracle, their roles and open invites. */
export function MembersSettings() {
  const { me, role, loading } = useMe();
  const isOwner = hasRole(role, "owner");

  if (!loading && isOwner) return <OwnerView selfId={me?.user_id ?? null} />;
  return (
    <>
      <PageHeader title="Members" status={pageTip} />
      {!loading && (
        <Split inspector={<RolesInspector />}>
          <p
            role="note"
            data-testid="role-note"
            className="flex flex-wrap items-center gap-2 rounded-button bg-accent-soft px-3 py-2 text-sm font-medium text-accent-ink"
          >
            <span>
              Your role is <b>{role ? LABEL[role].toLowerCase() : "unknown"}</b>.
            </span>
            <span>Only owners manage members.</span>
          </p>
        </Split>
      )}
    </>
  );
}

/** The four roles, what each can do behind an (i), and how many people hold each. */
function RolesSection({ members }: { members?: Member[] }) {
  return (
    <InspectorSection label="Roles">
      {ROLES.map((r) => (
        <InspectorRow
          key={r.role}
          value={members ? <span className="tnum">{members.filter((m) => m.role === r.role).length}</span> : undefined}
        >
          <span className="inline-flex items-center gap-1.5">
            {r.label}
            <InfoTip label={`the ${r.label.toLowerCase()} role`} align="start">
              {r.label}: {r.can}.
            </InfoTip>
          </span>
        </InspectorRow>
      ))}
    </InspectorSection>
  );
}

function RolesInspector() {
  return (
    <Inspector eyebrow="Members · roles" title="Roles" label="Roles">
      <RolesSection />
    </Inspector>
  );
}

function OwnerView({ selfId }: { selfId: string | null }) {
  const membersQ = useQuery("members", () => unwrap(api.GET("/v1/members")));
  const invitesQ = useQuery("invites", () => unwrap(api.GET("/v1/invites")));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  // The invite form lives in the inspector with its own submit; the header's Invite (the
  // page's one primary action) takes you to it, which on a phone is below the table.
  const emailRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("commenter");
  const [pending, setPending] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  async function changeRole(m: Member, role: Role) {
    setSaving(m.id);
    setError(null);
    try {
      const updated = await unwrap(
        api.PATCH("/v1/members/{user_id}", { params: { path: { user_id: m.id } }, body: { role } }),
      );
      membersQ.setData((prev) => prev?.map((x) => (x.id === updated.id ? updated : x)));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(null);
    }
  }

  async function setDisabled(m: Member, disable: boolean) {
    setSaving(m.id);
    setError(null);
    try {
      const path = { params: { path: { user_id: m.id } } };
      const updated = await unwrap(
        disable
          ? api.POST("/v1/members/{user_id}/disable", path)
          : api.POST("/v1/members/{user_id}/restore", path),
      );
      membersQ.setData((prev) => prev?.map((x) => (x.id === updated.id ? updated : x)));
      // Removing someone also revokes the open invite for their email.
      if (disable) invitesQ.setData((prev) => prev?.filter((i) => i.email !== updated.email));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(null);
      setConfirming(null);
    }
  }

  async function revoke(invite: Invite) {
    setError(null);
    try {
      await unwrap(api.DELETE("/v1/invites/{invite_id}", { params: { path: { invite_id: invite.id } } }));
      invitesQ.setData((prev) => prev?.filter((i) => i.id !== invite.id));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function invite(e: FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setPending(true);
    setInviteError(null);
    try {
      const created = await unwrap(api.POST("/v1/invites", { body: { email: email.trim(), role: inviteRole } }));
      invitesQ.setData((prev) => [created, ...(prev ?? [])]);
      setEmail("");
    } catch (err) {
      setInviteError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  const columns: Column<Member>[] = [
    {
      key: "email",
      header: "Email",
      cell: (m) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <Avatar name={m.email} size={28} tone={m.id === selfId ? "me" : "default"} />
          <span className={`min-w-0 truncate font-medium ${m.status === "disabled" ? "text-text2" : ""}`}>{m.email}</span>
          {m.id === selfId && (
            <Chip kind="acc">
              <span className="sr-only">(</span>you<span className="sr-only">)</span>
            </Chip>
          )}
          {m.status === "disabled" && (
            <Chip kind="na" title={m.disabled_at ? `Removed ${formatDate(m.disabled_at)}` : undefined}>
              Removed
            </Chip>
          )}
        </span>
      ),
    },
    {
      key: "role",
      header: "Role",
      width: "150px",
      cell: (m) => (
        <RoleSelect
          value={m.role}
          label={`Role for ${m.email}`}
          disabled={saving === m.id || m.status === "disabled"}
          onChange={(role) => changeRole(m, role)}
        />
      ),
    },
    {
      key: "since",
      header: "Since",
      width: "130px",
      align: "right",
      hideOnPhone: true,
      cell: (m) => <span className="tnum text-text2">{formatDate(m.created_at)}</span>,
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      width: "190px",
      align: "right",
      phone: "action",
      cell: (m) =>
        m.status === "disabled" ? (
          <Button
            variant="ghost"
            aria-label={`Restore ${m.email}`}
            disabled={saving === m.id}
            onClick={() => setDisabled(m, false)}
          >
            Restore
          </Button>
        ) : m.id === selfId ? null : confirming === m.id ? (
          <span className="inline-flex items-center gap-1" role="group" aria-label={`Confirm removing ${m.email}`}>
            <Button variant="danger" disabled={saving === m.id} onClick={() => setDisabled(m, true)}>
              {saving === m.id ? "Removing…" : "Confirm"}
            </Button>
            <Button variant="ghost" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
          </span>
        ) : (
          <Button variant="ghost" aria-label={`Remove ${m.email}`} onClick={() => setConfirming(m.id)}>
            Remove
          </Button>
        ),
    },
  ];

  const invites = invitesQ.data;
  const inspector = (
    <Inspector
      eyebrow="Members · invite"
      title="Invite someone"
      label="Invite someone"
      chips={
        <>
          <Chip hero>Google sign-in</Chip>
          <InfoTip label="invites" hero align="start" side="bottom">
            Their first Google sign-in lands with the role you pick. Without an invite, a Google sign-in from an allowed
            domain gets the company&apos;s default role (commenter unless changed).
          </InfoTip>
        </>
      }
      stats={[
        { label: "Members", value: membersQ.data?.length ?? "—" },
        { label: "Open invites", value: invites?.length ?? "—" },
      ]}
    >
      <InspectorSection>
        <form id={INVITE_FORM} onSubmit={invite} aria-label="Invite" className="flex flex-col gap-3">
          <Field label="Email">
            <input
              ref={emailRef}
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
              className={INPUT}
            />
          </Field>
          <Field label="Role">
            <RoleSelect value={inviteRole} label="Role" onChange={setInviteRole} />
          </Field>
          {inviteError && <Notice tone="error">{inviteError}</Notice>}
          <div>
            <Button type="submit" variant="solid" icon="plus" disabled={pending || !email.trim()}>
              {pending ? "Inviting…" : "Send invite"}
            </Button>
          </div>
        </form>
      </InspectorSection>
      <InspectorSection label="Open invites" testId="open-invites">
        {invitesQ.error && <Notice tone="error">{invitesQ.error}</Notice>}
        {!invites && !invitesQ.error && <span className="block h-3 w-2/3 animate-pulse rounded bg-surface2" />}
        {invites?.length === 0 && <p className="text-[15px] text-text2">No open invites</p>}
        {!!invites?.length && (
          <ul aria-label="Open invites" className="-my-1 flex flex-col">
            {invites.map((i) => (
              <li
                key={i.id}
                data-testid="invite-row"
                className="flex min-h-11 items-center gap-2 border-t border-line py-1.5 first:border-t-0"
              >
                <span className="min-w-0 flex-1 truncate font-medium" title={`${i.email} · invited ${formatDate(i.created_at)}`}>
                  {i.email}
                </span>
                <Chip kind="acc">{LABEL[i.role]}</Chip>
                <Button variant="ghost" aria-label={`Revoke invite for ${i.email}`} onClick={() => revoke(i)}>
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </InspectorSection>
      <RolesSection members={membersQ.data} />
    </Inspector>
  );

  return (
    <>
      <PageHeader
        title="Members"
        status={pageTip}
        action={
          <Button
            variant="primary"
            icon="plus"
            aria-controls={INVITE_FORM}
            onClick={() => {
              emailRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
              emailRef.current?.focus({ preventScroll: true });
            }}
          >
            Invite
          </Button>
        }
      />
      <Split inspector={inspector}>
        {error && <Notice tone="error">{error}</Notice>}
        <Panel title="People" count={membersQ.data?.length}>
          {membersQ.error ? (
            <div className="p-4">
              <Notice tone="error">{membersQ.error}</Notice>
            </div>
          ) : (
            <DataTable
              label="Members"
              columns={columns}
              rows={membersQ.data}
              loading={!membersQ.data}
              rowKey={(m) => m.id}
              rowProps={(m) => ({ "data-testid": "member-row", "data-status": m.status })}
              empty="No members"
            />
          )}
        </Panel>
      </Split>
    </>
  );
}
