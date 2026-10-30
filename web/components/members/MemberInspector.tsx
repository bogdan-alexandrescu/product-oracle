"use client";

import Link from "next/link";
import { Fragment, useState, type FormEvent, type ReactNode } from "react";

import { Field, INPUT } from "@/app/settings/_components/fields";
import { Button, Chip, InfoTip, Inspector, InspectorRow, InspectorSection, Notice } from "@/components/ds";
import { HandOverSelect, personName } from "@/components/members/ChangePreview";
import { MemberApprovals } from "@/components/members/MemberApprovals";
import type { Member } from "@/lib/api/client";
import { hasRole, membersApi, type MemberDetail, type Responsibility } from "@/lib/api/members-types";
import { formatDate, formatDateTime } from "@/lib/format";
import { errorMessage, useQuery } from "@/lib/use-query";

const ROLE_WORD = { owner: "Owner", approver: "Approver", commenter: "Commenter", viewer: "Viewer" } as const;
const NAME_MAX = 80;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Oct 3, 2026 · approved by Admin", "Oct 3, 2026 · joined from example.com", "Sep 1, 2026": the People table's date format. */
function joinedLine(d: MemberDetail): string {
  const day = formatDate(d.joined.at ?? d.created_at);
  const by = d.joined.by_name;
  if (d.joined.via === "access_request" && by) return `${day} · approved by ${by}`;
  if (d.joined.via === "invite" && by) return `${day} · invited by ${by}`;
  if (d.joined.via === "domain") return `${day} · joined from ${d.email.split("@")[1]}`;
  return day;
}

type Approvals = "section" | "version";

/**
 * "3 section approvals · 1 version approval · 1 checkpoint decision not yet delivered"; the
 * approval counts open the approvals behind them (#203 part 3).
 */
function HoldsLine({ d }: { d: MemberDetail }) {
  const [open, setOpen] = useState<Approvals | null>(null);
  const h = d.holds;
  const toggle = (kind: Approvals, label: string) => (
    <button type="button" aria-expanded={open === kind} onClick={() => setOpen((o) => (o === kind ? null : kind))} className="font-semibold text-accent-ink hover:underline">
      {label}
    </button>
  );
  const parts = [
    h.section_approvals ? toggle("section", plural(h.section_approvals, "section approval")) : null,
    h.version_approvals ? toggle("version", plural(h.version_approvals, "version approval")) : null,
    h.spend_approvals ? plural(h.spend_approvals, "spend approval") : null,
    h.checkpoint_decisions ? `${plural(h.checkpoint_decisions, "checkpoint decision")} not yet delivered` : null,
  ].filter((x) => x !== null);
  return (
    <>
      <p className="text-[15px]">
        {parts.length === 0
          ? "Nothing"
          : parts.map((x, i) => (
              <Fragment key={i}>
                {i > 0 && " · "}
                {x}
              </Fragment>
            ))}
      </p>
      {open && <MemberApprovals memberId={d.id} kind={open} />}
    </>
  );
}

/** One responsibility: its label, count, the items behind an (i), and Hand over in place. */
function ResponsibilityRow({
  r,
  people,
  subjectId,
  onHandOver,
}: {
  r: Responsibility;
  people: Member[];
  subjectId: string;
  onHandOver: (to: string | null) => Promise<void>;
}) {
  const first = people.find((p) => p.status !== "disabled" && p.id !== subjectId && hasRole(p.role, r.needs_role));
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState<string>(first?.id ?? "clear");
  const [pending, setPending] = useState(false);
  return (
    <li data-testid="responsibility-row" className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-line py-2 first:border-t-0">
      <span className="inline-flex min-w-0 flex-1 items-center gap-1.5 text-[15px]">
        {r.label} <span className="tnum text-text2">· {r.count}</span>
        {r.items.length > 0 && (
          <InfoTip label={r.label.toLowerCase()} align="start">
            {r.items.map((i) => i.title).join(" · ")}
          </InfoTip>
        )}
      </span>
      {!open ? (
        <Button variant="ghost" onClick={() => setOpen(true)}>
          Hand over
        </Button>
      ) : (
        <span className="flex basis-full flex-wrap items-center gap-2">
          <HandOverSelect r={r} people={people} subjectId={subjectId} value={to} onChange={setTo} withKeep={false} />
          <Button
            variant="solid"
            disabled={pending}
            onClick={async () => {
              setPending(true);
              await onHandOver(to === "clear" ? null : to);
              setPending(false);
              setOpen(false);
            }}
          >
            {pending ? "Handing over…" : "Hand over"}
          </Button>
          <Button variant="ghost" disabled={pending} onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </span>
      )}
      {r.blocks && (
        <Chip kind="warn" wrap className="basis-full">
          {r.blocks}
        </Chip>
      )}
    </li>
  );
}

/**
 * The member inspector (A5, 3.10): opened from a People row in place of the invite
 * inspector. Name (an owner may set it), email, role, how they joined, last sign-in, tokens,
 * what they hold, and their responsibilities ("Still assigned" once removed) with hand-over.
 */
export function MemberInspector({
  member,
  people,
  footer,
  onClose,
  onSaved,
}: {
  member: Member;
  people: Member[];
  /** Remove or Restore, by #104's rules (the row's own action). */
  footer?: ReactNode;
  onClose: () => void;
  onSaved: (m: Member) => void;
}) {
  // A change of status or role (removed, restored) reads the detail again.
  const detailQ = useQuery(`member:${member.id}:${member.status}:${member.role}`, () => membersApi.detail(member.id));
  const detail = detailQ.data ?? null;
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(member.name ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const updated = await membersApi.patch(member.id, { name: name.trim() || null });
      onSaved(updated);
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function handOver(kind: string, to: string | null) {
    setError(null);
    try {
      const out = await membersApi.handOver(member.id, [{ kind, to }]);
      detailQ.setData((d) => (d ? { ...d, responsibilities: out.responsibilities } : d));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const removed = member.status === "disabled";
  const rows = detail?.responsibilities ?? [];
  return (
    <Inspector
      eyebrow="Members · member"
      title={personName(member)}
      label={`Member ${member.email}`}
      testId="member-inspector"
      action={
        <Button variant="hero" icon="x" onClick={onClose}>
          Close
        </Button>
      }
      chips={
        <>
          <Chip hero>{ROLE_WORD[member.role]}</Chip>
          <Chip hero>{removed ? "Removed" : "Active"}</Chip>
          {member.engineering_lead && <Chip hero>Eng lead</Chip>}
        </>
      }
    >
      {(error ?? detailQ.error) && (
        <div className="px-5 pt-3.5">
          <Notice tone="error">{error ?? detailQ.error}</Notice>
        </div>
      )}
      <InspectorSection label="Details">
        <form onSubmit={save} aria-label="Member name" className="mb-2 flex flex-wrap items-end gap-2">
          <Field label="Name" className="min-w-0 flex-1">
            <input
              value={name}
              maxLength={NAME_MAX}
              onChange={(e) => {
                setName(e.target.value);
                setSaved(false);
              }}
              placeholder="As teammates know them"
              className={INPUT}
            />
          </Field>
          <Button type="submit" disabled={saving || name.trim() === (member.name ?? "")}>
            {saving ? "Saving…" : saved ? "Saved" : "Save"}
          </Button>
          <span className="basis-full text-[13px] text-text2">Up to {NAME_MAX} characters</span>
        </form>
        <InspectorRow value={<span className="break-all">{member.email}</span>}>Email</InspectorRow>
        <InspectorRow value={ROLE_WORD[member.role]}>Role</InspectorRow>
        <InspectorRow value={detail ? <span data-testid="member-joined">{joinedLine(detail)}</span> : "—"}>Joined</InspectorRow>
        <InspectorRow
          value={
            member.last_sign_in_at ? (
              <span data-testid="member-last-sign-in" title={formatDateTime(member.last_sign_in_at)}>
                {formatDate(member.last_sign_in_at)}
              </span>
            ) : (
              "Not known"
            )
          }
        >
          Last sign-in
        </InspectorRow>
        <InspectorRow
          value={
            <Link href={`/settings/api-tokens?member=${member.id}`} className="font-semibold text-accent-ink hover:underline">
              {member.open_tokens ?? 0} open
            </Link>
          }
        >
          Tokens
        </InspectorRow>
      </InspectorSection>
      <InspectorSection label="Holds" testId="member-holds">
        {detail ? <HoldsLine d={detail} /> : <p className="text-[15px]">—</p>}
      </InspectorSection>
      <InspectorSection label={removed ? "Still assigned" : "Responsibilities"} testId="member-responsibilities">
        {!detail ? (
          <span className="block h-3 w-2/3 animate-pulse rounded bg-surface2" />
        ) : rows.length === 0 ? (
          <p className="text-[15px] text-text2">Nothing assigned</p>
        ) : (
          <ul className="flex flex-col">
            {rows.map((r) => (
              <ResponsibilityRow key={r.kind} r={r} people={people} subjectId={member.id} onHandOver={(to) => handOver(r.kind, to)} />
            ))}
          </ul>
        )}
      </InspectorSection>
      {footer && <InspectorSection>{footer}</InspectorSection>}
    </Inspector>
  );
}
