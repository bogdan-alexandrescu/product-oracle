import { ImpactExplorer } from "@/app/impact/_explorer";
import type { RouteProps } from "@/lib/route-props";

/** v2 screen 2: what-if from a baseline item: the outputs built on it (a preview). */
export default async function EntityImpactPage({ params }: RouteProps<{ id: string }>) {
  const { id } = await params;
  return <ImpactExplorer key={id} source={{ kind: "entity", id }} />;
}
