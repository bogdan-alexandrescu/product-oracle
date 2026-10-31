"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";

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
  confirmInPage,
  DataTable,
  InfoTip,
  Inspector,
  InspectorRow,
  InspectorSection,
  Notice,
  PageHeader,
  Panel,
  Split,
  ViewOnly,
  type Column,
} from "@/components/ds";
import { api, unwrap, type Invite, type Member } from "@/lib/api/client";
import { hasRole, membersApi, type HandOver, type Impact } from "@/lib/api/members-types";
import { formatDate, formatDateTime } from "@/lib/format";
import { useMe, type Role } from "@/lib/me";
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
/** The Roles list's line for the engineering lead, as each role has one (qa-shell-27). */
const VIEWER_NOT_LEAD = "Viewers can't be the engineering lead";
/** On a phone the box is 24 px, inside a 44 px tall label (qa-onboarding-31). */
const CHECKBOX = "size-4 accent-[var(--accent)] disabled:opacity-50 max-[600px]:size-6";
/** Room for the longest role ("Commenter") with the select's arrow: never cut mid-word. */
const ROLE_SELECT = SELECT.replace("min-w-0", "min-w-[8.5rem]");
/** A role that can't be changed here: the same chip everywhere (qa-settings-6). */
const RoleChip = ({ role }: { role: Role }) => <Chip kind="line">{ROLE_LABEL[role]}</Chip>;
const SELF_NOT_REMOVED = "You can't remove yourself";
const NO_EMAIL = "Enter an email to send an invite.";
/** The invite's personal note (#203): plain text, at most this long; a counter shows near it. */
const MESSAGE_MAX = 500;
const MESSAGE_COUNT_FROM = 400;
/** A name is at most 80 characters (A5). */
const NAME_MAX = 80;

const RESENT = ["", "resent once", "resent twice"];

/** An invite row's tooltip: "Invited by Admin on Oct 21, 2026 · resent once". */
function invitedLine(i: Invite): string {
  const by = i.invited_by_name ? `Invited by ${i.invited_by_name} on` : "Invited on";
  const n = i.resend_count ?? 0;
  return [`${by} ${formatDate(i.created_at)}`, n ? (RESENT[n] ?? `resent ${n} times`) : null].filter(Boolean).join(" · ");
}

function RoleSelect({
  value,
  label,
  disabled,
  onChange,
  id,
  roles,
  className = "",
}: {
  value: Role;
  label: string;
  disabled?: boolean;
  onChange: (role: Role) => void;
  id?: string;
  /** The roles offered (A5: an approver's invite_roles); every role by default. */
  roles?: Role[];
  className?: string;
}) {
  return (
    <select id={id} aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as Role)} className={`${ROLE_SELECT} ${className}`}>
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

/**
 * While `dirty`, a link to another page or the browser's Back first asks "Discard your
 * changes?" (Keep editing or Discard), as New request's dialog does: the rail, Settings'
 * list, a Tokens count.
 */
function useLeaveGuard(dirty: boolean) {
  const router = useRouter();
  useEffect(() => {
    if (!dirty) return;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!(a instanceof HTMLAnchorElement) || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
      const url = new URL(a.href, window.location.href);
      // A link within this page (Invite someone's #invite-form) keeps the form.
      if (url.origin !== window.location.origin || (url.pathname === window.location.pathname && url.search === window.location.search)) return;
      e.preventDefault();
      e.stopPropagation();
      void confirmInPage({
        title: "Discard your changes?",
        message: "The invite you started is not sent. Leaving this page throws it away.",
        action: "Discard",
        cancel: "Keep editing",
        destructive: true,
      }).then((yes) => yes && router.push(`${url.pathname}${url.search}${url.hash}`));
    };
    // Before the app's own link handlers (React's, at its root), so nothing moves first.
    document.addEventListener("click", onClick, true);
    // The browser's Back asks too: a copy of this page's history entry takes the Back, and
    // Discard then goes back past the page itself.
    const guarded = { ...(window.history.state ?? {}), poLeaveGuard: true };
    if (!window.history.state?.poLeaveGuard) window.history.pushState(guarded, "", window.location.href);
    let leaving = false;
    const onPop = () => {
      if (leaving) return;
      void confirmInPage({
        title: "Discard your changes?",
        message: "The invite you started is not sent. Leaving this page throws it away.",
        action: "Discard",
        cancel: "Keep editing",
        destructive: true,
      }).then((yes) => {
        if (yes) {
          leaving = true;
          window.history.back();
        } else window.history.pushState(guarded, "", window.location.href);
      });
    };
    window.addEventListener("popstate", onPop);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", onPop);
    };
  }, [dirty, router]);
}

/** An email that breaks only after its @ or before a dot, never mid-word (qa-settings-2). */
function Email({ email }: { email: string }) {
  return (
    <>
      {email.split(/(?<=@)|(?=\.)/).map((part, i) => (
        <Fragment key={i}>
          {i > 0 && <wbr />}
          {part}
        </Fragment>
      ))}
    </>
  );
}

function subscribeHash(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

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
      {/* qa4-settings-36: the same View only chip as every other read-only Settings page. */}
      <PageHeader title="Members" status={ready ? <ViewOnly /> : undefined} info={pageTip} />
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
        Your role is <b>{role ? ROLE_LABEL[role] : "not known"}</b>.{" "}
        {can("create_invite") ? "You can invite viewers and commenters and approve their access requests." : "Owners manage members and sign-in."}
      </span>
      {engineeringLead && <span>You are an engineering lead.</span>}
    </p>
  );
}

/** The four roles and the engineering lead flag, what each can do in words, and how many active people hold each. */
function RolesSection({ members, label = "Roles" }: { members?: Member[]; label?: string | null }) {
  const leads = members?.filter((m) => m.engineering_lead && m.status !== "disabled").length;
  return (
    <>
      <InspectorSection label={label ?? undefined} testId="roles-list">
        {ROLES.map((r) => (
          <div key={r.role} data-testid={`role-${r.role}`} className="flex items-start gap-2.5 py-1">
            <span className="min-w-0 flex-1">
              <span className="block font-semibold">{r.label}</span>
              <span data-testid="role-can" className="block text-[13px] leading-5 break-words text-text2">
                {r.can.charAt(0).toUpperCase() + r.can.slice(1)}.
              </span>
            </span>
            {members && (
              <span className="tnum flex-none font-semibold">{members.filter((m) => m.role === r.role && m.status !== "disabled").length}</span>
            )}
          </div>
        ))}
      </InspectorSection>
      {/* qa-settings-7: not a fifth role, so a section of its own. */}
      <InspectorSection label="Engineering lead" testId="roles-lead">
        <div data-testid="roles-engineering-lead">
          <InspectorRow
            value={
              leads ? (
                <span className="tnum" data-testid="engineering-lead-count">
                  {leads}
                </span>
              ) : undefined
            }
          >
            <span className="inline-flex items-center gap-1.5">
              {/* The row keeps the words "Engineering lead" for a screen reader; the heading shows them. */}
              <span>
                <span className="sr-only">Engineering lead: </span>
                {/* qa4-settings-14: nobody named reads as words, not "People named 0". */}
                {leads == null ? (
                  "Any commenter or above can carry it"
                ) : leads === 0 ? (
                  <span data-testid="engineering-lead-none">Nobody named yet. Pick who carries engineering checks.</span>
                ) : (
                  "People named"
                )}
              </span>
              <InfoTip label="the engineering lead" align="start">
                {LEAD_TIP}
              </InfoTip>
            </span>
          </InspectorRow>
        </div>
      </InspectorSection>
    </>
  );
}

function RolesInspector() {
  return (
    // qa-shell-27: one heading, the panel's title; its roles section has none of its own.
    <Inspector eyebrow="Members" title="Roles" label="Roles">
      <RolesSection label={null} />
    </Inspector>
  );
}

const removed = (m: Member) => m.status === "disabled";
/** "Oct 18, 2026": the page's one date format (the People table's); the time is in its title. */
const shortDate = (iso: string) => formatDate(iso);
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

/** "Last tried Oct 22, 9:05 AM PDT · <reason>": one part of an invite's status line. */
function tried(at?: string | null, reason?: string | null): string {
  return [at ? `Last tried ${formatDateTime(at)}` : null, reason || null].filter(Boolean).join(" · ");
}

/**
 * An open invite's one status line, as text: only what still needs someone (access Google
 * has not granted yet, an email that failed or was not sent), when last tried and why.
 * Nothing when all went through: the chips say so.
 */
function InviteDetail({ invite }: { invite: Invite }) {
  const access = invite.access === "pending" ? tried(invite.access_at, invite.access_error) : "";
  const s = invite.email_status;
  const email =
    s === "failed" ? tried(invite.email_at, invite.email_error) : s === "not_sent" ? "Oracle has no sender set up: send them the sign-in link" : "";
  if (!access && !email) return null;
  return (
    <p data-testid="invite-detail" className="basis-full text-[13px] break-words text-text2">
      {access && <span data-testid="invite-access-detail">{access}</span>}
      {access && email && " · "}
      {email && <span data-testid="invite-email-detail">{email}</span>}
    </p>
  );
}

/**
 * An invite's Google IAP access: their Google sign-in is ready (qa-onboarding-38: they have
 * not joined until they sign in), or not yet with Retry. Nothing without IAP.
 */
function AccessState({ invite, retrying, onRetry }: { invite: Invite; retrying: boolean; onRetry: () => void }) {
  if (invite.access !== "granted" && invite.access !== "pending") return null;
  const granted = invite.access === "granted";
  return (
    <>
      <Chip
        kind={granted ? "pass" : "warn"}
        data-testid="invite-access"
        title={granted && invite.access_at ? `Google sign-in ready since ${formatDateTime(invite.access_at)}` : undefined}
      >
        {granted ? "Google sign-in ready" : "Access not granted yet"}
      </Chip>
      {!granted && (
        <Button variant="ghost" aria-label={`Retry access for ${invite.email}`} aria-busy={retrying || undefined} disabled={retrying} onClick={onRetry}>
          {retrying ? "Retrying…" : "Retry"}
        </Button>
      )}
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
  return (
    <>
      <Chip
        kind={s === "failed" ? "crit" : s === "sent" ? "line" : "na"}
        data-testid="invite-email"
        title={(s === "sent" || s === "failed") && invite.email_at ? `${EMAIL_LABEL[s]} ${formatDateTime(invite.email_at)}` : undefined}
      >
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

/** "Removed", its date under the chip (qa-settings-1: the chip fits its column). */
function StatusChip({ m }: { m: Member }) {
  const status = !removed(m) ? (
    <Chip kind="pass" dot>
      Active
    </Chip>
  ) : (
    <span data-testid="member-removed" className="flex flex-col items-start gap-0.5" title={m.disabled_at ? `Removed ${formatDateTime(m.disabled_at)}` : undefined}>
      <Chip kind="na" dot>
        Removed
      </Chip>
      {m.disabled_at && <span className="tnum text-[12px] leading-4 text-text2">{shortDate(m.disabled_at)}</span>}
    </span>
  );
  if (!m.access_pending) return status;
  // A Google IAP access change that failed; Oracle retries it on its own.
  return (
    <span className="flex flex-col items-start gap-1">
      {status}
      <Chip kind="warn" wrap data-testid="member-access" title="Google refused the change; Oracle retries it for a day">
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
  // The emails Oracle has been sending too long to keep looking (the outcome then says so).
  const [mailStalled, setMailStalled] = useState(false);
  // "Saved" after an Eng lead tick lands (qa-onboarding-21), by the member's email.
  const [leadSaved, setLeadSaved] = useState<string | null>(null);
  const leadSavedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (leadSavedTimer.current && clearTimeout(leadSavedTimer.current)), []);
  // The Set up checklist's Engineering lead step lands on #engineering-lead: the column is
  // marked and a line says what to pick.
  const leadStep = useSyncExternalStore(subscribeHash, () => window.location.hash === "#engineering-lead", () => false);
  const [resent, setResent] = useState<{ id: string; ok: boolean; text: string } | null>(null);
  const resentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (resentTimer.current && clearTimeout(resentTimer.current)), []);
  // qa-onboarding-36: a half-written invite asks before a link elsewhere drops it.
  useLeaveGuard(!!email.trim() || !!inviteName.trim() || !!inviteMessage.trim() || inviteLead);
  // qa-settings-44: below 1100 px the panel sits under the list; a picked member's comes into view.
  useEffect(() => {
    if (!inspecting || !window.matchMedia("(max-width: 1100px)").matches) return;
    const at = requestAnimationFrame(() => document.querySelector('[data-testid="member-inspector"]')?.scrollIntoView({ block: "start" }));
    return () => cancelAnimationFrame(at);
  }, [inspecting]);

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
      setLeadSaved(personName(m));
      if (leadSavedTimer.current) clearTimeout(leadSavedTimer.current);
      leadSavedTimer.current = setTimeout(() => setLeadSaved(null), 4000);
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

  /** qa-onboarding-37: what a Resend did, said on its own row ("Resent just now", or why not). */
  function resentNote(id: string, ok: boolean, text: string) {
    setResent({ id, ok, text });
    if (resentTimer.current) clearTimeout(resentTimer.current);
    if (ok) resentTimer.current = setTimeout(() => setResent((r) => (r?.id === id ? null : r)), 8000);
  }

  async function resend(invite: Invite) {
    setBusy(`email:${invite.id}`);
    setError(null);
    try {
      const updated = await unwrap(api.POST("/v1/invites/{invite_id}/email", { params: { path: { invite_id: invite.id } } }));
      polls.current = 0;
      setMailStalled(false);
      replaceInvite(updated);
      resentNote(invite.id, true, "Resent just now");
    } catch (e) {
      resentNote(invite.id, false, errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function renew(invite: Invite) {
    setBusy(`resend:${invite.id}`);
    setError(null);
    try {
      const updated = await unwrap(api.POST("/v1/invites/{invite_id}/resend", { params: { path: { invite_id: invite.id } } }));
      replaceInvite(updated);
      resentNote(invite.id, true, `Resent just now · expires ${formatDate(updated.expires_at)}`);
    } catch (e) {
      resentNote(invite.id, false, errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function invite(e: FormEvent) {
    e.preventDefault();
    // The press says what is missing (the button is never greyed out with no reason).
    if (!email.trim()) {
      setInviteError(NO_EMAIL);
      emailRef.current?.focus();
      return;
    }
    setPending(true);
    setInviteError(null);
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
      setMailStalled(false);
      setMade(created);
      setEmail("");
      setInviteName("");
      setInviteLead(false);
      setInviteMessage("");
    } catch (err) {
      // qa-onboarding-8: only the refusal shows, not the last invite's "Invite sent".
      setMade(null);
      setInviteError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  const roleCell = (m: Member) => {
    if (removed(m)) return <RoleChip role={m.role} />;
    const lastOwner = m.role === "owner" && activeOwners <= 1;
    if (m.id === selfId) {
      // qa-shell-28: on a phone your own card shows your role and status only, on one line.
      return (
        <span className="flex flex-col gap-1 max-[600px]:contents">
          {/* qa4-settings-9: phone only. The wrapper hides it: the Chip's own inline-flex beats a `hidden` passed to it. */}
          <span className="hidden max-[600px]:contents">
            <Chip kind="line" data-testid="own-role">
              {ROLE_LABEL[m.role]}
            </Chip>
          </span>
          <span className="contents max-[600px]:hidden">
            {lastOwner ? (
              <Unavailable reason="You are the only owner. Make someone else owner first." testId="role-unavailable">
                {(props) => (
                  <button type="button" {...props} aria-label={`Role for ${m.email}`} className="inline-flex rounded-full text-left">
                    <RoleChip role={m.role} />
                  </button>
                )}
              </Unavailable>
            ) : (
              <RoleSelect value={m.role} label={`Role for ${m.email}`} disabled={saving === m.id} onChange={(role) => changeRole(m, role)} className="self-start" />
            )}
          </span>
          {/* Your own lead box too: on a phone the Eng lead column hides. */}
          {phoneLead(m)}
        </span>
      );
    }
    return (
      // qa4-settings-21: on a phone the select and its lead box sit on one centred line, so the
      // Status pill beside them lines up (a column made the cell tall and the pill floated).
      <span className="flex flex-col gap-1 max-[600px]:flex-row max-[600px]:flex-wrap max-[600px]:items-center max-[600px]:gap-x-3">
        {/* Its own width, not the cell's (qa-shell-5): the browser sizes a select to its longest role and its arrow. */}
        <RoleSelect
          value={m.role}
          label={`Role for ${m.email}`}
          disabled={saving === m.id}
          onChange={(role) => changeRole(m, role)}
          className="self-start max-[600px]:self-center"
        />
        {phoneLead(m)}
      </span>
    );
  };

  /** On a phone the Eng lead column hides: its box moves into the role cell, under the select. */
  const phoneLead = (m: Member) => (
    <label
      className="hidden min-h-11 items-center gap-2 text-sm max-[600px]:inline-flex"
      title={m.role === "viewer" ? VIEWER_NOT_LEAD : undefined}
    >
      {leadBox(m)}
      {m.role === "viewer" ? "Engineering lead: not for viewers" : "Engineering lead"}
    </label>
  );

  /** A3: the member's engineering lead box; a viewer's is disabled and says why (title, and words beside it). */
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
        <span className="inline-flex flex-col items-end gap-0.5 max-[600px]:items-start">
          <Unavailable reason={reason} testId="remove-unavailable">
            {(props) => (
              <Button {...props} aria-label={`Remove ${m.email}`} className="opacity-60">
                Remove
              </Button>
            )}
          </Unavailable>
          <span data-testid="remove-reason" title={reason} className="text-[13px] leading-4 text-text2">
            {SELF_NOT_REMOVED}
          </span>
        </span>
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
          <span className="flex-none">
            <Avatar name={personName(m)} size={28} tone={m.id === selfId ? "me" : "default"} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
            {/* A5: the name in bold (the one name rule, as everyone's People list), the email under it;
                opens the member inspector. The name wraps; the email stays on one line (qa4-settings-10),
                cut with an ellipsis if it must be, the full address on hover. The chips sit under them.
                On a phone the button is a 44 px target. */}
            <button
              type="button"
              data-testid="member-open"
              onClick={() => setInspecting(m.id)}
              className={`flex max-w-full min-w-0 flex-col text-left leading-tight break-words hover:underline max-[600px]:min-h-11 max-[600px]:justify-center ${removed(m) ? "text-text2" : ""}`}
            >
              <span data-testid="member-name" className="font-semibold">
                {personName(m)}
              </span>
              {personName(m) !== m.email && (
                // Not `truncate`: on a phone the table undoes that class and wraps anywhere.
                <span data-testid="member-email" title={m.email} className="block max-w-full overflow-hidden text-[13px] font-normal text-ellipsis whitespace-nowrap text-text2">
                  {m.email}
                </span>
              )}
            </button>
            {(m.id === selfId || m.engineering_lead) && (
              <span className="flex flex-wrap gap-1">
                {m.id === selfId && (
                  <Chip kind="acc">
                    <span className="sr-only">(</span>you<span className="sr-only">)</span>
                  </Chip>
                )}
                {/* On a phone the Eng lead column hides; this chip says it instead. */}
                {m.engineering_lead && (
                  <span className="hidden max-[600px]:contents">
                    <Chip kind="acc">Eng lead</Chip>
                  </span>
                )}
              </span>
            )}
          </span>
        </span>
      ),
    },
    { key: "role", header: "Role", width: "160px", wrap: true, cell: roleCell },
    {
      key: "lead",
      // The anchor of A1's Engineering lead step (Set up on Home).
      header: (
        <span id="engineering-lead" data-highlight={leadStep || undefined} className={leadStep ? "rounded bg-accent-soft px-1.5 py-0.5 text-accent-ink" : undefined}>
          Eng lead
        </span>
      ),
      width: "96px",
      hideOnPhone: true,
      wrap: true,
      cell: (m) =>
        removed(m) ? (
          <span className="text-text2">{m.engineering_lead ? "Yes" : "—"}</span>
        ) : m.role === "viewer" ? (
          <span className="flex flex-col items-start gap-0.5" title={VIEWER_NOT_LEAD}>
            {leadBox(m)}
            <span className="text-[12px] leading-4 text-text2">Not for viewers</span>
          </span>
        ) : (
          leadBox(m)
        ),
    },
    { key: "status", header: "Status", width: "120px", wrap: true, cell: (m) => <StatusChip m={m} /> },
    {
      key: "signin",
      header: "Last sign-in",
      width: "104px",
      // Beside an open panel the table keeps its room for names; the panel shows the date.
      narrow: "laptop",
      // On a phone the cell says it in words: "Signed in Oct 20, 2026", or "Never signed in".
      cell: (m) =>
        m.last_sign_in_at ? (
          <span className="tnum text-text2">
            <span className="hidden font-semibold text-text max-[600px]:inline">Signed in </span>
            <span title={formatDateTime(m.last_sign_in_at)}>{formatDate(m.last_sign_in_at)}</span>
          </span>
        ) : (
          <span data-testid="never-signed-in" className="text-text2" title="No sign-in recorded yet">
            Never<span className="hidden max-[600px]:inline"> signed in</span>
          </span>
        ),
    },
    {
      key: "tokens",
      header: "Tokens",
      width: "64px",
      align: "right",
      phoneLabel: "Tokens ",
      cell: (m) => (
        <Link
          href={`/settings/api-tokens?member=${m.id}`}
          className="tnum font-semibold text-accent-ink hover:underline max-[600px]:inline-flex max-[600px]:min-h-11 max-[600px]:min-w-11 max-[600px]:items-center max-[600px]:justify-center"
          aria-label={`${m.open_tokens ?? 0} open tokens of ${m.email}`}
          data-testid="open-tokens"
        >
          {m.open_tokens ?? 0}
        </Link>
      ),
    },
    {
      key: "action",
      header: <span className="sr-only">Actions</span>,
      width: "120px",
      align: "right",
      phone: "action",
      wrap: true,
      // qa-shell-28: on a phone your own card shows your role and status only, not a Remove you can't use.
      cell: (m) => (m.id === selfId && !removed(m) ? <span className="contents max-[600px]:hidden">{actionCell(m)}</span> : actionCell(m)),
    },
  ];

  const invites = invitesQ.data;
  // Oracle sends invite emails in the background: look again until none is still sending.
  const sending = invites?.some((i) => i.email_status === "queued") ?? false;
  const reloadInvites = invitesQ.reload;
  useEffect(() => {
    if (!sending || polls.current >= MAIL_POLLS) return;
    const t = setTimeout(() => {
      polls.current += 1;
      // The last look: if the email is still not out, the outcome stops saying "Sending".
      if (polls.current >= MAIL_POLLS) setMailStalled(true);
      void reloadInvites();
    }, MAIL_POLL_MS);
    return () => clearTimeout(t);
  }, [sending, invites, reloadInvites]);
  // The invite just made, as the list has it now (gone once revoked).
  const latest = made ? invites?.find((i) => i.id === made.id) : undefined;
  const outcome = latest && (
    <InviteOutcome invite={latest} stalled={mailStalled} copied={copied === `made:${latest.id}`} onCopy={() => copyLink(latest, `made:${latest.id}`)} />
  );

  // qa-settings-4: GET /v1/invites lists the expired with the open (each needs an action); the page keeps them apart.
  const openInvites = invites?.filter((i) => i.status !== "expired");
  const expiredInvites = invites?.filter((i) => i.status === "expired");
  const inviteRow = (i: Invite) => (
    <li
      key={i.id}
      data-testid="invite-row"
      data-status={i.status}
      {...inviteActs.rowAttrs(i.id)}
      className="flex min-h-11 flex-col gap-1.5 border-t border-line py-2 first:border-t-0"
    >
      {/* The full email on its own line, wrapping at its @ or a dot, never cut; chips and actions under it. */}
      <span data-testid="invite-who" className="min-w-0 font-medium break-words" title={invitedLine(i)}>
        {i.name ? (
          <>
            {i.name}{" "}
            <span className="font-normal text-text2">
              <Email email={i.email} />
            </span>
          </>
        ) : (
          <Email email={i.email} />
        )}
      </span>
      {inviteActs.acted?.key === i.id ? (
        <ActedCell acted={inviteActs.acted} onUndo={inviteActs.undo} />
      ) : (
        <>
          <span className="flex flex-wrap items-center gap-1.5">
            <Chip kind="acc">{ROLE_LABEL[i.role]}</Chip>
            {i.engineering_lead && <Chip kind="acc">Eng lead</Chip>}
            {i.status === "expired" ? (
              <Chip kind="warn" data-testid="invite-expiry">
                Expired {formatDate(i.expires_at)}
              </Chip>
            ) : (
              <Chip kind="line" data-testid="invite-expiry">
                Expires {formatDate(i.expires_at)}
              </Chip>
            )}
            {/* #370: Retry and Resend are an owner's; an approver sees neither. An expired
                invite's only state is Expired: its access and email no longer matter. */}
            {manage && i.status !== "expired" && (
              <AccessState invite={i} retrying={busy === `access:${i.id}`} onRetry={() => retryAccess(i)} />
            )}
            {manage && i.status !== "expired" && (
              <EmailState invite={i} resending={busy === `email:${i.id}`} onResend={() => resend(i)} />
            )}
          </span>
          <span className="flex flex-wrap items-center gap-1.5">
            {i.status === "expired" ? (
              // A5: 14 more days from now; an expired link no longer signs anyone in, so no Copy link.
              <Button
                variant="ghost"
                aria-label={`Resend invite for ${i.email}`}
                disabled={busy === `resend:${i.id}`}
                onClick={() => renew(i)}
              >
                {busy === `resend:${i.id}` ? "Resending…" : "Resend"}
              </Button>
            ) : (
              <Button variant="ghost" icon="link" aria-label={`Copy link for ${i.email}`} onClick={() => copyLink(i)}>
                {copied === i.id ? "Copied" : "Copy link"}
              </Button>
            )}
            <Button variant="ghost" aria-label={`Revoke invite for ${i.email}`} onClick={() => revokeInvite(i)}>
              Revoke
            </Button>
          </span>
          {i.message && (
            // Plain text, on one line: the full note is its title.
            <span data-testid="invite-note" title={i.message} className="truncate text-[13px] text-text2">
              Note: {i.message}
            </span>
          )}
          {manage && i.status !== "expired" && <InviteDetail invite={i} />}
          {resent?.id === i.id && (
            <p
              role={resent.ok ? "status" : "alert"}
              data-testid="invite-resent"
              className={`text-[13px] font-medium break-words ${resent.ok ? "text-pass" : "text-crit"}`}
            >
              {resent.text}
            </p>
          )}
        </>
      )}
    </li>
  );

  const inspector = (
    <Inspector
      eyebrow="Members"
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
        // qa-settings-4: an expired invite is counted, and listed, apart from the open ones.
        { label: "Open invites", value: openInvites?.length ?? "—", testId: "stat-open-invites" },
        ...(expiredInvites?.length ? [{ label: "Expired", value: expiredInvites.length, testId: "stat-expired-invites" }] : []),
      ]}
    >
      <InspectorSection>
        <form id={INVITE_FORM} onSubmit={invite} aria-label="Invite" noValidate className="flex flex-col gap-3">
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
              title={!email.trim() ? NO_EMAIL : undefined}
              aria-describedby={inviteError ? "invite-error" : undefined}
              className={INPUT}
            />
          </Field>
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
              className="w-full"
              roles={inviteRoles}
              onChange={(r) => {
                setInviteRole(r);
                if (r === "viewer") setInviteLead(false);
              }}
            />
          </Field>
          {manage && (
            <div className="flex flex-col gap-0.5">
              <label className="inline-flex min-h-11 items-center gap-2 text-[15px]" title={inviteRole === "viewer" ? VIEWER_NOT_LEAD : undefined}>
                <input
                  type="checkbox"
                  checked={inviteLead && inviteRole !== "viewer"}
                  disabled={inviteRole === "viewer"}
                  onChange={(e) => setInviteLead(e.target.checked)}
                  className={CHECKBOX}
                />
                Engineering lead
              </label>
              {inviteRole === "viewer" && (
                <p data-testid="invite-lead-reason" className="-mt-2 text-[13px] text-text2">
                  {VIEWER_NOT_LEAD}. Pick Commenter or above to name them.
                </p>
              )}
            </div>
          )}
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
            {/* The page's one way to invite: a filled primary button, never greyed out without a reason. */}
            <Button type="submit" variant="primary" icon="plus" disabled={pending}>
              {pending ? "Inviting…" : "Send invite"}
            </Button>
          </div>
          {outcome}
        </form>
      </InspectorSection>
      <InspectorSection label="Open invites" testId="open-invites">
        {invitesQ.error && <Notice tone="error">{invitesQ.error}</Notice>}
        {!invites && !invitesQ.error && <span className="block h-3 w-2/3 animate-pulse rounded bg-surface2" />}
        {openInvites?.length === 0 && <p className="text-[15px] text-text2">No open invites</p>}
        {!!openInvites?.length && (
          <ul aria-label="Open invites" className={`-my-1 flex flex-col ${SETTLING}`}>
            {openInvites.map(inviteRow)}
          </ul>
        )}
      </InspectorSection>
      {!!expiredInvites?.length && (
        <InspectorSection label="Expired invites" testId="expired-invites">
          <ul aria-label="Expired invites" className={`-my-1 flex flex-col ${SETTLING}`}>
            {expiredInvites.map(inviteRow)}
          </ul>
        </InspectorSection>
      )}
      <RolesSection members={manage ? members : undefined} />
    </Inspector>
  );

  const active = members?.filter((m) => !removed(m)).length;
  const inspected = inspecting ? members?.find((m) => m.id === inspecting) : undefined;
  return (
    <>
      <PageHeader
        title="Members"
        status={
          <>
            {manage && active != null && <Chip kind="acc">{active} active</Chip>}
            {pageTip}
          </>
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
        {manage && leadStep && (
          <Notice testId="lead-step-hint">
            Pick who checks feasibility: tick Eng lead for the person who speaks for engineering. Any commenter or above can be it.
          </Notice>
        )}
        {manage && <Panel
          title="People"
          count={members?.length}
          tools={
            <span className="inline-flex flex-wrap items-center gap-2">
              {leadSaved && (
                <span role="status" data-testid="lead-saved" className="text-sm font-semibold text-pass">
                  Saved
                </span>
              )}
              <FindPerson value={find} onChange={setFind} />
              {/* Under 1100 px the invite form sits below this table: a way down to it. While a
                  member's panel is open (it stands in the form's place) it shows at every width and
                  closes the panel first (qa4-settings-11). */}
              <a
                href={`#${INVITE_FORM}`}
                data-testid="invite-someone"
                onClick={(e) => {
                  e.preventDefault();
                  if (inspected) setInspecting(null);
                  requestAnimationFrame(() => {
                    emailRef.current?.scrollIntoView({ block: "center" });
                    emailRef.current?.focus({ preventScroll: true });
                  });
                }}
                className={`min-h-11 items-center text-sm font-semibold text-accent-ink hover:underline ${inspected ? "inline-flex" : "hidden max-[1100px]:inline-flex"}`}
              >
                Invite someone
              </a>
            </span>
          }
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
                rows={members?.filter((m) => matches(find, m.name, m.email))}
                loading={!members}
                rowKey={(m) => m.id}
                rowProps={(m) => ({ "data-testid": "member-row", "data-status": m.status, ...memberActs.rowAttrs(m.id) })}
                empty={find.trim() ? <NoMatch find={find} onClear={() => setFind("")} /> : "No members"}
              />
            </div>
          )}
        </Panel>}
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

/** What happened to the invite just made: emailed, being emailed, or the link to send. */
function InviteOutcome({ invite, stalled, copied, onCopy }: { invite: Invite; stalled: boolean; copied: boolean; onCopy: () => void }) {
  if (invite.email_status === "sent") {
    return (
      <Notice tone="pass" testId="invite-outcome">
        Invite sent to {invite.email}
      </Notice>
    );
  }
  if (invite.email_status === "queued" && !stalled) {
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
      {invite.email_status === "queued"
        ? `Oracle hasn't emailed ${invite.email} yet. Send them this link yourself:`
        : "Oracle didn't email this invite. Send them this link:"}{" "}
      <code data-testid="invite-link" className="break-all font-mono text-[13px]">
        {invite.sign_in_url}
      </code>
    </Notice>
  );
}
