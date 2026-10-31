"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { Button, Chip, Inspector, InspectorSection, Page, PageHeader, SegmentedControl, Split } from "@/components/ds";
import { ErrorNote, INPUT } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { errorMessage } from "@/lib/use-query";

import type { BriefsCheck, CheckpointOut, RunOut } from "../../../_lib";

type Review = Schemas["CheckpointReview"];
type Action = Review["items"][number]["actions"][number];
type Feature = BriefsCheck["features"][number];
type ActIn = Omit<Schemas["ActionIn"], "answers">;
type Verdict = "feasible" | "feasible_with_changes" | "not_feasible";

const SIZES = ["xs", "s", "m", "l", "xl"] as const;
const VERDICTS: { value: Verdict; label: string; needs?: string }[] = [
  { value: "feasible", label: "Feasible" },
  { value: "feasible_with_changes", label: "Feasible with changes", needs: "Note: what changes" },
  { value: "not_feasible", label: "Not feasible as scoped", needs: "Reason: why not as scoped" },
];
const VERDICT_WORDS: Record<Verdict, string> = { feasible: "Feasible", feasible_with_changes: "Feasible with changes", not_feasible: "Not feasible as scoped" };
const VERDICT_KIND = { feasible: "pass", feasible_with_changes: "warn", not_feasible: "crit" } as const;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The feature's actions in the shared draft, staged first. */
function actionsOf(review: Review, key: string): Action[] {
  const all = review.items.find((i) => i.key === key)?.actions ?? [];
  return [...all].sort((a, b) => (a.state === b.state ? 0 : a.state === "staged" ? -1 : 1));
}
const edit = (acts: Action[], field: string) => acts.find((a) => a.kind === "edit" && a.field === field);
const verdictOf = (acts: Action[]) => edit(acts, "verdict")?.value as { verdict: Verdict; note?: string | null } | undefined;

/**
 * F4 Engineering check (`eng_review`): one row per feature of the briefs. The engineering lead
 * (and owners; approvers while no lead is named) give each a verdict, a size and the blocking
 * answers; each choice is a D8 action, so several people work the stop at once and nothing is
 * lost on refresh. Approve opens once nothing blocking is left (D3).
 */
export function EngReview({
  run,
  cp,
  title,
  check,
  review,
  back,
  onReview,
  onDecided,
}: {
  run: RunOut;
  cp: CheckpointOut;
  title: string;
  check: BriefsCheck;
  review: Review;
  back: ReactNode;
  onReview: (out: Review) => void;
  onDecided: () => Promise<void>;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState(check.features[0]?.key ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(review.note ?? "");
  const [sending, setSending] = useState(false);
  // Answers being typed, by feature and question: kept here, above the inspector, so a verdict
  // or size saved meanwhile (or another feature selected) never empties a box being typed in.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const pending = cp.status === "pending";
  const stages = pending && review.can_stage;
  // Choices from whoever does not stage are suggestions a decider stages (AC6). Train N (owner
  // 2026-10-24): the review's own can_suggest says who may suggest, as the items and scope
  // reviews read it; no route role stands in for it.
  const suggests = pending && !stages && review.can_suggest;
  const decides = pending && review.can_decide;
  const path = { params: { path: { run_id: run.id, checkpoint_id: cp.id } } };

  /** Saves one choice; true once it is saved (a failed save keeps what was typed). */
  async function write(call: () => Promise<Review>): Promise<boolean> {
    setError(null);
    setBusy(true);
    try {
      onReview(await call());
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  const act = (body: ActIn) => write(() => unwrap(api.POST("/v1/runs/{run_id}/checkpoints/{checkpoint_id}/actions", { ...path, body: { answers: [], ...body } })));
  const stage = (id: string) =>
    write(() => unwrap(api.POST("/v1/runs/{run_id}/checkpoints/{checkpoint_id}/actions/{action_id}/stage", { params: { path: { ...path.params.path, action_id: id } } })));

  async function decide(decision: "approved" | "changes_requested") {
    setError(null);
    setBusy(true);
    try {
      if (decision === "changes_requested") {
        onReview(await unwrap(api.PUT("/v1/runs/{run_id}/checkpoints/{checkpoint_id}/note", { ...path, body: { note: note.trim() || null } })));
      }
      await unwrap(
        api.POST("/v1/runs/{run_id}/checkpoints/{checkpoint_id}/decide", {
          ...path,
          body: { decision, note: decision === "changes_requested" ? note.trim() : null, expected_revision: decision === "approved" ? review.revision : null },
        }),
      );
      await onDecided();
      router.push(`/runs/${run.id}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  const left = review.gate?.left ?? [];
  const reasonsOf = (key: string) => left.filter((x) => x.item === key);
  const decided = check.features.filter((f) => verdictOf(actionsOf(review, f.key).filter((a) => a.state === "staged"))).length;
  const blockingQuestions = left.filter((x) => x.code === "blocking_question").length;
  const notFeasible = new Set(
    check.features.filter((f) => verdictOf(actionsOf(review, f.key).filter((a) => a.state === "staged"))?.verdict === "not_feasible").map((f) => f.key),
  );
  const gateOpen = !!review.gate?.open;
  const staged = review.items.flatMap((i) => i.actions.filter((a) => a.state === "staged").map((a) => ({ item: i.key, a })));
  const feature = check.features.find((f) => f.key === selected) ?? null;
  // Only who can decide: the engineering lead once one is named, else the stop's role.
  const waitsFor = cp.lead_stop ? "Waits for the engineering lead" : `Waits for an ${cp.approver_role}`;

  // Every briefs problem is file-level (oracle.engineering.check): nothing to decide, only Send back.
  const unreadable = check.problems.length > 0;
  const tally = unreadable
    ? "The briefs could not be read"
    : `${decided} of ${check.features.length} decided${blockingQuestions ? ` · ${plural(blockingQuestions, "blocking question")}` : ""}`;
  const approveWhy = unreadable
    ? "Send the briefs back to the architect to write them again"
    : !gateOpen
      ? "Give each feature a verdict and answer each blocking question first"
      : null;

  return (
    <Page className="pb-0">
      <PageHeader
        title={title}
        back={back}
        status={
          <>
            <Chip kind={pending ? "warn" : "na"}>{pending ? "Waiting" : cp.status === "approved" ? "Approved" : "Sent back"}</Chip>
            {pending && !decides && (
              <span className="inline-flex items-center gap-2" data-testid="view-only">
                <Chip kind="na">{suggests ? "Suggestions only" : "View only"}</Chip>
                <span className="text-sm text-text2">{waitsFor}</span>
              </span>
            )}
          </>
        }
      />
      {check.problems.length > 0 && (
        <div role="alert" data-testid="briefs-problem" className="mb-4 rounded-panel border border-crit bg-crit-soft px-4 py-3 text-[15px]">
          <p className="font-semibold">The briefs could not be read: send them back to the architect.</p>
          <ul className="mt-1 list-disc pl-5">
            {check.problems.map((p, i) => (
              <li key={i}>{p.message}</li>
            ))}
          </ul>
        </div>
      )}
      <Split
        inspector={
          feature && (
            <BriefInspector
              key={feature.key}
              feature={feature}
              codeMap={check.code_map_used}
              acts={actionsOf(review, feature.key)}
              stages={stages}
              suggests={suggests}
              busy={busy}
              onAct={act}
              onStage={stage}
              drafts={drafts}
              onDraft={(qid, text) => setDrafts((all) => ({ ...all, [`${feature.key}:${qid}`]: text }))}
              onAsk={(text) => {
                setNote((n) => (n.trim() ? `${n.trim()}\n${text}` : text));
                setSending(true);
              }}
            />
          )
        }
      >
        <section aria-label="Features" className="min-w-0 rounded-panel border border-line bg-surface">
          <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,2fr)_minmax(0,1.2fr)_64px_minmax(0,1fr)_minmax(0,1.4fr)] gap-3 border-b border-line px-4 py-2 text-[13px] font-semibold tracking-[0.02em] text-text2 max-[900px]:hidden">
            <span>Feature</span>
            <span>Approach</span>
            <span>Feasibility</span>
            <span>Size</span>
            <span>Questions</span>
            <span>Needs you because</span>
          </div>
          <ul>
            {check.features.map((f) => {
              const acts = actionsOf(review, f.key);
              const v = verdictOf(acts.filter((a) => a.state === "staged"));
              const size = (edit(acts.filter((a) => a.state === "staged"), "size")?.value as string | undefined) ?? f.size;
              const blocking = f.questions.filter((q) => q.blocking).length;
              const reasons = reasonsOf(f.key);
              const confirm = [
                !check.code_map_used ? "No code map: approach rests on assumptions" : null,
                f.depends_on.some((d) => notFeasible.has(d)) ? "Depends on a feature judged not feasible" : null,
              ].filter((x): x is string => !!x);
              return (
                <li
                  key={f.key}
                  data-testid="brief-row"
                  data-feature={f.key}
                  aria-current={f.key === selected ? "true" : undefined}
                  className={`grid grid-cols-[minmax(0,1.4fr)_minmax(0,2fr)_minmax(0,1.2fr)_64px_minmax(0,1fr)_minmax(0,1.4fr)] items-start gap-3 border-b border-line px-4 py-3 last:border-b-0 max-[900px]:grid-cols-1 max-[900px]:gap-1.5 max-[600px]:m-2 max-[600px]:rounded-panel max-[600px]:border ${
                    f.key === selected ? "bg-accent-soft" : ""
                  }`}
                >
                  <button type="button" className="min-w-0 text-left font-semibold hover:underline" onClick={() => setSelected(f.key)}>
                    {f.title}
                    <span className="ml-1.5 font-mono text-sm font-normal break-all text-text2" data-testid="brief-key">
                      {f.key}
                    </span>
                  </button>
                  <span className="min-w-0 text-text2">{f.approach}</span>
                  <span data-testid="brief-verdict">
                    {v ? (
                      <Chip kind={VERDICT_KIND[v.verdict]} wrap>
                        {VERDICT_WORDS[v.verdict]}
                      </Chip>
                    ) : (
                      <span className="text-sm text-text2">Not decided</span>
                    )}
                  </span>
                  <span className="tnum font-semibold" data-testid="brief-size">
                    <span className="mr-1 font-normal text-text2 min-[901px]:sr-only">Size</span>
                    {size.toUpperCase()}
                  </span>
                  <span className="text-sm" data-testid="brief-questions">
                    {f.questions.length ? `${f.questions.length} open${blocking ? ` · ${blocking} blocking` : ""}` : "None"}
                  </span>
                  <span className="flex min-w-0 flex-wrap gap-1.5" data-testid="brief-reasons">
                    {reasons.map((x, i) => (
                      <Chip key={`${x.code}-${i}`} kind="crit" wrap>
                        {x.label}
                      </Chip>
                    ))}
                    {confirm.map((c) => (
                      <Chip key={c} kind="warn" wrap>
                        {c}
                      </Chip>
                    ))}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      </Split>

      <div
        data-testid="decision-bar"
        className="sticky bottom-0 z-30 -mx-6 mt-4 border-t border-line bg-surface px-6 py-3 shadow-tip max-[600px]:bottom-[68px] max-[600px]:-mx-2.5 max-[600px]:px-3"
      >
        {error && <ErrorNote>{error}</ErrorNote>}
        {sending && decides && (
          <label className="mb-2 block">
            <span className="mb-1 block text-sm font-semibold text-text2">Note to the architect</span>
            <textarea className={`${INPUT} min-h-16`} value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note to the architect" />
          </label>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <span className="tnum font-semibold" data-testid="eng-tally">
            {tally}
          </span>
          {staged.length > 0 && (
            <span className="flex min-w-0 flex-wrap gap-1.5" data-testid="staged-chips">
              <Chip kind="acc">{plural(staged.length, "change")} staged</Chip>
            </span>
          )}
          <span className="flex-1" />
          {decides && (
            <>
              <Button
                variant="secondary"
                disabled={busy || (sending && !note.trim())}
                onClick={() => (sending ? void decide("changes_requested") : setSending(true))}
              >
                Send back to architect
              </Button>
              {!unreadable && (
                <Button variant="primary" disabled={busy || !gateOpen} title={approveWhy ?? undefined} onClick={() => void decide("approved")}>
                  Approve
                </Button>
              )}
            </>
          )}
        </div>
        {decides && approveWhy && (
          <p className="mt-1 text-sm text-text2" data-testid="approve-why">
            {approveWhy}
          </p>
        )}
      </div>
    </Page>
  );
}

/** The selected feature's brief, and its choices (staged, or suggested by a commenter). */
function BriefInspector({
  feature: f,
  codeMap,
  acts,
  stages,
  suggests,
  busy,
  onAct,
  onStage,
  drafts,
  onDraft,
  onAsk,
}: {
  feature: Feature;
  codeMap: boolean;
  acts: Action[];
  stages: boolean;
  suggests: boolean;
  busy: boolean;
  onAct: (body: ActIn) => Promise<boolean>;
  onStage: (id: string) => Promise<boolean>;
  /** The answers being typed, by `${feature}:${question}` (kept by the screen, never reset by a save). */
  drafts: Record<string, string>;
  onDraft: (questionId: string, text: string) => void;
  onAsk: (text: string) => void;
}) {
  const writes = stages || suggests;
  const verdict = edit(acts, "verdict");
  const current = verdict?.value as { verdict: Verdict; note?: string | null } | undefined;
  const [picking, setPicking] = useState<Verdict | null>(null);
  const [text, setText] = useState("");
  // The answered questions whose box is open again (Edit).
  const [editing, setEditing] = useState<Record<string, boolean>>({});
  const draftOf = (qid: string) => drafts[`${f.key}:${qid}`] ?? "";
  const size = (edit(acts, "size")?.value as string | undefined) ?? f.size;
  const need = VERDICTS.find((v) => v.value === picking)?.needs;
  const suggestions = acts.filter((a) => a.state === "suggested");

  const pick = (v: Verdict) => {
    if (v === "feasible") {
      setPicking(null);
      void onAct({ item_key: f.key, kind: "edit", field: "verdict", value: { verdict: v, note: null } });
    } else {
      setPicking(v);
      setText(current?.verdict === v ? (current.note ?? "") : "");
    }
  };

  return (
    <Inspector eyebrow="Feature · selected" title={f.title} label={`Brief: ${f.title}`} testId="brief-inspector">
      <InspectorSection label="Approach">
        <p>{f.approach}</p>
        <p className="mt-1.5 text-sm text-text2">{codeMap ? "Code map used" : "No code map: assumptions"}</p>
        {f.depends_on.length > 0 && <p className="mt-1.5 text-sm text-text2">Depends on {f.depends_on.join(", ")}</p>}
      </InspectorSection>

      <InspectorSection label="Feasibility">
        {current && (
          <p className="mb-2" data-testid="verdict-now">
            <Chip kind={VERDICT_KIND[current.verdict]} wrap>
              {VERDICT_WORDS[current.verdict]}
              {verdict?.state === "suggested" ? " (suggested)" : ""}
            </Chip>
            {current.note && <span className="mt-1 block text-sm">{current.note}</span>}
          </p>
        )}
        {writes && (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Verdict">
            {VERDICTS.map((v) => (
              <Button key={v.value} variant={current?.verdict === v.value ? "primary" : "secondary"} disabled={busy} onClick={() => pick(v.value)}>
                {v.label}
              </Button>
            ))}
          </div>
        )}
        {writes && picking && need && (
          <div className="mt-2 space-y-1.5">
            <label className="block">
              <span className="mb-1 block text-sm font-semibold text-text2">{need}</span>
              <textarea className={`${INPUT} min-h-16`} aria-label={need} value={text} onChange={(e) => setText(e.target.value)} />
            </label>
            <div className="flex gap-1.5">
              <Button
                variant="primary"
                disabled={busy || !text.trim()}
                onClick={() => {
                  void onAct({ item_key: f.key, kind: "edit", field: "verdict", value: { verdict: picking, note: text.trim() } }).then((saved) => saved && setPicking(null));
                }}
              >
                Save verdict
              </Button>
              <Button variant="ghost" onClick={() => setPicking(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </InspectorSection>

      <InspectorSection label="Size">
        {writes ? (
          <SegmentedControl
            label="Size"
            size="sm"
            items={SIZES.map((s) => ({ value: s, label: s.toUpperCase() }))}
            value={size as (typeof SIZES)[number]}
            onChange={(s) => void onAct({ item_key: f.key, kind: "edit", field: "size", value: s })}
          />
        ) : (
          <span className="tnum font-semibold">{size.toUpperCase()}</span>
        )}
        <p className="mt-1 text-sm text-text2">The architect proposed {f.size.toUpperCase()}.</p>
      </InspectorSection>

      <InspectorSection label={`Questions (${f.questions.length})`}>
        {f.questions.length === 0 && <p className="text-text2">No questions.</p>}
        <ul className="space-y-3">
          {f.questions.map((q) => {
            const answer = edit(acts, `answer:${q.id}`);
            const open = writes && (!answer || editing[q.id]);
            return (
              <li key={q.id} data-testid="brief-question">
                <p>
                  {q.blocking && (
                    <Chip kind="crit" className="mr-1.5">
                      Blocking
                    </Chip>
                  )}
                  {q.question}
                </p>
                {answer && !open && (
                  <p className="mt-1 text-sm" data-testid="answer">
                    {String(answer.value)}{" "}
                    <span className="text-text2">
                      {answer.state === "suggested" ? "Suggested" : "Answered"} by {answer.updated_by?.name ?? answer.created_by?.name ?? "someone"}
                    </span>
                    {writes && (
                      <>
                        {" · "}
                        <button
                          type="button"
                          className="text-accent hover:underline"
                          aria-label={`Edit the answer: ${q.question}`}
                          onClick={() => {
                            onDraft(q.id, String(answer.value));
                            setEditing((all) => ({ ...all, [q.id]: true }));
                          }}
                        >
                          Edit
                        </button>
                      </>
                    )}
                  </p>
                )}
                {open && (
                  <div className="mt-1.5 flex gap-1.5">
                    <input
                      className={`${INPUT} h-9`}
                      aria-label={`Answer: ${q.question}`}
                      value={draftOf(q.id)}
                      onChange={(e) => onDraft(q.id, e.target.value)}
                    />
                    <Button
                      disabled={busy || !draftOf(q.id).trim()}
                      onClick={() =>
                        void onAct({ item_key: f.key, kind: "edit", field: `answer:${q.id}`, value: draftOf(q.id).trim() }).then((saved) => {
                          if (!saved) return;
                          onDraft(q.id, "");
                          setEditing((all) => ({ ...all, [q.id]: false }));
                        })
                      }
                    >
                      Answer
                    </Button>
                    {answer && (
                      <Button variant="ghost" onClick={() => setEditing((all) => ({ ...all, [q.id]: false }))}>
                        Cancel
                      </Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {stages && (
          <Button variant="ghost" className="mt-2" onClick={() => onAsk(`${f.title}: `)}>
            Ask the architect
          </Button>
        )}
      </InspectorSection>

      {suggestions.length > 0 && (
        <InspectorSection label="Suggested">
          <ul className="space-y-1.5">
            {suggestions.map((a) => (
              <li key={a.id} className="flex items-center gap-2" data-testid="suggestion">
                <span className="min-w-0 flex-1 truncate">
                  {a.field === "verdict" ? VERDICT_WORDS[(a.value as { verdict: Verdict }).verdict] : a.field === "size" ? `Size ${String(a.value).toUpperCase()}` : String(a.value)}
                  <span className="text-text2"> · {a.created_by?.name ?? "someone"}</span>
                </span>
                {stages && (
                  <Button disabled={busy} onClick={() => void onStage(a.id)}>
                    Stage
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </InspectorSection>
      )}
    </Inspector>
  );
}
