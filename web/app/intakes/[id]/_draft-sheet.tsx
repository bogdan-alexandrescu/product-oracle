"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { Button, InfoTip, Notice, SegmentedControl, Sheet } from "@/components/ds";
import { TemplateThemePicker, useDraftChoice } from "@/components/NewDraft";
import { ErrorNote, Loading } from "@/components/ui";
import { CHECKPOINT_LABEL } from "@/app/runs/_lib";
import { ApiError, api, unwrap, type Schemas } from "@/lib/api/client";
import { errorMessage, useQuery } from "@/lib/use-query";

import type { Summary } from "./_lib";

type Depth = "quick" | "standard" | "deep";
type Reason = "too_old" | "never_reviewed" | "build_under_way";

/** GET /v1/baseline/review-status (B1 "Reuse base"): whether a PRD run may reuse the baseline. */
type ReviewStatus = {
  last_approved_at?: string | null;
  checkpoint_id?: string | null;
  age_days?: number | null;
  build_under_way: boolean;
  reusable: boolean;
  reason?: Reason | null;
  baseline_segment_usd: Record<Depth, number>;
};

/** The knobs the sheet sets; `reuse_baseline` is the B1 knob of a Baseline to PRD run. */
type SheetKnobs = Schemas["KnobsIn"] & { reuse_baseline: boolean };

const DEPTHS: { value: Depth; label: string }[] = [
  { value: "quick", label: "Quick" },
  { value: "standard", label: "Standard" },
  { value: "deep", label: "Deep" },
];

const usd = (n: number) => `$${n.toFixed(2)}`;
const monthDay = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** Why the baseline is rebuilt first, as its tooltip says it. */
function reasonText(status: ReviewStatus): string {
  if (status.reason === "build_under_way" || status.build_under_way) return "A baseline build is under way";
  if (status.reason === "never_reviewed" || !status.last_approved_at) return "No baseline review has been approved yet";
  const days = status.age_days ?? 0;
  return `The last baseline review was approved ${days} day${days === 1 ? "" : "s"} ago`;
}

// The review status route is read through the client untyped until the API types carry it.
const getReviewStatus = () =>
  unwrap((api.GET as unknown as (path: string) => Promise<{ data?: ReviewStatus; error?: unknown; response: Response }>)("/v1/baseline/review-status"));

/**
 * Draft with Oracle (C4): the template and theme chosen at the door (Change opens the same
 * picker), whether to reuse the current baseline or rebuild it (B1 "Reuse base"), the depth,
 * the flow's stops (each on by default, W2), one estimate line (P3d), and Start drafting.
 * The first estimate makes the intake's draft run; every later change updates that run
 * (PATCH) and re-estimates it, so the intake never gets a second one.
 */
export function DraftSheet({ summary, onClose }: { summary: Summary; onClose: () => void }) {
  const router = useRouter();
  const id = useId();
  const intake = summary.intake as Summary["intake"] & {
    template?: string | null;
    theme?: string | null;
    prd_answers?: Schemas["PrdAnswers"] | null;
    run_ids?: string[];
  };
  const prd = useMemo(() => intake.prd_answers ?? {}, [intake.prd_answers]);
  const choice = useDraftChoice({ kind: "prd", prd }, { template: intake.template ?? null, theme: intake.theme ?? null });
  const { template, templateKey, themeKey, themes } = choice;
  const themeName = themeKey ? (themes.data?.find((t) => t.key === themeKey)?.name ?? themeKey) : "No theme";

  const review = useQuery("baseline-review-status", getReviewStatus);
  const flows = useQuery("flows", () => unwrap(api.GET("/v1/flows")));
  const flow = flows.data?.flows.find((f) => f.key === "baseline_to_prd");

  const [changing, setChanging] = useState(false);
  const [reuse, setReuse] = useState<boolean | null>(null);
  const [depth, setDepth] = useState<Depth>("standard");
  const [stops, setStops] = useState<Record<string, boolean>>({});
  const [runId, setRunId] = useState<string | null>(summary.draft_run_id ?? intake.run_ids?.[0] ?? null);
  const [estimate, setEstimate] = useState<Schemas["EstimateOut"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
    }),
    [depth, checkpoints, stops, reusing],
  );

  async function runEstimate(current: SheetKnobs) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      let rid = runId;
      if (rid) {
        const patch = { knobs: current, template: templateKey, theme: themeKey };
        await unwrap(api.PATCH("/v1/runs/{run_id}", { params: { path: { run_id: rid } }, body: patch }));
      } else {
        const body = { knobs: current, template: templateKey, theme: themeKey, reuse_baseline: current.reuse_baseline };
        const run = await unwrap(api.POST("/v1/intakes/{intake_id}/runs", { params: { path: { intake_id: intake.id } }, body }));
        rid = run.id;
        setRunId(rid);
      }
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

  async function start() {
    if (!runId) return;
    setBusy(true);
    setError(null);
    try {
      await unwrap(api.POST("/v1/runs/{run_id}/start", { params: { path: { run_id: runId } } }));
      router.push(`/runs/${runId}`);
    } catch (e) {
      await refused(e);
      setBusy(false);
    }
  }

  const rebuildUsd = status?.baseline_segment_usd?.[depth];

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
                Use the current baseline (approved {status.last_approved_at ? monthDay(status.last_approved_at) : "recently"})
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
            Start drafting
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
