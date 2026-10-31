import { api, unwrap } from "@/lib/api/client";
import { useQuery } from "@/lib/use-query";

/**
 * What one Oracle run of a flow costs, from the flow catalog: each step's roles at the
 * given depth, as the run's estimate counts them, and whether that is over the approval
 * threshold (an owner approves it first). Null until the catalog loads. Used by New update,
 * Draft with Oracle (strategy) and New pricing memo, so the three say the same.
 */
export function useFlowCost(flowKey: string, depth = "standard"): { usd: number; over: boolean; threshold: number } | null {
  const catalog = useQuery("flows", () => unwrap(api.GET("/v1/flows")));
  const c = catalog.data;
  const flow = c?.flows.find((f) => f.key === flowKey);
  if (!c || !flow) return null;
  const base = flow.segments.reduce((sum, seg) => sum + seg.roles.reduce((n, r) => n + (c.roles.find((x) => x.key === r)?.base_usd ?? 0), 0), 0);
  const usd = Math.round(base * (c.depths[depth] ?? 1) * 100) / 100;
  return { usd, over: usd > c.approval_threshold_usd, threshold: c.approval_threshold_usd };
}
