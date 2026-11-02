"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { Button, Chip, Page, PageHeader, SegmentedControl } from "@/components/ds";
import { ErrorNote, INPUT } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { errorMessage } from "@/lib/use-query";

import type { BriefsCheck, CheckpointOut, RunOut } from "../../../_lib";

type Review = Schemas["CheckpointReview"];
type Action = Review["items"][number]["actions"][number];
type Feature = BriefsCheck["features"][number];
type Reason = NonNullable<Review["gate"]>["left"][number];
type ActIn = Omit<Schemas["ActionIn"], "answers">;
type Verdict = "feasible" | "feasible_with_changes" | "not_feasible";

const SIZES = ["xs", "s", "m", "l", "xl"] as const;
const VERDICTS: { value: Verdict; label: string; needs?: string }[] = [
  { value: "feasible", label: "Feasible" },
  { value: "feasible_with_changes", label: "Feasible with changes", needs: "What changes" },
  { value: "not_feasible", label: "Not feasible as scoped", needs: "Why not as scoped" },
];
const VERDICT_WORDS: Record<Verdict, string> = { feasible: "Feasible", feasible_with_changes: "Feasible with changes", not_feasible: "Not feasible as scoped" };
const VERDICT_KIND = { feasible: "pass", feasible_with_changes: "warn", not_feasible: "crit" } as const;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** qa4-work-54: what a brief written without a code map means, in an owner's words. */
const NO_CODE_MAP = "Oracle could not read the code, so this approach is a guess";

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
  // On a phone the list comes first; a tapped feature fills the screen until All features.
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(review.note ?? "");
  const [sending, setSending] = useState(false);
  // Answers being typed, by feature and question: kept here, above the inspector, so a verdict
  // or size saved meanwhile (or another feature selected) never empties a box being typed in.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // The decision bar's height and where the list's top sits: the sticky list runs down to the
  // bar's top edge (as in the picked frame) at rest and once scrolled, and scrolls on its own,
  // so no row is ever under the bar (a click there would land on the bar).
  const barRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLElement>(null);
  const [barH, setBarH] = useState(72);
  const [listTop, setListTop] = useState(16);
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBarH(el.offsetHeight));
    ro.observe(el);
    const place = () => setListTop(Math.max(16, Math.round(listRef.current?.getBoundingClientRect().top ?? 16)));
    place();
    window.addEventListener("scroll", place, { passive: true });
    window.addEventListener("resize", place);
    return () => {
      ro.disconnect();
      window.removeEventListener("scroll", place);
      window.removeEventListener("resize", place);
    };
  }, []);
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
  const at = Math.max(0, check.features.findIndex((f) => f.key === selected));
  const feature = check.features[at] ?? null;
  const open = (key: string) => {
    setSelected(key);
    setReading(true);
  };
  const go = (i: number) => {
    const next = check.features[Math.min(check.features.length - 1, Math.max(0, i))];
    if (next) setSelected(next.key);
  };
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
      {!!check.unmapped_repos?.length && (
        <p data-testid="briefs-unmapped" className="mb-4 text-[15px] text-text2">
          No code map covers {check.unmapped_repos.join(", ")}: {check.unmapped_repos.length > 1 ? "their" : "its"} work is described as assumptions.
        </p>
      )}
      {check.unnamed_repo && (
        <p data-testid="briefs-unnamed" className="mb-4 text-[15px] text-text2">
          No code map of this run holds some cited ids, and the briefs do not say which repository they come from.
        </p>
      )}
      <div style={{ "--bar-h": `${barH}px`, "--list-top": `${listTop}px` } as CSSProperties} className="grid grid-cols-[300px_minmax(0,1fr)] items-start gap-4 max-[900px]:grid-cols-1">
        {/* EC1 b (owner, Nov 1): the features in a list that scrolls on its own, the picked one at reading width beside it. */}
        <section
          ref={listRef}
          aria-label="Features"
          data-testid="brief-list"
          className={`sticky top-4 max-h-[calc(100dvh_-_var(--bar-h,72px)_-_var(--list-top,16px))] min-w-0 overflow-y-auto overscroll-contain rounded-panel border border-line bg-surface max-[900px]:static max-[900px]:max-h-none ${
            reading ? "max-[900px]:hidden" : ""
          }`}
        >
          <div className="border-b border-line px-4 py-2 text-[13px] font-semibold text-text2">{plural(check.features.length, "feature")}</div>
          <ul>
            {check.features.map((f) => {
              const acts = actionsOf(review, f.key).filter((a) => a.state === "staged");
              const v = verdictOf(acts);
              const size = (edit(acts, "size")?.value as string | undefined) ?? f.size;
              const confirm = f.depends_on.some((d) => notFeasible.has(d)) ? "Depends on a feature judged not feasible" : null;
              return (
                <li key={f.key} data-testid="brief-row" data-feature={f.key} aria-current={f.key === selected ? "true" : undefined}>
                  <button
                    type="button"
                    onClick={() => open(f.key)}
                    className={`block w-full border-b border-line px-4 py-2.5 text-left hover:bg-surface2 ${
                      f.key === selected ? "bg-accent-soft shadow-[inset_3px_0_0_var(--color-accent)] hover:bg-accent-soft" : ""
                    }`}
                  >
                    <span className="flex items-baseline gap-2">
                      {/* The feature's name; its key shows in small type in the pane, by its title. */}
                      <span className="min-w-0 flex-1 font-semibold [overflow-wrap:anywhere]">{f.title}</span>
                      <span className="tnum text-sm font-semibold text-text2" data-testid="brief-size">
                        <span className="sr-only">Size </span>
                        {size.toUpperCase()}
                      </span>
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-1.5">
                      <span className="flex" data-testid="brief-verdict">
                        {v ? (
                          <Chip kind={VERDICT_KIND[v.verdict]} wrap>
                            {VERDICT_WORDS[v.verdict]}
                          </Chip>
                        ) : (
                          <span className="text-sm text-text2">Not decided</span>
                        )}
                      </span>
                      <QuestionCount feature={f} acts={acts} reasons={reasonsOf(f.key)} />
                      <Reasons reasons={reasonsOf(f.key)} confirm={confirm} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
        {feature && (
          <BriefPane
            key={feature.key}
            feature={feature}
            at={at}
            count={check.features.length}
            onGo={(i) => go(i)}
            onList={() => setReading(false)}
            reading={reading}
            codeMap={check.code_map_used}
            titleOf={(key) => check.features.find((x) => x.key === key)?.title ?? key.replace(/^f\./, "").replace(/[-_]+/g, " ")}
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
        )}
      </div>

      <div
        ref={barRef}
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

/** A list row's questions: the blocking ones the gate still holds Approve on, in its words, and how many are answered. */
function QuestionCount({ feature: f, acts, reasons }: { feature: Feature; acts: Action[]; reasons: Reason[] }) {
  if (!f.questions.length) return null;
  const answered = f.questions.filter((q) => edit(acts, `answer:${q.id}`)).length;
  const blocking = reasons.filter((x) => x.code === "blocking_question");
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-sm" data-testid="brief-questions">
      {blocking.length > 0 && (
        <Chip kind="crit" title={blocking[0].label}>
          {blocking.length} blocking
        </Chip>
      )}
      <span className="whitespace-nowrap text-text2">
        {answered} of {f.questions.length} answered
      </span>
    </span>
  );
}

/** The gate's other reasons for a row (Not decided and the blocking chip say the rest), and a warning to confirm. */
function Reasons({ reasons, confirm }: { reasons: Reason[]; confirm: string | null }) {
  const labels = [...new Set(reasons.filter((x) => x.code !== "no_verdict" && x.code !== "blocking_question").map((x) => x.label))];
  if (!labels.length && !confirm) return null;
  return (
    <span className="inline-flex flex-wrap gap-1.5" data-testid="brief-reasons">
      {labels.map((l) => (
        <Chip key={l} kind="crit" wrap>
          {l}
        </Chip>
      ))}
      {confirm && (
        <Chip kind="warn" wrap>
          {confirm}
        </Chip>
      )}
    </span>
  );
}

function PaneSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="border-b border-line px-6 py-3.5 last:border-b-0 max-[600px]:px-4">
      <h3 className="mb-2 text-[13px] font-semibold tracking-[0.02em] text-text2">{label}</h3>
      {children}
    </section>
  );
}

/**
 * The selected feature at reading width: verdict and size on top, the architect's questions
 * right under them (EC2 b, owner Nov 1), then the whole approach.
 */
function BriefPane({
  feature: f,
  at,
  count,
  onGo,
  onList,
  reading,
  codeMap,
  titleOf,
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
  at: number;
  count: number;
  onGo: (index: number) => void;
  onList: () => void;
  /** On a phone, whether the pane shows (the list shows otherwise). */
  reading: boolean;
  codeMap: boolean;
  titleOf: (key: string) => string;
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
  // The answered questions whose box is open again (Change).
  const [editing, setEditing] = useState<Record<string, boolean>>({});
  const draftOf = (qid: string) => drafts[`${f.key}:${qid}`] ?? "";
  const size = (edit(acts, "size")?.value as string | undefined) ?? f.size;
  const need = VERDICTS.find((v) => v.value === picking)?.needs;
  const suggestions = acts.filter((a) => a.state === "suggested");
  const answered = f.questions.filter((q) => edit(acts, `answer:${q.id}`)).length;
  // The picked verdict is filled in as soon as it is clicked, before its note is saved.
  const shown = picking ?? current?.verdict ?? null;

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
    <article
      className={`min-w-0 rounded-panel border border-line bg-surface ${reading ? "" : "max-[900px]:hidden"}`}
      data-testid="brief-inspector"
      aria-label={`Brief: ${f.title}`}
    >
      <header className="flex items-start gap-3 border-b border-line px-6 py-4 max-[600px]:px-4">
        <div className="min-w-0 flex-1">
          <button type="button" className="mb-1 text-sm font-semibold text-accent min-[901px]:hidden" onClick={onList}>
            ‹ All features
          </button>
          <div className="text-[13px] font-semibold text-text2" data-testid="brief-position">
            Feature {at + 1} of {count}
            <span className="ml-2 font-mono font-normal [overflow-wrap:anywhere]">{f.key}</span>
          </div>
          <h2 className="font-display text-[22px] leading-7 font-bold">{f.title}</h2>
        </div>
        <div className="flex flex-none gap-1.5">
          <Button variant="secondary" disabled={at === 0} onClick={() => onGo(at - 1)} aria-label="Previous feature">
            ‹
          </Button>
          <Button variant="secondary" disabled={at === count - 1} onClick={() => onGo(at + 1)} aria-label="Next feature">
            ›
          </Button>
        </div>
      </header>

      <section data-testid="decide" className="border-b border-line bg-surface2 px-6 py-3.5 max-[600px]:px-4">
        <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
          <div>
            <div className="mb-1.5 text-[13px] font-semibold text-text2">Verdict</div>
            {writes ? (
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Verdict">
                {VERDICTS.map((v) => (
                  <Button key={v.value} variant={shown === v.value ? "solid" : "secondary"} aria-pressed={shown === v.value} disabled={busy} onClick={() => pick(v.value)}>
                    {v.label}
                  </Button>
                ))}
              </div>
            ) : (
              !current && <span className="text-sm text-text2">Not decided</span>
            )}
          </div>
          <div>
            <div className="mb-1.5 text-[13px] font-semibold text-text2">Size</div>
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
            <div className="mt-1 text-[12px] text-text2">Architect proposed {f.size.toUpperCase()}</div>
          </div>
        </div>
        {current && (verdict?.state === "suggested" || !writes) && (
          <p className="mt-2" data-testid="verdict-now">
            <Chip kind={VERDICT_KIND[current.verdict]} wrap>
              {VERDICT_WORDS[current.verdict]}
              {verdict?.state === "suggested" ? " (suggested)" : ""}
            </Chip>
          </p>
        )}
        {current?.note && !picking && (
          <p className="mt-2 text-sm" data-testid="verdict-note">
            <span className="font-semibold">{current.verdict === "not_feasible" ? "Why: " : "Changes: "}</span>
            {current.note}{" "}
            {writes && (
              <button type="button" className="font-semibold text-accent" onClick={() => pick(current.verdict)}>
                Change
              </button>
            )}
          </p>
        )}
        {writes && picking && need && (
          <div className="mt-2.5 max-w-[640px] space-y-1.5">
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
        {suggestions.length > 0 && (
          <div className="mt-3">
            <div className="mb-1 text-[13px] font-semibold text-text2">Suggested</div>
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
          </div>
        )}
      </section>

      <PaneSection label={f.questions.length ? `Architect's questions · ${answered} of ${f.questions.length} answered` : "Architect's questions"}>
        {f.questions.length === 0 && <p className="text-text2">None for this feature.</p>}
        {f.questions.length > 0 && (
          <ul className="max-w-[760px] space-y-2">
            {f.questions.map((q) => {
              const answer = edit(acts, `answer:${q.id}`);
              const open = writes && (!answer || editing[q.id]);
              const done = !!answer && !open;
              return (
                <li key={q.id} data-testid="brief-question" data-answered={answer ? "true" : "false"} className="rounded-md border border-line px-3 py-2.5">
                  <p className="flex items-start gap-1.5">
                    {done ? (
                      <span className="mt-0.5 text-pass" aria-label="Answered">
                        ✓
                      </span>
                    ) : q.blocking ? (
                      <Chip kind="crit">Blocking</Chip>
                    ) : (
                      <Chip kind="na">Question</Chip>
                    )}
                    <span className={done ? "text-text2" : "font-semibold"}>{q.question}</span>
                  </p>
                  {done && (
                    <p className="mt-1 ml-5 text-[15px]" data-testid="answer">
                      {String(answer.value)}{" "}
                      <span className="text-sm text-text2">
                        · {answer.state === "suggested" ? "Suggested by " : ""}
                        {answer.updated_by?.name ?? answer.created_by?.name ?? "someone"}
                      </span>{" "}
                      {writes && (
                        <button
                          type="button"
                          className="text-sm font-semibold text-accent"
                          aria-label={`Change the answer: ${q.question}`}
                          onClick={() => {
                            onDraft(q.id, String(answer.value));
                            setEditing((all) => ({ ...all, [q.id]: true }));
                          }}
                        >
                          Change
                        </button>
                      )}
                    </p>
                  )}
                  {open && (
                    <div className="mt-1.5 flex gap-1.5">
                      <input
                        className={`${INPUT} h-9`}
                        aria-label={`Answer: ${q.question}`}
                        placeholder="Your answer"
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
        )}
        {stages && (
          <Button className="mt-2" onClick={() => onAsk(`${f.title}: `)}>
            Ask the architect
          </Button>
        )}
      </PaneSection>

      <PaneSection label="Approach">
        <div className="max-w-[72ch] space-y-1.5 text-[15px] leading-6">
          {f.approach
            .split("\n")
            .filter((t) => t.trim())
            .map((t, i) => (
              <p key={i}>{t}</p>
            ))}
          {f.depends_on.length > 0 && <p className="text-sm text-text2">Depends on {f.depends_on.map(titleOf).join(", ")}</p>}
          {!codeMap && (
            <p className="text-sm text-text2" data-testid="brief-guess">
              {NO_CODE_MAP}
            </p>
          )}
        </div>
      </PaneSection>
    </article>
  );
}
