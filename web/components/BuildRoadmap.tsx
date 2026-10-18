"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";

import { EstimateSummary, type EstimateOut } from "@/app/runs/_lib";
import { TemplateThemePicker, useDraftChoice } from "@/components/NewDraft";
import { Button, ErrorNote, INPUT, Loading } from "@/components/ui";
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
      <Button size={size} onClick={() => setOpen(true)}>
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
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-neutral-900/30 px-4 py-10">
      <div role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} className="w-full max-w-3xl rounded-lg border border-neutral-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-3">
          <h2 id={`${id}-title`} className="text-base font-semibold text-neutral-900">
            Build roadmap
          </h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            ✕
          </Button>
        </div>
        <div className="space-y-5 px-5 py-4 text-sm">
          <p className="text-neutral-700">
            From{" "}
            <Link href={`/documents/${prd.slug}/v/${prd.approved_version}`} className="font-medium underline underline-offset-2">
              {prd.title} v{prd.approved_version}
            </Link>{" "}
            (approved). Agents turn its features, priorities and dependencies into roadmap items on Now / Next / Later,
            then write a roadmap draft that is reviewed and approved like a PRD. Each item links back to its PRD section.
          </p>

          <div>
            <label htmlFor={`${id}-target`} className="mb-1 block font-medium text-neutral-800">
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

          {choice.live.error && <ErrorNote>{choice.live.error}</ErrorNote>}
          {!rec && !choice.live.error && <Loading />}
          {rec && (
            <p className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-neutral-800" data-testid="recommendation">
              Recommended: <span className="font-semibold">{rec.template.name}</span>
              {rec.theme && <> with the {rec.theme.name} theme</>}. {rec.reason}
            </p>
          )}
          <TemplateThemePicker choice={choice} />

          {estimate && <EstimateSummary estimate={estimate} />}
          {error && <ErrorNote>{error}</ErrorNote>}
        </div>
        <div className="flex justify-end gap-2 border-t border-neutral-200 px-5 py-3">
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
