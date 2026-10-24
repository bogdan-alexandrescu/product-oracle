"use client";

import { useEffect, useState, type ReactNode } from "react";

import { ConfirmDialog } from "@/components/account/ConfirmDialog";
import { SELECT } from "@/app/settings/_components/fields";
import { Chip } from "@/components/ds";
import type { Member } from "@/lib/api/client";
import { hasRole, membersApi, type HandOver, type Impact, type Responsibility, type Role } from "@/lib/api/members-types";
import { errorMessage } from "@/lib/use-query";

/*
 * A5 (#203 part 2): what removing or demoting a member ends, voids and lapses, read from
 * GET /v1/members/{id}/impact before the owner confirms, and the hand-over of what they hold.
 * Each group shows only when it is not empty.
 */

const ROLE_WORD: Record<Role, string> = { owner: "Owner", approver: "Approver", commenter: "Commenter", viewer: "Viewer" };
const PROVIDER: Record<string, string> = {
  slack: "Slack",
  github: "GitHub",
  google_drive: "Google Drive",
  drive: "Google Drive",
  notion: "Notion",
  fireflies: "Fireflies",
  jira: "Jira",
  linear: "Linear",
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const andList = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
/** "feature_set" reads "Feature set". */
const kindWord = (kind: string) => {
  const w = kind.replace(/_/g, " ");
  return w.charAt(0).toUpperCase() + w.slice(1);
};

/** "Admin" or the email: the one name rule on a member row. */
export const personName = (m: Pick<Member, "email" | "name">) => m.name?.trim() || m.email;

function Group({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
  return (
    <section data-testid={testId} aria-label={title} className="flex flex-col gap-1.5">
      <h3 className="text-[13px] leading-4 font-semibold tracking-[0.02em] text-text2">{title}</h3>
      {children}
    </section>
  );
}

const LINES = "flex list-disc flex-col gap-1 pl-5 text-[15px] leading-[22px]";

/** "Ends now": only for a removal. */
function EndsNow({ ends }: { ends: NonNullable<Impact["ends"]> }) {
  const lines: string[] = [];
  if (ends.sign_in) lines.push("Signs them out everywhere; they can't sign in.");
  const creds = [
    ends.api_tokens ? plural(ends.api_tokens, "personal API token") : null,
    ends.mcp_clients ? plural(ends.mcp_clients, "MCP client") : null,
  ].filter((x): x is string => !!x);
  if (creds.length) lines.push(`Revokes ${andList(creds)}.`);
  const providers = Object.entries(ends.connections)
    .filter(([, n]) => n > 0)
    .map(([p]) => PROVIDER[p] ?? kindWord(p));
  const sources = ends.sources ? `their ${plural(ends.sources, "source")}; documents citing them can't publish until those sources are replaced` : "";
  if (providers.length && sources) lines.push(`Disconnects ${andList(providers)} and pauses ${sources}.`);
  else if (providers.length) lines.push(`Disconnects ${andList(providers)}.`);
  else if (sources) lines.push(`Pauses ${sources}.`);
  if (ends.runs.length) lines.push(`Cancels ${plural(ends.runs.length, "unfinished run")}: ${ends.runs.map((r) => r.title).join(", ")}.`);
  if (ends.llm_jobs) lines.push(`Cancels ${plural(ends.llm_jobs, "queued built-in job")}.`);
  if (ends.invites) lines.push(`Revokes ${plural(ends.invites, "invite")} they sent.`);
  if (!lines.length) return null;
  return (
    <Group title="Ends now" testId="preview-ends">
      <ul className={LINES}>
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </Group>
  );
}

function BackToInbox({ voids }: { voids: Impact["voids"] }) {
  const lines: string[] = [];
  if (voids.spend_approvals.length) lines.push(`${plural(voids.spend_approvals.length, "spend approval")}: ${voids.spend_approvals.map((x) => x.title).join(", ")}`);
  if (voids.resumes.length) lines.push(`${plural(voids.resumes.length, "resume approval")}: ${voids.resumes.map((x) => x.title).join(", ")}`);
  if (voids.checkpoint_decisions.length) {
    lines.push(
      `${plural(voids.checkpoint_decisions.length, "checkpoint decision")} not yet delivered: ${voids.checkpoint_decisions
        .map((x) => `${kindWord(x.kind)} · ${x.title}`)
        .join(", ")}`,
    );
  }
  if (!lines.length) return null;
  return (
    <Group title="Goes back to the Inbox" testId="preview-inbox">
      <ul className={LINES}>
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </Group>
  );
}

function Lapses({ lapses }: { lapses: Impact["lapses"] }) {
  const parts = [
    lapses.section_approvals ? plural(lapses.section_approvals, "section approval") : null,
    lapses.version_approvals.length
      ? `${plural(lapses.version_approvals.length, "version approval")} (${lapses.version_approvals.map((v) => `${v.title} v${v.version}`).join(", ")})`
      : null,
  ].filter((x): x is string => !!x);
  if (!parts.length) return null;
  return (
    <Group title="Lapses for good" testId="preview-lapses">
      <p className="text-[15px] leading-[22px]">{parts.join(" and ")}</p>
    </Group>
  );
}

/** "keep" leaves a kind as it is; "clear" hands it to nobody; otherwise a member's id. */
type Choice = "keep" | "clear" | string;
export type Choices = Record<string, Choice>;

/** The moves to send: every row not left as it is. */
export const movesOf = (choices: Choices): HandOver[] =>
  Object.entries(choices)
    .filter(([, c]) => c !== "keep")
    .map(([kind, c]) => ({ kind, to: c === "clear" ? null : c }));

/** Who may hold a kind: active members other than the subject, with at least its role. */
const holders = (people: Member[], subjectId: string, need: Role) =>
  people.filter((p) => p.status !== "disabled" && p.id !== subjectId && hasRole(p.role, need));

/** One select per responsibility: Leave as is, Clear, or a member who may hold it. */
export function HandOverSelect({
  r,
  people,
  subjectId,
  value,
  onChange,
  withKeep = true,
}: {
  r: Responsibility;
  people: Member[];
  subjectId: string;
  value: Choice;
  onChange: (c: Choice) => void;
  withKeep?: boolean;
}) {
  return (
    <select aria-label={`Hand over ${r.label}`} value={value} onChange={(e) => onChange(e.target.value)} className={`${SELECT} max-w-full`}>
      {withKeep && <option value="keep">Leave as is</option>}
      <option value="clear">Clear</option>
      {holders(people, subjectId, r.needs_role).map((p) => (
        <option key={p.id} value={p.id}>
          {personName(p)}
        </option>
      ))}
    </select>
  );
}

/** The responsibilities with a hand-over select each, and "Hand everything to" above them. */
function HandOverRows({
  title,
  testId,
  rows,
  people,
  subjectId,
  choices,
  setChoices,
  rowLabel,
}: {
  title: string;
  testId: string;
  rows: Responsibility[];
  people: Member[];
  subjectId: string;
  choices: Choices;
  setChoices: (c: Choices) => void;
  rowLabel: (r: Responsibility) => string;
}) {
  const [all, setAll] = useState("");
  if (!rows.length) return null;
  const everyone = people.filter((p) => p.status !== "disabled" && p.id !== subjectId);
  return (
    <Group title={title} testId={testId}>
      <label className="flex flex-wrap items-center gap-2 text-[15px]">
        Hand everything to
        <select
          aria-label="Hand everything to"
          value={all}
          onChange={(e) => {
            const to = e.target.value;
            setAll(to);
            const person = everyone.find((p) => p.id === to);
            if (!person) return;
            // Fills each row the person may hold; the others keep their choice.
            const next = { ...choices };
            for (const r of rows) if (hasRole(person.role, r.needs_role)) next[r.kind] = person.id;
            setChoices(next);
          }}
          className={`${SELECT} max-w-full`}
        >
          <option value="">Choose per row</option>
          {everyone.map((p) => (
            <option key={p.id} value={p.id}>
              {personName(p)}
            </option>
          ))}
        </select>
      </label>
      <ul className="flex flex-col">
        {rows.map((r) => (
          <li key={r.kind} data-testid="handover-row" className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line py-2 first:border-t-0">
            <span className="min-w-0 flex-1 text-[15px]">
              {rowLabel(r)} <span className="tnum text-text2">· {r.count}</span>
            </span>
            <HandOverSelect r={r} people={people} subjectId={subjectId} value={choices[r.kind] ?? "keep"} onChange={(c) => setChoices({ ...choices, [r.kind]: c })} />
            {r.blocks && (
              <Chip kind="warn" wrap className="basis-full">
                {r.blocks}
              </Chip>
            )}
          </li>
        ))}
      </ul>
    </Group>
  );
}

/** Reads the preview for a change; null while it loads. */
function useImpact(member: Member | null, change: "remove" | { role: Role } | null) {
  const [read, setRead] = useState<{ key: string; impact: Impact | null; error: string | null } | null>(null);
  const key = member && change ? `${member.id}:${change === "remove" ? "remove" : change.role}` : null;
  useEffect(() => {
    if (!member || !change || !key) return;
    let live = true;
    membersApi.impact(member.id, change).then(
      (impact) => live && setRead({ key, impact, error: null }),
      (e) => live && setRead({ key, impact: null, error: errorMessage(e) }),
    );
    return () => {
      live = false;
    };
    // The key stands for the member and the change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  // A read for another member or change is not this one's.
  const mine = read && read.key === key ? read : null;
  return { impact: mine?.impact ?? null, error: mine?.error ?? null };
}

/** Removing a member (#104's dialog): its fixed lines replaced by the preview, with hand-over. */
export function RemoveDialog({
  member,
  people,
  pending,
  error,
  onConfirm,
  onClose,
}: {
  member: Member | null;
  people: Member[];
  pending: boolean;
  error: string | null;
  onConfirm: (moves: HandOver[]) => void;
  onClose: () => void;
}) {
  const { impact, error: readError } = useImpact(member, member ? "remove" : null);
  // The choices are per member: a new one starts from "Leave as is".
  const [chosen, setChosen] = useState<{ id: string | null; choices: Choices }>({ id: null, choices: {} });
  const choices = chosen.id === (member?.id ?? null) ? chosen.choices : {};
  const setChoices = (c: Choices) => setChosen({ id: member?.id ?? null, choices: c });
  return (
    <ConfirmDialog
      open={!!member}
      title={member ? `Remove ${personName(member)}?` : ""}
      subject={member ? `${member.email} · ${ROLE_WORD[member.role]}` : undefined}
      testId="remove-dialog"
      confirmLabel="Remove member"
      pendingLabel="Removing…"
      pending={pending}
      waiting={!impact && !readError ? "Checking what this ends…" : null}
      error={error ?? readError}
      onClose={onClose}
      onConfirm={() => onConfirm(movesOf(choices))}
      consequences={[]}
      note="History keeps their name. An owner can restore them; revoked tokens and connections stay revoked."
    >
      {impact && member && (
        <>
          {impact.ends && <EndsNow ends={impact.ends} />}
          <BackToInbox voids={impact.voids} />
          <Lapses lapses={impact.lapses} />
          <HandOverRows
            title="Responsibilities"
            testId="preview-responsibilities"
            rows={impact.responsibilities}
            people={people}
            subjectId={member.id}
            choices={choices}
            setChoices={setChoices}
            rowLabel={(r) => r.label}
          />
        </>
      )}
    </ConfirmDialog>
  );
}

/**
 * A lower role: the preview of what the demotion lapses and voids, and what needs a new
 * holder. `impact` is read by the caller (a change with nothing to show applies at once).
 */
export function RoleDialog({
  member,
  role,
  impact,
  people,
  pending,
  error,
  onConfirm,
  onClose,
}: {
  member: Member | null;
  role: Role | null;
  impact: Impact | null;
  people: Member[];
  pending: boolean;
  error: string | null;
  onConfirm: (moves: HandOver[]) => void;
  onClose: () => void;
}) {
  const at = member && role ? `${member.id}:${role}` : null;
  const [chosen, setChosen] = useState<{ at: string | null; choices: Choices }>({ at: null, choices: {} });
  const choices = chosen.at === at ? chosen.choices : {};
  const setChoices = (c: Choices) => setChosen({ at, choices: c });
  const needs = impact?.responsibilities.filter((r) => r.holder_ok === false) ?? [];
  return (
    <ConfirmDialog
      open={!!member && !!role && !!impact}
      title={member && role ? `Change ${personName(member)} to ${ROLE_WORD[role]}?` : ""}
      subject={member ? `${member.email} · ${ROLE_WORD[member.role]}` : undefined}
      testId="role-dialog"
      confirmLabel="Change role"
      pendingLabel="Changing…"
      confirmVariant="solid"
      pending={pending}
      error={error}
      onClose={onClose}
      onConfirm={() => onConfirm(movesOf(choices))}
      consequences={[]}
    >
      {impact && member && (
        <>
          <Lapses lapses={impact.lapses} />
          <BackToInbox voids={impact.voids} />
          <HandOverRows
            title="Needs a new holder"
            testId="preview-needs-holder"
            rows={needs}
            people={people}
            subjectId={member.id}
            choices={choices}
            setChoices={setChoices}
            rowLabel={(r) => `${r.label} needs ${ROLE_WORD[r.needs_role]}`}
          />
        </>
      )}
    </ConfirmDialog>
  );
}
