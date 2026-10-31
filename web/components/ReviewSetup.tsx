"use client";

import { useId, useState, type FormEvent } from "react";

import { Button, Chip, Icon, Panel, Sheet } from "@/components/ds";
import { peopleByIds, PersonPicker, type Person } from "@/components/PersonPicker";
import { FIELD_LABEL, InlineError, TEXTAREA } from "@/components/review/parts";
import { ErrorNote, Loading } from "@/components/ui";
import { ApiError, api, unwrap, type Schemas } from "@/lib/api/client";
import { formatDay, plural } from "@/lib/format";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

/*
 * A document's review setup (#342), on the document page: the Review settings sheet (the
 * policy: decider, mandatory reviewers, required sections, re-review on change; owners),
 * each section's owner, reviewers and due date (approvers), and feedback campaigns asked
 * for and closed (approvers). Each save sends the lock_version it read; a 409 shows the
 * API's words and reloads, so the next save starts from what is there now (a section's form
 * takes the saved values and says what changed before Save is allowed again). A control the
 * signed-in member's role can never use is hidden, not disabled; a read-only sheet says
 * View only (owner rule, #370).
 */

type Policy = Schemas["ReviewPolicyOut"];
type SectionState = Schemas["SectionStateOut"];
type Campaign = Schemas["CampaignOut"];

const SOURCE_LABEL: Record<Policy["source"], string> = {
  document: "Set for this document",
  company: "Company default",
  default: "Default policy",
};

/** qa4-docs-share-33: what the pill means, beside it. */
const SOURCE_HINT: Record<Policy["source"], string> = {
  document: "These settings were saved for this document.",
  company: "Nothing is set for this document yet, so the company's settings apply. Saving sets them for this document.",
  default: "Nothing is set for this document yet, so the standard settings apply. Saving sets them for this document.",
};

/**
 * qa-docs-18: the sheet's own tick box, on the app's tokens (a hairline box, the accent and a
 * check when ticked, the focus ring), not the browser's; still a real checkbox for keys and readers.
 */
function Tick({ checked, onChange }: { checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <span className="relative grid size-[18px] flex-none place-items-center">
      <input
        type="checkbox"
        data-testid="review-tick"
        className="peer size-[18px] cursor-pointer appearance-none rounded-[5px] border-[1.5px] border-line-strong bg-surface checked:border-accent checked:bg-accent"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <Icon name="check" size={16} stroke={2.4} className="pointer-events-none absolute hidden text-on-accent peer-checked:block" />
    </span>
  );
}

/** A picked due date (YYYY-MM-DD) as the API's due_at: 17:00 UTC that day, shown back as that day. */
const dueAt = (day: string) => (day ? `${day}T17:00:00Z` : null);

/** Today on this browser's calendar as YYYY-MM-DD: the earliest due date a form takes (qa4-docs-share-12, -34). */
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Why a form refuses a due date before today. */
const PAST_DUE = "Pick today or a later day for the due date.";

/** qa4-docs-share-34, -36: a due date whose day has passed reads Overdue, the same everywhere here. */
const pastDue = (at: string | null | undefined) => !!at && at.slice(0, 10) < today();

/** The names of the people with these ids, loaded once per set of ids. */
function usePeople(ids: readonly (string | null | undefined)[]): Map<string, Person> {
  const key = [...new Set(ids.filter(Boolean))].sort().join(",");
  const q = useQuery(`people-ids|${key}`, () => peopleByIds(key ? key.split(",") : []), { keepPrevious: true });
  return q.data ?? new Map();
}

/**
 * Chosen people as chips (each with Remove), and a button that opens the member picker.
 * `single`: one person at most (the picked one replaces it). `readOnly`: the chips alone.
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
  readOnly = false,
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
  readOnly?: boolean;
  testId?: string;
}) {
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<Map<string, Person>>(new Map());
  const addId = useId();
  const nameOf = (id: string) => picked.get(id)?.name ?? people.get(id)?.name ?? "Someone";
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className={FIELD_LABEL}>{label}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5" data-testid={testId}>
        {ids.length === 0 && <span className="text-sm text-text2">{empty}</span>}
        {ids.map((id) => (
          <span key={id} className="inline-flex items-center gap-1 rounded-full border border-line-strong py-0.5 pr-1 pl-2.5 text-sm">
            {nameOf(id)}
            {!readOnly && (
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
        {!readOnly && (
          <Button id={addId} variant="ghost" icon="plus" onClick={() => setPicking((x) => !x)} aria-expanded={picking}>
            {addLabel}
          </Button>
        )}
      </div>
      {picking && (
        // qa4-docs-share-1: Escape closes the picker alone (the sheet around it stays open with
        // its picks) and focus goes back to the button that opened it.
        <div
          data-own-escape
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            e.stopPropagation();
            setPicking(false);
            document.getElementById(addId)?.focus();
          }}
        >
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
        </div>
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
      {/* qa-docs-28: a side panel on a wide screen, the bottom sheet on a phone. */}
      <Sheet open={open} title="Review settings" onClose={() => setOpen(false)} testId="sheet-review-settings" side>
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
  const { can } = useMe();
  const canEdit = can("put_review_policy");
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
        {!canEdit && <Chip kind="line">View only</Chip>}
        <span className="text-sm text-text2" data-testid="policy-source-hint">
          {SOURCE_HINT[draft.source]}
        </span>
        <span className="text-sm text-text2">The decider and reviewers must be approvers or owners.</span>
      </div>
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
        readOnly={!canEdit}
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
        readOnly={!canEdit}
      />
      {canEdit ? (
        <>
          <fieldset className="flex min-w-0 flex-col gap-1.5" data-testid="required-sections">
            <legend className={`${FIELD_LABEL} mb-1.5`}>Required sections</legend>
            {sections.map((s) => (
              <label key={s.section_key} className="flex min-h-9 min-w-0 items-center gap-2 text-sm text-text">
                <Tick
                  checked={required.has(s.section_key)}
                  onChange={(on) =>
                    set({
                      required_section_keys: on
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
            <Tick checked={draft.rereview_on_change} onChange={(on) => set({ rereview_on_change: on })} />
            Ask for re-review when an approved section changes
          </label>
        </>
      ) : (
        <>
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className={FIELD_LABEL}>Required sections</span>
            <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm text-text" data-testid="required-sections">
              {sections
                .filter((s) => required.has(s.section_key))
                .map((s) => (
                  <Chip key={s.section_key} kind="line">
                    {s.heading}
                  </Chip>
                ))}
              {!sections.some((s) => required.has(s.section_key)) && <span className="text-text2">None</span>}
            </div>
          </div>
          <p className="text-sm text-text">
            {draft.rereview_on_change ? "Re-review is asked for when an approved section changes." : "No re-review when an approved section changes."}
          </p>
        </>
      )}
      {error && <InlineError>{error}</InlineError>}
      {canEdit && (
        // qa4-docs-share-33: Save and Cancel stay in view at the panel's foot while the settings scroll.
        <div data-testid="policy-actions" className="sticky bottom-0 -mx-4 -mb-4 flex flex-wrap items-center gap-2 border-t border-line bg-surface px-4 py-3">
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? "Saving…" : "Save review settings"}
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      )}
    </form>
  );
}

/** Each section of the latest version with its owner, reviewers and due date, editable in place (approvers). */
export function SectionAssignments({ doc, states, onSaved }: { doc: string; states: SectionState[]; onSaved: () => Promise<void> }) {
  const { can } = useMe();
  const canEdit = can("put_section_assignment");
  const people = usePeople(states.flatMap((s) => [s.owner_id, ...(s.reviewer_ids ?? [])]));
  const [editing, setEditing] = useState<string | null>(null);
  // qa-docs-45: sections nobody owns yet fold into one line; Assign (Show, read-only) lists them.
  const [unfolded, setUnfolded] = useState(false);
  // A required section keeps its row: its Required chip says something about it.
  const assigned = (s: SectionState) => !!s.owner_id || (s.reviewer_ids ?? []).length > 0 || !!s.due_at || !!s.required;
  const open = states.filter((s) => !assigned(s));
  const shown = states.filter((s) => assigned(s) || unfolded || editing === s.section_key);
  return (
    <Panel title="Section owners and reviewers" testId="section-assignments">
      <ul className="divide-y divide-line">
        {shown.map((s) => (
          <li key={s.section_key} data-section-key={s.section_key} className="flex min-w-0 flex-col gap-2 px-4 py-2.5">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
              <span className="min-w-0 font-semibold break-words text-text">{s.heading}</span>
              {s.required && <Chip kind="line">Required</Chip>}
              <span className="flex-1" />
              {canEdit && (
                <Button
                  variant="secondary"
                  aria-label={`Edit owner and reviewers of ${s.heading}`}
                  aria-expanded={editing === s.section_key}
                  onClick={() => setEditing((k) => (k === s.section_key ? null : s.section_key))}
                >
                  Edit
                </Button>
              )}
            </div>
            {canEdit && editing === s.section_key ? (
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
                {s.due_at && (
                  <Chip kind={s.overdue || pastDue(s.due_at) ? "warn" : "line"}>{`${s.overdue || pastDue(s.due_at) ? "Overdue" : "Due"} ${formatDay(s.due_at)}`}</Chip>
                )}
              </div>
            )}
          </li>
        ))}
        {open.length > 0 && (
          <li data-testid="unassigned-sections" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 px-4 py-2.5">
            <span className="min-w-0 text-text2">
              {/* qa4-docs-share-13: once they are listed, the line says so instead of "more". */}
              {unfolded
                ? `${plural(open.length, "section")} with no owner, listed above`
                : open.length === states.length
                  ? `${plural(open.length, "section")}, no owner yet`
                  : `${plural(open.length, "more section")} with no owner`}
            </span>
            <span className="flex-1" />
            {/* qa4-docs-share-13: the button says what it does: it lists the sections (each then has Edit). */}
            <Button variant="secondary" aria-expanded={unfolded} onClick={() => setUnfolded((u) => !u)}>
              {unfolded ? "Hide" : `Show ${plural(open.length, "section")}${canEdit ? " to assign" : ""}`}
            </Button>
          </li>
        )}
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
  // After a 409: the row the form was built from, until the reloaded row arrives (Save waits for it).
  const [stale, setStale] = useState<SectionState | null>(null);
  // What someone else changed: the row before and as saved now.
  const [changed, setChanged] = useState<{ was: SectionState; now: SectionState } | null>(null);
  if (stale && state.lock_version !== stale.lock_version) {
    // The form takes what is saved now, so the next Save starts from it, not over it.
    setStale(null);
    setChanged({ was: stale, now: state });
    setOwner(state.owner_id ? [state.owner_id] : []);
    setReviewers(state.reviewer_ids ?? []);
    setDue(state.due_at ? state.due_at.slice(0, 10) : "");
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    // qa4-docs-share-34: a new due date before today is refused (a saved one may stay as it is).
    if (due && due < today() && due !== (state.due_at ?? "").slice(0, 10)) {
      setError(PAST_DUE);
      return;
    }
    setSaving(true);
    setError(null);
    setChanged(null);
    try {
      await unwrap(
        api.PUT("/v1/documents/{doc}/sections/{key}/assignment", {
          params: { path: { doc, key: state.section_key } },
          body: { owner_id: owner[0] ?? null, reviewer_ids: reviewers, due_at: dueAt(due), lock_version: state.lock_version ?? null },
        }),
      );
      await onDone(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError("Someone else changed this section since you opened it. The form now shows what is saved; check it and save again.");
        setStale(state);
      } else {
        setError(errorMessage(err));
      }
      await onDone(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    // noValidate: a past due date gets the form's own plain words, not the browser's bubble.
    <form onSubmit={save} noValidate className="flex min-w-0 flex-col gap-3 rounded-button border border-line bg-surface2 p-3">
      <PeopleField label="Owner" addLabel="Choose the owner" ids={owner} people={people} onChange={setOwner} single empty="No owner" />
      <PeopleField label="Reviewers" addLabel="Add a reviewer" ids={reviewers} people={people} onChange={setReviewers} empty="None" />
      <label className={`${FIELD_LABEL} max-w-48`}>
        Due date
        <input type="date" value={due} min={today()} onChange={(e) => setDue(e.target.value)} className={`${TEXTAREA} h-9`} />
      </label>
      {error && <InlineError>{error}</InlineError>}
      {changed && <ChangedNote was={changed.was} now={changed.now} people={people} />}
      <div className="flex items-center gap-2">
        <Button type="submit" variant="solid" icon="check" disabled={saving || stale !== null}>
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** What someone else changed on a section's owner, reviewers and due date, each as now (was). */
function ChangedNote({ was, now, people }: { was: SectionState; now: SectionState; people: Map<string, Person> }) {
  const names = (ids: readonly string[]) => (ids.length ? ids.map((id) => people.get(id)?.name ?? "Someone").join(", ") : null);
  const day = (at: string | null | undefined) => (at ? formatDay(at) : null);
  const same = (a: readonly string[], b: readonly string[]) => [...a].sort().join(",") === [...b].sort().join(",");
  const lines: string[] = [];
  if (was.owner_id !== now.owner_id) {
    lines.push(`Owner: ${names(now.owner_id ? [now.owner_id] : []) ?? "No owner"} (was ${names(was.owner_id ? [was.owner_id] : []) ?? "No owner"})`);
  }
  if (!same(was.reviewer_ids ?? [], now.reviewer_ids ?? [])) {
    lines.push(`Reviewers: ${names(now.reviewer_ids ?? []) ?? "None"} (was ${names(was.reviewer_ids ?? []) ?? "None"})`);
  }
  if (day(was.due_at) !== day(now.due_at)) lines.push(`Due date: ${day(now.due_at) ?? "None"} (was ${day(was.due_at) ?? "None"})`);
  return (
    <div className="flex min-w-0 flex-col gap-0.5 text-sm text-text" data-testid="assignment-changed">
      <span className={FIELD_LABEL}>What changed</span>
      {lines.length ? lines.map((l) => <span key={l} className="min-w-0 break-words">{l}</span>) : <span className="text-text2">Nothing you can see here.</span>}
    </div>
  );
}

/** Feedback campaigns on the document: Ask for feedback opens one on the latest version; each can be closed and reopened (approvers). */
export function Campaigns({ doc }: { doc: string }) {
  const { can } = useMe();
  const canEdit = can("create_review_campaign");
  const q = useQuery(`campaigns|${doc}`, () => unwrap(api.GET("/v1/documents/{doc}/campaigns", { params: { path: { doc } } })));
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The campaign being closed or reopened: its button waits, so a double click sends one change.
  const [toggling, setToggling] = useState<string | null>(null);

  async function toggle(c: Campaign) {
    setToggling(c.id);
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
    try {
      await q.reload();
    } finally {
      setToggling(null);
    }
  }

  const rows = q.data ?? [];
  return (
    <Panel
      title="Feedback campaigns"
      count={rows.length}
      testId="campaigns"
      tools={
        // qa-docs-26: while the form is open, its own Send and Cancel are the way out.
        canEdit && !asking && (
          <Button icon="comment" onClick={() => setAsking(true)}>
            Ask for feedback
          </Button>
        )
      }
    >
      {canEdit && asking && (
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
              {c.due_at && !(c.status === "open" && pastDue(c.due_at)) ? ` · due ${formatDay(c.due_at)}` : ""}
            </span>
            {/* qa4-docs-share-36: an open campaign past its due date says so. */}
            {c.due_at && c.status === "open" && pastDue(c.due_at) && <Chip kind="warn">{`Overdue ${formatDay(c.due_at)}`}</Chip>}
            <span className="flex-1" />
            {canEdit && (
              // qa-docs-30: what the action does to the campaign, not a bare Close.
              <Button variant="secondary" aria-label={`${c.status === "open" ? "End campaign" : "Reopen"} ${c.title}`} disabled={toggling === c.id} onClick={() => toggle(c)}>
                {c.status === "open" ? "End campaign" : "Reopen"}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** Why a campaign's Send waits (qa-docs-5). */
const NO_TITLE = "Add a title to send";

function CampaignForm({ doc, onDone, onCancel }: { doc: string; onDone: () => Promise<void>; onCancel: () => void }) {
  const hintId = useId();
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [due, setDue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(e: FormEvent) {
    e.preventDefault();
    // qa4-docs-share-12: a due date before today is refused.
    if (due && due < today()) {
      setError(PAST_DUE);
      return;
    }
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
    // noValidate: a past due date gets the form's own plain words, not the browser's bubble (Send waits for a title).
    <form onSubmit={send} noValidate className="flex min-w-0 flex-col gap-3 border-b border-line bg-surface2 p-4">
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
        <input type="date" value={due} min={today()} onChange={(e) => setDue(e.target.value)} className={`${TEXTAREA} h-9`} />
      </label>
      {error && <InlineError>{error}</InlineError>}
      <div className="flex flex-wrap items-center gap-2">
        {/* qa-docs-5, qa-docs-26: a disabled Send says what it waits for, right beside it and
            tied to it (its description), so the reason reads as Send's own hint. */}
        <Button
          type="submit"
          variant="solid"
          icon="check"
          disabled={saving || !title.trim()}
          aria-describedby={!title.trim() ? hintId : undefined}
          title={!title.trim() ? NO_TITLE : undefined}
        >
          {saving ? "Sending…" : "Send"}
        </Button>
        {!title.trim() && (
          <span id={hintId} data-testid="campaign-send-hint" className="text-[13px] text-text2">
            {NO_TITLE}
          </span>
        )}
        <Button variant="ghost" className="ml-auto" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
