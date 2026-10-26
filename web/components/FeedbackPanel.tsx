"use client";

import Link from "next/link";
import { useEffect, useState, type MouseEvent, type ReactNode } from "react";

import { QUESTIONS_CHANGED } from "@/components/AskTeammate";
import { peopleByIds } from "@/components/PersonPicker";

import { SuggestionActions, SuggestionCard, SuggestionForm, useSuggestionDecision } from "@/components/SuggestionCard";
import { FeedbackStateChip } from "@/components/review/FeedbackState";
import { Button, Chip, Empty } from "@/components/ds";
import { FeedbackStatusChip, InlineError, Quote, VerdictChip } from "@/components/review/parts";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap, type FeedbackItem, type FeedbackStatus, type Schemas, type Suggestion } from "@/lib/api/client";
import { useMe } from "@/lib/me";
import { sectionHref } from "@/lib/section-link";
import { useQuery } from "@/lib/use-query";
import { invalidateWaiting, waitingChanged } from "@/lib/waiting";

/** C5: an item made from an answer given after drafting started links back to its question on the brief. */
export function FromQuestionLink({ item }: { item: FeedbackItem }) {
  if (!item.intake_id || !item.intake_question_id) return null;
  return (
    <Link
      href={`/intakes/${item.intake_id}#q-${item.intake_question_id}`}
      data-testid="feedback-from-question"
      className="mt-1 inline-block text-sm font-semibold text-accent-ink underline"
    >
      Open the question on the brief
    </Link>
  );
}

/** Where a row's section link goes: the section in this version, else the version it was raised on. */
export type GoTo = {
  /** Section keys of the version on screen. */
  keys: ReadonlySet<string>;
  /** Opens a section of the version on screen. */
  open: (key: string) => void;
  /** Section headings of the version on screen: "Go to 2.2 Evidence from support". */
  headings?: ReadonlyMap<string, string>;
};

function plainClick(e: MouseEvent) {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

/** "Go to <section>": the one section link (sectionHref); opens it here when this version has it. */
export function SectionLink({ item, doc, current, goTo }: { item: FeedbackItem; doc: string; current: number; goTo?: GoTo }) {
  const key = item.section_key!;
  const here = !!goTo?.keys.has(key);
  const n = here ? current : item.raised_on_version;
  const heading = here ? goTo?.headings?.get(key) : undefined;
  return (
    <Link
      href={sectionHref(doc, n, key)}
      data-section-link={key}
      data-testid="feedback-goto"
      data-own-nav
      title={heading ?? `§${key}`}
      onClick={(e) => {
        if (!here || !plainClick(e)) return;
        e.preventDefault();
        goTo!.open(key);
      }}
      className="inline-flex h-7 min-w-0 items-center gap-1 text-sm font-semibold text-accent-ink hover:underline"
    >
      <span className="min-w-0 truncate">
        Go to {heading ?? <span className="font-mono text-[13px] font-medium">§{key}</span>}
      </span>
      {n !== current && <span className="flex-none">(v{n})</span>}
    </Link>
  );
}

/**
 * Resolve and Reopen for an item without an open suggestion; a comment's thread follows
 * its item, as the Comments tab shows it.
 */
export function useTriage(item: FeedbackItem, onChanged?: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function set(status: "addressed" | "open") {
    setBusy(true);
    setError(null);
    try {
      await unwrap(
        api.PATCH("/v1/feedback/{feedback_id}", {
          params: { path: { feedback_id: item.id } },
          body: { status },
        }),
      );
      if (item.comment_id) {
        await unwrap(
          api.PATCH("/v1/comments/{comment_id}", {
            params: { path: { comment_id: item.comment_id } },
            body: { resolved: status === "addressed" },
          }),
        );
      }
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, set };
}

function FeedbackRow({
  item,
  doc,
  current,
  goTo,
  onChanged,
}: {
  item: FeedbackItem;
  doc: string;
  current: number;
  goTo?: GoTo;
  onChanged?: () => void;
}) {
  const { can } = useMe();
  // #370: triage (PATCH /v1/feedback) and the suggestion's accept/dismiss.
  const canDecide = can("update_feedback") && !!onChanged;
  return item.suggestion ? (
    <SuggestionRow item={item} suggestion={item.suggestion} doc={doc} current={current} goTo={goTo} canDecide={canDecide} onChanged={onChanged} />
  ) : (
    <PlainRow item={item} doc={doc} current={current} goTo={goTo} canDecide={canDecide} onChanged={onChanged} />
  );
}

type RowProps = { item: FeedbackItem; doc: string; current: number; goTo?: GoTo; canDecide: boolean; onChanged?: () => void };

function SuggestionRow({ suggestion, ...props }: RowProps & { suggestion: Suggestion }) {
  // Remounts when the suggestion changes, so the editor starts from the saved text.
  return <SuggestionRowInner key={`${suggestion.id}|${suggestion.updated_at}`} suggestion={suggestion} {...props} />;
}

function SuggestionRowInner({ item, suggestion, doc, current, goTo, canDecide, onChanged }: RowProps & { suggestion: Suggestion }) {
  const d = useSuggestionDecision(suggestion, () => onChanged?.());
  // Decided (or nothing to decide): the item itself is resolved or reopened.
  const open = suggestion.status === "open" && item.status === "open";
  return (
    <Row
      item={item}
      doc={doc}
      current={current}
      goTo={goTo}
      // C1e: a staged item is decided; it waits for "Build draft" in the page header.
      actions={
        canDecide &&
        (open ? (
          <>
            <SuggestionActions d={d} />
            <StageForAgents item={item} onChanged={onChanged} />
          </>
        ) : (
          (item.state !== "staged" || item.staged_for_agents) && <TriageActions item={item} onChanged={onChanged} />
        ))
      }
      form={canDecide && open && <SuggestionForm d={d} />}
    >
      <SuggestionCard suggestion={suggestion} canDecide={canDecide} editing={d.mode === "edit"} />
    </Row>
  );
}

function PlainRow({ item, doc, current, goTo, canDecide, onChanged }: RowProps) {
  return <Row item={item} doc={doc} current={current} goTo={goTo} actions={canDecide && <TriageActions item={item} onChanged={onChanged} />} />;
}

/**
 * D12: an open item with no section text to accept (its suggestion is an answer, none,
 * dismissed or absent, or a whole-draft remark) can be staged for the agents.
 */
export function canStageForAgents(item: FeedbackItem): boolean {
  if (item.status !== "open") return false;
  if (item.staged_for_agents) return true;
  if (item.state === "staged") return false;
  const s = item.suggestion;
  if (s?.kind === "duplicate" && s.status === "open") return false;
  return !(s && s.kind === "section_text" && (s.status === "open" || s.status === "accepted"));
}

/** Stage for agents / Unstage: the next draft goes to the agents with the item. */
export function StageForAgents({ item, onChanged }: { item: FeedbackItem; onChanged?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!canStageForAgents(item)) return null;
  const on = !item.staged_for_agents;
  async function act() {
    setBusy(true);
    setError(null);
    try {
      const params = { params: { path: { feedback_id: item.id } } };
      await unwrap(
        on
          ? api.POST("/v1/feedback/{feedback_id}/stage-for-agents", params)
          : api.DELETE("/v1/feedback/{feedback_id}/stage-for-agents", params),
      );
      invalidateWaiting();
      waitingChanged();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button variant={on ? "secondary" : "ghost"} icon={on ? "doc" : undefined} disabled={busy} onClick={act}>
        {on ? "Stage for agents" : "Unstage"}
      </Button>
      {error && <InlineError>{error}</InlineError>}
    </>
  );
}

/** "Staged for draft N · agents" on an item staged for the agents. */
export function AgentStagedNote({ item }: { item: FeedbackItem }) {
  if (!item.staged_for_agents) return null;
  return (
    <p className="mt-1.5 text-sm font-semibold text-text2" data-testid="agent-staged">
      Staged for draft {item.staged_for_version} · agents
    </p>
  );
}

export function TriageActions({ item, onChanged }: { item: FeedbackItem; onChanged?: () => void }) {
  const t = useTriage(item, onChanged);
  if (item.status === "superseded") return null;
  return (
    <>
      {item.staged_for_agents ? null : item.status === "open" ? (
        <Button variant="solid" icon="check" disabled={t.busy} onClick={() => t.set("addressed")}>
          Resolve
        </Button>
      ) : (
        <Button disabled={t.busy} onClick={() => t.set("open")}>
          Reopen
        </Button>
      )}
      <StageForAgents item={item} onChanged={onChanged} />
      {t.error && <InlineError>{t.error}</InlineError>}
    </>
  );
}

/** One feedback item: its section link and actions on top, then what it says. */
function Row({
  item,
  doc,
  current,
  goTo,
  actions,
  form,
  children,
}: {
  item: FeedbackItem;
  doc: string;
  current: number;
  goTo?: GoTo;
  actions?: ReactNode;
  form?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li
      className="scroll-mt-16 border-b border-line py-3 last:border-b-0"
      data-testid="feedback-item"
      data-feedback-id={item.id}
      data-status={item.status}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {item.section_key && <SectionLink item={item} doc={doc} current={current} goTo={goTo} />}
        <FeedbackStateChip item={item} />
        {item.verdict ? <VerdictChip verdict={item.verdict} /> : <Chip kind="line">{item.kind === "comment" ? "Comment" : "General"}</Chip>}
        <span className="tnum ml-auto text-[13px] text-text2">
          raised on v{item.raised_on_version}
        </span>
      </div>
      {actions && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="feedback-actions">
          {actions}
        </div>
      )}
      {form}
      <p className="mt-1.5 text-[15px] leading-[22px] text-text">{item.summary}</p>
      <FromQuestionLink item={item} />
      <AgentStagedNote item={item} />
      {item.anchor && <Quote>{item.anchor.exact}</Quote>}
      {item.resolution_note && (
        <p className="mt-1 text-sm leading-5 text-text2">
          <span className="font-semibold text-text">Resolution:</span> {item.resolution_note}
        </p>
      )}
      {children}
    </li>
  );
}

/** How this version handled feedback raised on earlier versions; `sectionKeys` keeps only those sections' items. */
export function ResolutionPanel({
  doc,
  n,
  refreshKey,
  sectionKeys,
  goTo,
}: {
  doc: string;
  n: number;
  refreshKey: number;
  sectionKeys?: ReadonlySet<string> | null;
  goTo?: GoTo;
}) {
  const q = useQuery(`${doc}|${n}|${refreshKey}`, () =>
    unwrap(api.GET("/v1/documents/{doc}/versions/{n}/resolution-report", { params: { path: { doc, n } } })),
  );
  if (q.error) return <ErrorNote>{q.error}</ErrorNote>;
  if (!q.data) return <Loading />;
  const items = sectionKeys
    ? q.data.items.filter((f) => !!f.section_key && sectionKeys.has(f.section_key))
    : q.data.items;
  if (items.length === 0) {
    return <Empty>No earlier feedback</Empty>;
  }
  const counts = sectionKeys
    ? items.reduce<Record<string, number>>((m, f) => ({ ...m, [f.status]: (m[f.status] ?? 0) + 1 }), {})
    : q.data.counts;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-3">
        {Object.entries(counts).map(([s, count]) => (
          <span key={s} className="tnum inline-flex items-center gap-1.5 text-sm font-bold">
            <FeedbackStatusChip status={s as FeedbackStatus} /> {count}
          </span>
        ))}
      </div>
      <ol className="flex flex-col">
        {items.map((f) => (
          <FeedbackRow key={f.id} item={f} doc={doc} current={n} goTo={goTo} />
        ))}
      </ol>
    </div>
  );
}

/** What became of an asked question, in the asker's words. */
const ANSWER_KIND: Record<Schemas["AnswerIn"]["kind"], string> = {
  answer: "Answered",
  dont_know: "Doesn't know",
  defer: "Deferred",
  delegate: "Asked someone else",
  research: "Research proposed",
};

type SectionQuestion = { q: Schemas["StakeholderQuestionOut"]; answer: Schemas["StakeholderAnswerOut"] | null };

/**
 * The questions asked about these sections (C2), on the Feedback tab: who it waits on
 * ("Waiting on <name>") or the answer and who gave it. Reads again when a question is asked
 * here (AskTeammate) or the panel reopens.
 */
export function SectionQuestions({ documentId, sectionKeys }: { documentId: string; sectionKeys: ReadonlySet<string> }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const again = () => setTick((t) => t + 1);
    window.addEventListener(QUESTIONS_CHANGED, again);
    return () => window.removeEventListener(QUESTIONS_CHANGED, again);
  }, []);
  const keys = [...sectionKeys].sort().join(",");
  const q = useQuery(`section-questions|${documentId}|${keys}|${tick}`, async () => {
    const rows = await unwrap(api.GET("/v1/questions", { params: { query: { document_id: documentId, limit: 500 } } }));
    const mine = rows.filter((x) => !!x.section_key && sectionKeys.has(x.section_key) && x.status !== "draft" && x.status !== "withdrawn");
    const answers = await Promise.all(
        mine.map((x) =>
          x.status === "asked" || x.status === "delegated"
            ? Promise.resolve([])
            : unwrap(api.GET("/v1/answers", { params: { query: { question_id: x.id, limit: 20 } } })),
        ),
    );
    const people = await peopleByIds([...mine.map((x) => x.asked_to), ...answers.flat().map((a) => a.answered_by)]);
    const names = new Map([...people].map(([id, p]) => [id, p.name]));
    return {
      names,
      rows: mine.map((x, i): SectionQuestion => ({ q: x, answer: answers[i].find((a) => a.kind !== "delegate") ?? answers[i][0] ?? null })),
    };
  });
  if (q.error) return <ErrorNote>{q.error}</ErrorNote>;
  if (!q.data || q.data.rows.length === 0) return null;
  const name = (id: string | null | undefined) => (id && q.data!.names.get(id)) || "someone";
  return (
    <section aria-label="Questions" data-testid="section-questions" className="mb-3 border-b border-line pb-2">
      <h3 className="text-[13px] leading-4 font-semibold tracking-[0.02em] text-text2">Questions</h3>
      <ol className="flex flex-col">
        {q.data.rows.map(({ q: x, answer }) => (
          <li key={x.id} data-testid="section-question" data-status={x.status} className="border-b border-line py-2.5 last:border-b-0">
            <p className="text-[15px] leading-[22px] text-text">{x.prompt}</p>
            {x.status === "asked" || x.status === "delegated" ? (
              <p className="mt-1">
                <Chip kind="warn">Waiting on {name(x.asked_to)}</Chip>
              </p>
            ) : (
              <p className="mt-1 text-sm leading-5 text-text2">
                <span className="font-semibold text-text">
                  {answer ? ANSWER_KIND[answer.kind] : "Answered"} by {name(answer?.answered_by)}
                  {answer?.body ? ":" : ""}
                </span>{" "}
                {answer?.body}
              </p>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
