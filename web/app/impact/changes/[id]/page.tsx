import { ImpactExplorer } from "@/app/impact/_explorer";
import type { RouteProps } from "@/lib/route-props";

/** v2 screen 2: the outputs a recorded change marked Potentially stale. */
export default async function ChangeImpactPage({ params }: RouteProps<{ id: string }>) {
  const { id } = await params;
  return <ImpactExplorer key={id} source={{ kind: "change", id }} />;
}
