"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { Button, InfoTip, Notice, SegmentedControl, Sheet } from "@/components/ds";
import { GoalPicker, TemplateThemePicker, useConfirmedGoals, useDraftChoice } from "@/components/NewDraft";
import { ErrorNote, Loading } from "@/components/ui";
import { CHECKPOINT_LABEL } from "@/app/runs/_lib";
import { ApiError, api, unwrap, type Schemas } from "@/lib/api/client";
import { formatDayUtc } from "@/lib/format";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

import type { Summary } from "./_lib";

type Depth = Schemas["KnobsIn"]["depth"];
/** GET /v1/baseline/review-status (B1 "Reuse base"): whether a PRD run may reuse the baseline. */
type ReviewStatus = Schemas["ReviewStatusOut"];
/** The knobs the sheet sets; `reuse_baseline` is the B1 knob of a Baseline to PRD run. */
type SheetKnobs = Schemas["KnobsIn"];
type Run = Schemas["RunOut"];

const DEPTHS: { value: Depth; label: string }[] = [
  { value: "quick", label: "Quick" },
  { value: "standard", label: "Standard" },
  { value: "deep", label: "Deep" },
];

const usd = (n: number) => `$${n.toFixed(2)}`;

/** Why the baseline is rebuilt first, as its tooltip says it. */
function reasonText(status: ReviewStatus): string {
  if (status.reason === "build_under_way" || status.build_under_way) return "A baseline build is under way";
  if (status.reason === "never_reviewed" || !status.last_approved_at) return "No baseline review has been approved yet";
  const days = status.age_days ?? 0;
  return `The last baseline review was approved ${days} day${days === 1 ? "" : "s"} ago`;
}

const getReviewStatus = () => unwrap(api.GET("/v1/baseline/review-status"));

/**
 * Draft with Oracle (C4): the template and theme chosen at the door (Change opens the same
 * picker), the goals the PRD serves (the brief's until changed, #260), whether to reuse the
 * current baseline or rebuild it (B1 "Reuse base"), the depth,
 * the flow's stops (each on by default, W2), one estimate line (P3d), and Start drafting.
 * The first estimate makes the intake's draft run (POST /v1/intakes/{id}/runs); every later
 * change goes through the same route, which updates that run, and re-estimates it, so the
 * intake never gets a second one. Nothing starts until Start drafting: reopened, the sheet
 * takes up that draft run with its choices and its estimate.
 */
export function DraftSheet({ summary, onClose }: { summary: Summary; onClose: () => void }) {
  const runId = summary.draft_run_id ?? null;
  const draft = useQuery(`draft-run|${runId}`, () =>
    runId ? unwrap(api.GET("/v1/runs/{run_id}", { params: { path: { run_id: runId } } })) : Promise.resolve(null),
  );
  if (runId && draft.loading && draft.data === undefined) {
    return (
      <Sheet open title="Draft with Oracle" onClose={onClose} testId="draft-sheet">
        <Loading />
      </Sheet>
    );
  }
  // A run that started (or could not be read) is not taken up: the sheet starts afresh.
  const run = draft.data?.status === "draft" ? draft.data : null;
  return <DraftSheetBody summary={summary} run={run} onClose={onClose} />;
}

function DraftSheetBody({ summary, run, onClose }: { summary: Summary; run: Run | null; onClose: () => void }) {
  const router = useRouter();
  const { can } = useMe();
  const id = useId();
  const intake = summary.intake;
  const prd = useMemo(() => intake.prd_answers ?? {}, [intake.prd_answers]);
  const choice = useDraftChoice(
    { kind: "prd", prd },
    run ? { template: run.template ?? null, theme: run.theme ?? null } : { template: intake.template ?? null, theme: intake.theme ?? null },
  );
  const { template, templateKey, themeKey, themes } = choice;
  const themeName = themeKey ? (themes.data?.find((t) => t.key === themeKey)?.name ?? themeKey) : "No theme";

  const review = useQuery("baseline-review-status", getReviewStatus);
  const flows = useQuery("flows", () => unwrap(api.GET("/v1/flows")));
  const flow = flows.data?.flows.find((f) => f.key === "baseline_to_prd");

  const [changing, setChanging] = useState(false);
  const [reuse, setReuse] = useState<boolean | null>(run ? !!run.knobs.reuse_baseline : null);
  const [goals, setGoals] = useState<string[]>(run ? (run.knobs.goals ?? []).map((g) => g.id) : (intake.goal_ids ?? []));
  const [depth, setDepth] = useState<Depth>(run?.knobs.depth ?? "standard");
  const [stops, setStops] = useState<Record<string, boolean>>(run?.knobs.checkpoints ?? {});
  const [runId, setRunId] = useState<string | null>(run?.id ?? null);
  const [estimate, setEstimate] = useState<Schemas["EstimateOut"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // A goal of the brief rejected since is left out, and the sheet says so (#260).
  const confirmed = useConfirmedGoals();
  const leftOut = useMemo(
    () => (confirmed.data ? goals.filter((g) => !confirmed.data!.some((c) => c.id === g)) : []),
    [goals, confirmed.data],
  );
  const serving = useMemo(() => goals.filter((g) => !leftOut.includes(g)), [goals, leftOut]);

  const status = review.data;
  const reusable = !!status?.reusable;
  // Reuse is preselected when the baseline is reusable; Rebuild is one click away.
  const reusing = reusable && (reuse ?? true);

  const checkpoints = useMemo(
    () => (flow?.segments ?? []).flatMap((s) => (s.checkpoint ? [{ kind: s.checkpoint, segment: s.name }] : [])),
    [flow],
  );
  // With "Use the current baseline" its segment does not run, so its stop is not listed.
  const listed = checkpoints.filter((c) => !(reusing && c.segment === "baseline"));

  const knobs: SheetKnobs = useMemo(
    () => ({
      depth,
      roles: {},
      checkpoints: Object.fromEntries(checkpoints.map((c) => [c.kind, stops[c.kind] ?? true])),
      reuse_baseline: reusing,
      goals: serving,
    }),
    [depth, checkpoints, stops, reusing, serving],
  );

  async function runEstimate(current: SheetKnobs) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      // The intake's run route makes its draft run, or updates it once made: never a second run.
      const run = await unwrap(
        api.POST("/v1/intakes/{intake_id}/runs", {
          params: { path: { intake_id: intake.id } },
          body: { knobs: current, template: templateKey, theme: themeKey, reuse_baseline: current.reuse_baseline },
        }),
      );
      const rid = run.id;
      setRunId(rid);
      setEstimate(await unwrap(api.POST("/v1/runs/{run_id}/estimate", { params: { path: { run_id: rid } } })));
    } catch (e) {
      setEstimate(null);
      await refused(e);
    } finally {
      setBusy(false);
    }
  }

  /** A 409 baseline_not_reusable: say why and select Rebuild; anything else is shown as it is. */
  async function refused(e: unknown) {
    if (e instanceof ApiError && e.code === "baseline_not_reusable") {
      setReuse(false);
      const fresh = await getReviewStatus().catch(() => null);
      if (fresh) review.setData(() => fresh);
      setNotice(`${fresh ? reasonText(fresh) : "The current baseline can no longer be used"}: Oracle rebuilds it first.`);
      return;
    }
    setError(errorMessage(e));
  }

  // Once estimated, the estimate follows every choice (the same draft run, re-estimated).
  const estimated = estimate != null;
  const choiceKey = JSON.stringify([knobs, templateKey, themeKey]);
  const lastKey = useRef(choiceKey);
  useEffect(() => {
    if (choiceKey === lastKey.current) return;
    lastKey.current = choiceKey;
    if (!estimated) return;
    const t = setTimeout(() => void runEstimate(knobs), 150);
    return () => clearTimeout(t);
    // Re-estimates when a choice changes, not when the estimate itself arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choiceKey]);

  // Reopened on an estimated draft run: estimate it again (the same run), so the figure and
  // the baseline check are current.
  const resumed = useRef(run?.estimate_usd == null);
  const ready = !!flow && !!status && !!templateKey;
  useEffect(() => {
    if (resumed.current || !ready) return;
    resumed.current = true;
    void runEstimate(knobs);
    // Once, when the sheet's inputs have loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  async function start() {
    if (!runId) return;
    setBusy(true);
    setError(null);
    try {
      const path = { params: { path: { run_id: runId } } };
      await unwrap(api.POST("/v1/runs/{run_id}/start", path));
      // #259: an owner approves their own run's cost here rather than on the run page.
      if (ownerApproves) await unwrap(api.POST("/v1/runs/{run_id}/approve", path));
      router.push(`/runs/${runId}`);
    } catch (e) {
      await refused(e);
      setBusy(false);
    }
  }

  const rebuildUsd = status?.baseline_segment_usd?.[depth];
  const ownerApproves = can("approve_run") && !!estimate?.needs_approval;

  return (
    <Sheet open title="Draft with Oracle" onClose={onClose} testId="draft-sheet">
      <div className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-5 p-4">
        {error && <ErrorNote>{error}</ErrorNote>}
        {notice && <Notice tone="warn">{notice}</Notice>}

        <section aria-labelledby={`${id}-template`} className="min-w-0">
          <div className="mb-1.5 flex items-center gap-2">
            <h3 id={`${id}-template`} className="font-semibold text-text">
              Template and theme
            </h3>
            <Button variant="ghost" className="ml-auto" onClick={() => setChanging((c) => !c)} aria-expanded={changing}>
              {changing ? "Done" : "Change"}
            </Button>
          </div>
          <p data-testid="draft-template" className="text-text [overflow-wrap:anywhere]">
            {template?.name ?? templateKey ?? "…"}
            <span className="text-text2"> · {themeName}</span>
          </p>
          {changing && (
            <div className="mt-3 flex flex-col gap-6">
              <TemplateThemePicker choice={choice} />
            </div>
          )}
        </section>

        <section className="min-w-0">
          <GoalPicker value={goals} onChange={setGoals} legend="Goals this PRD serves" />
          {leftOut.length > 0 && (
            <p data-testid="draft-goals-left-out" className="mt-1.5 text-sm text-text2">
              {leftOut.length === 1
                ? "1 goal of this brief is no longer a confirmed goal: this PRD leaves it out."
                : `${leftOut.length} goals of this brief are no longer confirmed goals: this PRD leaves them out.`}
            </p>
          )}
        </section>

        <section aria-labelledby={`${id}-baseline`} className="min-w-0">
          <h3 id={`${id}-baseline`} className="mb-1.5 font-semibold text-text">
            Baseline
          </h3>
          {review.error && <ErrorNote>{review.error}</ErrorNote>}
          {!status && review.loading && <Loading />}
          {status && reusable && (
            <div role="radiogroup" aria-labelledby={`${id}-baseline`} className="flex flex-col gap-1.5">
              <label className="flex cursor-pointer items-center gap-2 text-text">
                <input
                  type="radio"
                  name={`${id}-baseline`}
                  className="size-4 accent-[var(--accent)]"
                  checked={reusing}
                  onChange={() => setReuse(true)}
                />
                Use the current baseline (approved {status.last_approved_at ? formatDayUtc(status.last_approved_at) : "recently"})
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-text">
                <input
                  type="radio"
                  name={`${id}-baseline`}
                  className="size-4 accent-[var(--accent)]"
                  checked={!reusing}
                  onChange={() => setReuse(false)}
                />
                Rebuild it{rebuildUsd != null ? ` (${usd(rebuildUsd)})` : ""}
              </label>
            </div>
          )}
          {status && !reusable && (
            <p className="flex items-center gap-2 text-text">
              Oracle rebuilds the baseline first
              <InfoTip label="the baseline" align="start">
                {reasonText(status)}
              </InfoTip>
            </p>
          )}
        </section>

        <section className="min-w-0">
          <h3 className="mb-1.5 font-semibold text-text">Depth</h3>
          <SegmentedControl label="Depth" items={DEPTHS} value={depth} onChange={setDepth} size="sm" />
        </section>

        <section aria-labelledby={`${id}-stops`} className="min-w-0">
          <h3 id={`${id}-stops`} className="mb-1.5 font-semibold text-text">
            Stops
          </h3>
          {flows.error && <ErrorNote>{flows.error}</ErrorNote>}
          {!flow && flows.loading && <Loading />}
          <ul className="flex flex-col gap-1.5">
            {listed.map((c) => {
              const label = CHECKPOINT_LABEL[c.kind as keyof typeof CHECKPOINT_LABEL] ?? c.kind;
              return (
                <li key={c.kind}>
                  <label className="inline-flex cursor-pointer items-center gap-2 text-text">
                    <input
                      type="checkbox"
                      role="switch"
                      className="size-4 accent-[var(--accent)]"
                      checked={stops[c.kind] ?? true}
                      onChange={(e) => setStops((all) => ({ ...all, [c.kind]: e.target.checked }))}
                      aria-label={label}
                    />
                    {label}
                  </label>
                </li>
              );
            })}
          </ul>
        </section>

        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
          {estimate ? (
            <p data-testid="draft-estimate" className="min-w-0 flex-1 text-text">
              <span className="tnum font-semibold">Estimated {usd(estimate.total_usd)}</span>
              {estimate.needs_approval && <span className="text-text2"> · Needs an owner&apos;s approval before it starts</span>}
            </p>
          ) : (
            <span className="min-w-0 flex-1" />
          )}
          {!estimate && (
            <Button onClick={() => void runEstimate(knobs)} disabled={busy || !flow || !status || !templateKey}>
              {busy ? "Estimating…" : "Estimate"}
            </Button>
          )}
          <Button variant="primary" onClick={start} disabled={busy || !estimate}>
            {ownerApproves ? `Approve ${usd(estimate!.total_usd)} and start` : "Start drafting"}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
