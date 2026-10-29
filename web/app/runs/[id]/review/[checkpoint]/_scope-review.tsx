"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { Button, Chip, FilterChips, Page, PageHeader, Ring, SegmentedControl, Sheet, Split } from "@/components/ds";
import { blockingLeftText, DecisionBar, type StagedChip } from "@/components/review/DecisionBar";
import { ErrorNote, INPUT, Loading } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";
import { invalidateWaiting, waitingChanged } from "@/lib/waiting";

import { draftKey, loadDraft } from "./_draft";
import type { ReviewViewProps } from "./_shell";
import { FixButtons, LeaveOutPicker, RequirementRow, ScopeInspector } from "./_scope-inspector";
import { runDocName } from "../../../_lib";

import { actionsOn, changeText, decisionText, describeAction, fixesFor, goalName, named, pct, reasonText, type Feature, type Mode, type Ops, type Reason, type Review, type Scope, type Ui } from "./_scope-lib";

type Filter = "needs" | "all" | "out" | "changed";
type Group = "goal" | "reason";

const REASON_CHIP: Record<string, string> = {
  depends_on_excluded: "Depends on a left-out feature",
  dependency_cycle: "Dependency cycle",
  unknown_goal: "Unknown goal",
  unknown_dependency: "Unknown dependency",
  unknown_blocker: "Unknown blocker",
  unknown_feature: "Unknown feature",
  unknown_requirement: "Unknown requirement",
  serves_no_goal: "No confirmed goal",
  low_confidence: "Low confidence",
  linked_blocker: "Linked open blocker",
  new_feature: "New, not in the baseline",
  duplicate_of_existing: "Duplicate",
};
const FILE_PROBLEMS = ["unreadable_yaml", "missing_file", "wrong_version", "wrong_document", "no_features"];
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const COLS = "grid-cols-[28px_28px_minmax(130px,1.5fr)_minmax(90px,1fr)_44px_48px_minmax(120px,1fr)_minmax(170px,1.6fr)]";

function usePhone(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 600px)");
    const on = () => setPhone(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return phone;
}

/** What differs from the previous attempt (the Changed filter's chips). */
function changedChips(f: Feature, scope: Scope): string[] {
  const prev = scope.previous;
  if (!prev) return [];
  if (!(f.key in prev)) return [`New in attempt ${scope.attempt}`];
  const out: string[] = [];
  if (prev[f.key] !== f.decision) out.push(prev[f.key] !== "include" && f.decision === "include" ? "Was left out" : "Decision changed");
  const kept = f.requirements.filter((q) => q.decision === "keep").map((q) => q.key).sort();
  const before = [...(scope.previous_requirements?.[f.key] ?? [])].sort();
  if (JSON.stringify(kept) !== JSON.stringify(before)) out.push("Requirements changed");
  return out;
}

const openReasons = (f: Feature): Reason[] => f.reasons.filter((r) => !r.answered);

/**
 * C7 Scope review: the feature set as rows a person decides. Approvers fix, leave out, edit,
 * add and enhance rows in place (each write re-checks the set and the bar follows); commenters
 * suggest (D8 "suggested"); viewers read. Approve with edits writes the edits without an agent
 * round; Send back carries them to the agents.
 */
export function ScopeReview({ run, cp, item, reloadRun }: ReviewViewProps) {
  const router = useRouter();
  const { can } = useMe();
  const phone = usePhone();
  const scopeQ = useQuery(`scope-review|${run.id}|${cp.id}`, async () => {
    const latest = await unwrap(api.GET("/v1/runs/{run_id}/scope", { params: { path: { run_id: run.id } } }));
    return unwrap(api.GET("/v1/prd-scopes/{scope_id}", { params: { path: { scope_id: latest.id } } }));
  });
  const path = { params: { path: { run_id: run.id, checkpoint_id: cp.id } } };
  const reviewQ = useQuery(draftKey(run.id, cp.id), () => loadDraft(run.id, cp.id));
  // rirs-2: rows the agents left untitled read as words, never as their keys.
  const scope = useMemo(() => (scopeQ.data ? named(scopeQ.data) : null), [scopeQ.data]);
  const review = reviewQ.data ?? null;
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("needs");
  const [group, setGroup] = useState<Group>("goal");
  const [selected, setSelected] = useState<string | null>(item);
  const [sheet, setSheet] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [leaveOut, setLeaveOut] = useState<{ key: string; where: "row" | "inspector"; preset?: string } | null>(null);
  const [waiving, setWaiving] = useState<{ key: string; code: string } | null>(null);
  const [goalsFor, setGoalsFor] = useState<string | null>(null);
  const [rawOpen, setRawOpen] = useState(false);

  // The rows that needed me before a change stay under Needs you, with their ✓.
  const [seen, setSeen] = useState<Set<string>>(new Set());

  const pending = cp.status === "pending" && scope?.status === "proposed";
  const mode: Mode = !pending
    ? "viewer"
    : // #370 fixes 4: scope.can_edit and review.can_suggest are the API's item answers (the
      // stop's role, a commenter); no second check of the signed-in role here.
      scope?.can_edit && can("patch_scope_item", scope.can_edit)
      ? "approver"
      : review?.can_suggest && can("create_checkpoint_action", review.can_suggest)
        ? "commenter"
        : "viewer";

  async function reload() {
    await Promise.all([scopeQ.reload(), reviewQ.reload()]);
  }
  async function write<T>(call: () => Promise<T>): Promise<T> {
    setError(null);
    const needed = (scope?.features ?? []).filter((f) => f.needs_you).map((f) => f.key);
    setSeen((x) => new Set([...x, ...needed]));
    try {
      const out = await call();
      await reload();
      return out;
    } catch (e) {
      setError(errorMessage(e));
      await reload();
      throw e;
    }
  }
  const scopeId = scope?.id ?? "";
  const ops: Ops = {
    patch: (row, body) =>
      write(() =>
        unwrap(api.PATCH("/v1/prd-scopes/{scope_id}/items/{item_id}", { params: { path: { scope_id: scopeId, item_id: row.id } }, body: { ...body, revert: body.revert ?? false, lock_version: row.lock_version } })),
      ).then(() => undefined),
    act: (body) => write(() => unwrap(api.POST("/v1/runs/{run_id}/checkpoints/{checkpoint_id}/actions", { ...path, body: { ...body, answers: body.answers ?? [] } }))).then(() => undefined),
    removeAction: (id) =>
      write(() => unwrap(api.DELETE("/v1/runs/{run_id}/checkpoints/{checkpoint_id}/actions/{action_id}", { params: { path: { run_id: run.id, checkpoint_id: cp.id, action_id: id } } }))).then(
        () => undefined,
      ),
    stage: (id) =>
      write(() => unwrap(api.POST("/v1/runs/{run_id}/checkpoints/{checkpoint_id}/actions/{action_id}/stage", { params: { path: { run_id: run.id, checkpoint_id: cp.id, action_id: id } } }))).then(
        () => undefined,
      ),
    add: async (parentId, text, acceptance) => {
      const parent = scope?.features.find((f) => f.id === parentId);
      await write(() => unwrap(api.POST("/v1/prd-scopes/{scope_id}/items", { params: { path: { scope_id: scopeId } }, body: { parent_id: parentId, text, acceptance } })));
      if (parent) setExpanded((s) => new Set(s).add(parent.key));
    },
    removeItem: (id) => write(() => unwrap(api.DELETE("/v1/prd-scopes/{scope_id}/items/{item_id}", { params: { path: { scope_id: scopeId, item_id: id } } }))).then(() => undefined),
    enhance: async (itemId) => {
      let job = await unwrap(api.POST("/v1/prd-scopes/{scope_id}/items/{item_id}/enhance", { params: { path: { scope_id: scopeId, item_id: itemId } }, body: {} }));
      // Poll the job (as RefineSection does) until it ends.
      for (let i = 0; i < 120 && (job.status === "queued" || job.status === "running"); i++) {
        await new Promise((r) => setTimeout(r, i === 0 ? 400 : 1500));
        job = await unwrap(api.GET("/v1/llm-jobs/{job_id}", { params: { path: { job_id: job.id } } }));
      }
      return job;
    },
    acceptEnhance: (itemId, jobId, body) =>
      write(() =>
        unwrap(api.POST("/v1/prd-scopes/{scope_id}/items/{item_id}/enhance/{job_id}/accept", { params: { path: { scope_id: scopeId, item_id: itemId, job_id: jobId } }, body })),
      ).then(() => undefined),
  };
  const pick = (f: Feature) => {
    setSelected(f.key);
    if (phone) setSheet(true);
  };
  const makeUi = (where: "row" | "inspector"): Ui => ({
    leaveOut: (f, preset) => setLeaveOut({ key: f.key, where, preset }),
    pickGoal: (f) => {
      pick(f);
      setGoalsFor(f.key);
    },
    waive: (f, code) => {
      pick(f);
      setWaiving({ key: f.key, code });
    },
  });

  const rows = useMemo(() => {
    if (!scope) return [];
    const list = [...scope.features].sort((a, b) => a.position - b.position);
    if (filter === "needs") return list.filter((f) => f.needs_you || seen.has(f.key));
    if (filter === "out") return list.filter((f) => f.decision !== "include");
    if (filter === "changed") return list.filter((f) => changedChips(f, scope).length > 0);
    return list;
  }, [scope, filter, seen]);

  if (scopeQ.error) return <Page className="py-6"><ErrorNote>{scopeQ.error}</ErrorNote></Page>;
  if (!scope) return <div className="px-6 py-8"><Loading /></div>;

  const title = (key: string) => scope.features.find((f) => f.key === key)?.title ?? key;
  const goalTitle = (key: string) => goalName(scope, key);
  const groups: { label: string; rows: Feature[] }[] = [];
  for (const f of rows) {
    const label =
      group === "goal"
        ? f.goals.length
          ? goalTitle(f.goals[0].key)
          : "No goal"
        : (() => {
            const r = openReasons(f)[0];
            return r ? (REASON_CHIP[r.code] ?? r.label) : "Nothing open";
          })();
    const g = groups.find((x) => x.label === label);
    if (g) g.rows.push(f);
    else groups.push({ label, rows: [f] });
  }

  // The bar's staged changes: rows a person changed, requirements added, accepts and waivers.
  const chips: StagedChip[] = [];
  for (const f of scope.features) {
    if (f.edited) {
      const what = f.decision !== (f.history.original as { decision?: string }).decision ? { exclude: "left out", defer: "deferred", include: "included" }[f.decision] : changeText(f).toLowerCase();
      chips.push({ key: f.id, label: `${f.title}: ${what}`, onRemove: () => ops.patch(f, { revert: true }) });
    }
    for (const q of f.requirements) {
      if (q.added) chips.push({ key: q.id, label: `+ Requirement on ${f.title}`, onRemove: () => ops.removeItem(q.id) });
      else if (q.edited) chips.push({ key: q.id, label: `${q.title.slice(0, 32)}: ${q.decision === "cut" ? "cut" : "edited"}`, onRemove: () => ops.patch(q, { revert: true }) });
    }
  }
  for (const it of review?.items ?? []) {
    for (const a of it.actions) {
      if (a.state !== "staged" || (a.kind !== "accept" && a.kind !== "waive")) continue;
      chips.push({ key: a.id, label: `${title(it.key)}: ${a.kind === "waive" ? "waived" : "kept"}`, onRemove: () => ops.removeAction(a.id) });
    }
  }
  const s = scope.summary;
  // Features with a blocking reason open, as the bar's gate line counts them (s.blocking counts reasons).
  const blocking = scope.features.filter((f) => openReasons(f).some((r) => r.severity === "blocking")).length;
  const tally = `${s.handled} of ${s.features} handled · ${blockingLeftText(blocking)} · ${plural(s.suggestions_open, "suggestion")} waiting`;
  const fileProblems = (scope.check.problems ?? []).filter((p) => FILE_PROBLEMS.includes(p.code));
  const selectedFeature = scope.features.find((f) => f.key === selected) ?? scope.features.find((f) => f.needs_you) ?? scope.features[0] ?? null;
  // rirs-2/24: the PRD by its name ("Saved addresses PRD"), never its slug.
  const prdTitle = runDocName(run) ?? "this PRD";
  // rirs-13: only an approver is asked; the others see what needs a decision.
  const needsWord = mode === "approver" ? "Needs you" : "Needs a decision";

  const inspector = selectedFeature && (
    <ScopeInspector
      feature={selectedFeature}
      scope={scope}
      review={review}
      mode={mode}
      ops={ops}
      ui={makeUi("inspector")}
      waiving={waiving?.key === selectedFeature.key ? waiving.code : null}
      onWaiveDone={() => setWaiving(null)}
      goalsOpen={goalsFor === selectedFeature.key}
      onGoalsDone={() => setGoalsFor(null)}
      leavingOut={leaveOut?.key === selectedFeature.key && leaveOut.where === "inspector" ? (leaveOut.preset ?? null) : undefined}
      onLeaveOutDone={() => setLeaveOut(null)}
    />
  );

  return (
    <Page>
      <PageHeader
        back={
          <span>
            <Link href="/runs" className="hover:underline">
              Runs
            </Link>{" "}
            /{" "}
            <Link href={`/runs/${run.id}`} className="break-words hover:underline" data-testid="run-name">
              {runDocName(run) ? `${runDocName(run)} · ${run.flow_title}` : run.flow_title}
            </Link>
          </span>
        }
        title="Feature set"
        status={
          <>
            <span className="min-w-0 text-sm break-words text-text2" data-testid="scope-for">
              For {prdTitle} · attempt {scope.attempt}
            </span>
            {cp.status === "pending" ? (
              <Chip kind="warn" dot>
                {mode === "approver" ? "Waiting for you" : "Waiting for an approver"}
              </Chip>
            ) : (
              <Chip kind={cp.status === "approved" ? "pass" : "na"}>{cp.status === "approved" ? "Approved" : cp.status === "changes_requested" ? "Sent back" : "Skipped"}</Chip>
            )}
          </>
        }
        action={
          <Button icon="doc" onClick={() => setRawOpen(true)}>
            Raw file
          </Button>
        }
      />
      {error && (
        <p className="mb-2 text-sm text-crit" role="alert">
          {error}
        </p>
      )}
      {fileProblems.length > 0 ? (
        <FileProblems runId={run.id} cpId={cp.id} problems={fileProblems} canDecide={mode === "approver"} onRaw={() => setRawOpen(true)} onDecided={() => router.push(`/runs/${run.id}`)} />
      ) : (
        <Split inspector={!phone ? inspector : undefined}>
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <FilterChips<Filter>
              label="Show"
              value={filter}
              onChange={setFilter}
              items={[
                { value: "needs", label: needsWord, count: s.needs_you },
                { value: "all", label: "All", count: s.features },
                { value: "out", label: "Left out", count: scope.features.filter((f) => f.decision !== "include").length },
                ...(scope.attempt > 1 && scope.previous ? [{ value: "changed" as const, label: "Changed", count: scope.features.filter((f) => changedChips(f, scope).length > 0).length }] : []),
              ]}
            />
            <span className="ml-auto flex items-center gap-2 text-sm text-text2">
              Group by
              <SegmentedControl<Group> label="Group by" size="sm" value={group} onChange={setGroup} items={[{ value: "goal", label: "Goal" }, { value: "reason", label: "Reason" }]} />
            </span>
          </div>
          <div role="table" aria-label="Features" className="min-w-0 rounded-panel border border-line bg-surface max-[600px]:border-0 max-[600px]:bg-transparent" data-testid="scope-table">
            <div role="row" className={`grid ${COLS} items-center gap-x-2 border-b border-line px-2 py-2 text-[13px] font-semibold text-text2 max-[600px]:hidden`}>
              <span role="columnheader" aria-label="Requirements" />
              <span role="columnheader">#</span>
              <span role="columnheader">Feature</span>
              <span role="columnheader">Goal</span>
              {/* rirs-12: the narrow columns keep a short head; the full word is its name and tooltip. */}
              <span role="columnheader" aria-label="Confidence">
                <abbr title="Confidence" className="no-underline">
                  Conf.
                </abbr>
              </span>
              <span role="columnheader" aria-label="Requirements kept">
                <abbr title="Requirements kept" className="no-underline">
                  Reqs
                </abbr>
              </span>
              <span role="columnheader">{needsWord} because</span>
              <span role="columnheader">Your call</span>
            </div>
            {rows.length === 0 && (
              <p className="px-4 py-6 text-sm text-text2" data-testid="scope-empty">
                {filter === "needs"
                  ? mode === "approver"
                    ? "Nothing needs you: every feature is fine as the agents proposed it."
                    : "Nothing needs a decision: every feature is fine as the agents proposed it."
                  : "No features here."}
              </p>
            )}
            {groups.map((g) => (
              <div key={g.label} role="rowgroup" aria-label={g.label} className="max-[600px]:flex max-[600px]:flex-col max-[600px]:gap-2">
                <div role="row" className="border-b border-line bg-surface2 px-3 py-1.5 text-sm font-semibold max-[600px]:rounded-button max-[600px]:border-0 max-[600px]:bg-transparent max-[600px]:px-1">
                  <span role="cell">
                    {g.label} <span className="tnum text-text2">{g.rows.length}</span>
                  </span>
                </div>
                {g.rows.map((f) => (
                  <FeatureRow
                    key={f.id}
                    f={f}
                    scope={scope}
                    review={review}
                    mode={mode}
                    ops={ops}
                    ui={makeUi("row")}
                    selected={selectedFeature?.key === f.key}
                    expanded={expanded.has(f.key)}
                    changed={filter === "changed" ? changedChips(f, scope) : []}
                    goalTitle={goalTitle}
                    leavingOut={leaveOut?.key === f.key && leaveOut.where === "row" ? (leaveOut.preset ?? null) : undefined}
                    onLeaveOutDone={() => setLeaveOut(null)}
                    onToggle={() =>
                      setExpanded((x) => {
                        const n = new Set(x);
                        if (n.has(f.key)) n.delete(f.key);
                        else n.add(f.key);
                        return n;
                      })
                    }
                    onSelect={() => pick(f)}
                  />
                ))}
              </div>
            ))}
          </div>
          {review && (
            <DecisionBar
              runId={run.id}
              checkpointId={cp.id}
              tally={tally}
              chips={chips}
              changes={chips.length}
              edits={s.edits}
              gate={review.gate ?? null}
              console={cp.console ?? null}
              revision={review.revision}
              savedNote={review.note ?? null}
              canDecide={mode === "approver" && !!review.can_decide}
              canNote={!!review.can_stage}
              onReload={reload}
              onDecided={() => {
                invalidateWaiting();
                waitingChanged();
                void reloadRun();
                router.push(`/runs/${run.id}`);
              }}
            />
          )}
        </Split>
      )}
      <Sheet open={phone && sheet && !!inspector} title={selectedFeature?.title ?? "Feature"} onClose={() => setSheet(false)} testId="sheet-feature">
        {inspector}
      </Sheet>
      <RawFile open={rawOpen} onClose={() => setRawOpen(false)} runId={run.id} seq={cp.segment_seq ?? scope.segment_seq} />
    </Page>
  );
}

function FeatureRow({
  f,
  scope,
  review,
  mode,
  ops,
  ui,
  selected,
  expanded,
  changed,
  goalTitle,
  leavingOut,
  onLeaveOutDone,
  onToggle,
  onSelect,
}: {
  f: Feature;
  scope: Scope;
  review: Review | null;
  mode: Mode;
  ops: Ops;
  ui: Ui;
  selected: boolean;
  expanded: boolean;
  changed: string[];
  goalTitle: (key: string) => string;
  leavingOut: string | null | undefined;
  onLeaveOutDone: () => void;
  onToggle: () => void;
  onSelect: () => void;
}) {
  const open = openReasons(f);
  const kept = f.requirements.filter((q) => q.decision === "keep").length;
  const suggestions = actionsOn(review, f.key).filter((a) => a.state === "suggested");
  const titleOf = (k: string) => scope.features.find((x) => x.key === k)?.title ?? k;
  return (
    <div
      role="row"
      aria-selected={selected}
      data-testid="scope-row"
      data-key={f.key}
      className={`border-b border-line last:border-b-0 max-[600px]:rounded-button max-[600px]:border max-[600px]:bg-surface ${selected ? "bg-accent-soft/50 shadow-[inset_4px_0_0_var(--accent)]" : ""}`}
    >
      <div className={`grid ${COLS} items-center gap-x-2 px-2 py-2 max-[600px]:flex max-[600px]:flex-wrap max-[600px]:gap-2 max-[600px]:px-3`}>
        {/* rirs-41: on a phone the card's title line has a Details control instead of a lone chevron. */}
        <span role="cell" className="max-[600px]:hidden">
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={`Requirements of ${f.title}`}
            onClick={onToggle}
            className="grid size-7 place-items-center rounded text-text hover:bg-surface2"
            data-testid="row-chevron"
          >
            <span aria-hidden className={`inline-block transition-transform ${expanded ? "rotate-90" : ""}`}>
              ›
            </span>
          </button>
        </span>
        <span role="cell" className="tnum text-sm text-text max-[600px]:hidden" data-testid="row-number">
          {f.position}
        </span>
        <span role="cell" className="flex min-w-0 flex-wrap items-center gap-1.5 max-[600px]:basis-full">
          <button
            type="button"
            onClick={onSelect}
            title={f.title}
            className="min-h-6 min-w-0 truncate text-left font-medium hover:underline max-[600px]:min-h-10 max-[600px]:flex-1 max-[600px]:whitespace-normal"
            data-testid="feature-title"
          >
            {f.title}
          </button>
          {f.flags.includes("new_feature") && <Chip kind="acc">New</Chip>}
          {f.decision !== "include" && <Chip kind="na">{decisionText(f.decision)}</Chip>}
          {changed.map((c) => (
            <Chip key={c} kind="acc" data-testid="changed-chip">
              {c}
            </Chip>
          ))}
          <span className="hidden flex-none max-[600px]:block">
            <Button className="h-10 px-3 text-sm" aria-label={`Details of ${f.title}`} onClick={onSelect} data-testid="row-details">
              Details
              <span aria-hidden>›</span>
            </Button>
          </span>
        </span>
        <span role="cell" className="flex min-w-0 flex-wrap gap-1">
          {f.goals.length ? (
            f.goals.map((g) => (
              <Chip key={g.key} kind="line" title={goalTitle(g.key)} className="max-w-full truncate">
                {goalTitle(g.key)}
              </Chip>
            ))
          ) : (
            <Chip kind="warn">No goal</Chip>
          )}
        </span>
        <span role="cell" className="max-[600px]:hidden">
          <Ring value={pct(f.confidence)} size={32} stroke={4} />
        </span>
        <span role="cell" className="tnum text-sm max-[600px]:hidden" title={`${kept} of ${f.requirements.length} requirements kept`}>
          {kept}/{f.requirements.length}
        </span>
        <span role="cell" className="flex min-w-0 flex-wrap gap-1" data-testid="row-reasons">
          {open.map((r) => (
            <Chip key={r.code} kind={r.severity === "blocking" ? "crit" : "warn"} title={reasonText(r, scope)} wrap>
              {REASON_CHIP[r.code] ?? r.label}
            </Chip>
          ))}
        </span>
        <span role="cell" className="min-w-0 max-[600px]:basis-full" data-testid="your-call">
          <YourCall f={f} scope={scope} review={review} mode={mode} ops={ops} ui={ui} />
        </span>
      </div>
      {suggestions.map((a) => (
        <p key={a.id} className="px-3 pb-2 pl-16 text-sm text-text2 max-[600px]:pl-3" data-testid="suggested-by">
          Suggested by {a.created_by?.name ?? "someone"}: {describeAction(a, titleOf)}
        </p>
      ))}
      {leavingOut !== undefined && (
        <div className="px-3 pb-2 pl-16 max-[600px]:pl-3">
          <LeaveOutPicker
            preset={leavingOut ?? undefined}
            suggest={mode === "commenter"}
            onCancel={onLeaveOutDone}
            onPick={async (reason) => {
              if (mode === "approver") await ops.patch(f, { decision: "exclude", decision_reason: reason });
              else await ops.act({ item_key: f.key, kind: "edit", field: "decision", value: { decision: "exclude", reason }, answers: [] });
              onLeaveOutDone();
            }}
          />
        </div>
      )}
      {expanded && (
        <div role="rowgroup" aria-label={`Requirements of ${f.title}`}>
          {f.requirements.map((q) => (
            <RequirementRow key={q.id} req={q} mode={mode} ops={ops} review={review} />
          ))}
        </div>
      )}
    </div>
  );
}

/** The row's call: what a person decided (✓ … with Undo), else the first open reason's fixes. */
function YourCall({ f, scope, review, mode, ops, ui }: { f: Feature; scope: Scope; review: Review | null; mode: Mode; ops: Ops; ui: Ui }) {
  const approver = mode === "approver";
  const undo = (run: () => Promise<void>) =>
    approver && (
      <Button variant="ghost" className="h-8 px-2 text-sm max-[600px]:h-10" onClick={() => void run()}>
        Undo
      </Button>
    );
  const done = (text: string, run: (() => Promise<void>) | null) => (
    <span className="flex flex-wrap items-center gap-1 text-sm font-medium text-pass" data-testid="row-done">
      ✓ {text}
      {run && undo(run)}
    </span>
  );
  if (f.edited) return done(changeText(f), () => ops.patch(f, { revert: true }));
  const open = openReasons(f);
  if (open.length) return <FixButtons fixes={fixesFor(open[0], f, scope, mode, ops, ui)} />;
  const answer = actionsOn(review, f.key).find((a) => a.state === "staged" && (a.kind === "accept" || a.kind === "waive"));
  if (answer) return done(answer.kind === "waive" ? "Waived" : "Kept", () => ops.removeAction(answer.id));
  // Fixed elsewhere (a dependency included again): Undo puts that row back.
  const fixedBy = scope.features.filter((d) => f.depends_on.includes(d.key) && d.edited);
  if (fixedBy.length) return done("Fixed", () => Promise.all(fixedBy.map((d) => ops.patch(d, { revert: true }))).then(() => undefined));
  if (f.reasons.length) return done("Handled", null);
  return <span className="text-sm text-text2">—</span>;
}

function FileProblems({
  runId,
  cpId,
  problems,
  canDecide,
  onRaw,
  onDecided,
}: {
  runId: string;
  cpId: string;
  problems: { code: string; message: string }[];
  canDecide: boolean;
  onRaw: () => void;
  onDecided: () => void;
}) {
  const [note, setNote] = useState("The feature set file could not be read: write it again.");
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="rounded-panel border border-crit/40 bg-crit-bg p-4" role="alert" data-testid="file-problems">
      <p className="font-semibold text-crit">This feature set cannot be reviewed row by row</p>
      <ul className="mt-1 ml-4 list-disc text-sm">
        {problems.map((p) => (
          <li key={p.code + p.message}>{p.message}</li>
        ))}
      </ul>
      {canDecide && <textarea aria-label="Note to the agents" value={note} rows={2} maxLength={2000} onChange={(e) => setNote(e.target.value)} className={`${INPUT} mt-2`} />}
      {error && <p className="text-sm text-crit">{error}</p>}
      <div className="mt-2 flex gap-2">
        {canDecide && (
          <Button
            variant="solid"
            disabled={!note.trim()}
            onClick={() =>
              void unwrap(api.POST("/v1/runs/{run_id}/checkpoints/{checkpoint_id}/decide", { params: { path: { run_id: runId, checkpoint_id: cpId } }, body: { decision: "changes_requested", note } })).then(
                onDecided,
                (e) => setError(errorMessage(e)),
              )
            }
          >
            Send back
          </Button>
        )}
        <Button onClick={onRaw}>Raw file</Button>
      </div>
    </div>
  );
}

/** feature_set.yaml and design.md as the agents wrote them (the run page's raw-file view). */
function RawFile({ open, onClose, runId, seq }: { open: boolean; onClose: () => void; runId: string; seq: number }) {
  const [name, setName] = useState<"feature_set.yaml" | "design.md">("feature_set.yaml");
  const [loaded, setLoaded] = useState<{ name: string; text: string } | null>(null);
  const content = loaded?.name === name ? loaded.text : "Loading…";
  useEffect(() => {
    if (!open) return;
    let live = true;
    api.GET("/v1/runs/{run_id}/segments/{seq}/artifacts/{name}", { params: { path: { run_id: runId, seq, name } }, parseAs: "text" }).then(({ data, response }) => {
      if (live) setLoaded({ name, text: response.ok ? (data as string) : `Could not load ${name}. Try again.` });
    });
    return () => {
      live = false;
    };
  }, [open, name, runId, seq]);
  return (
    <Sheet open={open} title="Raw file" onClose={onClose} testId="sheet-raw-file">
      <div className="flex flex-col gap-2 px-4 py-3">
        <SegmentedControl
          label="File"
          size="sm"
          value={name}
          onChange={setName}
          items={[
            { value: "feature_set.yaml", label: "feature_set.yaml" },
            { value: "design.md", label: "design.md" },
          ]}
        />
        <pre className="max-h-[70vh] overflow-auto rounded-button bg-surface2 p-3 font-mono text-[13px] whitespace-pre-wrap break-words" data-testid="raw-file-content">
          {content}
        </pre>
      </div>
    </Sheet>
  );
}

