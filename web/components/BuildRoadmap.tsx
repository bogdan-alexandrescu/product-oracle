"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";

import { EstimateSummary, type EstimateOut } from "@/app/runs/_lib";
import { TemplateThemePicker, useDraftChoice } from "@/components/NewDraft";
import { Button, Icon, InfoTip, Notice } from "@/components/ds";
import { INPUT } from "@/components/ui";
import { api, unwrap, type Schemas, type VersionSource } from "@/lib/api/client";
import { hasRole, useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

/** A PRD with an approved version to build a roadmap from. */
type ApprovedPrd = { slug: string; title: string; approved_version?: number | null };

/** "From <PRD title> v<n>": the PRD version a roadmap version was built from (O4b). */
export function SourceLink({ source }: { source: VersionSource }) {
  return (
    <span data-testid="version-source">
      From{" "}
      <Link href={`/documents/${source.slug}/v/${source.version}`} className="font-medium underline-offset-2 hover:underline">
        {source.title} v{source.version}
      </Link>
    </span>
  );
}

/** Build roadmap on an approved PRD; approvers and above start runs. */
export function BuildRoadmapButton({ prd, size }: { prd: ApprovedPrd; size?: "sm" | "md" }) {
  const { role } = useMe();
  const [open, setOpen] = useState(false);
  if (!hasRole(role, "approver") || prd.approved_version == null) return null;
  return (
    <>
      <Button
        variant="secondary"
        icon="roadmap"
        className={size === "sm" ? "" : "h-10 rounded-button px-4 text-[15px]"}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        Build roadmap
      </Button>
      {/* On the body: the sticky document toolbar's backdrop blur would contain a fixed dialog. */}
      {open &&
        createPortal(
          <BuildRoadmapDialog prd={{ ...prd, approved_version: prd.approved_version }} onClose={() => setOpen(false)} />,
          document.body,
        )}
    </>
  );
}

// No answers: the recommendation for a roadmap (the company default, else Now / Next / Later).
const ROADMAP: Schemas["RecommendIn"] = { kind: "roadmap", roadmap: {} };
/** Target option for a new roadmap under a slug the user types. */
const NEW = "__new";

/**
 * O4b: a prd_to_roadmap run from the PRD's approved version. Pick the template and theme
 * (the new-draft picker) and the roadmap, see the estimate, then start the run.
 */
export function BuildRoadmapDialog({ prd, onClose }: { prd: ApprovedPrd & { approved_version: number }; onClose: () => void }) {
  const router = useRouter();
  const id = useId();
  const roadmaps = useQuery("documents|roadmap", () =>
    unwrap(api.GET("/v1/documents", { params: { query: { kind: "roadmap" } } })),
  );
  const choice = useDraftChoice(ROADMAP);
  const { rec, templateKey, themeKey } = choice;
  const [target, setTarget] = useState("");
  const [slug, setSlug] = useState("");
  // The draft run and its estimate, for the inputs they were made with.
  const [draft, setDraft] = useState<{ id: string; inputs: string; estimate: EstimateOut } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Without a roadmap named, the API builds "<prd>-roadmap": its next version, or a new roadmap.
  const defaultSlug = `${prd.slug}-roadmap`;
  const existing = roadmaps.data?.find((d) => d.slug === defaultSlug);
  const others = (roadmaps.data ?? []).filter((d) => d.slug !== defaultSlug);
  const document = target === NEW ? slug.trim() : target;
  const inputs = JSON.stringify([document, templateKey, themeKey]);
  // Any change makes the estimate stale: estimate again before starting.
  const estimate = draft?.inputs === inputs ? draft.estimate : null;

  async function runEstimate() {
    setBusy(true);
    setError(null);
    try {
      const run = await unwrap(
        api.POST("/v1/runs", {
          body: {
            flow: "prd_to_roadmap",
            source: prd.slug,
            source_version: prd.approved_version,
            document: document || null,
            template: templateKey,
            theme: themeKey,
            knobs: { depth: "standard", roles: {}, checkpoints: {} },
          },
        }),
      );
      const out = await unwrap(api.POST("/v1/runs/{run_id}/estimate", { params: { path: { run_id: run.id } } }));
      setDraft({ id: run.id, inputs, estimate: out });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    if (!draft || !estimate) return;
    setBusy(true);
    setError(null);
    try {
      await unwrap(api.POST("/v1/runs/{run_id}/start", { params: { path: { run_id: draft.id } } }));
      router.push(`/runs/${draft.id}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    // Rendered in a portal: React still bubbles its events to the button's table row, so keep
    // clicks and keys (bar Escape, which closes) from selecting or moving rows underneath.
    <div
      className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-hero/50 px-4 py-10 max-[600px]:px-2 max-[600px]:py-4"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.key !== "Escape" && e.stopPropagation()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        className="w-full max-w-3xl overflow-hidden rounded-inspector border border-line bg-surface text-text shadow-tip"
      >
        <div className="bg-hero px-5 pt-4 pb-[18px] text-hero-text max-[600px]:px-4">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[13px] leading-4 font-semibold tracking-[0.02em] text-hero-text2">Approved PRD</span>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="grid size-8 place-items-center rounded-lg text-hero-text2 hover:bg-hero-2 hover:text-hero-text"
            >
              <Icon name="x" size={20} />
            </button>
          </div>
          <h2 id={`${id}-title`} className="mt-1 font-display text-[22px] leading-[27px] font-bold tracking-[-0.01em]">
            Build roadmap
          </h2>
          <p className="mt-2 flex flex-wrap items-center gap-2">
            <Link
              href={`/documents/${prd.slug}/v/${prd.approved_version}`}
              className="inline-flex h-[26px] items-center rounded-full bg-hero-2 px-2.5 text-[13px] font-semibold text-hero-text underline-offset-2 hover:underline"
            >
              {prd.title} v{prd.approved_version}
            </Link>
            <span className="inline-flex h-[26px] items-center rounded-full bg-lime px-2.5 text-[13px] font-semibold text-on-lime">
              Approved
            </span>
            <InfoTip label="Build roadmap" align="start" side="bottom" hero>
              Agents turn the PRD&apos;s features, priorities and dependencies into roadmap items on Now / Next / Later,
              then write a roadmap draft that is reviewed and approved like a PRD. Each item links back to its PRD
              section.
            </InfoTip>
          </p>
        </div>
        <div className="space-y-5 px-5 py-4 text-[15px] max-[600px]:px-4">
          <div>
            <label htmlFor={`${id}-target`} className="mb-1.5 block text-[13px] leading-4 font-semibold tracking-[0.02em] text-text2">
              Roadmap
            </label>
            <select id={`${id}-target`} className={INPUT} value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">{existing ? `${existing.title} (next version)` : `New roadmap (${defaultSlug})`}</option>
              {others.map((d) => (
                <option key={d.id} value={d.slug}>
                  {d.title} (next version)
                </option>
              ))}
              <option value={NEW}>New roadmap with another name…</option>
            </select>
          </div>
          {target === NEW && (
            <input
              className={INPUT}
              aria-label="New roadmap slug"
              placeholder="new-roadmap-slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
            />
          )}

          {choice.live.error && <Notice tone="error">{choice.live.error}</Notice>}
          {!rec && !choice.live.error && <p className="text-text2">Loading…</p>}
          {rec && (
            <p
              className="flex flex-wrap items-center gap-2 rounded-button bg-accent-soft px-3 py-2 text-accent-ink"
              data-testid="recommendation"
            >
              <span className="text-[13px] font-semibold tracking-[0.02em]">Recommended</span>
              <span className="font-semibold">{rec.template.name}</span>
              {rec.theme && <span>· {rec.theme.name}</span>}
              <InfoTip label="Recommendation" align="start">
                {rec.reason}
              </InfoTip>
            </p>
          )}
          <TemplateThemePicker choice={choice} />

          {estimate && <EstimateSummary estimate={estimate} />}
          {error && <Notice tone="error">{error}</Notice>}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3 max-[600px]:px-4">
          <Button onClick={onClose}>Cancel</Button>
          <Button onClick={runEstimate} disabled={busy || !templateKey || (target === NEW && !slug.trim())}>
            {draft ? "Re-estimate" : "Estimate"}
          </Button>
          <Button variant="primary" onClick={start} disabled={busy || !estimate || !estimate.within_budget}>
            {estimate?.needs_approval ? "Ask an owner to approve" : "Start run"}
          </Button>
        </div>
      </div>
    </div>
  );
}
