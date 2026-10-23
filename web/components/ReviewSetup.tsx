"use client";

import { useState, type FormEvent, type ReactNode } from "react";

import { Button, Chip, Panel, Sheet } from "@/components/ds";
import { peopleByIds, PersonPicker, type Person } from "@/components/PersonPicker";
import { FIELD_LABEL, InlineError, TEXTAREA } from "@/components/review/parts";
import { ErrorNote, Loading } from "@/components/ui";
import { ApiError, api, unwrap, type Schemas } from "@/lib/api/client";
import { formatDayUtc } from "@/lib/format";
import { hasRole, useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

/*
 * A document's review setup (#342), on the document page: the Review settings sheet (the
 * policy: decider, mandatory reviewers, required sections, re-review on change; owners),
 * each section's owner, reviewers and due date (approvers), and feedback campaigns asked
 * for and closed (approvers). Each save sends the lock_version it read; a 409 shows the
 * API's words and reloads, so the next save starts from what is there now.
 */

type Policy = Schemas["ReviewPolicyOut"];
type SectionState = Schemas["SectionStateOut"];
type Campaign = Schemas["CampaignOut"];

const SOURCE_LABEL: Record<Policy["source"], string> = {
  document: "Set for this document",
  company: "Company default",
  default: "Default policy",
};

/** A picked due date (YYYY-MM-DD) as the API's due_at: 17:00 UTC that day, shown back as that day. */
const dueAt = (day: string) => (day ? `${day}T17:00:00Z` : null);

/** The names of the people with these ids, loaded once per set of ids. */
function usePeople(ids: readonly (string | null | undefined)[]): Map<string, Person> {
  const key = [...new Set(ids.filter(Boolean))].sort().join(",");
  const q = useQuery(`people-ids|${key}`, () => peopleByIds(key ? key.split(",") : []), { keepPrevious: true });
  return q.data ?? new Map();
}

/** Why a control is disabled, under it. */
function Reason({ children }: { children: ReactNode }) {
  return (
    <p data-testid="review-reason" className="text-sm text-text2">
      {children}
    </p>
  );
}

/**
 * Chosen people as chips (each with Remove), and a button that opens the member picker.
 * `single`: one person at most (the picked one replaces it).
 */
function PeopleField({
  label,
  addLabel,
  ids,
  people,
  onChange,
  single = false,
  approversOnly = false,
  empty,
  disabled,
  testId,
}: {
  label: string;
  addLabel: string;
  ids: string[];
  people: Map<string, Person>;
  onChange: (ids: string[]) => void;
  single?: boolean;
  approversOnly?: boolean;
  empty: string;
  disabled?: boolean;
  testId?: string;
}) {
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<Map<string, Person>>(new Map());
  const nameOf = (id: string) => picked.get(id)?.name ?? people.get(id)?.name ?? "Someone";
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className={FIELD_LABEL}>{label}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5" data-testid={testId}>
        {ids.length === 0 && <span className="text-sm text-text2">{empty}</span>}
        {ids.map((id) => (
          <span key={id} className="inline-flex items-center gap-1 rounded-full border border-line-strong py-0.5 pr-1 pl-2.5 text-sm">
            {nameOf(id)}
            {!disabled && (
              <button
                type="button"
                aria-label={`Remove ${nameOf(id)}`}
                onClick={() => onChange(ids.filter((x) => x !== id))}
                className="grid size-6 place-items-center rounded-full text-text2 hover:bg-surface2 hover:text-text"
              >
                ×
              </button>
            )}
          </span>
        ))}
        <Button variant="ghost" icon="plus" disabled={disabled} onClick={() => setPicking((x) => !x)} aria-expanded={picking}>
          {addLabel}
        </Button>
      </div>
      {picking && (
        <PersonPicker
          autoFocus
          approversOnly={approversOnly}
          exclude={ids}
          onPick={(p) => {
            setPicked((m) => new Map(m).set(p.user_id, p));
            onChange(single ? [p.user_id] : [...ids, p.user_id]);
            setPicking(false);
          }}
        />
      )}
    </div>
  );
}

/** The Review settings button and sheet: the document's review policy (owners change it). */
export function ReviewSettingsButton({ doc, sections, onSaved }: { doc: string; sections: SectionState[]; onSaved: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button icon="settings" onClick={() => setOpen(true)}>
        Review settings
      </Button>
      <Sheet open={open} title="Review settings" onClose={() => setOpen(false)} testId="sheet-review-settings">
        {open && (
          <PolicyForm
            doc={doc}
            sections={sections}
            onCancel={() => setOpen(false)}
            onSaved={async () => {
              setOpen(false);
              // Required sections show on the section rows.
              await onSaved();
            }}
          />
        )}
      </Sheet>
    </>
  );
}

function PolicyForm({
  doc,
  sections,
  onSaved,
  onCancel,
}: {
  doc: string;
  sections: SectionState[];
  onSaved: () => Promise<void>;
  onCancel: () => void;
}) {
  const { role } = useMe();
  const canEdit = hasRole(role, "owner");
  const q = useQuery(`review-policy|${doc}`, () => unwrap(api.GET("/v1/documents/{doc}/review-policy", { params: { path: { doc } } })));
  // The edits not saved yet, over the policy as loaded; null shows the policy as loaded.
  const [edits, setEdits] = useState<Policy | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draft = edits ?? q.data ?? null;
  const people = usePeople([draft?.decider_id, ...(draft?.mandatory_reviewer_ids ?? [])]);

  if (q.error) return <div className="p-4"><ErrorNote>{q.error}</ErrorNote></div>;
  if (!draft) return <div className="p-4"><Loading /></div>;
  const set = (patch: Partial<Policy>) => setEdits({ ...draft, ...patch });
  const required = new Set(draft.required_section_keys);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      await unwrap(
        api.PUT("/v1/documents/{doc}/review-policy", {
          params: { path: { doc } },
          body: {
            decider_id: draft.decider_id ?? null,
            mandatory_reviewer_ids: draft.mandatory_reviewer_ids,
            required_section_keys: draft.required_section_keys,
            section_approval: draft.section_approval,
            rereview_on_change: draft.rereview_on_change,
            lock_version: draft.lock_version ?? null,
          },
        }),
      );
      await q.reload();
      setEdits(null);
      await onSaved();
    } catch (err) {
      setError(errorMessage(err));
      // Someone else changed the policy: show theirs; any other refusal keeps the edits.
      if (err instanceof ApiError && err.status === 409) {
        await q.reload();
        setEdits(null);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Chip kind={draft.source === "document" ? "acc" : "na"}>{SOURCE_LABEL[draft.source]}</Chip>
        <span className="text-sm text-text2">The decider and reviewers must be approvers or owners.</span>
      </div>
      {!canEdit && <Reason>Only an owner can change review settings.</Reason>}
      <PeopleField
        label="Decider"
        addLabel="Choose the decider"
        testId="decider"
        ids={draft.decider_id ? [draft.decider_id] : []}
        people={people}
        onChange={(ids) => set({ decider_id: ids[0] ?? null })}
        single
        approversOnly
        empty="Any approver"
        disabled={!canEdit}
      />
      <PeopleField
        label="Mandatory reviewers"
        addLabel="Add a mandatory reviewer"
        testId="mandatory-reviewers"
        ids={draft.mandatory_reviewer_ids}
        people={people}
        onChange={(ids) => set({ mandatory_reviewer_ids: ids })}
        approversOnly
        empty="None"
        disabled={!canEdit}
      />
      <fieldset className="flex min-w-0 flex-col gap-1.5">
        <legend className={`${FIELD_LABEL} mb-1.5`}>Required sections</legend>
        {sections.map((s) => (
          <label key={s.section_key} className="flex min-h-9 min-w-0 items-center gap-2 text-sm text-text">
            <input
              type="checkbox"
              className="size-4 flex-none accent-[var(--accent)]"
              checked={required.has(s.section_key)}
              disabled={!canEdit}
              onChange={(e) =>
                set({
                  required_section_keys: e.target.checked
                    ? [...draft.required_section_keys, s.section_key]
                    : draft.required_section_keys.filter((k) => k !== s.section_key),
                })
              }
            />
            <span className="min-w-0 break-words">{s.heading}</span>
          </label>
        ))}
      </fieldset>
      <label className="flex min-h-9 items-center gap-2 text-sm text-text">
        <input
          type="checkbox"
          className="size-4 flex-none accent-[var(--accent)]"
          checked={draft.rereview_on_change}
          disabled={!canEdit}
          onChange={(e) => set({ rereview_on_change: e.target.checked })}
        />
        Ask for re-review when an approved section changes
      </label>
      {error && <InlineError>{error}</InlineError>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" disabled={!canEdit || saving}>
          {saving ? "Saving…" : "Save review settings"}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Each section of the latest version with its owner, reviewers and due date, editable in place (approvers). */
export function SectionAssignments({ doc, states, onSaved }: { doc: string; states: SectionState[]; onSaved: () => Promise<void> }) {
  const { role } = useMe();
  const canEdit = hasRole(role, "approver");
  const people = usePeople(states.flatMap((s) => [s.owner_id, ...(s.reviewer_ids ?? [])]));
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <Panel title="Section owners and reviewers" count={states.length} testId="section-assignments">
      {!canEdit && (
        <div className="border-b border-line px-4 py-2">
          <Reason>Only an approver or owner can assign sections.</Reason>
        </div>
      )}
      <ul className="divide-y divide-line">
        {states.map((s) => (
          <li key={s.section_key} data-section-key={s.section_key} className="flex min-w-0 flex-col gap-2 px-4 py-2.5">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
              <span className="min-w-0 font-semibold break-words text-text">{s.heading}</span>
              {s.required && <Chip kind="line">Required</Chip>}
              <span className="flex-1" />
              <Button
                variant="ghost"
                disabled={!canEdit}
                aria-label={`Edit owner and reviewers of ${s.heading}`}
                aria-expanded={editing === s.section_key}
                onClick={() => setEditing((k) => (k === s.section_key ? null : s.section_key))}
              >
                Edit
              </Button>
            </div>
            {editing === s.section_key ? (
              <AssignmentForm
                doc={doc}
                state={s}
                people={people}
                onDone={async (saved) => {
                  if (saved) setEditing(null);
                  await onSaved();
                }}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
                {s.owner_id ? <Chip kind="acc">Owner {people.get(s.owner_id)?.name ?? "…"}</Chip> : <Chip kind="na">No owner</Chip>}
                {(s.reviewer_ids ?? []).map((id) => (
                  <Chip key={id} kind="line">
                    Reviewer {people.get(id)?.name ?? "…"}
                  </Chip>
                ))}
                {s.due_at && <Chip kind={s.overdue ? "warn" : "line"}>{`${s.overdue ? "Overdue" : "Due"} ${formatDayUtc(s.due_at)}`}</Chip>}
              </div>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function AssignmentForm({
  doc,
  state,
  people,
  onDone,
  onCancel,
}: {
  doc: string;
  state: SectionState;
  people: Map<string, Person>;
  onDone: (saved: boolean) => Promise<void>;
  onCancel: () => void;
}) {
  const [owner, setOwner] = useState<string[]>(state.owner_id ? [state.owner_id] : []);
  const [reviewers, setReviewers] = useState<string[]>(state.reviewer_ids ?? []);
  const [due, setDue] = useState(state.due_at ? state.due_at.slice(0, 10) : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await unwrap(
        api.PUT("/v1/documents/{doc}/sections/{key}/assignment", {
          params: { path: { doc, key: state.section_key } },
          body: { owner_id: owner[0] ?? null, reviewer_ids: reviewers, due_at: dueAt(due), lock_version: state.lock_version ?? null },
        }),
      );
      await onDone(true);
    } catch (err) {
      setError(errorMessage(err));
      await onDone(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="flex min-w-0 flex-col gap-3 rounded-button border border-line bg-surface2 p-3">
      <PeopleField label="Owner" addLabel="Choose the owner" ids={owner} people={people} onChange={setOwner} single empty="No owner" />
      <PeopleField label="Reviewers" addLabel="Add a reviewer" ids={reviewers} people={people} onChange={setReviewers} empty="None" />
      <label className={`${FIELD_LABEL} max-w-48`}>
        Due date
        <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className={`${TEXTAREA} h-9`} />
      </label>
      {error && <InlineError>{error}</InlineError>}
      <div className="flex items-center gap-2">
        <Button type="submit" variant="solid" icon="check" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Feedback campaigns on the document: Ask for feedback opens one on the latest version; each can be closed and reopened (approvers). */
export function Campaigns({ doc }: { doc: string }) {
  const { role } = useMe();
  const canEdit = hasRole(role, "approver");
  const q = useQuery(`campaigns|${doc}`, () => unwrap(api.GET("/v1/documents/{doc}/campaigns", { params: { path: { doc } } })));
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(c: Campaign) {
    setError(null);
    try {
      await unwrap(
        api.PATCH("/v1/campaigns/{campaign_id}", {
          params: { path: { campaign_id: c.id } },
          body: { status: c.status === "open" ? "closed" : "open", lock_version: c.lock_version },
        }),
      );
    } catch (err) {
      setError(errorMessage(err));
    }
    await q.reload();
  }

  const rows = q.data ?? [];
  return (
    <Panel
      title="Feedback campaigns"
      count={rows.length}
      testId="campaigns"
      tools={
        <Button icon="comment" disabled={!canEdit} onClick={() => setAsking((x) => !x)} aria-expanded={asking}>
          Ask for feedback
        </Button>
      }
    >
      {!canEdit && (
        <div className="border-b border-line px-4 py-2">
          <Reason>Only an approver or owner can ask for feedback.</Reason>
        </div>
      )}
      {asking && (
        <CampaignForm
          doc={doc}
          onDone={async () => {
            setAsking(false);
            await q.reload();
          }}
          onCancel={() => setAsking(false)}
        />
      )}
      {q.error && <div className="p-4"><ErrorNote>{q.error}</ErrorNote></div>}
      {error && <div className="px-4 pt-2"><InlineError>{error}</InlineError></div>}
      {q.data && rows.length === 0 && <p className="px-4 py-3 text-sm text-text2">Nobody has been asked for feedback yet.</p>}
      <ul className="divide-y divide-line">
        {rows.map((c) => (
          <li key={c.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5">
            <span className="min-w-0 font-semibold break-words text-text">{c.title}</span>
            <Chip kind={c.status === "open" ? "now" : "na"}>{c.status === "open" ? "Open" : "Closed"}</Chip>
            <span className="tnum text-sm text-text2">
              v{c.version_number} · {c.comments} comment{c.comments === 1 ? "" : "s"} · {c.participants} of {c.invited} took part
              {c.due_at ? ` · due ${formatDayUtc(c.due_at)}` : ""}
            </span>
            <span className="flex-1" />
            <Button variant="ghost" disabled={!canEdit} aria-label={`${c.status === "open" ? "Close" : "Reopen"} ${c.title}`} onClick={() => toggle(c)}>
              {c.status === "open" ? "Close" : "Reopen"}
            </Button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function CampaignForm({ doc, onDone, onCancel }: { doc: string; onDone: () => Promise<void>; onCancel: () => void }) {
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [due, setDue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await unwrap(
        api.POST("/v1/documents/{doc}/campaigns", {
          params: { path: { doc } },
          body: { title: title.trim(), message: message.trim() || null, due_at: dueAt(due), audience_roles: ["commenter", "approver", "owner"] },
        }),
      );
      await onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={send} className="flex min-w-0 flex-col gap-3 border-b border-line bg-surface2 p-4">
      <p className="text-sm text-text2">Everyone who can comment is asked to comment on the latest version. Approval stays with the decider.</p>
      <label className={FIELD_LABEL}>
        Title
        <input autoFocus required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} className={`${TEXTAREA} h-9`} />
      </label>
      <label className={FIELD_LABEL}>
        Message (optional)
        <textarea rows={2} maxLength={4000} value={message} onChange={(e) => setMessage(e.target.value)} className={TEXTAREA} />
      </label>
      <label className={`${FIELD_LABEL} max-w-48`}>
        Due date (optional)
        <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className={`${TEXTAREA} h-9`} />
      </label>
      {error && <InlineError>{error}</InlineError>}
      <div className="flex items-center gap-2">
        <Button type="submit" variant="solid" icon="check" disabled={saving || !title.trim()}>
          {saving ? "Sending…" : "Send"}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
