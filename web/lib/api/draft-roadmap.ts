import { api, unwrap, type Schemas } from "@/lib/api/client";

/**
 * E1 Roadmap per PRD draft: the four routes under
 * /v1/documents/{doc}/versions/{n}/roadmap-items and /v1/documents/{doc}/roadmap-items/settings.
 */
export type DraftRoadmapStatus = Schemas["DraftRoadmapOut"]["status"];

export type DraftRoadmapProblem = { code: string; item: string | null; message: string };

/** `check` as the run's items check returns it (the API types it as an open object). */
export type DraftRoadmapCheck = {
  items: number;
  by_horizon: { now: number; next: number; later: number };
  problems: DraftRoadmapProblem[];
};

export type DraftRoadmapOut = Omit<Schemas["DraftRoadmapOut"], "check"> & { check: DraftRoadmapCheck | null };

/** `VersionOut.draft_roadmap`, PRD versions only (null on roadmap versions). */
export type DraftRoadmapSummary = Schemas["DraftRoadmapSummary"];

export type DraftRoadmapSettings = Schemas["DraftRoadmapSettings"];

export type DeriveIn = Schemas["DeriveIn"];

export async function getDraftRoadmap(doc: string, n: number, view: "full" | "brief" = "full"): Promise<DraftRoadmapOut> {
  const out = await unwrap(
    api.GET("/v1/documents/{doc}/versions/{n}/roadmap-items", { params: { path: { doc, n }, query: { view } } }),
  );
  return out as DraftRoadmapOut;
}

export async function deriveDraftRoadmap(doc: string, n: number, body: DeriveIn = { depth: "standard" }): Promise<DraftRoadmapOut> {
  const out = await unwrap(
    api.POST("/v1/documents/{doc}/versions/{n}/roadmap-items/derive", { params: { path: { doc, n } }, body }),
  );
  return out as DraftRoadmapOut;
}

export function getDraftRoadmapSettings(doc: string): Promise<DraftRoadmapSettings> {
  return unwrap(api.GET("/v1/documents/{doc}/roadmap-items/settings", { params: { path: { doc } } }));
}

export function putDraftRoadmapSettings(doc: string, body: DraftRoadmapSettings): Promise<DraftRoadmapSettings> {
  return unwrap(api.PUT("/v1/documents/{doc}/roadmap-items/settings", { params: { path: { doc } }, body }));
}

/** A version's `draft_roadmap` summary (null on roadmap versions). */
export function draftRoadmapOf(version: Schemas["VersionOut"] | null | undefined): DraftRoadmapSummary | null {
  return version?.draft_roadmap ?? null;
}
