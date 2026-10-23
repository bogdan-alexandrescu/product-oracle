"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { ActedCell, SETTLING, Unavailable, useActed } from "@/components/account/acted";
import { ConfirmDialog } from "@/components/account/ConfirmDialog";
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
import { formatDate, formatDateTime } from "@/lib/format";
import { useMe, type Role } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

const ROLES: { role: Role; label: string; can: string }[] = [
  { role: "owner", label: "Owner", can: "everything, plus members, invites, API tokens and company settings" },
  { role: "approver", label: "Approver", can: "sets section verdicts, imports and approves versions" },
  { role: "commenter", label: "Commenter", can: "comments, replies and resolves their own threads" },
  { role: "viewer", label: "Viewer", can: "reads documents, versions, diffs, feedback and exports" },
];
export const ROLE_LABEL = Object.fromEntries(ROLES.map((r) => [r.role, r.label])) as Record<Role, string>;
const INVITE_FORM = "invite-form";
/** A3: the engineering lead is a flag any commenter or above carries, not a fifth role. */
const LEAD_TIP =
  "Engineering lead: decides both engineering stops (the check after the feature set and the dates after the PRD draft) and verifies dates. Any commenter or above can carry it.";
const VIEWER_NOT_LEAD = "Viewers can't be the engineering lead";
const CHECKBOX = "size-4 accent-[var(--accent)] disabled:opacity-50";

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
  const { me, role, engineeringLead, loading, can, capsReady, capsError } = useMe();
  // #370: managing members starts with reading them (GET /v1/members).
  const canManage = can("list_members");
  const ready = !loading && (capsReady || !!capsError);

  if (ready && canManage) return <OwnerView selfId={me?.user_id ?? null} />;
  return (
    <>
      <PageHeader title="Members" status={pageTip} />
      {ready && (
        <Split inspector={<RolesInspector />}>
          <p
            role="note"
            data-testid="role-note"
            className="flex flex-wrap items-center gap-2 rounded-button bg-accent-soft px-3 py-2 text-sm font-medium text-accent-ink"
          >
            <span>
              Your role is <b>{role ? ROLE_LABEL[role].toLowerCase() : "unknown"}</b>.
            </span>
            {engineeringLead && <span>You are an engineering lead.</span>}
          </p>
        </Split>
      )}
    </>
  );
}

/** The four roles and the engineering lead flag, what each can do behind an (i), and how many active people hold each. */
function RolesSection({ members }: { members?: Member[] }) {
  const leads = members?.filter((m) => m.engineering_lead && m.status !== "disabled").length;
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
      <div data-testid="roles-engineering-lead">
        <InspectorRow
          value={
            leads != null ? (
              <span className="tnum" data-testid="engineering-lead-count">
                {leads}
              </span>
            ) : undefined
          }
        >
          <span className="inline-flex items-center gap-1.5">
            Engineering lead
            <InfoTip label="the engineering lead" align="start">
              {LEAD_TIP}
            </InfoTip>
          </span>
        </InspectorRow>
      </div>
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
/** How long the page waits between looks at an invite email Oracle is still sending. */
const MAIL_POLL_MS = 1000;
const MAIL_POLLS = 30;

/** An invite's Google IAP access: granted, or not yet with Retry. Nothing without IAP. */
function AccessState({ invite, retrying, onRetry }: { invite: Invite; retrying: boolean; onRetry: () => void }) {
  if (invite.access === "granted") {
    return (
      <Chip kind="pass" data-testid="invite-access" title={invite.access_at ? `Granted ${formatDateTime(invite.access_at)}` : undefined}>
        Access granted
      </Chip>
    );
  }
  if (invite.access !== "pending") return null;
  return (
    <>
      <Chip kind="warn" data-testid="invite-access" title={invite.access_error ?? undefined}>
        Access not granted yet
      </Chip>
      <Button variant="ghost" aria-label={`Retry access for ${invite.email}`} disabled={retrying} onClick={onRetry}>
        {retrying ? "Retrying…" : "Retry"}
      </Button>
    </>
  );
}

const EMAIL_LABEL: Record<Invite["email_status"], string> = {
  queued: "Sending…",
  sent: "Sent",
  failed: "Failed",
  not_sent: "Not sent",
};

/** An invite's email: Sent <date>, Sending…, Not sent (no sender), or Failed; Resend. */
function EmailState({ invite, resending, onResend }: { invite: Invite; resending: boolean; onResend: () => void }) {
  const s = invite.email_status;
  const title =
    s === "failed"
      ? (invite.email_error ?? undefined)
      : s === "not_sent"
        ? "Oracle has no sender set up: send them the sign-in link"
        : invite.email_at
          ? `${EMAIL_LABEL[s]} ${formatDateTime(invite.email_at)}`
          : undefined;
  return (
    <>
      <Chip kind={s === "failed" ? "crit" : s === "sent" ? "line" : "na"} data-testid="invite-email" title={title}>
        {EMAIL_LABEL[s]}
        {s === "sent" && invite.email_at ? ` ${shortDate(invite.email_at)}` : ""}
      </Chip>
      {(s === "failed" || s === "sent") && (
        <Button variant="ghost" aria-label={`Resend invitation to ${invite.email}`} disabled={resending} onClick={onResend}>
          {resending ? "Resending…" : "Resend"}
        </Button>
      )}
    </>
  );
}

const tokensPhrase = (n: number) => (n === 0 ? "nothing else is" : n === 1 ? "their 1 open token is" : `their ${n} open tokens are`);

/** "Removed Oct 18, 2026" */
function StatusChip({ m }: { m: Member }) {
  const status = !removed(m) ? (
    <Chip kind="pass" dot>
      Active
    </Chip>
  ) : (
    <Chip kind="na" dot title={m.disabled_at ? `Removed ${formatDateTime(m.disabled_at)}` : undefined}>
      Removed{m.disabled_at ? ` ${shortDate(m.disabled_at)}` : ""}
    </Chip>
  );
  if (!m.access_pending) return status;
  // A Google IAP access change that failed; Oracle retries it on its own.
  return (
    <span className="flex flex-col items-start gap-1">
      {status}
      <Chip kind="warn" data-testid="member-access" title="Google refused the change; Oracle retries it for a day">
        {m.access_pending === "revoke" ? "Access not removed yet" : "Access not granted yet"}
      </Chip>
    </span>
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
  const [inviteLead, setInviteLead] = useState(false);
  const [pending, setPending] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  // The invite just made, whose outcome the form reports.
  const [made, setMade] = useState<Invite | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const polls = useRef(0);

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

  async function setLead(m: Member, engineering_lead: boolean) {
    setSaving(m.id);
    setError(null);
    // The box shows the tick at once; a refusal puts it back and says why.
    replace({ ...m, engineering_lead });
    try {
      replace(await unwrap(api.PATCH("/v1/members/{user_id}", { params: { path: { user_id: m.id } }, body: { engineering_lead } })));
    } catch (e) {
      replace(m);
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
            const again = await unwrap(
              api.POST("/v1/invites", { body: { email: invite.email, role: invite.role, engineering_lead: invite.engineering_lead } }),
            ).catch((e) => {
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

  async function copyLink(invite: Invite, key = invite.id) {
    // They sign in with Google at the app's address; the invite gives them the role.
    await navigator.clipboard?.writeText(invite.sign_in_url).catch(() => undefined);
    setCopied(key);
    setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
  }

  const replaceInvite = (updated: Invite) => invitesQ.setData((prev) => prev?.map((i) => (i.id === updated.id ? updated : i)));

  async function retryAccess(invite: Invite) {
    setBusy(`access:${invite.id}`);
    setError(null);
    try {
      replaceInvite(await unwrap(api.POST("/v1/invites/{invite_id}/access", { params: { path: { invite_id: invite.id } } })));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function resend(invite: Invite) {
    setBusy(`email:${invite.id}`);
    setError(null);
    try {
      const updated = await unwrap(api.POST("/v1/invites/{invite_id}/email", { params: { path: { invite_id: invite.id } } }));
      polls.current = 0;
      replaceInvite(updated);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function invite(e: FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setPending(true);
    setInviteError(null);
    try {
      const created = await unwrap(
        api.POST("/v1/invites", { body: { email: email.trim(), role: inviteRole, engineering_lead: inviteLead && inviteRole !== "viewer" } }),
      );
      invitesQ.setData((prev) => [created, ...(prev ?? [])]);
      polls.current = 0;
      setMade(created);
      setEmail("");
      setInviteLead(false);
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
        <span className="flex flex-col gap-1">
          <Unavailable reason="You are the only owner. Make someone else owner first." testId="role-unavailable">
            {(props) => (
              <button type="button" {...props} aria-label={`Role for ${m.email}`} className={`${SELECT} inline-flex items-center opacity-70`}>
                {ROLE_LABEL[m.role]}
              </button>
            )}
          </Unavailable>
          {phoneLead(m)}
        </span>
      );
    }
    return (
      <span className="flex flex-col gap-1">
        <RoleSelect value={m.role} label={`Role for ${m.email}`} disabled={saving === m.id} onChange={(role) => changeRole(m, role)} />
        {phoneLead(m)}
      </span>
    );
  };

  /** On a phone the Eng lead column hides: its box moves into the role cell, under the select. */
  const phoneLead = (m: Member) => (
    <label className="hidden items-center gap-2 text-sm max-[600px]:inline-flex">
      {leadBox(m)}
      Engineering lead
    </label>
  );

  /** A3: the member's engineering lead box; a viewer's is disabled and says why. */
  const leadBox = (m: Member) => {
    const viewer = m.role === "viewer";
    return (
      <input
        type="checkbox"
        aria-label={`Engineering lead: ${m.email}`}
        checked={m.engineering_lead}
        disabled={viewer || removed(m) || saving === m.id}
        title={viewer ? VIEWER_NOT_LEAD : undefined}
        onChange={(e) => setLead(m, e.target.checked)}
        className={CHECKBOX}
      />
    );
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
          {/* On a phone the Eng lead column hides; this chip says it instead. */}
          {m.engineering_lead && (
            <Chip kind="acc" className="hidden max-[600px]:inline-flex">
              Eng lead
            </Chip>
          )}
        </span>
      ),
    },
    { key: "role", header: "Role", width: "128px", wrap: true, cell: roleCell },
    {
      key: "lead",
      // The anchor of A1's Engineering lead step (Set up on Home).
      header: <span id="engineering-lead">Eng lead</span>,
      width: "110px",
      hideOnPhone: true,
      cell: (m) => (removed(m) ? <span className="text-text2">{m.engineering_lead ? "Yes" : "—"}</span> : leadBox(m)),
    },
    { key: "status", header: "Status", width: "146px", wrap: true, cell: (m) => <StatusChip m={m} /> },
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
  // Oracle sends invite emails in the background: look again until none is still sending.
  const sending = invites?.some((i) => i.email_status === "queued") ?? false;
  const reloadInvites = invitesQ.reload;
  useEffect(() => {
    if (!sending || polls.current >= MAIL_POLLS) return;
    const t = setTimeout(() => {
      polls.current += 1;
      void reloadInvites();
    }, MAIL_POLL_MS);
    return () => clearTimeout(t);
  }, [sending, invites, reloadInvites]);
  // The invite just made, as the list has it now (gone once revoked).
  const latest = made ? invites?.find((i) => i.id === made.id) : undefined;
  const outcome = latest && <InviteOutcome invite={latest} copied={copied === `made:${latest.id}`} onCopy={() => copyLink(latest, `made:${latest.id}`)} />;

  const inspector = (
    <Inspector
      eyebrow="Members · invite"
      title="Invite someone"
      label="Invite someone"
      chips={
        <>
          <Chip hero>Google sign-in</Chip>
          <InfoTip label="invites" hero align="start" side="bottom">
            Oracle lets their Google account through and emails them the sign-in link; their first Google sign-in lands
            with the role you pick. Copy link copies the sign-in link, to send it yourself. Without an invite, a Google
            sign-in from an allowed domain gets the company&apos;s default role.
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
              onChange={(e) => {
                setEmail(e.target.value);
                setInviteError(null);
              }}
              placeholder="name@company.com"
              aria-invalid={inviteError ? true : undefined}
              aria-describedby={inviteError ? "invite-error" : undefined}
              className={INPUT}
            />
          </Field>
          {inviteError && (
            <p id="invite-error" role="alert" className="-mt-1.5 text-[13px] font-medium text-crit">
              {inviteError}
            </p>
          )}
          <Field label="Role">
            <RoleSelect
              value={inviteRole}
              label="Role"
              onChange={(r) => {
                setInviteRole(r);
                if (r === "viewer") setInviteLead(false);
              }}
            />
          </Field>
          <label className="inline-flex items-center gap-2 text-[15px]" title={inviteRole === "viewer" ? VIEWER_NOT_LEAD : undefined}>
            <input
              type="checkbox"
              checked={inviteLead && inviteRole !== "viewer"}
              disabled={inviteRole === "viewer"}
              onChange={(e) => setInviteLead(e.target.checked)}
              className={CHECKBOX}
            />
            Engineering lead
          </label>
          <div>
            <Button type="submit" variant="solid" icon="plus" disabled={pending || !email.trim()}>
              {pending ? "Inviting…" : "Send invite"}
            </Button>
          </div>
          {outcome}
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
                    {i.engineering_lead && <Chip kind="acc">Eng lead</Chip>}
                    <Button variant="ghost" icon="link" aria-label={`Copy link for ${i.email}`} onClick={() => copyLink(i)}>
                      {copied === i.id ? "Copied" : "Copy link"}
                    </Button>
                    <Button variant="ghost" aria-label={`Revoke invite for ${i.email}`} onClick={() => revokeInvite(i)}>
                      Revoke
                    </Button>
                    <span className="flex basis-full flex-wrap items-center gap-1.5">
                      <AccessState invite={i} retrying={busy === `access:${i.id}`} onRetry={() => retryAccess(i)} />
                      <EmailState invite={i} resending={busy === `email:${i.id}`} onResend={() => resend(i)} />
                    </span>
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
    <>
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
    </>
  );
}

/** What happened to the invite just made: emailed, being emailed, or the link to send. */
function InviteOutcome({ invite, copied, onCopy }: { invite: Invite; copied: boolean; onCopy: () => void }) {
  if (invite.email_status === "sent") {
    return (
      <Notice tone="pass" testId="invite-outcome">
        Invite sent to {invite.email}
      </Notice>
    );
  }
  if (invite.email_status === "queued") {
    return (
      <Notice testId="invite-outcome">
        Sending the invite to {invite.email}…
      </Notice>
    );
  }
  return (
    <Notice
      tone="warn"
      testId="invite-outcome"
      action={
        <Button icon="link" onClick={onCopy}>
          {copied ? "Copied" : "Copy sign-in link"}
        </Button>
      }
    >
      Oracle didn&apos;t email this invite. Send them this link:{" "}
      <code data-testid="invite-link" className="break-all font-mono text-[13px]">
        {invite.sign_in_url}
      </code>
    </Notice>
  );
}
