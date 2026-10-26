"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, type ReactNode } from "react";

import { Button, Notice } from "@/components/ds";
import { INPUT } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

import { FRESH, usd, type Output, type Proposal } from "./_lib";

type Proposed = Schemas["RegenerationOut"];
type Estimate = Schemas["RegenerateEstimateOut"];

/** What a row's stages 2 and 3 returned, kept by the screen per output so a reload keeps them. */
export type RowResult = { proposed?: Proposed; estimate?: Estimate };

/**
 * C's three stages on one plan row: settle the staleness (review, accept regeneration,
 * reconcile with a reason), propose the draft run (a spec or design: POST
 * /v1/spec-requests/{id}/regenerate) or estimate it (a roadmap or other document: POST
 * /v1/documents/{doc}/regenerate/estimate, with its threshold), then start it (on the run
 * page, or POST …/regenerate). The order is the one the UI suggests; the API does not need
 * the first stage before the second. Each row is acted on by itself: nothing runs the plan.
 */
export function PlanSteps({
  output,
  proposal,
  result,
  onResult,
  onChanged,
}: {
  output: Output;
  proposal?: Proposal;
  result: RowResult;
  onResult: (r: RowResult) => void;
  onChanged: () => void;
}) {
  const { can, me } = useMe();
  const isDoc = output.kind === "document_version";
  // A document's decider regenerates it whatever their role (oracle.trash.regenerate): read its policy.
  const slug = isDoc ? output.document_slug : null;
  const policyQ = useQuery(`impact-policy|${slug ?? ""}`, () =>
    slug ? unwrap(api.GET("/v1/documents/{doc}/review-policy", { params: { path: { doc: slug } } })) : Promise.resolve(null),
  );
  const decider = Boolean(me?.user_id && policyQ.data?.decider_id === me.user_id);
  const mayAct = can("act_on_staleness");
  const mayPropose = !isDoc && Boolean(output.request_id) && can("regenerate_spec", true);
  const mayEstimate = isDoc && Boolean(slug) && can("estimate_regeneration", decider);
  const mayStart = isDoc && Boolean(slug) && can("start_regeneration", decider);

  if (!proposal) return null;
  if (!mayAct && !mayPropose && !mayEstimate) {
    return <p className="text-sm text-text2">Read only. An approver acts on this plan.</p>;
  }
  return (
    <ol className="flex flex-col gap-3" aria-label="Steps">
      <Step title="1 · Settle staleness">
        {mayAct ? (
          <Settle output={output} onChanged={onChanged} />
        ) : (
          <p className="text-sm text-text2">
            You decide on this {isDoc ? output.category.replace("_", " ") : "output"}, so you can regenerate it. Settling its staleness needs an approver.
          </p>
        )}
      </Step>
      {isDoc ? (
        <>
          <Step title="2 · Estimate">
            <EstimateStep slug={slug!} may={mayEstimate} estimate={result.estimate} onEstimate={(estimate) => onResult({ ...result, estimate })} />
          </Step>
          <Step title="3 · Start">
            <StartStep slug={slug!} may={mayStart} estimate={result.estimate} />
          </Step>
        </>
      ) : (
        <>
          <Step title="2 · Propose draft run">
            <ProposeStep requestId={output.request_id!} may={mayPropose} proposed={result.proposed} onProposed={(proposed) => onResult({ ...result, proposed })} />
          </Step>
          <Step title="3 · Estimate and start">
            {result.proposed ? (
              <Link href={`/runs/${result.proposed.run_id}`} className="text-sm font-medium text-accent-ink hover:underline">
                Estimate and start it on the run page
              </Link>
            ) : (
              <p className="text-sm text-text2">On the run page, once the draft run is proposed.</p>
            )}
          </Step>
        </>
      )}
    </ol>
  );
}

function Step({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li className="flex flex-col gap-1.5 border-l-2 border-line pl-3">
      <span className="text-[13px] leading-4 font-semibold tracking-[0.02em] text-text2">{title}</span>
      {children}
    </li>
  );
}

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

function Settle({ output, onChanged }: { output: Output; onChanged: () => void }) {
  const id = useId();
  const { busy, error, run } = useAction();
  const [reconciling, setReconciling] = useState(false);
  const [reason, setReason] = useState("");
  const f = output.freshness;
  const act = (action: Schemas["StalenessAction"]["action"], why: string | null = null) =>
    run(async () => {
      await unwrap(
        api.POST("/v1/trace/staleness/actions", {
          body: {
            action,
            artifact_version_id: output.artifact_version_id ?? null,
            document_version_id: output.artifact_version_id ? null : (output.document_version_id ?? null),
            dependency_ids: [],
            reason: why,
          },
        }),
      );
      setReconciling(false);
      setReason("");
      onChanged();
    });

  if (f === "fresh" || f === "reconciled") return <p className="text-sm text-text2">Settled: {FRESH[f].label}.</p>;
  return (
    <div className="flex flex-col gap-2">
      {!reconciling && (
        <div className="flex flex-wrap gap-2">
          {f === "potentially_stale" && (
            <Button disabled={busy} onClick={() => void act("review")}>
              Mark reviewed
            </Button>
          )}
          <Button disabled={busy} onClick={() => void act("accept_regeneration")}>
            Accept regeneration
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setReconciling(true)}>
            Reconcile…
          </Button>
        </div>
      )}
      {reconciling && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act("reconcile", reason.trim() || null);
          }}
        >
          <label htmlFor={`${id}-why`} className="text-sm font-medium">
            Why the current version still holds
          </label>
          <textarea id={`${id}-why`} rows={2} maxLength={2000} className={INPUT} value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="solid" disabled={busy}>
              Reconcile
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setReconciling(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}

function ProposeStep({ requestId, may, proposed, onProposed }: { requestId: string; may: boolean; proposed?: Proposed; onProposed: (p: Proposed) => void }) {
  const { busy, error, run } = useAction();
  if (proposed) {
    return (
      <p data-testid="plan-proposed" className="text-sm">
        Draft run {proposed.run_id.slice(0, 8)} from PRD v{proposed.prd_version}
        {proposed.section_keys.length > 0 && ` · ${proposed.section_keys.join(", ")}`}.
        {proposed.dropped_section_keys.length > 0 && ` Dropped ${proposed.dropped_section_keys.join(", ")} (no longer in the PRD).`}
      </p>
    );
  }
  if (!may) return <p className="text-sm text-text2">An approver proposes it.</p>;
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          variant="solid"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              onProposed(
                await unwrap(
                  api.POST("/v1/spec-requests/{request_id}/regenerate", {
                    params: { path: { request_id: requestId } },
                    body: { knobs: { depth: "standard", roles: {}, checkpoints: {} } },
                  }),
                ),
              );
            })
          }
        >
          Propose regeneration
        </Button>
      </div>
      <p className="text-sm text-text2">Creates a draft run; nothing is rewritten until someone estimates and starts it.</p>
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}

function EstimateStep({ slug, may, estimate, onEstimate }: { slug: string; may: boolean; estimate?: Estimate; onEstimate: (e: Estimate) => void }) {
  const { busy, error, run } = useAction();
  if (estimate) {
    return (
      <div data-testid="plan-estimate" className="flex flex-col gap-1 text-sm">
        <div className="flex items-center gap-2">
          <span className="flex-1">Estimate · flow <code className="font-mono text-[13px]">{estimate.flow}</code></span>
          <b className="tnum">{usd(estimate.estimate_usd)}</b>
        </div>
        <div className="flex items-center gap-2 text-text2">
          <span className="flex-1">Owner approval over</span>
          <span className="tnum">{usd(estimate.approval_threshold_usd)}</span>
        </div>
        {estimate.needs_owner_approval && (
          <p className="font-medium text-warn">Over the {usd(estimate.approval_threshold_usd)} threshold: waits for an owner&apos;s approval.</p>
        )}
      </div>
    );
  }
  if (!may) return <p className="text-sm text-text2">An approver or the document&apos;s decider estimates it.</p>;
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          variant="solid"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              onEstimate(await unwrap(api.POST("/v1/documents/{doc}/regenerate/estimate", { params: { path: { doc: slug } }, body: { note: null } })));
            })
          }
        >
          Estimate
        </Button>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}

function StartStep({ slug, may, estimate }: { slug: string; may: boolean; estimate?: Estimate }) {
  const router = useRouter();
  const { busy, error, run } = useAction();
  if (!estimate) return <p className="text-sm text-text2">Once it is estimated.</p>;
  if (!may) return <p className="text-sm text-text2">An approver or the document&apos;s decider starts it.</p>;
  return (
    <div className="flex flex-col gap-2">
      {estimate.needs_owner_approval && <p className="text-sm text-text2">Waits for an owner&apos;s approval after you start it.</p>}
      <div>
        <Button
          variant="solid"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const out = await unwrap(api.POST("/v1/documents/{doc}/regenerate", { params: { path: { doc: slug } }, body: { run_id: estimate.run_id, note: null } }));
              router.push(`/runs/${out.id}`);
            })
          }
        >
          Start run
        </Button>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}

