"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { Button, Chip, Icon, Inspector, InspectorSection, Page, PageHeader, Sheet, Split } from "@/components/ds";
import { RawFileSheet } from "@/components/review/RawFileSheet";
import { ErrorNote, INPUT } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatDay } from "@/lib/format";
import { errorMessage } from "@/lib/use-query";

import type { CheckpointOut, DatesCheck, RunOut } from "../../../_lib";

type Review = Schemas["CheckpointReview"];
type Action = Review["items"][number]["actions"][number];
type Item = DatesCheck["items"][number];
type Basis = NonNullable<Item["proposed"]>;
type ActIn = Omit<Schemas["ActionIn"], "answers">;
type Decision = { word: "Accepted" | "Changed" | "No date"; basis: Basis | null; reason: string | null; action: Action };

const BASIS_KINDS: { value: Basis["kind"]; label: string }[] = [
  { value: "estimate", label: "Estimate" },
  { value: "capacity", label: "Capacity plan" },
  { value: "commitment", label: "Commitment" },
];
const CONFIDENCE_WORDS = { low: "Low", medium: "Medium", high: "High" } as const;
const HORIZON_WORDS = { next: "Next", later: "Later" } as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "Nov 30 · est-shipping-step": a basis as the row shows it (a calendar day, no time zone). */
const basisWords = (b: Basis) => `${DATE_RE.test(b.supports_date) ? formatDay(b.supports_date) : b.supports_date} · ${b.reference}`;

/** A decision action of the date stop: Accept, a changed estimate, or No date. */
const isDecision = (a: Action) => a.kind === "accept" || (a.kind === "edit" && (a.field === "estimate" || a.field === "no_date"));

/** The item's choice in `acts` (the latest), as the Decision column words it. */
function decisionOf(item: Item, acts: Action[]): Decision | null {
  const latest = acts.filter(isDecision).sort((a, b) => (a.updated_at ?? "").localeCompare(b.updated_at ?? "")).pop();
  if (!latest) return null;
  if (latest.kind === "accept") return { word: "Accepted", basis: item.proposed, reason: null, action: latest };
  if (latest.field === "estimate") return { word: "Changed", basis: latest.value as Basis, reason: null, action: latest };
  return { word: "No date", basis: null, reason: (latest.value as { reason?: string } | null)?.reason ?? null, action: latest };
}

const DECISION_KIND = { Accepted: "pass", Changed: "acc", "No date": "na" } as const;

/**
 * F4 lane B, the Engineering dates (`eng_dates`): after the PRD review, one row per Now item of
 * the draft's roadmap. The engineering lead (and owners; approvers while no lead is named)
 * accepts each proposed date, changes it (another estimate, capacity plan or commitment) or
 * records No date with a reason; each choice is a D8 action, so nothing is lost on refresh.
 * Approve opens once every proposed date is decided (D3, never waived). Next and Later items
 * carry no dates (O4) and are read-only here.
 */
export function EngDates({
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
  check: DatesCheck;
  review: Review;
  back: ReactNode;
  onReview: (out: Review) => void;
  onDecided: () => Promise<void>;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState(check.items[0]?.key ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(review.note ?? "");
  const [sending, setSending] = useState(false);
  const [changing, setChanging] = useState<Item | null>(null);
  const [noDate, setNoDate] = useState<Item | null>(null);
  const [raw, setRaw] = useState(false);
  const [more, setMore] = useState<string | null>(null);
  const pending = cp.status === "pending";
  const stages = pending && review.can_stage;
  // Choices from whoever does not stage are suggestions a decider stages (AC6): the review's
  // own can_suggest says who may suggest, as the Engineering check reads it.
  const suggests = pending && !stages && review.can_suggest;
  const writes = stages || suggests;
  const decides = pending && review.can_decide;
  const path = { params: { path: { run_id: run.id, checkpoint_id: cp.id } } };

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
  const ask = (item: Item) => {
    setMore(null);
    setNote((n) => (n.trim() ? `${n.trim()}\n${item.title}: ` : `${item.title}: `));
    setSending(true);
  };

  const actsOf = (key: string) => review.items.find((i) => i.key === key)?.actions ?? [];
  const stagedOf = (key: string) => actsOf(key).filter((a) => a.state === "staged");
  const left = review.gate?.left ?? [];
  const reasonsOf = (key: string) => left.filter((x) => x.item === key);
  const toDecide = left.filter((x) => x.code === "date_undecided").length;
  const decidedKeys = check.items.filter((i) => decisionOf(i, stagedOf(i.key))).map((i) => i.key);
  // Only a proposed date needs a choice; an undated item counts once someone gave it one.
  const total = check.items.filter((i) => i.proposed || decidedKeys.includes(i.key)).length;
  const gateOpen = !!review.gate?.open;
  const staged = review.items.flatMap((i) => i.actions.filter((a) => a.state === "staged"));
  const item = check.items.find((i) => i.key === selected) ?? null;
  const seq = cp.segment_seq ?? 1;
  // Only who can decide: the engineering lead once one is named, else the stop's role.
  const waitsFor = cp.lead_stop ? "Waits for the engineering lead" : `Waits for an ${cp.approver_role}`;
  const tally = `${decidedKeys.length} of ${total} decided${toDecide ? ` · ${toDecide} to decide` : ""}`;
  const approveWhy = !gateOpen
    ? check.problems.length
      ? "The dates file could not be read: send it back to the architect"
      : "Accept, change or mark No date on each proposed date first"
    : null;
  const nextCount = check.others.filter((o) => o.horizon === "next").length;
  const laterCount = check.others.filter((o) => o.horizon === "later").length;
  const grid = "grid-cols-[minmax(0,1.6fr)_56px_minmax(0,1.3fr)_92px_minmax(0,1.5fr)_minmax(0,1.3fr)]";

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
      {check.prd && (
        <p className="mb-3 text-text2" data-testid="dates-prd">
          The Now items of {check.prd.document} v{check.prd.version}
        </p>
      )}
      {check.problems.length > 0 && (
        <div role="alert" data-testid="dates-problem" className="mb-4 rounded-panel border border-crit bg-crit-soft px-4 py-3 text-[15px]">
          <p className="font-semibold">The dates file could not be read: send it back to the architect.</p>
          <ul className="mt-1 list-disc pl-5">
            {check.problems.map((p, i) => (
              <li key={i}>{p.message}</li>
            ))}
          </ul>
          <Button icon="doc" className="mt-2" onClick={() => setRaw(true)}>
            Raw file
          </Button>
          <RawFileSheet open={raw ? "file" : null} onClose={() => setRaw(false)} runId={run.id} seq={seq} name="eng_dates.yaml" />
        </div>
      )}
      <Split
        inspector={
          item && (
            <DatesInspector
              key={item.key}
              item={item}
              acts={actsOf(item.key)}
              stages={stages}
              busy={busy}
              onStage={stage}
              onAsk={stages ? () => ask(item) : undefined}
            />
          )
        }
      >
        <section aria-label="Now items" className="min-w-0 rounded-panel border border-line bg-surface">
          <div className={`grid ${grid} gap-3 border-b border-line px-4 py-2 text-[13px] font-semibold tracking-[0.02em] text-text2 max-[900px]:hidden`}>
            <span>Item</span>
            <span>Size</span>
            <span>Proposed date</span>
            <span>Confidence</span>
            <span>Decision</span>
            <span>Needs you because</span>
          </div>
          <ul>
            {check.items.map((i) => {
              const d = decisionOf(i, stagedOf(i.key));
              const suggested = decisionOf(i, actsOf(i.key).filter((a) => a.state === "suggested"));
              const reasons = reasonsOf(i.key);
              return (
                <li
                  key={i.key}
                  data-testid="date-row"
                  data-item={i.key}
                  aria-current={i.key === selected ? "true" : undefined}
                  className={`grid ${grid} items-start gap-3 border-b border-line px-4 py-3 last:border-b-0 max-[900px]:grid-cols-1 max-[900px]:gap-1.5 max-[600px]:m-2 max-[600px]:rounded-panel max-[600px]:border ${
                    i.key === selected ? "bg-accent-soft" : ""
                  }`}
                >
                  <button type="button" className="min-w-0 text-left hover:underline" onClick={() => setSelected(i.key)}>
                    <span className="block font-semibold">{i.title}</span>
                    {i.section && <span className="block text-sm text-text2">PRD section {i.section}</span>}
                  </button>
                  <span className="tnum font-semibold" data-testid="date-size">
                    <span className="mr-1 font-normal text-text2 min-[901px]:sr-only">Size</span>
                    {i.size ? i.size.toUpperCase() : "—"}
                  </span>
                  <span className="min-w-0 text-sm" data-testid="date-proposed">
                    {i.proposed ? basisWords(i.proposed) : <span className="text-text2">No date proposed</span>}
                    {d?.word === "Changed" && d.basis && <span className="block font-semibold">Now {basisWords(d.basis)}</span>}
                    {!i.proposed && i.no_date_reason && !d && <span className="block text-text2">{i.no_date_reason}</span>}
                  </span>
                  <span className="text-sm" data-testid="date-confidence">
                    <span className="mr-1 text-text2 min-[901px]:sr-only">Confidence</span>
                    {i.confidence ? CONFIDENCE_WORDS[i.confidence] : "—"}
                  </span>
                  <span className="flex min-w-0 flex-col gap-1.5">
                    <span data-testid="date-decision">
                      {d ? (
                        <Chip kind={DECISION_KIND[d.word]} wrap>
                          {d.word}
                        </Chip>
                      ) : i.proposed ? (
                        <span className="font-semibold text-text2">Decide</span>
                      ) : (
                        <Chip kind="na">No date</Chip>
                      )}
                    </span>
                    {d?.reason && <span className="text-sm text-text2">{d.reason}</span>}
                    {!d && suggested && (
                      <span className="text-sm text-text2" data-testid="date-suggested">
                        {suggested.word} (suggested)
                      </span>
                    )}
                    {writes && (
                      <span className="flex flex-wrap items-center gap-1.5" role="group" aria-label={`Date: ${i.title}`}>
                        {i.proposed && (
                          <Button disabled={busy} onClick={() => void act({ item_key: i.key, kind: "accept", value: null })}>
                            Accept
                          </Button>
                        )}
                        <Button disabled={busy} onClick={() => setChanging(i)}>
                          Change
                        </Button>
                        <Button disabled={busy} onClick={() => setNoDate(i)}>
                          No date
                        </Button>
                        {stages && (
                          <span className="relative">
                            <Button
                              variant="ghost"
                              aria-label={`More for ${i.title}`}
                              aria-expanded={more === i.key}
                              onClick={() => setMore((m) => (m === i.key ? null : i.key))}
                            >
                              {/* An icon, as the shell's More: a text glyph (⋯) needs a font that has it, and without one Chromium crashed the lead's screen. */}
                              <Icon name="more" size={16} />
                            </Button>
                            {more === i.key && (
                              <span className="absolute top-full right-0 z-20 mt-1 rounded-button border border-line bg-surface p-1 shadow-tip">
                                <Button variant="ghost" className="whitespace-nowrap" onClick={() => ask(i)}>
                                  Ask the architect
                                </Button>
                              </span>
                            )}
                          </span>
                        )}
                      </span>
                    )}
                  </span>
                  <span className="flex min-w-0 flex-wrap gap-1.5" data-testid="date-reasons">
                    {reasons.map((x, n) => (
                      <Chip key={`${x.code}-${n}`} kind={x.code === "date_beyond_now" ? "warn" : "crit"} wrap>
                        {x.label}
                      </Chip>
                    ))}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
        {check.others.length > 0 && (
          <details className="mt-3 rounded-panel border border-line bg-surface" data-testid="dates-others">
            <summary className="cursor-pointer px-4 py-2.5 font-semibold">
              {[nextCount ? `Next ${nextCount}` : null, laterCount ? `Later ${laterCount}` : null].filter(Boolean).join(" · ")} · no dates (O4 Roadmap shape)
            </summary>
            <ul className="border-t border-line">
              {check.others.map((o) => (
                <li key={o.key} className="flex items-center gap-2 border-b border-line px-4 py-2 last:border-b-0" data-testid="dates-other">
                  <span className="min-w-0 flex-1">{o.title}</span>
                  <Chip kind="na">{HORIZON_WORDS[o.horizon]}</Chip>
                </li>
              ))}
            </ul>
          </details>
        )}
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
          <span className="tnum font-semibold" data-testid="dates-tally">
            {tally}
          </span>
          {staged.length > 0 && (
            <span className="flex min-w-0 flex-wrap gap-1.5" data-testid="staged-chips">
              <Chip kind="acc">
                {staged.length} change{staged.length === 1 ? "" : "s"} staged
              </Chip>
            </span>
          )}
          <span className="flex-1" />
          {decides && (
            <>
              <Button
                variant="ghost"
                disabled={busy || (sending && !note.trim())}
                onClick={() => (sending ? void decide("changes_requested") : setSending(true))}
              >
                Send back to architect
              </Button>
              <Button variant="primary" disabled={busy || !gateOpen} title={approveWhy ?? undefined} onClick={() => void decide("approved")}>
                Approve
              </Button>
            </>
          )}
        </div>
        {decides && approveWhy && (
          <p className="mt-1 text-sm text-text2" data-testid="approve-why">
            {approveWhy}
          </p>
        )}
      </div>

      {changing && (
        <ChangeSheet
          item={changing}
          current={decisionOf(changing, stagedOf(changing.key))?.basis ?? changing.proposed}
          busy={busy}
          error={error}
          onClose={() => setChanging(null)}
          onSave={(basis) => void act({ item_key: changing.key, kind: "edit", field: "estimate", value: basis }).then((ok) => ok && setChanging(null))}
        />
      )}
      {noDate && (
        <NoDateSheet
          item={noDate}
          busy={busy}
          error={error}
          onClose={() => setNoDate(null)}
          onSave={(reason) => void act({ item_key: noDate.key, kind: "edit", field: "no_date", value: { reason } }).then((ok) => ok && setNoDate(null))}
        />
      )}
    </Page>
  );
}

/** Change: another basis for the item's date, pre-filled from the proposal (or the current choice). */
function ChangeSheet({
  item,
  current,
  busy,
  error,
  onClose,
  onSave,
}: {
  item: Item;
  current: Basis | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (basis: Basis) => void;
}) {
  const [kind, setKind] = useState<Basis["kind"]>(current?.kind ?? "estimate");
  const [reference, setReference] = useState(current?.reference ?? "");
  const [date, setDate] = useState(current?.supports_date ?? "");
  const ready = !!reference.trim() && DATE_RE.test(date);
  return (
    <Sheet open dialog title={`Change the date: ${item.title}`} onClose={onClose} testId="date-change">
      <form
        className="space-y-3 px-4 py-3 sm:w-[560px] sm:max-w-full"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) onSave({ kind, reference: reference.trim(), supports_date: date });
        }}
      >
        <label className="block">
          <span className="mb-1 block text-sm font-semibold text-text2">Kind</span>
          <select className={`${INPUT} h-10`} aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value as Basis["kind"])}>
            {BASIS_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-semibold text-text2">Reference</span>
          <input className={`${INPUT} h-10`} aria-label="Reference" value={reference} onChange={(e) => setReference(e.target.value)} />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-semibold text-text2">Date</span>
          <input type="date" className={`${INPUT} h-10`} aria-label="Date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="flex gap-1.5">
          <Button type="submit" variant="primary" disabled={busy || !ready}>
            Save date
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Sheet>
  );
}

/** No date: the item stays in Now without a date; a reason is required. */
function NoDateSheet({
  item,
  busy,
  error,
  onClose,
  onSave,
}: {
  item: Item;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <Sheet open dialog title={`No date: ${item.title}`} onClose={onClose} testId="date-none">
      <form
        className="space-y-3 px-4 py-3 sm:w-[560px] sm:max-w-full"
        onSubmit={(e) => {
          e.preventDefault();
          if (reason.trim()) onSave(reason.trim());
        }}
      >
        <label className="block">
          <span className="mb-1 block text-sm font-semibold text-text2">Reason: why no date yet</span>
          <textarea className={`${INPUT} min-h-16`} aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="flex gap-1.5">
          <Button type="submit" variant="primary" disabled={busy || !reason.trim()}>
            Save
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Sheet>
  );
}

/** The selected Now item: the architect's basis and assumptions, and suggestions to stage. */
function DatesInspector({
  item: i,
  acts,
  stages,
  busy,
  onStage,
  onAsk,
}: {
  item: Item;
  acts: Action[];
  stages: boolean;
  busy: boolean;
  onStage: (id: string) => Promise<boolean>;
  onAsk?: () => void;
}) {
  const suggestions = acts.filter((a) => a.state === "suggested" && isDecision(a));
  const words = (a: Action) => {
    const d = decisionOf(i, [a]);
    if (!d) return a.kind;
    if (d.word === "Changed" && d.basis) return `Change to ${basisWords(d.basis)}`;
    if (d.word === "No date") return `No date${d.reason ? `: ${d.reason}` : ""}`;
    return "Accept";
  };
  return (
    <Inspector eyebrow="Now item · selected" title={i.title} label={`Dates: ${i.title}`} testId="dates-inspector">
      <InspectorSection label="Proposed date">
        {i.proposed ? (
          <>
            <p className="font-semibold">{basisWords(i.proposed)}</p>
            <p className="mt-1 text-sm text-text2">{BASIS_KINDS.find((k) => k.value === i.proposed!.kind)?.label}</p>
          </>
        ) : (
          <p className="text-text2">No date proposed{i.no_date_reason ? `: ${i.no_date_reason}` : ""}</p>
        )}
      </InspectorSection>
      <InspectorSection label={`Assumptions (${i.assumptions.length})`}>
        {i.assumptions.length === 0 ? (
          <p className="text-text2">None.</p>
        ) : (
          <ul className="list-disc space-y-1 pl-5">
            {i.assumptions.map((x, n) => (
              <li key={n}>{x}</li>
            ))}
          </ul>
        )}
        {onAsk && (
          <Button variant="ghost" className="mt-2" onClick={onAsk}>
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
                  {words(a)}
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
