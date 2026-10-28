"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { EstimateSummary, type EstimateOut } from "@/app/runs/_lib";
import { TemplateThemePicker, useDraftChoice } from "@/components/NewDraft";
import { Button, Dialog, InfoTip, Notice } from "@/components/ds";
import { INPUT } from "@/components/ui";
import { api, unwrap, type Schemas, type VersionSource } from "@/lib/api/client";
import { getDraftRoadmap } from "@/lib/api/draft-roadmap";
import { useMe } from "@/lib/me";
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

/** Build roadmap on an approved PRD; shown to those who may start the run. */
export function BuildRoadmapButton({ prd, size }: { prd: ApprovedPrd; size?: "sm" | "md" }) {
  const { can } = useMe();
  const [open, setOpen] = useState(false);
  // #370: a prd_to_roadmap run (POST /v1/runs); the handler only keeps update_draft for owners.
  if (!can("create_run", true) || prd.approved_version == null) return null;
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
      {/* The Dialog draws on the body: the sticky document toolbar's backdrop blur would contain a fixed dialog. */}
      {open && <BuildRoadmapDialog prd={{ ...prd, approved_version: prd.approved_version }} onClose={() => setOpen(false)} />}
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
  // E1 part B: the run reuses the approved version's draft items unless asked to derive them again,
  // which is offered only when the version has ready draft items to reuse.
  const [deriveAgain, setDeriveAgain] = useState(false);
  const draftItems = useQuery(`draft-roadmap|${prd.slug}|${prd.approved_version}`, () =>
    getDraftRoadmap(prd.slug, prd.approved_version, "brief"),
  );
  const hasDraftItems = draftItems.data?.status === "ready" && draftItems.data.items.length > 0;
  const derive = hasDraftItems && deriveAgain;
  // The draft run and its estimate, for the inputs they were made with.
  const [draft, setDraft] = useState<{ id: string; inputs: string; estimate: EstimateOut } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Without a roadmap named, the API builds "<prd>-roadmap": its next version, or a new roadmap.
  const defaultSlug = `${prd.slug}-roadmap`;
  const existing = roadmaps.data?.find((d) => d.slug === defaultSlug);
  const others = (roadmaps.data ?? []).filter((d) => d.slug !== defaultSlug);
  const document = target === NEW ? slug.trim() : target;
  const inputs = JSON.stringify([document, templateKey, themeKey, derive]);
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
            knobs: { depth: "standard", roles: {}, checkpoints: {}, reuse_draft_items: !derive },
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

  // Anything the person picked or estimated: closing asks before it is thrown away.
  const dirty = !!target || !!slug.trim() || deriveAgain || !!draft;

  return (
    <Dialog
      title="Build roadmap"
      onClose={onClose}
      dirty={dirty}
      size="lg"
      testId="build-roadmap-dialog"
      head={
        <p className="mt-1.5 flex flex-wrap items-center gap-2">
          <span className="text-[13px] leading-4 font-semibold tracking-[0.02em] text-text2">Approved PRD</span>
          <Link
            href={`/documents/${prd.slug}/v/${prd.approved_version}`}
            className="inline-flex h-[26px] items-center rounded-full border border-line-strong px-2.5 text-[13px] font-semibold text-text underline-offset-2 hover:underline"
          >
            {prd.title} v{prd.approved_version}
          </Link>
          <span className="inline-flex h-[26px] items-center rounded-full bg-accent-soft px-2.5 text-[13px] font-semibold text-accent-ink">
            Approved
          </span>
          <InfoTip label="Build roadmap" align="start" side="bottom">
            Agents turn the PRD&apos;s features, priorities and dependencies into roadmap items on Now / Next / Later,
            then write a roadmap draft that is reviewed and approved like a PRD. Each item links back to its PRD
            section.
          </InfoTip>
        </p>
      }
      actions={
        <>
          <Button onClick={runEstimate} disabled={busy || !templateKey || (target === NEW && !slug.trim())}>
            {draft ? "Re-estimate" : "Estimate"}
          </Button>
          <Button variant="primary" onClick={start} disabled={busy || !estimate || !estimate.within_budget}>
            {estimate?.needs_approval ? "Ask an owner to approve" : "Start run"}
          </Button>
        </>
      }
    >
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

      {hasDraftItems && (
        <details className="text-[15px]" data-testid="build-roadmap-advanced">
          <summary className="cursor-pointer text-[13px] leading-4 font-semibold tracking-[0.02em] text-text2">Advanced options</summary>
          <div className="mt-2 flex items-center gap-2">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={deriveAgain} onChange={(e) => setDeriveAgain(e.target.checked)} />
              Derive the items again
            </label>
            <InfoTip label="Derive the items again" align="start">
              Oracle reuses the roadmap items already derived for this PRD version, so the Roadmap items step costs
              nothing. Tick this to derive them again, for example after the baseline changed.
            </InfoTip>
          </div>
        </details>
      )}

      {estimate && <EstimateSummary estimate={estimate} />}
      {error && <Notice tone="error">{error}</Notice>}
    </Dialog>
  );
}
