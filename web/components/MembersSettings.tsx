"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { ActedCell, SETTLING, Unavailable, useActed } from "@/components/account/acted";
import { AccessRequests } from "@/components/members/AccessRequests";
import { personName, RemoveDialog, RoleDialog } from "@/components/members/ChangePreview";
import { MemberInspector } from "@/components/members/MemberInspector";
import { SignInRules } from "@/components/members/SignInRules";
import { FindPerson, matches, NoMatch, PeopleReadOnly } from "@/components/members/PeopleReadOnly";
import { Field, INPUT, SELECT, TEXTAREA } from "@/app/settings/_components/fields";
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
import { hasRole, membersApi, type HandOver, type Impact } from "@/lib/api/members-types";
import { formatDate, formatDateTime, formatDay, formatShortDate } from "@/lib/format";
import { useMe, type Role } from "@/lib/me";
import { displayName } from "@/lib/names";
import { errorMessage, useQuery } from "@/lib/use-query";

const ROLES: { role: Role; label: string; can: string }[] = [
  { role: "owner", label: "Owner", can: "everything, plus members, invites, API tokens and company settings" },
  { role: "approver", label: "Approver", can: "sets section verdicts, imports and approves versions, invites viewers and commenters" },
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
/** The invite's personal note (#203): plain text, at most this long; a counter shows near it. */
const MESSAGE_MAX = 500;
const MESSAGE_COUNT_FROM = 400;
/** A name is at most 80 characters (A5). */
const NAME_MAX = 80;
/** An address the invite can go to: something@domain.tld, no spaces. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Why Send invite is off, said under the Email field; null once the address can be sent to. */
function emailProblem(email: string): string | null {
  if (!email.trim()) return "Enter an email address";
  return EMAIL_SHAPE.test(email.trim()) ? null : "Enter a valid email address, like name@company.com";
}

/** An email that wraps does so after its "@", not inside the name or the domain. */
function EmailLines({ email }: { email: string }) {
  const at = email.lastIndexOf("@");
  if (at < 0) return <>{email}</>;
  return (
    <>
      {email.slice(0, at + 1)}
      <wbr />
      {email.slice(at + 1)}
    </>
  );
}

const RESENT = ["", "resent once", "resent twice"];

/** An invite row's tooltip: "Invited by Admin on Oct 21 · resent once". */
function invitedLine(i: Invite): string {
  const by = i.invited_by_name ? `Invited by ${i.invited_by_name} on` : "Invited on";
  const n = i.resend_count ?? 0;
  return [`${by} ${formatDay(i.created_at)}`, n ? (RESENT[n] ?? `resent ${n} times`) : null].filter(Boolean).join(" · ");
}

function RoleSelect({
  value,
  label,
  disabled,
  onChange,
  id,
  roles,
}: {
  value: Role;
  label: string;
  disabled?: boolean;
  onChange: (role: Role) => void;
  id?: string;
  /** The roles offered (A5: an approver's invite_roles); every role by default. */
  roles?: Role[];
}) {
  return (
    <select id={id} aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as Role)} className={SELECT}>
      {ROLES.filter((r) => !roles || roles.includes(r.role)).map((r) => (
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
  const { me, loading, can, capsReady, capsError } = useMe();
  // #370: managing members starts with reading them (GET /v1/members); an approver invites
  // (A5) and reads the people list like everyone else.
  const canManage = can("list_members");
  const canInvite = can("create_invite") && !!me?.invite_roles?.length;
  const ready = !loading && (capsReady || !!capsError);

  if (ready && (canManage || canInvite)) return <OwnerView selfId={me?.user_id ?? null} manage={canManage} />;
  return (
    <>
      <PageHeader title="Members" info={pageTip} />
      {ready && (
        <Split inspector={<RolesInspector />}>
          <RoleNote />
          <PeopleReadOnly />
        </Split>
      )}
    </>
  );
}

/** "Your role is commenter. Owners manage members and sign-in." (A5, 3.10) */
function RoleNote() {
  const { role, engineeringLead, can } = useMe();
  return (
    <p
      role="note"
      data-testid="role-note"
      className="flex flex-wrap items-center gap-2 rounded-button bg-accent-soft px-3 py-2 text-sm font-medium text-accent-ink"
    >
      <span>
        Your role is <b>{role ? ROLE_LABEL[role].toLowerCase() : "unknown"}</b>.{" "}
        {can("create_invite") ? "You can invite viewers and commenters and approve their access requests." : "Owners manage members and sign-in."}
      </span>
      {engineeringLead && <span>You are an engineering lead.</span>}
    </p>
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
/** "Oct 18": the chip's date; the full one is in its title. */
const shortDate = (iso: string) => formatDay(iso);
/** How long the page waits between looks at an invite email Oracle is still sending. */
const MAIL_POLL_MS = 1000;
const MAIL_POLLS = 30;

/** "Google sign-in treats this as pat@example.com; ...": a plus address is no Google account of its own. */
function plusAddressWarning(email: string): string | null {
  const at = email.trim().lastIndexOf("@");
  const local = email.trim().slice(0, at);
  if (at < 1 || !local.includes("+")) return null;
  const base = `${local.slice(0, local.indexOf("+"))}${email.trim().slice(at)}`;
  return `Google sign-in treats this as ${base}; IAP access can't be granted to it.`;
}

/** "Last tried Oct 22, 9:05 AM PDT · <reason>": said only of an attempt that failed, as text. */
function Tried({ at, reason, testId }: { at?: string | null; reason?: string | null; testId: string }) {
  const said = [at ? `Last tried ${formatDateTime(at)}` : null, reason || null].filter(Boolean).join(" · ");
  if (!said) return null;
  return (
    <span data-testid={testId} className="basis-full break-words text-[13px] text-text2">
      {said}
    </span>
  );
}

const EMAIL_LABEL: Record<Invite["email_status"], string> = {
  queued: "Sending…",
  sent: "Sent",
  failed: "Failed",
  not_sent: "Not sent",
};

/** "Sent Oct 15", "Access granted Oct 15": the day the email or access worked; its full time on hover. */
function On({ at }: { at?: string | null }) {
  return at ? <span title={formatDateTime(at)}> {shortDate(at)}</span> : null;
}

/**
 * An open invite's one status line (owners): the email (Sent <day>, Sending…, Not sent, or
 * Failed, with Resend) and Google IAP access (Access granted <day>, or not yet with Retry;
 * nothing without IAP). When it was last tried and why shows only after a failure. An expired
 * invite has neither: its Expired chip says it, and Resend gives it 14 more days.
 */
function InviteDelivery({
  invite,
  busy,
  onRetry,
  onResend,
}: {
  invite: Invite;
  busy: string | null;
  onRetry: () => void;
  onResend: () => void;
}) {
  if (invite.status === "expired") return null;
  const s = invite.email_status;
  const access = invite.access === "granted" || invite.access === "pending" ? invite.access : null;
  const retrying = busy === `access:${invite.id}`;
  const resending = busy === `email:${invite.id}`;
  const emailReason = s === "failed" ? invite.email_error : s === "not_sent" ? "Oracle has no sender set up: send them the sign-in link" : null;
  return (
    <>
      <span data-testid="invite-status" className="flex basis-full flex-wrap items-center gap-1.5">
        <Chip kind={s === "failed" ? "crit" : s === "sent" ? "line" : "na"} data-testid="invite-email">
          {EMAIL_LABEL[s]}
          {s === "sent" && <On at={invite.email_at} />}
        </Chip>
        {(s === "failed" || s === "sent") && (
          <Button variant="ghost" aria-label={`Resend invitation to ${invite.email}`} disabled={resending} onClick={onResend}>
            {resending ? "Resending…" : "Resend"}
          </Button>
        )}
        {access && (
          <Chip kind={access === "granted" ? "pass" : "warn"} data-testid="invite-access">
            {access === "granted" ? "Access granted" : "Access not granted yet"}
            {access === "granted" && <On at={invite.access_at} />}
          </Chip>
        )}
        {access === "pending" && (
          <Button variant="ghost" aria-label={`Retry access for ${invite.email}`} aria-busy={retrying || undefined} disabled={retrying} onClick={onRetry}>
            {retrying ? "Retrying…" : "Retry"}
          </Button>
        )}
      </span>
      <Tried at={s === "failed" ? invite.email_at : null} reason={emailReason} testId="invite-email-detail" />
      {access === "pending" && <Tried at={invite.access_at} reason={invite.access_error} testId="invite-access-detail" />}
    </>
  );
}

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

/**
 * The owner's page; with `manage` off, an approver's (A5): their role note, the Access
 * requests and Invite inspector with their roles and their own invites, and the read-only
 * People list instead of the member table.
 */
function OwnerView({ selfId, manage = true }: { selfId: string | null; manage?: boolean }) {
  const { me } = useMe();
  const inviteRoles = me?.invite_roles ?? [];
  const membersQ = useQuery(manage ? "members" : "members:none", () =>
    manage ? unwrap(api.GET("/v1/members")) : Promise.resolve(undefined as Member[] | undefined),
  );
  const invitesQ = useQuery("invites", () => unwrap(api.GET("/v1/invites")));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Member | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const memberActs = useActed();
  // A5: the member whose inspector is open (in place of the invite inspector), the People
  // search, and a demotion waiting on its dialog.
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [find, setFind] = useState("");
  const [demoting, setDemoting] = useState<{ member: Member; role: Role; impact: Impact } | null>(null);
  const [demoteError, setDemoteError] = useState<string | null>(null);
  const inviteActs = useActed();

  const emailRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("commenter");
  const [inviteLead, setInviteLead] = useState(false);
  const [inviteMessage, setInviteMessage] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [pending, setPending] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  // The invite just made, whose outcome the form reports.
  const [made, setMade] = useState<Invite | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const polls = useRef(0);

  // B5: the goal owner picker's "Invite them first" opens here with ?invite=1: the invite
  // form ready (its role starts at Commenter).
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("invite") !== "1") return;
    const at = requestAnimationFrame(() => {
      emailRef.current?.scrollIntoView({ block: "center" });
      emailRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(at);
  }, []);

  const members = membersQ.data;
  const activeOwners = members?.filter((m) => m.role === "owner" && !removed(m)).length ?? 0;
  const replace = (updated: Member) => membersQ.setData((prev) => prev?.map((x) => (x.id === updated.id ? updated : x)));

  async function changeRole(m: Member, next: Role, hand_over: HandOver[] = []) {
    setSaving(m.id);
    setError(null);
    try {
      // A5: a lower role first reads what it lapses and voids; with something to show, the
      // dialog asks (the select stays on the old role until Change role).
      if (!demoting && !hasRole(next, m.role)) {
        const impact = await membersApi.impact(m.id, { role: next });
        if (!impact.nothing) {
          setDemoteError(null);
          setDemoting({ member: m, role: next, impact });
          return;
        }
      }
      replace(await membersApi.patch(m.id, hand_over.length ? { role: next, hand_over } : { role: next }));
      setDemoting(null);
    } catch (e) {
      if (demoting) setDemoteError(errorMessage(e));
      else setError(errorMessage(e));
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

  async function remove(m: Member, hand_over: HandOver[]) {
    setSaving(m.id);
    setConfirmError(null);
    try {
      const updated = await membersApi.disable(m.id, hand_over);
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
              api.POST("/v1/invites", {
                body: { email: invite.email, name: invite.name ?? null, role: invite.role, engineering_lead: invite.engineering_lead, message: invite.message ?? null },
              }),
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

  async function renew(invite: Invite) {
    setBusy(`resend:${invite.id}`);
    setError(null);
    try {
      replaceInvite(await unwrap(api.POST("/v1/invites/{invite_id}/resend", { params: { path: { invite_id: invite.id } } })));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function invite(e: FormEvent) {
    e.preventDefault();
    if (emailProblem(email)) return;
    setPending(true);
    // A new attempt clears the last one's outcome: only the latest shows.
    setInviteError(null);
    setMade(null);
    try {
      const created = await unwrap(
        api.POST("/v1/invites", {
          body: {
            email: email.trim(),
            name: inviteName.trim() || null,
            role: inviteRole,
            engineering_lead: inviteLead && inviteRole !== "viewer",
            message: inviteMessage.trim() || null,
          },
        }),
      );
      invitesQ.setData((prev) => [created, ...(prev ?? [])]);
      polls.current = 0;
      setMade(created);
      setEmail("");
      setInviteName("");
      setInviteLead(false);
      setInviteMessage("");
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
      wrap: true,
      cell: (m) => (
        <span className="flex min-w-0 items-start gap-2.5">
          <Avatar name={personName(m)} size={28} tone={m.id === selfId ? "me" : "default"} />
          <span className="flex min-w-0 flex-col items-start gap-1">
            {/* A5: the name in bold, the email whole under it (it wraps, never cut); opens the member inspector. */}
            <button
              type="button"
              data-testid="member-open"
              onClick={() => setInspecting(m.id)}
              className={`flex min-w-0 max-w-full flex-col text-left leading-tight hover:underline ${removed(m) ? "text-text2" : ""}`}
            >
              <span data-testid="member-name" className="font-semibold [overflow-wrap:anywhere]">
                {personName(m)}
              </span>
              <span data-testid="member-email" className="text-[13px] font-normal text-text2 [overflow-wrap:anywhere]">
                <EmailLines email={m.email} />
              </span>
            </button>
            {/* The chips on their own line, so the email keeps its room. */}
            {(m.id === selfId || m.engineering_lead) && (
              <span className="flex flex-wrap gap-1">
                {m.id === selfId && (
                  <Chip kind="acc" data-testid="member-you">
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
            )}
          </span>
        </span>
      ),
    },
    // Wide enough for the whole of "Commenter" in its select.
    { key: "role", header: "Role", width: "148px", wrap: true, cell: roleCell },
    {
      key: "lead",
      // The anchor of A1's Engineering lead step (Set up on Home).
      header: <span id="engineering-lead">Eng lead</span>,
      width: "84px",
      hideOnPhone: true,
      cell: (m) => (removed(m) ? <span className="text-text2">{m.engineering_lead ? "Yes" : "—"}</span> : leadBox(m)),
    },
    { key: "status", header: "Status", width: "140px", wrap: true, cell: (m) => <StatusChip m={m} /> },
    {
      key: "signin",
      header: "Last sign-in",
      // "Oct 20" (the year only when it is not this one); the full time on hover.
      width: "100px",
      phoneLabel: "Signed in ",
      // Beside the inspector the member's name and email need the room; the inspector has it.
      narrow: "hide",
      cell: (m) =>
        m.last_sign_in_at ? (
          <span className="tnum text-text2" title={formatDateTime(m.last_sign_in_at)}>
            {formatShortDate(m.last_sign_in_at)}
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
      narrow: "hide",
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
    { key: "action", header: <span className="sr-only">Actions</span>, width: "112px", align: "right", phone: "action", wrap: true, cell: actionCell },
  ];

  const problem = emailProblem(email);
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
        ...(manage
          ? [
              { label: "Active", value: members ? members.filter((m) => !removed(m)).length : "—", testId: "stat-active" },
              { label: "Removed", value: members ? members.filter(removed).length : "—", testId: "stat-removed" },
            ]
          : []),
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
              aria-invalid={inviteError || (email.trim() && problem) ? true : undefined}
              aria-describedby={inviteError ? "invite-error" : problem ? "invite-email-hint" : undefined}
              className={INPUT}
            />
          </Field>
          {/* Why Send invite is off: nothing typed yet, or not an address. */}
          {problem && !inviteError && (
            <p id="invite-email-hint" data-testid="invite-email-hint" className={`-mt-1.5 text-[13px] ${email.trim() ? "font-medium text-crit" : "text-text2"}`}>
              {problem}
            </p>
          )}
          {plusAddressWarning(email) && (
            <p data-testid="plus-address-warning" role="note" className="-mt-1.5 text-[13px] font-medium text-warn">
              {plusAddressWarning(email)}
            </p>
          )}
          {inviteError && (
            <p id="invite-error" role="alert" className="-mt-1.5 text-[13px] font-medium text-crit">
              {inviteError}
            </p>
          )}
          <Field label="Name (optional)">
            <input
              value={inviteName}
              maxLength={NAME_MAX}
              onChange={(e) => setInviteName(e.target.value)}
              placeholder="As teammates know them"
              className={INPUT}
            />
          </Field>
          <Field label="Role">
            <RoleSelect
              value={inviteRole}
              label="Role"
              roles={inviteRoles}
              onChange={(r) => {
                setInviteRole(r);
                if (r === "viewer") setInviteLead(false);
              }}
            />
          </Field>
          {manage && <label className="inline-flex items-center gap-2 text-[15px]" title={inviteRole === "viewer" ? VIEWER_NOT_LEAD : undefined}>
            <input
              type="checkbox"
              checked={inviteLead && inviteRole !== "viewer"}
              disabled={inviteRole === "viewer"}
              onChange={(e) => setInviteLead(e.target.checked)}
              className={CHECKBOX}
            />
            Engineering lead
          </label>}
          <Field label="Message (optional)">
            <textarea
              rows={3}
              maxLength={MESSAGE_MAX}
              value={inviteMessage}
              onChange={(e) => setInviteMessage(e.target.value.slice(0, MESSAGE_MAX))}
              placeholder="A note for them, sent with the invite"
              className={TEXTAREA}
            />
          </Field>
          {inviteMessage.length >= MESSAGE_COUNT_FROM && (
            <p data-testid="invite-message-count" aria-live="polite" className="tnum -mt-1.5 text-right text-[13px] text-text2">
              {inviteMessage.length}/{MESSAGE_MAX}
            </p>
          )}
          <div>
            <Button type="submit" variant="solid" icon="plus" disabled={pending || !!problem}>
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
                className="flex min-h-11 flex-wrap items-center gap-1.5 border-t border-line py-2 first:border-t-0"
              >
                {/* The name, and the whole email on its own line under it (it wraps, never cut). */}
                <span data-testid="invite-who" className="flex min-w-0 basis-full flex-col leading-tight" title={invitedLine(i)}>
                  <span className="font-medium [overflow-wrap:anywhere]">{displayName(i.email, i.name)}</span>{" "}
                  <span className="text-[13px] text-text2 [overflow-wrap:anywhere]">{i.email}</span>
                </span>
                {inviteActs.acted?.key === i.id ? (
                  <ActedCell acted={inviteActs.acted} onUndo={inviteActs.undo} />
                ) : (
                  <>
                    <Chip kind="acc">{ROLE_LABEL[i.role]}</Chip>
                    {i.engineering_lead && <Chip kind="acc">Eng lead</Chip>}
                    {i.status === "expired" ? (
                      <Chip kind="warn">Expired {formatDate(i.expires_at)}</Chip>
                    ) : (
                      <Chip kind="line">Expires {formatDate(i.expires_at)}</Chip>
                    )}
                    <Button variant="ghost" icon="link" aria-label={`Copy link for ${i.email}`} onClick={() => copyLink(i)}>
                      {copied === i.id ? "Copied" : "Copy link"}
                    </Button>
                    {i.status === "expired" && (
                      // A5: 14 more days from now.
                      <Button
                        variant="ghost"
                        aria-label={`Resend invite for ${i.email}`}
                        disabled={busy === `resend:${i.id}`}
                        onClick={() => renew(i)}
                      >
                        {busy === `resend:${i.id}` ? "Resending…" : "Resend"}
                      </Button>
                    )}
                    <Button variant="ghost" aria-label={`Revoke invite for ${i.email}`} onClick={() => revokeInvite(i)}>
                      Revoke
                    </Button>
                    {i.message && (
                      // Plain text, on one line: the full note is its title.
                      <span data-testid="invite-note" title={i.message} className="basis-full truncate text-[13px] text-text2">
                        Note: {i.message}
                      </span>
                    )}
                    {/* #370: Retry and Resend are an owner's; an approver sees neither. */}
                    {manage && <InviteDelivery invite={i} busy={busy} onRetry={() => retryAccess(i)} onResend={() => resend(i)} />}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </InspectorSection>
      <RolesSection members={manage ? members : undefined} />
    </Inspector>
  );

  // "Find a person" by the name shown (the same rule on every view) or the email.
  const found = members?.filter((m) => matches(find, personName(m), m.email));
  const inspected = inspecting ? members?.find((m) => m.id === inspecting) : undefined;
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
      <Split
        inspector={
          inspected ? (
            <MemberInspector
              key={inspected.id}
              member={inspected}
              people={members ?? []}
              footer={memberActs.acted?.key === inspected.id ? null : actionCell(inspected)}
              onClose={() => setInspecting(null)}
              onSaved={(u) => replace({ ...inspected, ...u })}
            />
          ) : (
            inspector
          )
        }
      >
        {error && <Notice tone="error">{error}</Notice>}
        {!manage && <RoleNote />}
        <AccessRequests roles={inviteRoles} onInvited={() => void invitesQ.reload()} />
        {!manage && <PeopleReadOnly />}
        {manage && (
          <Panel
            title="People"
            // The one count of people: the active ones shown; a removed row says Removed and is not counted.
            count={found && <PeopleCount active={found.filter((m) => !removed(m)).length} />}
            tools={<FindPerson value={find} onChange={setFind} />}
          >
            {membersQ.error ? (
              <div className="p-4">
                <Notice tone="error">{membersQ.error}</Notice>
              </div>
            ) : (
              <div className={SETTLING}>
                <DataTable
                  label="Members"
                  columns={columns}
                  rows={found}
                  loading={!members}
                  rowKey={(m) => m.id}
                  rowProps={(m) => ({ "data-testid": "member-row", "data-status": m.status, ...memberActs.rowAttrs(m.id) })}
                  empty={<NoMatch find={find} onClear={() => setFind("")} />}
                />
              </div>
            )}
          </Panel>
        )}
        {manage && <SignInRules />}
      </Split>
      <RemoveDialog
        member={confirming}
        people={members ?? []}
        pending={!!confirming && saving === confirming.id}
        error={confirmError}
        onClose={() => setConfirming(null)}
        onConfirm={(moves) => confirming && remove(confirming, moves)}
      />
      <RoleDialog
        member={demoting?.member ?? null}
        role={demoting?.role ?? null}
        impact={demoting?.impact ?? null}
        people={members ?? []}
        pending={!!demoting && saving === demoting.member.id}
        error={demoteError}
        onClose={() => setDemoting(null)}
        onConfirm={(moves) => demoting && changeRole(demoting.member, demoting.role, moves)}
      />
    </>
  );
}

/** The People count: "4 active"; removed people are not counted (their rows say Removed). */
function PeopleCount({ active }: { active: number }) {
  return (
    <span>
      {active} <span className="text-[15px] font-semibold text-text2">active</span>
    </span>
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
