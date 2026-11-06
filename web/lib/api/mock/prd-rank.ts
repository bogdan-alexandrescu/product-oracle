/**
 * prd-order (oracle.docs.prd_order.prd_ranks): the mock's routes rank PRDs in the one company
 * PRD order. server.ts names its prdOrder(db) here before every route, as knowCompanyGoals does
 * for the goal order; a route takes a ranker (prdRanker) once and sorts by it.
 */
type PrdRef = { id?: string | null; slug?: string | null };

let current: () => { order: Map<string, number>; docs: { id: string; slug: string }[] } = () => ({ order: new Map(), docs: [] });

/** server.ts: the company PRD order (prdOrder, by document id) and the documents it ranks, read when a route sorts. */
export function knowPrdOrder(read: typeof current): void {
  current = read;
}

/** A ranker of PRDs (by id or slug; a PRD it does not rank last): each PRD's place, 1 = first. */
export function prdRanker(): (prd: PrdRef | null | undefined) => number {
  const { order, docs } = current();
  const bySlug = new Map(docs.flatMap((d) => (order.has(d.id) ? [[d.slug, order.get(d.id)!] as const] : [])));
  return (prd) => (prd ? (order.get(prd.id ?? "") ?? bySlug.get(prd.slug ?? "") ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER);
}

/** Two PRDs in the company order, then by title, for Array.prototype.sort. */
export function byPrdRank(rank: ReturnType<typeof prdRanker>) {
  return (a: PrdRef & { title: string }, b: PrdRef & { title: string }) => rank(a) - rank(b) || a.title.localeCompare(b.title);
}
