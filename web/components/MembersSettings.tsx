"use client";

import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";

import { ActedCell, SETTLING, Unavailable, useActed } from "@/components/account/acted";
import { ConfirmDialog } from "@/components/account/ConfirmDialog";
import { Field, INPUT, SELECT } from "@/app/settings/_components/fields";
import { Button } from "@/components/ds/Button";
import { Chip } from "@/components/ds/Chip";
import { DataTable, type Column } from "@/components/ds/DataTable";
import { Avatar } from "@/components/ds/Figures";
import { InfoTip } from "@/components/ds/InfoTip";
import { Inspector, InspectorRow, InspectorSection } from "@/components/ds/Inspector";
import { Notice, Page, PageHeader, Panel, Split } from "@/components/ds/Layout";
import { api, unwrap, type Invite, type Member } from "@/lib/api/client";
import { formatDate, formatDateTime } from "@/lib/format";
import { hasRole, useMe, type Role } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

const ROLES: { role: Role; label: string; can: string }[] = [
  { role: "owner", label: "Owner", can: "everything, plus members, invites, API tokens and company settings" },
  { role: "approver", label: "Approver", can: "sets section verdicts, imports and approves versions" },
  { role: "commenter", label: "Commenter", can: "comments, replies and resolves their own threads" },
  { role: "viewer", label: "Viewer", can: "reads documents, versions, diffs, feedback and exports" },
];
export const ROLE_LABEL = Object.fromEntries(ROLES.map((r) => [r.role, r.label])) as Record<Role, string>;
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
    <select id={id} aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as Role)} className={SELECT}>
      {ROLES.map((r) => (
        <option key={r.role} value={r.role}>
          {r.label}
        </option>
      ))}
    </select>
  );
}

const pageTip = (
  <InfoTip label="members" align="start" side="bottom">
    Everyone who signs in to this company&apos;s Oracle has one role. Removing someone disables them: the row stays so
    history keeps their name, and an owner can restore them.
  </InfoTip>
);

/** Settings > Members: the people of this company's Oracle, their roles and status, and invites. */
export function MembersSettings() {
  const { me, role, loading } = useMe();
  const isOwner = hasRole(role, "owner");

  if (!loading && isOwner) return <OwnerView selfId={me?.user_id ?? null} />;
  return (
    <Page>
      <PageHeader title="Members" status={pageTip} />
      {!loading && (
        <Split inspector={<RolesInspector />}>
          <p
            role="note"
            data-testid="role-note"
            className="flex flex-wrap items-center gap-2 rounded-button bg-accent-soft px-3 py-2 text-sm font-medium text-accent-ink"
          >
            <span>
              Your role is <b>{role ? ROLE_LABEL[role].toLowerCase() : "unknown"}</b>.
            </span>
            <span>Only owners manage members.</span>
          </p>
        </Split>
      )}
    </Page>
  );
}

/** The four roles, what each can do behind an (i), and how many active people hold each. */
function RolesSection({ members }: { members?: Member[] }) {
  return (
    <InspectorSection label="Roles">
      {ROLES.map((r) => (
        <InspectorRow
          key={r.role}
          value={
            members ? (
              <span className="tnum">{members.filter((m) => m.role === r.role && m.status !== "disabled").length}</span>
            ) : undefined
          }
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

const removed = (m: Member) => m.status === "disabled";
const shortFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
/** "Oct 18": the chip's date; the full one is in its title. */
const shortDate = (iso: string) => shortFmt.format(new Date(iso));
const tokensPhrase = (n: number) => (n === 0 ? "nothing else is" : n === 1 ? "their 1 open token is" : `their ${n} open tokens are`);

/** "Removed Oct 18, 2026" */
function StatusChip({ m }: { m: Member }) {
  if (!removed(m)) {
    return (
      <Chip kind="pass" dot>
        Active
      </Chip>
    );
  }
  return (
    <Chip kind="na" dot title={m.disabled_at ? `Removed ${formatDateTime(m.disabled_at)}` : undefined}>
      Removed{m.disabled_at ? ` ${shortDate(m.disabled_at)}` : ""}
    </Chip>
  );
}

function OwnerView({ selfId }: { selfId: string | null }) {
  const membersQ = useQuery("members", () => unwrap(api.GET("/v1/members")));
  const invitesQ = useQuery("invites", () => unwrap(api.GET("/v1/invites")));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Member | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const memberActs = useActed();
  const inviteActs = useActed();

  const emailRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("commenter");
  const [pending, setPending] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const members = membersQ.data;
  const activeOwners = members?.filter((m) => m.role === "owner" && !removed(m)).length ?? 0;
  const replace = (updated: Member) => membersQ.setData((prev) => prev?.map((x) => (x.id === updated.id ? updated : x)));

  async function changeRole(m: Member, role: Role) {
    setSaving(m.id);
    setError(null);
    try {
      replace(await unwrap(api.PATCH("/v1/members/{user_id}", { params: { path: { user_id: m.id } }, body: { role } })));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(null);
    }
  }

  async function restore(m: Member) {
    setSaving(m.id);
    setError(null);
    try {
      replace(await unwrap(api.POST("/v1/members/{user_id}/restore", { params: { path: { user_id: m.id } } })));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(null);
    }
  }

  async function remove(m: Member) {
    setSaving(m.id);
    setConfirmError(null);
    try {
      const updated = await unwrap(api.POST("/v1/members/{user_id}/disable", { params: { path: { user_id: m.id } } }));
      replace(updated);
      // Removing someone also revokes the open invite for their email.
      invitesQ.setData((prev) => prev?.filter((i) => i.email !== updated.email));
      setConfirming(null);
      memberActs.mark({ key: m.id, outcome: "Removed", undo: () => void restore(updated) });
    } catch (e) {
      setConfirmError(errorMessage(e));
    } finally {
      setSaving(null);
    }
  }

  async function revokeInvite(invite: Invite) {
    setError(null);
    try {
      await unwrap(api.DELETE("/v1/invites/{invite_id}", { params: { path: { invite_id: invite.id } } }));
      // The row stays with its outcome for a moment, then leaves the list.
      inviteActs.mark(
        {
          key: invite.id,
          outcome: "Revoked",
          undo: async () => {
            const again = await unwrap(api.POST("/v1/invites", { body: { email: invite.email, role: invite.role } })).catch((e) => {
              setError(errorMessage(e));
              return null;
            });
            invitesQ.setData((prev) => prev?.map((i) => (i.id === invite.id && again ? again : i)));
          },
        },
        () => invitesQ.setData((prev) => prev?.filter((i) => i.id !== invite.id)),
      );
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function copyLink(invite: Invite) {
    // They sign in with Google at the app's address; the invite gives them the role.
    const link = `${window.location.origin}/`;
    await navigator.clipboard?.writeText(link).catch(() => undefined);
    setCopied(invite.id);
    setTimeout(() => setCopied((c) => (c === invite.id ? null : c)), 1500);
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

  const roleCell = (m: Member) => {
    if (removed(m)) return <Chip kind="line">{ROLE_LABEL[m.role]}</Chip>;
    const lastOwner = m.role === "owner" && activeOwners <= 1;
    if (m.id === selfId && lastOwner) {
      return (
        <Unavailable reason="You are the only owner. Make someone else owner first." testId="role-unavailable">
          {(props) => (
            <button type="button" {...props} aria-label={`Role for ${m.email}`} className={`${SELECT} inline-flex items-center opacity-70`}>
              {ROLE_LABEL[m.role]}
            </button>
          )}
        </Unavailable>
      );
    }
    return <RoleSelect value={m.role} label={`Role for ${m.email}`} disabled={saving === m.id} onChange={(role) => changeRole(m, role)} />;
  };

  const actionCell = (m: Member) => {
    if (memberActs.acted?.key === m.id) return <ActedCell acted={memberActs.acted} onUndo={memberActs.undo} />;
    if (removed(m)) {
      return (
        <Button aria-label={`Restore ${m.email}`} disabled={saving === m.id} onClick={() => restore(m)}>
          Restore
        </Button>
      );
    }
    if (m.id === selfId) {
      const reason =
        m.role === "owner" && activeOwners <= 1
          ? "You can't remove yourself, and you are the only owner. Make someone else owner; they can remove you."
          : "You can't remove yourself. Another owner can remove you.";
      return (
        <Unavailable reason={reason} testId="remove-unavailable">
          {(props) => (
            <Button {...props} aria-label={`Remove ${m.email}`} className="opacity-60">
              Remove
            </Button>
          )}
        </Unavailable>
      );
    }
    return (
      <Button
        aria-label={`Remove ${m.email}`}
        onClick={() => {
          setConfirmError(null);
          setConfirming(m);
        }}
      >
        Remove
      </Button>
    );
  };

  const columns: Column<Member>[] = [
    {
      key: "email",
      header: "Member",
      cell: (m) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <Avatar name={m.email} size={28} tone={m.id === selfId ? "me" : "default"} />
          <span className={`min-w-0 truncate font-medium ${removed(m) ? "text-text2" : ""}`}>{m.email}</span>
          {m.id === selfId && (
            <Chip kind="acc">
              <span className="sr-only">(</span>you<span className="sr-only">)</span>
            </Chip>
          )}
        </span>
      ),
    },
    { key: "role", header: "Role", width: "128px", wrap: true, cell: roleCell },
    { key: "status", header: "Status", width: "146px", cell: (m) => <StatusChip m={m} /> },
    {
      key: "signin",
      header: "Last sign-in",
      width: "104px",
      phoneLabel: "Signed in ",
      cell: (m) =>
        m.last_sign_in_at ? (
          <span className="tnum text-text2" title={formatDateTime(m.last_sign_in_at)}>
            {formatDate(m.last_sign_in_at)}
          </span>
        ) : (
          <span className="text-text2" title="Not known: no sign-in recorded yet">
            —
          </span>
        ),
    },
    {
      key: "tokens",
      header: "Tokens",
      width: "72px",
      align: "right",
      phoneLabel: "Tokens ",
      cell: (m) => (
        <Link
          href={`/settings/api-tokens?member=${m.id}`}
          className="tnum font-semibold text-accent-ink hover:underline"
          aria-label={`${m.open_tokens ?? 0} open tokens of ${m.email}`}
          data-testid="open-tokens"
        >
          {m.open_tokens ?? 0}
        </Link>
      ),
    },
    { key: "action", header: <span className="sr-only">Actions</span>, width: "132px", align: "right", phone: "action", wrap: true, cell: actionCell },
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
            Their first Google sign-in lands with the role you pick. Copy link copies the app&apos;s address to send
            them. Without an invite, a Google sign-in from an allowed domain gets the company&apos;s default role.
          </InfoTip>
        </>
      }
      stats={[
        { label: "Active", value: members ? members.filter((m) => !removed(m)).length : "—", testId: "stat-active" },
        { label: "Removed", value: members ? members.filter(removed).length : "—", testId: "stat-removed" },
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
              placeholder="name@company.com"
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
          <ul aria-label="Open invites" className={`-my-1 flex flex-col ${SETTLING}`}>
            {invites.map((i) => (
              <li
                key={i.id}
                data-testid="invite-row"
                {...inviteActs.rowAttrs(i.id)}
                className="flex min-h-11 flex-wrap items-center gap-1.5 border-t border-line py-1.5 first:border-t-0"
              >
                <span className="min-w-0 flex-1 truncate font-medium max-[600px]:min-w-[9rem]" title={`${i.email} · invited ${formatDate(i.created_at)}`}>
                  {i.email}
                </span>
                {inviteActs.acted?.key === i.id ? (
                  <ActedCell acted={inviteActs.acted} onUndo={inviteActs.undo} />
                ) : (
                  <>
                    <Chip kind="acc">{ROLE_LABEL[i.role]}</Chip>
                    <Button variant="ghost" icon="link" aria-label={`Copy sign-in link for ${i.email}`} onClick={() => copyLink(i)}>
                      {copied === i.id ? "Copied" : <span className="sr-only">Copy link</span>}
                    </Button>
                    <Button variant="ghost" aria-label={`Revoke invite for ${i.email}`} onClick={() => revokeInvite(i)}>
                      Revoke
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </InspectorSection>
      <RolesSection members={members} />
    </Inspector>
  );

  const active = members?.filter((m) => !removed(m)).length;
  return (
    <Page>
      <PageHeader
        title="Members"
        status={
          <>
            {active != null && <Chip kind="acc">{active} active</Chip>}
            {pageTip}
          </>
        }
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
        <Panel title="People" count={members?.length}>
          {membersQ.error ? (
            <div className="p-4">
              <Notice tone="error">{membersQ.error}</Notice>
            </div>
          ) : (
            <div className={SETTLING}>
              <DataTable
                label="Members"
                columns={columns}
                rows={members}
                loading={!members}
                rowKey={(m) => m.id}
                rowProps={(m) => ({ "data-testid": "member-row", "data-status": m.status, ...memberActs.rowAttrs(m.id) })}
                empty="No members"
              />
            </div>
          )}
        </Panel>
      </Split>
      <ConfirmDialog
        open={!!confirming}
        title="Remove this member?"
        subject={confirming?.email}
        testId="remove-dialog"
        confirmLabel="Remove member"
        pendingLabel="Removing…"
        pending={!!confirming && saving === confirming.id}
        error={confirmError}
        onClose={() => setConfirming(null)}
        onConfirm={() => confirming && remove(confirming)}
        consequences={[
          { icon: "lock", text: "They can't sign in; every session they have ends now." },
          {
            icon: "link",
            text: `Their connections and sources stop, and ${tokensPhrase(confirming?.open_tokens ?? 0)} revoked.`,
          },
          { icon: "inbox", text: "Their pending approvals and checkpoint decisions go back to the Inbox." },
          { icon: "doc", text: "History keeps their name." },
          { icon: "user", text: "An owner can restore them; revoked tokens and connections stay revoked." },
        ]}
      />
    </Page>
  );
}
