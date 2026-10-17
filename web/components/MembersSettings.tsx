"use client";

import { useState, type FormEvent } from "react";

import { Badge, Button, ErrorNote, Loading } from "@/components/ui";
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

function RoleSelect({
  value,
  label,
  disabled,
  onChange,
}: {
  value: Role;
  label: string;
  disabled?: boolean;
  onChange: (role: Role) => void;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as Role)}
      className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-900 disabled:opacity-50"
    >
      {ROLES.map((r) => (
        <option key={r.role} value={r.role}>
          {r.label}
        </option>
      ))}
    </select>
  );
}

/** Settings > Members: the people of this company's Oracle, their roles and open invites. */
export function MembersSettings() {
  const { me, role, loading } = useMe();
  const isOwner = hasRole(role, "owner");

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <h1 className="mb-2 text-2xl font-semibold tracking-tight text-neutral-900">Members</h1>
      <p className="mb-6 text-sm text-neutral-600">
        Everyone who signs in to this company&apos;s Oracle has one role.
      </p>
      <dl className="mb-8 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[8rem_1fr]">
        {ROLES.map((r) => (
          <div key={r.role} className="contents">
            <dt className="font-medium text-neutral-800">{r.label}</dt>
            <dd className="text-neutral-600">{r.can}</dd>
          </div>
        ))}
      </dl>
      {loading ? (
        <Loading />
      ) : isOwner ? (
        <OwnerView selfId={me?.user_id ?? null} />
      ) : (
        <p role="note" data-testid="role-note" className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-700">
          Your role is {role ? LABEL[role].toLowerCase() : "unknown"}. Only owners can see members, change roles and
          invite people.
        </p>
      )}
    </div>
  );
}

function OwnerView({ selfId }: { selfId: string | null }) {
  const membersQ = useQuery("members", () => unwrap(api.GET("/v1/members")));
  const invitesQ = useQuery("invites", () => unwrap(api.GET("/v1/invites")));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

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

  async function revoke(invite: Invite) {
    setError(null);
    try {
      await unwrap(api.DELETE("/v1/invites/{invite_id}", { params: { path: { invite_id: invite.id } } }));
      invitesQ.setData((prev) => prev?.filter((i) => i.id !== invite.id));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <div className="flex flex-col gap-8">
      {error && <ErrorNote>{error}</ErrorNote>}

      <section aria-labelledby="members-heading">
        <h2 id="members-heading" className="mb-3 text-sm font-semibold text-neutral-800">
          People
        </h2>
        {membersQ.error && <ErrorNote>{membersQ.error}</ErrorNote>}
        {!membersQ.data && !membersQ.error && <Loading />}
        {membersQ.data && (
          <table className="w-full text-sm" aria-label="Members">
            <thead>
              <tr className="border-b border-neutral-200 text-left text-xs text-neutral-500">
                <th className="py-2 font-medium">Email</th>
                <th className="py-2 font-medium">Role</th>
                <th className="py-2 font-medium">Since</th>
              </tr>
            </thead>
            <tbody>
              {membersQ.data.map((m) => (
                <tr key={m.id} data-testid="member-row" className="border-b border-neutral-100">
                  <td className="py-2 text-neutral-900">
                    {m.email}
                    {m.id === selfId && <span className="ml-2 text-xs text-neutral-500">(you)</span>}
                  </td>
                  <td className="py-2">
                    <RoleSelect
                      value={m.role}
                      label={`Role for ${m.email}`}
                      disabled={saving === m.id}
                      onChange={(role) => changeRole(m, role)}
                    />
                  </td>
                  <td className="py-2 text-neutral-500">{formatDate(m.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="invite-heading">
        <h2 id="invite-heading" className="mb-1 text-sm font-semibold text-neutral-800">
          Invite someone
        </h2>
        <p className="mb-3 text-sm text-neutral-600">
          Their first Google sign-in lands with the role you pick. Without an invite, a Google sign-in from an allowed
          domain gets the company&apos;s default role (commenter unless changed).
        </p>
        <InviteForm onInvited={(i) => invitesQ.setData((prev) => [i, ...(prev ?? [])])} />
      </section>

      <section aria-labelledby="invites-heading">
        <h2 id="invites-heading" className="mb-3 text-sm font-semibold text-neutral-800">
          Open invites
        </h2>
        {invitesQ.error && <ErrorNote>{invitesQ.error}</ErrorNote>}
        {!invitesQ.data && !invitesQ.error && <Loading />}
        {invitesQ.data?.length === 0 && <p className="text-sm text-neutral-500">No open invites.</p>}
        {!!invitesQ.data?.length && (
          <ul aria-label="Open invites" className="flex flex-col divide-y divide-neutral-100 text-sm">
            {invitesQ.data.map((i) => (
              <li key={i.id} data-testid="invite-row" className="flex items-center gap-3 py-2">
                <span className="text-neutral-900">{i.email}</span>
                <Badge>{LABEL[i.role]}</Badge>
                <span className="text-xs text-neutral-500">invited {formatDate(i.created_at)}</span>
                <Button size="sm" variant="ghost" className="ml-auto" aria-label={`Revoke invite for ${i.email}`} onClick={() => revoke(i)}>
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function InviteForm({ onInvited }: { onInvited: (invite: Invite) => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("commenter");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setPending(true);
    setError(null);
    try {
      const invite = await unwrap(api.POST("/v1/invites", { body: { email: email.trim(), role } }));
      onInvited(invite);
      setEmail("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} aria-label="Invite" className="flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1 text-xs text-neutral-600">
        Email
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="name@example.com"
          className="w-72 rounded-md border border-neutral-300 px-2 py-1.5 text-sm text-neutral-900"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-neutral-600">
        Role
        <RoleSelect value={role} label="Role" onChange={setRole} />
      </label>
      <Button type="submit" variant="primary" disabled={pending || !email.trim()}>
        {pending ? "Inviting…" : "Invite"}
      </Button>
      {error && (
        <p role="alert" className="w-full text-sm text-rose-700">
          {error}
        </p>
      )}
    </form>
  );
}
