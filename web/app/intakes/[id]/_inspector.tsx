"use client";

import Link from "next/link";
import { useState } from "react";

import { Button, Chip, CodeChip, Inspector, InspectorRow, InspectorSection, type ChipKind } from "@/components/ds";
import { FIELD_LABEL, InlineError, TEXTAREA } from "@/components/review/parts";
import { assess, goalViews } from "@/app/home/_goals";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatCount, plural } from "@/lib/format";
import { useMe, type Role } from "@/lib/me";
import { sectionHref } from "@/lib/section-link";
import { errorMessage, useQuery } from "@/lib/use-query";

import { DECIDED_GAP, HARD_BLOCKERS, categoryNote, criticalCount, holdCount, tally, unknownGaps, unknownNote, type Batch, type Gap, type Summary } from "./_lib";

type Decision = Schemas["DecisionIn"]["decision"];

const DECISIONS: { value: Decision; label: string }[] = [
  { value: "accept_assumption", label: "Accept as an assumption" },
  { value: "accept_risk", label: "Accept the risk" },
  { value: "validate", label: "Validate" },
];

/**
 * Record a decision on a gap (B4): the choice, a required rationale, and the server's
 * message in place when the decision is an owner's (a critical gap's risk, a hard blocker).
 */
export function DecideForm({
  gap,
  choices = DECISIONS,
  submit = "Record decision",
  onDone,
  onCancel,
}: {
  gap: Gap;
  choices?: { value: Decision; label: string }[];
  submit?: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [decision, setDecision] = useState<Decision>(choices[0].value);
  const [rationale, setRationale] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function record() {
    if (!rationale.trim()) {
      setError("Write a rationale first");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await unwrap(
        api.POST("/v1/gaps/{gap_id}/decisions", {
          params: { path: { gap_id: gap.id } },
          body: { decision, rationale: rationale.trim() },
        }),
      );
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 flex min-w-0 flex-col gap-2 rounded-button border border-line bg-surface2 p-2.5" data-testid="decide-form">
      {choices.length > 1 && (
        <fieldset className="flex flex-col gap-1">
          <legend className="sr-only">Decision</legend>
          {choices.map((c) => (
            <label key={c.value} className="flex items-center gap-2 text-sm text-text">
              <input type="radio" name={`decision-${gap.id}`} checked={decision === c.value} onChange={() => setDecision(c.value)} />
              {c.label}
            </label>
          ))}
        </fieldset>
      )}
      <label className={FIELD_LABEL}>
        Rationale
        <textarea rows={2} maxLength={2000} value={rationale} onChange={(e) => setRationale(e.target.value)} className={TEXTAREA} />
      </label>
      {error && <InlineError>{error}</InlineError>}
      <div className="flex flex-wrap gap-1.5">
        <Button variant="solid" icon="check" disabled={busy} onClick={record}>
          {busy ? "Recording…" : submit}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * Who may decide a gap here (#370: `can` from useMe): whoever may decide gaps; below an
 * owner, not a hard blocker (B4).
 */
export function mayReview(can: ReturnType<typeof useMe>["can"], gap: Gap): boolean {
  return can("decide_knowledge_gap", !HARD_BLOCKERS.has(gap.category));
}

/**
 * The brief's goals (C5): the goal_alignment gap's goals (those ticked at the New PRD door),
 * then the summary's goal links, each with its distance to go (Home's reading).
 */
function IntakeGoals({ summary: s }: { summary: Summary }) {
  const confirmed = useQuery("intake-goals", () =>
    unwrap(api.GET("/v1/baseline/entities", { params: { query: { type: "goal", status: "confirmed" } } })),
  );
  const views = new Map(goalViews(confirmed.data ?? []).map((g) => [g.id, g]));
  const ids = [...new Set([...s.gaps.filter((g) => g.category === "goal_alignment").flatMap((g) => g.entity_ids), ...s.goals.map((g) => g.entity_id)])];
  const goals = ids
    .map((id) => {
      const view = views.get(id);
      const link = s.goals.find((g) => g.entity_id === id);
      const title = view?.title ?? link?.title;
      return title ? { id, title, key: link?.key, progress: view ? assess(view) : null } : null;
    })
    .filter((g) => g !== null);
  if (goals.length)
    return goals.map((g) => (
      <InspectorRow
        key={g.id}
        value={g.progress && (g.progress.state === "togo" || g.progress.state === "met") ? <span className="text-text2">{g.progress.text}</span> : undefined}
      >
        <CodeChip kind="goal" entityId={g.id} entityKey={g.key} title={g.title} />
      </InspectorRow>
    ));
  if (confirmed.loading) return null;
  return <p className="text-sm text-text2">{confirmed.data?.length ? "No goal chosen yet" : "No confirmed company goal yet"}</p>;
}

/** Critical questions still open that hold nothing (none is a blocker): what the draft lacks. */
function missingGaps(s: Summary): Summary["gaps"] {
  return s.readiness.blocking_gap_ids.length ? [] : s.gaps.filter((g) => g.importance === "critical" && !DECIDED_GAP.has(g.status));
}

/** Where the brief stands, as the inspector's chip says it: archived, blocked, open critical questions, or ready. */
export function readiness(s: Summary): { label: string; kind: ChipKind } {
  if (s.intake.status === "archived") return { label: "Archived", kind: "na" };
  if (s.readiness.gate === "blocked") return { label: holdCount(s.readiness.blocking_gap_ids.length), kind: "crit" };
  const missing = missingGaps(s).length;
  if (missing > 0) return { label: `${criticalCount(missing)} open`, kind: "warn" };
  return { label: "Ready to draft", kind: "pass" };
}

/**
 * The inspector's title (the phone's summary card says the same, qa-work-29): qa-docs-19, it
 * answers the question in the same words as what follows it (and, #307, never "Ready to
 * draft" while a critical question is open).
 */
export function readinessTitle(s: Summary): string {
  if (s.intake.status === "archived") return "Not drafting";
  if (s.readiness.gate !== "clear") return "Not ready to draft";
  return missingGaps(s).length > 0 ? "Can draft, with gaps" : "Ready to draft";
}

/**
 * The right column (a sheet behind "Show details" on a phone): Ready to draft, with each
 * critical question that holds the draft and Decide, or the critical questions still open
 * that hold nothing (never "Ready to draft" while one is open), or Archived; the figures;
 * the goals; the template.
 */
export function IntakeInspector({
  summary: s,
  batches,
  onChanged,
  questionFor,
  onAnswer,
}: {
  summary: Summary;
  /** The thread's batches, once read: how the asked questions stand (qa-work-21). */
  batches?: Batch[];
  /** Unused (#370: the capabilities decide); kept for the intake shell. */
  role?: Role | null;
  onChanged: () => void;
  /** The question that asks about a gap, when one was asked (qa-docs-19: it gets a way to it). */
  questionFor?: (gapId: string) => string | null;
  /** Shows that question in the thread, ready to answer. */
  onAnswer?: (questionId: string) => void;
}) {
  const { can } = useMe();
  const [deciding, setDeciding] = useState<string | null>(null);
  const gate = s.readiness;
  const blocking = gate.blocking_gap_ids.map((id) => s.gaps.find((g) => g.id === id)).filter((g): g is Summary["gaps"][number] => !!g);
  const converted = s.intake.status === "converted";
  const archived = s.intake.status === "archived";
  const missing = missingGaps(s);
  const counts = tally(s, batches);
  const unknown = unknownGaps(batches);
  const title = readinessTitle(s);
  const note = unknownNote(counts);
  return (
    <Inspector
      eyebrow="Before drafting"
      title={title}
      testId="intake-inspector"
      label="Before drafting"
      stats={[
        { label: "Open", value: counts.open, testId: "stat-open" },
        { label: "Answered", value: counts.answered, testId: "stat-answered" },
        { label: "Critical open", value: gate.open_critical, tone: gate.open_critical ? "crit" : undefined, testId: "stat-critical" },
      ]}
    >
      <InspectorSection testId="ready-to-draft">
        {note && (
          <p data-testid="open-unknown" className="mb-2 text-[13px] text-text2">
            {note}
          </p>
        )}
        {archived ? (
          <div className="flex flex-col gap-1.5">
            <Chip kind="na" dot>
              Archived
            </Chip>
            <p className="text-[13px] text-text2">Its questions are kept here, and no one is asked them any more.</p>
          </div>
        ) : gate.gate === "clear" && missing.length > 0 ? (
          <div className="flex flex-col gap-2.5">
            <Chip kind="warn" dot>
              {criticalCount(missing.length)} open
            </Chip>
            <p data-testid="missing-note" className="text-[13px] text-text2">
              {missing.length === 1 ? "It does not stop the draft." : "They do not stop the draft."} The PRD will mark{" "}
              {missing.length === 1 ? "it" : "them"} as still unknown.
            </p>
            <ul className="flex flex-col gap-2">
              {missing.map((g) => (
                <li key={g.id} className="flex min-w-0 flex-col gap-0.5" data-testid="missing-gap">
                  <span className="text-sm break-words text-text">{g.statement}</span>
                  {(categoryNote(g) || unknown.has(g.id)) && (
                    <span className="text-[13px] text-text2">
                      {[categoryNote(g), unknown.has(g.id) && "answered “I don't know”"].filter(Boolean).join(" · ")}
                    </span>
                  )}
                  {/* qa-docs-19: each open question has a way to answer it, in the thread.
                      qa-docs-23: the thread is the one place to answer; this takes you there. */}
                  {(() => {
                    const q = questionFor?.(g.id);
                    return q && onAnswer ? (
                      <div className="mt-1">
                        <Button variant="secondary" aria-label={`Go to question: ${g.statement}`} onClick={() => onAnswer(q)}>
                          Go to question
                        </Button>
                      </div>
                    ) : (
                      <span className="text-[13px] text-text2">Not asked yet: ask it from Next questions.</span>
                    );
                  })()}
                </li>
              ))}
            </ul>
          </div>
        ) : gate.gate === "clear" ? (
          <Chip kind="pass" dot>
            Ready to draft
          </Chip>
        ) : (
          <div className="flex flex-col gap-2.5">
            <Chip kind="crit" dot>
              {holdCount(blocking.length)}
            </Chip>
            <ul className="flex flex-col gap-2.5">
              {blocking.map((g) => (
                <li key={g.id} className="flex min-w-0 flex-col gap-1.5" data-testid="blocking-gap">
                  <div className="flex min-w-0 items-start gap-2">
                    <span className="min-w-0 flex-1 text-sm break-words text-text">{g.statement}</span>
                    <Chip kind="crit">{g.importance === "critical" ? "Critical" : g.importance}</Chip>
                  </div>
                  {categoryNote(g) && <span className="text-[13px] text-text2">{categoryNote(g)}</span>}
                  {/* #370: an approver may still reject a critical gap; the form says what needs an owner. */}
                  {can("decide_knowledge_gap", true) && deciding !== g.id && (
                    <div>
                      <Button onClick={() => setDeciding(g.id)}>Decide</Button>
                    </div>
                  )}
                  {deciding === g.id && (
                    <DecideForm
                      gap={g}
                      onCancel={() => setDeciding(null)}
                      onDone={() => {
                        setDeciding(null);
                        onChanged();
                      }}
                    />
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {!archived && gate.private_blocking_gap_ids.length > 0 && (
          <p className="mt-2 text-[13px] text-text2">
            {criticalCount(gate.private_blocking_gap_ids.length)} from your own sources hold nothing until you share them.
          </p>
        )}
      </InspectorSection>
      <InspectorSection label="Goals" testId="intake-goals">
        <IntakeGoals summary={s} />
      </InspectorSection>
      <IntakeRequests intakeId={s.intake.id} />
      <InspectorSection label="Template" testId="intake-template">
        <InspectorRow value={s.template.theme ?? undefined}>{s.template.name}</InspectorRow>
      </InspectorSection>
      {converted && (
        <InspectorSection label="Drafting" testId="answers-since">
          <p className="text-sm text-text">
            {plural(s.answers_since_run ?? 0, "answer")} since drafting started
          </p>
          {/* C5: each became a feedback item on the PRD; the next draft takes them. */}
          {(s.late_answers_as_feedback ?? 0) > 0 && (
            <p className="text-sm text-text" data-testid="late-answers-feedback">
              {formatCount(s.late_answers_as_feedback ?? 0)} became feedback for the next draft
              {s.draft_document && s.draft_version != null && (
                <>
                  {" · "}
                  <Link href={sectionHref(s.draft_document, s.draft_version, null, { feedback: "open" })} className="font-semibold text-accent-ink underline">
                    Open the PRD&apos;s feedback
                  </Link>
                </>
              )}
            </p>
          )}
          {s.draft_run_id && (
            <Link href={`/runs/${s.draft_run_id}`} className="text-sm font-semibold text-accent-ink underline">
              Open the draft run
            </Link>
          )}
        </InspectorSection>
      )}
    </Inspector>
  );
}

/** The brief's "Requests behind it" (C1 lane 2): each one links to it in Requests. Hidden
 * when the brief has none. */
function IntakeRequests({ intakeId }: { intakeId: string }) {
  const requests = useQuery(`intake-requests:${intakeId}`, () =>
    unwrap(api.GET("/v1/requests", { params: { query: { intake_id: intakeId, limit: 200 } } })),
  );
  const items = requests.data?.items ?? [];
  if (!requests.error && items.length === 0) return null;
  return (
    <InspectorSection label="Requests behind it" testId="intake-requests">
      {requests.error && <InlineError>{requests.error}</InlineError>}
      <ul className="flex flex-col gap-1 text-sm">
        {items.map((r) => (
          <li key={r.id}>
            <Link href={`/requests?request=${r.id}`} className="font-semibold text-accent-ink underline-offset-2 hover:underline [overflow-wrap:anywhere]">
              {r.title}
            </Link>
          </li>
        ))}
      </ul>
    </InspectorSection>
  );
}
