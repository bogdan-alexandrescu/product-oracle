"use client";

import { useEffect, useState } from "react";

import { Button, Chip, Inspector, InspectorSection, Ring, SegmentedControl } from "@/components/ds";
import { INPUT } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { errorMessage } from "@/lib/use-query";

import {
  actionsOn,
  changeText,
  decisionText,
  describeAction,
  fixesFor,
  LEAVE_OUT_REASONS,
  pct,
  setDecision,
  type Feature,
  type Fix,
  type LlmJob,
  type Mode,
  type Ops,
  type Requirement,
  type Review,
  type Scope,
  type Ui,
} from "./_scope-lib";

/** Runs a fix, saying what went wrong in place. */
export function FixButtons({ fixes, small = true }: { fixes: Fix[]; small?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
      {fixes.map((f) => (
        <Button
          key={f.label}
          className={small ? "h-8 px-2.5 text-sm max-[600px]:h-10" : ""}
          disabled={busy}
          onClick={async (e) => {
            e.stopPropagation();
            setBusy(true);
            setError(null);
            try {
              await f.run();
            } catch (err) {
              setError(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          {f.label}
        </Button>
      ))}
      {error && (
        <span className="basis-full text-sm text-crit" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

/** Leave out asks why: No goal · Not now · Out of scope · Duplicate · Other (with text). */
export function LeaveOutPicker({ preset, onPick, onCancel, suggest = false }: { preset?: string; onPick: (reason: string) => Promise<void> | void; onCancel: () => void; suggest?: boolean }) {
  const [other, setOther] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pick = async (reason: string) => {
    setError(null);
    try {
      await onPick(reason);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <div role="group" aria-label="Why leave it out?" className="mt-2 flex min-w-0 flex-col gap-2 rounded-button border border-line bg-surface2 p-2.5" data-testid="leave-out-picker" onClick={(e) => e.stopPropagation()}>
      <span className="text-sm font-medium">{suggest ? "Suggest leaving it out because:" : "Why leave it out?"}</span>
      <span className="flex flex-wrap gap-1.5">
        {LEAVE_OUT_REASONS.map((r) => (
          <Button key={r.value} variant={preset === r.value ? "solid" : "secondary"} className="h-8 px-2.5 text-sm max-[600px]:h-10" onClick={() => void pick(r.value)}>
            {r.label}
          </Button>
        ))}
        <Button className="h-8 px-2.5 text-sm max-[600px]:h-10" aria-pressed={other != null} onClick={() => setOther(other == null ? "" : null)}>
          Other
        </Button>
        <Button variant="ghost" className="h-8 px-2.5 text-sm max-[600px]:h-10" onClick={onCancel}>
          Cancel
        </Button>
      </span>
      {other != null && (
        <span className="flex flex-wrap gap-1.5">
          <input aria-label="Other reason" maxLength={480} value={other} onChange={(e) => setOther(e.target.value)} className={`${INPUT} min-w-0 flex-1`} />
          <Button variant="solid" disabled={!other.trim()} onClick={() => void pick(`other:${other.trim()}`)}>
            Leave out
          </Button>
        </span>
      )}
      {error && <span className="text-sm text-crit">{error}</span>}
    </div>
  );
}

const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);

/** Enhance: Oracle deepens a requirement; its suggestion is accepted, edited and accepted, or discarded. */
function EnhanceCard({ req, ops, onClose }: { req: Requirement; ops: Ops; onClose: () => void }) {
  const [job, setJob] = useState<LlmJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    ops.enhance(req.id).then(
      (j) => live && setJob(j),
      (e) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
    // Once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const out = (job?.status === "succeeded" ? job.output : null) as { text: string; acceptance: string[]; edge_cases: string[]; data_needs: string[] } | null;
  async function accept(text?: string) {
    if (!job) return;
    setBusy(true);
    setError(null);
    try {
      await ops.acceptEnhance(req.id, job.id, text != null ? { text } : {});
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-2 rounded-button border border-accent bg-accent-soft/40 p-3" data-testid="enhance-card" onClick={(e) => e.stopPropagation()}>
      {error && <p className="text-sm text-crit">{error}</p>}
      {!out && !error && (
        <p className="text-sm text-text2" aria-live="polite">
          {job?.status === "failed" ? `Oracle could not deepen it: ${job.error ?? "the job failed"}` : "Oracle is deepening this requirement…"}
        </p>
      )}
      {out && (
        <div className="flex flex-col gap-2 text-sm" data-testid="enhance-suggestion">
          <p className="font-medium">Oracle suggests</p>
          {edit == null ? <p data-testid="enhance-text">{out.text}</p> : <textarea aria-label="Requirement text" value={edit} maxLength={1000} rows={3} onChange={(e) => setEdit(e.target.value)} className={INPUT} />}
          <List title="Acceptance criteria" items={out.acceptance} />
          <List title="Edge cases" items={out.edge_cases} />
          <List title="Data needs" items={out.data_needs} />
          <span className="flex flex-wrap gap-1.5">
            {edit == null ? (
              <>
                <Button variant="solid" disabled={busy} onClick={() => void accept()}>
                  Accept
                </Button>
                <Button disabled={busy} onClick={() => setEdit(out.text)}>
                  Edit and accept
                </Button>
              </>
            ) : (
              <Button variant="solid" disabled={busy || !edit.trim()} onClick={() => void accept(edit)}>
                Accept
              </Button>
            )}
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              Discard
            </Button>
          </span>
        </div>
      )}
      {(!out || error) && (
        <Button variant="ghost" className="mt-1 h-8 px-2.5 text-sm" onClick={onClose}>
          Close
        </Button>
      )}
    </div>
  );
}

function List({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <p className="text-text2">{title}</p>
      <ul className="ml-4 list-disc">
        {items.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
    </div>
  );
}

/** A requirement: text on one line (full in the tooltip), acceptance count, decision, Keep · Cut · Edit · Enhance. */
export function RequirementRow({ req, mode, ops, review, indent = true }: { req: Requirement; mode: Mode; ops: Ops; review: Review | null; indent?: boolean }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [enhancing, setEnhancing] = useState(false);
  const text = req.text ?? req.title;
  const cut = req.decision === "cut";
  const suggestions = actionsOn(review, req.key).filter((a) => a.state === "suggested");
  return (
    <div
      role="row"
      data-testid={`requirement-${req.key}`}
      data-added={req.added || undefined}
      className={`border-t border-line py-2 pr-2 ${indent ? "pl-14 max-[600px]:pl-3" : "pl-0"}`}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span role="cell" className={`min-w-0 flex-1 truncate text-sm ${cut ? "text-text2 line-through" : ""}`} title={text} data-testid="requirement-text">
          {text}
        </span>
        {req.added && (
          <Chip kind="acc" data-testid="yours">
            Yours
          </Chip>
        )}
        <span className="text-sm text-text2 tnum">{req.acceptance.length} AC</span>
        {req.edited && !req.added ? (
          <span className="flex items-center gap-1.5 text-sm text-pass" data-testid="requirement-done">
            ✓ {cut ? "Requirement cut" : "Edited"}
            {mode === "approver" && (
              <Button variant="ghost" className="h-8 px-2 text-sm" onClick={() => void ops.patch(req, { revert: true })}>
                Undo
              </Button>
            )}
          </span>
        ) : (
          <Chip kind={cut ? "na" : "pass"}>{cut ? "Cut" : "Kept"}</Chip>
        )}
        {mode === "approver" && (
          <span className="flex flex-wrap gap-1">
            {cut ? (
              <Button className="h-8 px-2.5 text-sm" onClick={() => void ops.patch(req, { decision: "keep" })}>
                Keep
              </Button>
            ) : (
              <Button className="h-8 px-2.5 text-sm" onClick={() => void ops.patch(req, { decision: "cut" })}>
                Cut
              </Button>
            )}
            <Button className="h-8 px-2.5 text-sm" onClick={() => setEditing(editing == null ? text : null)}>
              Edit
            </Button>
            <Button className="h-8 px-2.5 text-sm" disabled={enhancing} onClick={() => setEnhancing(true)}>
              Enhance
            </Button>
            {req.added && (
              <Button variant="ghost" className="h-8 px-2.5 text-sm" onClick={() => void ops.removeItem(req.id)}>
                Remove
              </Button>
            )}
          </span>
        )}
        {mode === "commenter" && !cut && (
          <Button className="h-8 px-2.5 text-sm" onClick={() => void setDecision(mode, ops, req, "cut")}>
            Suggest Cut
          </Button>
        )}
      </div>
      {suggestions.map((a) => (
        <p key={a.id} className="mt-1 text-sm text-text2" data-testid="suggested-by">
          Suggested by {a.created_by?.name ?? "someone"}: {describeAction(a)}
        </p>
      ))}
      {editing != null && (
        <div className="mt-2 flex flex-col gap-1.5">
          <textarea aria-label={`Edit ${req.key}`} value={editing} maxLength={1000} rows={2} onChange={(e) => setEditing(e.target.value)} className={INPUT} />
          <span className="flex gap-1.5">
            <Button variant="solid" disabled={!editing.trim()} onClick={() => void ops.patch(req, { text: editing }).then(() => setEditing(null))}>
              Save
            </Button>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </span>
        </div>
      )}
      {enhancing && <EnhanceCard req={req} ops={ops} onClose={() => setEnhancing(false)} />}
    </div>
  );
}

function AddRequirement({ feature, ops }: { feature: Feature; ops: Ops }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [acceptance, setAcceptance] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!open)
    return (
      <Button icon="plus" className="mt-2" onClick={() => setOpen(true)}>
        Add requirement
      </Button>
    );
  return (
    <div className="mt-2 flex flex-col gap-1.5" data-testid="add-requirement">
      <textarea aria-label="Requirement" placeholder="What it must do" value={text} maxLength={1000} rows={2} onChange={(e) => setText(e.target.value)} className={`${INPUT} placeholder:text-text2`} />
      <textarea
        aria-label="Acceptance criteria (one per line, optional)"
        placeholder="Acceptance criteria, one per line (optional)"
        value={acceptance}
        rows={2}
        onChange={(e) => setAcceptance(e.target.value)}
        className={`${INPUT} placeholder:text-text2`}
      />
      <span className="text-sm text-text2">{text.length} / 1000 · its goals are the feature&apos;s</span>
      {error && <span className="text-sm text-crit">{error}</span>}
      <span className="flex gap-1.5">
        <Button
          variant="solid"
          disabled={!text.trim()}
          onClick={() =>
            void ops.add(feature.id, text.trim(), lines(acceptance)).then(
              () => {
                setOpen(false);
                setText("");
                setAcceptance("");
              },
              (e) => setError(errorMessage(e)),
            )
          }
        >
          Add
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </span>
    </div>
  );
}

function GoalsEditor({ feature, scope, mode, ops, onDone }: { feature: Feature; scope: Scope; mode: Mode; ops: Ops; onDone: () => void }) {
  const [picked, setPicked] = useState<Record<string, number>>(
    Object.fromEntries(feature.goals.filter((g) => g.goal_id).map((g) => [g.goal_id!, g.contribution ?? 1])),
  );
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const goals = Object.entries(picked).map(([goal_id, contribution]) => ({ goal_id, contribution }));
    try {
      if (mode === "approver") await ops.patch(feature, { goals });
      else await ops.act({ item_key: feature.key, kind: "edit", field: "goals", value: goals, answers: [] });
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <div className="flex flex-col gap-1.5" data-testid="goals-editor">
      {scope.goals_available.map((g) => (
        <label key={g.goal_id} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={g.goal_id in picked}
            onChange={(e) => setPicked((p) => (e.target.checked ? { ...p, [g.goal_id]: 2 } : Object.fromEntries(Object.entries(p).filter(([k]) => k !== g.goal_id))))}
          />
          <span className="min-w-0 flex-1">{g.title}</span>
          {g.goal_id in picked && (
            <select
              aria-label={`Contribution to ${g.title}`}
              value={picked[g.goal_id]}
              onChange={(e) => setPicked((p) => ({ ...p, [g.goal_id]: Number(e.target.value) }))}
              className="rounded border border-line-strong bg-surface px-1 text-sm"
            >
              {[0, 1, 2, 3].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          )}
        </label>
      ))}
      {error && <span className="text-sm text-crit">{error}</span>}
      <span className="flex gap-1.5">
        <Button variant="solid" onClick={() => void save()}>
          {mode === "approver" ? "Save goals" : "Suggest goals"}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </span>
    </div>
  );
}

function WaiveForm({ feature, code, ops, onDone }: { feature: Feature; code: string; ops: Ops; onDone: () => void }) {
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mt-2 flex flex-col gap-1.5" data-testid="waive-form">
      <textarea aria-label="Why is this fine?" placeholder="Why is this fine?" value={note} maxLength={2000} rows={2} onChange={(e) => setNote(e.target.value)} className={`${INPUT} placeholder:text-text2`} />
      {error && <span className="text-sm text-crit">{error}</span>}
      <span className="flex gap-1.5">
        <Button
          variant="solid"
          disabled={!note.trim()}
          onClick={() =>
            void ops.act({ item_key: feature.key, kind: "waive", answers: [code], value: { reason: note.trim() }, note: note.trim() }).then(onDone, (e) => setError(errorMessage(e)))
          }
        >
          Waive
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </span>
    </div>
  );
}

/**
 * The selected feature (C7): its reasons with their fixes (and Waive with a note for a
 * blocking one), the decision, goals, dependencies, requirements (Add requirement, Enhance),
 * evidence, commenters' suggestions (Accept applies, Dismiss drops) and history.
 */
export function ScopeInspector({
  feature: f,
  scope,
  review,
  mode,
  ops,
  ui,
  waiving,
  goalsOpen,
  onWaiveDone,
  onGoalsDone,
  leavingOut,
  onLeaveOutDone,
}: {
  feature: Feature;
  scope: Scope;
  review: Review | null;
  mode: Mode;
  ops: Ops;
  ui: Ui;
  waiving: string | null;
  goalsOpen: boolean;
  onWaiveDone: () => void;
  onGoalsDone: () => void;
  leavingOut: string | null | undefined;
  onLeaveOutDone: () => void;
}) {
  const byKey = new Map(scope.features.map((x) => [x.key, x]));
  const actions = actionsOn(review, f.key);
  const staged = actions.filter((a) => a.state === "staged");
  const suggested = actions.filter((a) => a.state === "suggested");
  const goalTitle = (key: string) => scope.goals_available.find((g) => g.key === key)?.title ?? key;
  const write = mode !== "viewer";
  return (
    <Inspector
      eyebrow="Feature · selected"
      title={f.title}
      label={`Feature: ${f.title}`}
      testId="scope-inspector"
      chips={
        <>
          <Chip hero kind={f.decision === "include" ? "now" : "na"}>
            {decisionText(f.decision, f.decision_reason)}
          </Chip>
          <Chip hero>{f.goals.length ? f.goals.map((g) => goalTitle(g.key)).join(", ") : "No goal"}</Chip>
        </>
      }
      stats={[
        { label: "Confidence", figure: <Ring value={pct(f.confidence)} hero size={44} /> },
        { label: "Requirements", value: f.requirements.filter((q) => q.decision === "keep").length, of: f.requirements.length },
      ]}
    >
      {f.text && (
        <InspectorSection label="What it is">
          <p className="text-sm">{f.text}</p>
        </InspectorSection>
      )}
      {f.reasons.length > 0 && (
        <InspectorSection label="Needs you because">
          <ul className="flex flex-col gap-2">
            {f.reasons.map((r) => {
              const answer = staged.find((a) => (a.kind === "waive" || a.kind === "accept") && (!a.answers.length || a.answers.includes(r.code)));
              return (
                <li key={r.code} className={`rounded-button border p-2.5 ${r.severity === "blocking" ? "border-crit/40" : "border-warn/40"}`} data-testid={`reason-${r.code}`}>
                  <span className="flex flex-wrap items-center gap-2">
                    <Chip kind={r.severity === "blocking" ? "crit" : "warn"}>{r.severity === "blocking" ? "Blocking" : "To confirm"}</Chip>
                    <span className="min-w-0 flex-1 text-sm break-words">{r.label}</span>
                  </span>
                  {r.answered && answer ? (
                    <p className="mt-1.5 flex items-center gap-1.5 text-sm text-pass">
                      ✓ {answer.kind === "waive" ? `Waived: ${((answer.value ?? {}) as { reason?: string }).reason ?? answer.note ?? ""}` : "Kept"}
                      {mode === "approver" && (
                        <Button variant="ghost" className="h-8 px-2 text-sm" onClick={() => void ops.removeAction(answer.id)}>
                          Undo
                        </Button>
                      )}
                    </p>
                  ) : (
                    write && (
                      <div className="mt-1.5">
                        <FixButtons fixes={fixesFor(r, f, scope, mode, ops, ui)} />
                      </div>
                    )
                  )}
                  {waiving === r.code && mode === "approver" && <WaiveForm feature={f} code={r.code} ops={ops} onDone={onWaiveDone} />}
                </li>
              );
            })}
          </ul>
        </InspectorSection>
      )}
      <InspectorSection label="Decision">
        <SegmentedControl
          label="Decision"
          size="sm"
          value={f.decision}
          items={[
            { value: "include", label: "Include", disabled: !write },
            { value: "exclude", label: "Leave out", disabled: !write },
            { value: "defer", label: "Defer to a later PRD", disabled: !write },
          ]}
          onChange={(v) => (v === "exclude" ? ui.leaveOut(f) : void setDecision(mode, ops, f, v))}
        />
        {leavingOut !== undefined && (
          <LeaveOutPicker preset={leavingOut ?? undefined} suggest={mode === "commenter"} onCancel={onLeaveOutDone} onPick={(reason) => Promise.resolve(setDecision(mode, ops, f, "exclude", reason)).then(onLeaveOutDone)} />
        )}
        {f.edited && (
          <p className="mt-2 flex items-center gap-1.5 text-sm text-pass">
            ✓ {changeText(f)}
            {mode === "approver" && (
              <Button variant="ghost" className="h-8 px-2 text-sm" onClick={() => void ops.patch(f, { revert: true })}>
                Undo
              </Button>
            )}
          </p>
        )}
      </InspectorSection>
      <InspectorSection label="Goals">
        <div className="flex flex-wrap items-center gap-1.5">
          {f.goals.length ? (
            f.goals.map((g) => (
              <Chip key={g.key} kind="acc">
                {goalTitle(g.key)} · {g.contribution ?? 1}/3
              </Chip>
            ))
          ) : (
            <Chip kind="warn">No goal</Chip>
          )}
          {write && !goalsOpen && (
            <Button variant="ghost" className="h-8 px-2.5 text-sm" onClick={() => ui.pickGoal(f)}>
              Change
            </Button>
          )}
        </div>
        {goalsOpen && write && (
          <div className="mt-2">
            <GoalsEditor feature={f} scope={scope} mode={mode} ops={ops} onDone={onGoalsDone} />
          </div>
        )}
      </InspectorSection>
      <InspectorSection label="Depends on">
        {f.depends_on.length === 0 ? (
          <p className="text-sm text-text2">Nothing</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {f.depends_on.map((d) => {
              const dep = byKey.get(d);
              return (
                <li key={d} className="flex items-center gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">{dep?.title ?? d}</span>
                  <Chip kind={!dep ? "crit" : dep.decision === "include" ? "pass" : "warn"}>{dep ? decisionText(dep.decision) : "Unknown"}</Chip>
                  {mode === "approver" && (
                    <button
                      type="button"
                      aria-label={`Remove dependency on ${dep?.title ?? d}`}
                      className="grid size-8 place-items-center rounded hover:bg-surface2"
                      onClick={() => void ops.patch(f, { depends_on: f.depends_on.filter((x) => x !== d) })}
                    >
                      ×
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </InspectorSection>
      <InspectorSection label="Requirements">
        <div data-testid="inspector-requirements">
          {f.requirements.map((q) => (
            <RequirementRow key={q.id} req={q} mode={mode} ops={ops} review={review} indent={false} />
          ))}
        </div>
        {mode === "approver" && <AddRequirement feature={f} ops={ops} />}
      </InspectorSection>
      <InspectorSection label="Evidence">
        {f.evidence_ids.length ? (
          <ul className="text-sm">
            {f.evidence_ids.slice(0, 3).map((id) => (
              <li key={id} className="font-mono">
                {id.slice(0, 8)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-text2">No evidence linked</p>
        )}
      </InspectorSection>
      {suggested.length > 0 && (
        <InspectorSection label="Suggestions">
          <ul className="flex flex-col gap-2" data-testid="inspector-suggestions">
            {suggested.map((a) => (
              <li key={a.id} className="text-sm">
                <p>
                  Suggested by {a.created_by?.name ?? "someone"}: {describeAction(a, (k) => byKey.get(k)?.title ?? k)}
                </p>
                {mode === "approver" && (
                  <span className="mt-1 flex gap-1.5">
                    <Button variant="solid" className="h-8 px-2.5 text-sm" onClick={() => void ops.stage(a.id)}>
                      Accept
                    </Button>
                    <Button variant="ghost" className="h-8 px-2.5 text-sm" onClick={() => void ops.removeAction(a.id)}>
                      Dismiss
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </InspectorSection>
      )}
      <InspectorSection label="History">
        <History f={f} />
      </InspectorSection>
    </Inspector>
  );
}

function History({ f }: { f: Feature }) {
  const o = f.history.original as Record<string, unknown>;
  const changed = Object.keys(o).length > 0;
  return (
    <div className="text-sm" data-testid="history">
      {changed ? (
        <>
          <p>The agents proposed: {decisionText(String(o.decision ?? f.decision), (o.decision_reason as string | null) ?? null)}</p>
          {f.history.decided_by_name && (
            <p className="text-text2">
              Changed by {f.history.decided_by_name}
              {f.history.decided_at ? `, ${formatDateTime(f.history.decided_at)}` : ""}
            </p>
          )}
        </>
      ) : (
        <p className="text-text2">As the agents proposed it</p>
      )}
    </div>
  );
}
