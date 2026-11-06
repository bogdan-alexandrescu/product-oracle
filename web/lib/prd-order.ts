/**
 * PRDs keep one company order on every page (prd-order), the API's rule
 * (api/oracle/docs/prd_order.py): a PRD's position (an owner's Move up / Move down, 1 = first)
 * first; then, without one, the goal order of the goal it mainly serves; then its title.
 * GET /v1/documents carries each PRD's place as `order`; every list, filter or picker of PRDs
 * sorts by it (byPrdOrder, or usePrdOrder where the page holds only a PRD's slug or id).
 */
import { useCallback } from "react";

import { api, unwrap } from "@/lib/api/client";
import { useQuery } from "@/lib/use-query";

/** The fields the rule reads (a DocumentSummary is one). */
export type OrderedPrd = { title: string; order?: number | null };

/** The one PRD order, for Array.prototype.sort: by `order`, a PRD without one last, then by title. */
export function byPrdOrder(a: OrderedPrd, b: OrderedPrd): number {
  const oa = a.order ?? Infinity;
  const ob = b.order ?? Infinity;
  if (oa !== ob) return oa < ob ? -1 : 1;
  return a.title.toLowerCase().localeCompare(b.title.toLowerCase()) || a.title.localeCompare(b.title);
}

/** `prds` in the one PRD order (a new array). */
export function sortPrds<T extends OrderedPrd>(prds: readonly T[]): T[] {
  return [...prds].sort(byPrdOrder);
}

/** A PRD's place in the company order by its slug or id, read from the PRDs list; null until it loads or for a PRD it does not list. */
export function usePrdOrder(): (prd: { slug?: string | null; id?: string | null }) => number | null {
  const data = usePrds().data;
  return useCallback((prd) => data?.find((d) => d.slug === prd.slug || d.id === prd.id)?.order ?? null, [data]);
}

/** The one PRD order for PRDs a page holds by slug or id (and title), their places read with usePrdOrder. */
export function byPrdOrderOf(orderOf: ReturnType<typeof usePrdOrder>) {
  return (a: { slug?: string | null; id?: string | null; title: string }, b: { slug?: string | null; id?: string | null; title: string }) =>
    byPrdOrder({ title: a.title, order: orderOf(a) }, { title: b.title, order: orderOf(b) });
}

/** A picker of documents: the PRDs (`prds`, the kind=prd list) in the one PRD order first, then every other document of `all` in its own order (roadmaps keep their group); none until both load. */
export function prdsFirst<T extends OrderedPrd & { kind?: string | null }>(prds: readonly T[] | null | undefined, all: readonly T[] | null | undefined): T[] {
  if (!prds || !all) return [];
  return [...sortPrds(prds), ...all.filter((d) => (d.kind ?? "prd") !== "prd")];
}

/** The PRDs list (kind=prd, each with its `order`), the one query usePrdOrder reads too. */
export function usePrds() {
  return useQuery("prd-order", () => unwrap(api.GET("/v1/documents", { params: { query: { kind: "prd" } } })));
}
