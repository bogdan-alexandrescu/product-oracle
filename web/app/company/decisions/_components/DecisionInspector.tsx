"use client";

import Link from "next/link";
import { useState, type FormEvent, type ReactNode } from "react";

import { Button, Chip, Inspector, InspectorRow, InspectorSection, LinkButton } from "@/components/ds";
import { ErrorNote, INPUT } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { hasRole, useMe } from "@/lib/me";
import { errorMessage } from "@/lib/use-query";

import {
  ORIGIN_LABEL,
  REVERSIBILITY_LABEL,
  STATE_KIND,
  STATE_LABEL,
  SUBJECT_LABEL,
  VERDICT_LABEL,
  isCheckpoint,
  isoDay,
  shortDate,
  type Decision,
  type DecisionOption,
  type Person,
} from "./lib";

type Done = (updated?: Decision) => Promise<void> | void;
const path = (d: Decision) => ({ params: { path: { decision: String(d.number) } } });

/**
 * B1's inspector for one decision: the call, its options (Oracle's pick tagged), what was
 * chosen and why, what it should lead to, the people, what it is about, its reviews; then the
 * actions the member may take. A checkpoint record is read-only: the stop, the run, the note.
 */
export function DecisionInspector({
  decision: d,
  people,
  onChanged,
  autoDecide = false,
}: {
  decision: Decision;
  people: Person[];
  onChanged: Done;
  /** Open the decide form at once (the Inbox's Decide). */
  autoDecide?: boolean;
}) {
  const { role } = useMe();
  const [mode, setMode] = useState<null | "decide" | "review" | "reassign" | "withdraw">(autoDecide && d.can_decide ? "decide" : null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const checkpoint = isCheckpoint(d);
  const email = (id: string | null | undefined) => people.find((p) => p.id === id)?.email ?? null;
  const chosen = d.options.find((o) => o.key === d.chosen_option);
  const stop = d.subjects.find((s) => s.kind === "run");

  async function askOracle() {
    setBusy(true);
    setError(null);
    try {
      // A click-and-wait job on Oracle's own model: queued, then read until it ends.
      let job = await unwrap(api.POST("/v1/decisions/{decision}/options-job", path(d)));
      for (let i = 0; i < 60 && (job.status === "queued" || job.status === "running"); i++) {
        await new Promise((r) => setTimeout(r, 1000));
        job = await unwrap(api.GET("/v1/llm-jobs/{job_id}", { params: { path: { job_id: job.id } } }));
      }
      if (job.status !== "succeeded") setError(job.error ?? `Oracle's options job ${job.status}`);
      await onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const done: Done = async (updated) => {
    setMode(null);
    setError(null);
    await onChanged(updated);
  };

  return (
    <Inspector
      testId="decision-inspector"
      label={`${d.ref} ${d.title}`}
      eyebrow={`${d.ref} · ${checkpoint ? "Checkpoint" : "Judgement call"}`}
      title={d.title}
      chips={
        <>
          <Chip hero kind={STATE_KIND[d.state]}>
            {STATE_LABEL[d.state]}
          </Chip>
          {!checkpoint && <Chip hero>{REVERSIBILITY_LABEL[d.reversibility]}</Chip>}
          <Chip hero>{ORIGIN_LABEL[d.origin]}</Chip>
        </>
      }
      action={
        checkpoint && d.run_id ? (
          <LinkButton variant="hero" href={`/runs/${d.run_id}`}>
            Open run
          </LinkButton>
        ) : undefined
      }
    >
      {error && (
        <div className="px-5 pt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      {checkpoint ? (
        <InspectorSection label="The stop" testId="decision-stop">
          <InspectorRow value={d.chosen_option === "approve" ? "Approved" : "Sent back"}>{stopLabel(d)}</InspectorRow>
          <p className="mt-1 text-[15px] whitespace-pre-line">{d.rationale}</p>
          {d.context && <p className="mt-2 text-sm whitespace-pre-line text-text2">{d.context}</p>}
          {reviewFile(d) && (
            <p className="mt-2 text-sm">
              <a href={reviewFile(d)!} className="font-medium text-accent-ink hover:underline">
                Open review file
              </a>
            </p>
          )}
          {stop && <p className="mt-1 text-sm text-text2">Decided {shortDate(d.decided_at)} by {d.decided_by_email ?? email(d.approver_id) ?? "the approver"}</p>}
        </InspectorSection>
      ) : (
        <>
          {d.question && (
            <InspectorSection label="The question">
              <p className="text-[15px]">{d.question}</p>
              {d.context && <p className="mt-1.5 text-sm whitespace-pre-line text-text2">{d.context}</p>}
            </InspectorSection>
          )}
          {!d.question && d.context && (
            <InspectorSection label="Context">
              <p className="text-sm whitespace-pre-line text-text2">{d.context}</p>
            </InspectorSection>
          )}
          <InspectorSection
            label="Options"
            tools={
              d.status === "proposed" &&
              hasRole(role, "approver") && (
                <Button variant="ghost" disabled={busy} onClick={askOracle}>
                  {busy ? "Asking Oracle…" : "Ask Oracle for options"}
                </Button>
              )
            }
          >
            {d.options.length === 0 ? <p className="text-sm text-text2">No options yet</p> : <Options options={d.options} chosen={d.chosen_option} />}
          </InspectorSection>
          {d.chosen_option && (
            <InspectorSection label="Chosen" testId="decision-chosen">
              <p className="font-semibold">{chosen?.label ?? d.chosen_option}</p>
              <p className="mt-1 text-[15px]">
                <span className="font-semibold text-text2">Why </span>
                {d.rationale}
              </p>
            </InspectorSection>
          )}
          {(d.expected_outcome || d.prediction) && (
            <InspectorSection label="Expected">
              {d.expected_outcome && <p className="text-[15px]">{d.expected_outcome}</p>}
              {d.prediction && (
                <p className="mt-1 text-sm text-text2">
                  {String(d.prediction.metric ?? "")}: {String(d.prediction.baseline ?? "?")} → {String(d.prediction.predicted ?? "?")}
                  {d.prediction.by ? ` by ${shortDate(String(d.prediction.by))}` : ""}
                </p>
              )}
            </InspectorSection>
          )}
        </>
      )}
      <InspectorSection label="People">
        <InspectorRow value={d.approver_email ?? email(d.approver_id) ?? "—"}>Approver</InspectorRow>
        <InspectorRow value={d.driver === "oracle" ? "Oracle" : (email(d.driver.replace(/^user:/, "")) ?? "A member")}>Driver</InspectorRow>
        {d.contributor_ids.length > 0 && <InspectorRow value={d.contributor_ids.map((i) => email(i) ?? "a member").join(", ")}>Contributors</InspectorRow>}
        {d.informed_ids.length > 0 && <InspectorRow value={d.informed_ids.map((i) => email(i) ?? "a member").join(", ")}>Informed</InspectorRow>}
      </InspectorSection>
      {d.subjects.length > 0 && (
        <InspectorSection label="About">
          <ul className="flex flex-col gap-1 text-sm">
            {d.subjects.map((s) => (
              <li key={`${s.kind}:${s.id}`}>
                <SubjectLink subject={s} />
              </li>
            ))}
          </ul>
        </InspectorSection>
      )}
      {!checkpoint && (
        <InspectorSection label="Review">
          <InspectorRow value={shortDate(d.review_at)}>Review date</InspectorRow>
          {d.decided_at && <InspectorRow value={shortDate(d.decided_at)}>Decided</InspectorRow>}
          {d.reviews.map((r) => (
            <p key={r.id} className="mt-1 text-sm">
              <span className="font-semibold">{VERDICT_LABEL[r.verdict]}</span> {shortDate(r.created_at)}: {r.note}
            </p>
          ))}
          {d.revisit_id && (
            <p className="mt-1 text-sm">
              <Link href={`/company/decisions?d=${encodeURIComponent(d.revisit_id)}`} className="font-medium text-accent-ink hover:underline">
                Open the revisit
              </Link>
            </p>
          )}
        </InspectorSection>
      )}
      {!checkpoint && (
        <Actions d={d} people={people} mode={mode} setMode={setMode} done={done} />
      )}
    </Inspector>
  );
}

function stopLabel(d: Decision): string {
  const m = /^(?:Approve|Send back) (.+?) · /.exec(d.title);
  return m?.[1] ?? "Stop";
}

function reviewFile(d: Decision): string | null {
  const m = /Review file: (\S+)/.exec(d.context ?? "");
  return m?.[1] ?? null;
}

function SubjectLink({ subject: s }: { subject: Decision["subjects"][number] }) {
  const kind = String(s.kind);
  const label = `${SUBJECT_LABEL[kind] ?? kind} ${String(s.ref ?? "")}`.trim();
  const href =
    kind === "run" ? `/runs/${String(s.id)}` : kind === "document" && s.ref ? `/documents/${String(s.ref)}` : kind === "document_version" && s.ref ? versionHref(String(s.ref)) : null;
  return href ? (
    <Link href={href} className="font-medium text-accent-ink hover:underline">
      {label}
    </Link>
  ) : (
    <span>{label}</span>
  );
}

function versionHref(ref: string): string {
  const [slug, n] = ref.split("@");
  return n ? `/documents/${slug}/versions/${n}` : `/documents/${slug}`;
}

function Options({ options, chosen }: { options: DecisionOption[]; chosen?: string | null }) {
  return (
    <ul className="flex flex-col gap-2.5">
      {options.map((o) => (
        <li
          key={o.key}
          data-testid="decision-option"
          className={`rounded-lg border px-3 py-2 ${o.key === chosen ? "border-accent bg-accent-soft" : "border-line"}`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{o.label}</span>
            {o.recommended && <Chip kind="acc">Oracle recommends</Chip>}
            {o.key === chosen && <Chip kind="pass">Chosen</Chip>}
          </div>
          {o.summary && <p className="mt-0.5 text-sm text-text2">{o.summary}</p>}
          {o.pros.length > 0 && <Lines label="Pros" lines={o.pros} />}
          {o.cons.length > 0 && <Lines label="Cons" lines={o.cons} />}
          {o.evidence_ids.length > 0 && (
            <p className="mt-1 flex flex-wrap gap-1">
              {o.evidence_ids.map((e) => (
                <Chip key={e} kind="line" title={`Evidence ${e}`}>
                  Evidence {e.slice(0, 6)}
                </Chip>
              ))}
            </p>
          )}
          {o.cost_if_wrong && (
            <p className="mt-1 text-sm">
              <span className="font-semibold text-text2">Cost if wrong </span>
              {o.cost_if_wrong}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

function Lines({ label, lines }: { label: string; lines: string[] }) {
  return (
    <p className="mt-1 text-sm">
      <span className="font-semibold text-text2">{label} </span>
      {lines.join(" · ")}
    </p>
  );
}

type Mode = null | "decide" | "review" | "reassign" | "withdraw";

/** The actions the member may take on this decision, each opening its own short form. */
function Actions({
  d,
  people,
  mode,
  setMode,
  done,
}: {
  d: Decision;
  people: Person[];
  mode: Mode;
  setMode: (m: Mode) => void;
  done: Done;
}) {
  const buttons = (
    <div className="flex flex-wrap gap-2">
      {d.can_decide && (
        <Button variant="solid" onClick={() => setMode("decide")} aria-expanded={mode === "decide"}>
          Decide
        </Button>
      )}
      {d.can_review && (
        <Button onClick={() => setMode("review")} aria-expanded={mode === "review"}>
          Review
        </Button>
      )}
      {d.can_reassign && (
        <Button onClick={() => setMode("reassign")} aria-expanded={mode === "reassign"}>
          Reassign
        </Button>
      )}
      {d.can_withdraw && (
        <Button variant="ghost" onClick={() => setMode("withdraw")} aria-expanded={mode === "withdraw"}>
          Withdraw
        </Button>
      )}
    </div>
  );
  if (!d.can_decide && !d.can_review && !d.can_reassign && !d.can_withdraw) return null;
  return (
    <InspectorSection label="Actions" testId="decision-actions">
      {buttons}
      {mode === "decide" && <DecideForm d={d} onDone={done} onCancel={() => setMode(null)} />}
      {mode === "review" && <ReviewForm d={d} onDone={done} onCancel={() => setMode(null)} />}
      {mode === "reassign" && <ReassignForm d={d} people={people} onDone={done} onCancel={() => setMode(null)} />}
      {mode === "withdraw" && <WithdrawForm d={d} onDone={done} onCancel={() => setMode(null)} />}
    </InspectorSection>
  );
}

function FormShell({
  name,
  onSubmit,
  children,
  submit,
  onCancel,
  error,
  busy,
}: {
  name: string;
  onSubmit: () => Promise<void>;
  children: ReactNode;
  submit: string;
  onCancel: () => void;
  error: string | null;
  busy: boolean;
}) {
  return (
    <form
      aria-label={name}
      className="mt-3 flex flex-col gap-2.5"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void onSubmit();
      }}
    >
      {children}
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex gap-2">
        <Button type="submit" variant="solid" disabled={busy}>
          {submit}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
      {label}
      {children}
    </label>
  );
}

function useSubmit(onDone: Done) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (call: () => Promise<Decision>) => {
    setBusy(true);
    setError(null);
    try {
      const updated = await call();
      await onDone(updated);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

/** Decide: an option, why, the reversibility confirmed, a review date (+90 days) and what should happen. */
function DecideForm({ d, onDone, onCancel }: { d: Decision; onDone: Done; onCancel: () => void }) {
  const [option, setOption] = useState<string>(d.options.find((o) => o.recommended)?.key ?? "");
  const [why, setWhy] = useState("");
  const [reversibility, setReversibility] = useState(d.reversibility);
  const [review, setReview] = useState(isoDay(90));
  const [expected, setExpected] = useState(d.expected_outcome ?? "");
  const { busy, error, setError, run } = useSubmit(onDone);
  return (
    <FormShell
      name="Decide"
      submit="Record decision"
      busy={busy}
      error={error}
      onCancel={onCancel}
      onSubmit={async () => {
        if (d.options.length < 2) return setError("Add at least two options before deciding");
        if (!option) return setError("Pick an option");
        if (!why.trim()) return setError("Say why");
        if (!expected.trim()) return setError("Say what should happen if it is right");
        await run(() =>
          unwrap(
            api.POST("/v1/decisions/{decision}/decide", {
              ...path(d),
              body: { option_key: option, rationale: why, reversibility, review_at: review || null, expected_outcome: expected, lock_version: d.lock_version },
            }),
          ),
        );
      }}
    >
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-sm font-semibold text-text2">Chosen option</legend>
        {d.options.map((o) => (
          <label key={o.key} className="flex items-center gap-2 text-[15px]">
            <input type="radio" name={`decide-${d.id}`} value={o.key} checked={option === o.key} onChange={() => setOption(o.key)} />
            {o.label}
          </label>
        ))}
      </fieldset>
      <Field label="Why">
        <textarea className={INPUT} rows={3} value={why} onChange={(e) => setWhy(e.target.value)} />
      </Field>
      <Field label="Reversibility">
        <select aria-label="Reversibility" className={INPUT} value={reversibility} onChange={(e) => setReversibility(e.target.value as Decision["reversibility"])}>
          <option value="reversible">Reversible</option>
          <option value="irreversible">Hard to reverse</option>
        </select>
      </Field>
      <Field label="Review date">
        <input type="date" className={INPUT} value={review} min={isoDay(0)} max={isoDay(365)} onChange={(e) => setReview(e.target.value)} />
      </Field>
      <Field label="Expected outcome">
        <input className={INPUT} value={expected} onChange={(e) => setExpected(e.target.value)} placeholder="What should happen if it is right" />
      </Field>
    </FormShell>
  );
}

/** Review: reaffirm (and when to look again), revisit (a new proposal that supersedes it), or reverse. */
function ReviewForm({ d, onDone, onCancel }: { d: Decision; onDone: Done; onCancel: () => void }) {
  const [verdict, setVerdict] = useState<"reaffirmed" | "revisit" | "reversed">("reaffirmed");
  const [note, setNote] = useState("");
  const [next, setNext] = useState(isoDay(90));
  const { busy, error, setError, run } = useSubmit(onDone);
  return (
    <FormShell
      name="Review"
      submit={verdict === "reaffirmed" ? "Reaffirm" : verdict === "revisit" ? "Revisit" : "Reverse"}
      busy={busy}
      error={error}
      onCancel={onCancel}
      onSubmit={async () => {
        if (!note.trim()) return setError("Say what the review found");
        await run(() =>
          unwrap(
            api.POST("/v1/decisions/{decision}/reviews", {
              ...path(d),
              body: { verdict, note, next_review_at: verdict === "reaffirmed" ? next || null : null },
            }),
          ),
        );
      }}
    >
      <fieldset className="flex flex-wrap gap-3">
        <legend className="mb-1 text-sm font-semibold text-text2">Verdict</legend>
        {(
          [
            ["reaffirmed", "Reaffirm"],
            ["revisit", "Revisit"],
            ["reversed", "Reverse"],
          ] as const
        ).map(([v, label]) => (
          <label key={v} className="flex items-center gap-1.5 text-[15px]">
            <input type="radio" name={`review-${d.id}`} checked={verdict === v} onChange={() => setVerdict(v)} />
            {label}
          </label>
        ))}
      </fieldset>
      <Field label="Note">
        <textarea className={INPUT} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      {verdict === "reaffirmed" && (
        <Field label="Next review">
          <input type="date" className={INPUT} value={next} min={isoDay(0)} max={isoDay(365)} onChange={(e) => setNext(e.target.value)} />
        </Field>
      )}
    </FormShell>
  );
}

function ReassignForm({ d, people, onDone, onCancel }: { d: Decision; people: Person[]; onDone: Done; onCancel: () => void }) {
  const approvers = people.filter((p) => hasRole(p.role, "approver"));
  const [approver, setApprover] = useState(d.approver_id);
  const [reason, setReason] = useState("");
  const { busy, error, setError, run } = useSubmit(onDone);
  return (
    <FormShell
      name="Reassign"
      submit="Reassign"
      busy={busy}
      error={error}
      onCancel={onCancel}
      onSubmit={async () => {
        if (!reason.trim()) return setError("Say why");
        await run(() => unwrap(api.POST("/v1/decisions/{decision}/reassign", { ...path(d), body: { approver_id: approver, reason } })));
      }}
    >
      <Field label="New approver">
        <select aria-label="New approver" className={INPUT} value={approver} onChange={(e) => setApprover(e.target.value)}>
          {approvers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.email}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Reason">
        <input className={INPUT} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </FormShell>
  );
}

function WithdrawForm({ d, onDone, onCancel }: { d: Decision; onDone: Done; onCancel: () => void }) {
  const [reason, setReason] = useState("");
  const { busy, error, setError, run } = useSubmit(onDone);
  return (
    <FormShell
      name="Withdraw"
      submit="Withdraw"
      busy={busy}
      error={error}
      onCancel={onCancel}
      onSubmit={async () => {
        if (!reason.trim()) return setError("Say why");
        await run(() => unwrap(api.POST("/v1/decisions/{decision}/withdraw", { ...path(d), body: { reason } })));
      }}
    >
      <Field label="Reason">
        <input className={INPUT} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </FormShell>
  );
}
