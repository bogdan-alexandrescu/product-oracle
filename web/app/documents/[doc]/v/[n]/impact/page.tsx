import { ImpactExplorer } from "@/app/impact/_explorer";
import type { RouteProps } from "@/lib/route-props";

/** v2 screen 2: what a PRD version changes for the outputs built on earlier versions (a preview). */
export default async function VersionImpactPage({ params }: RouteProps<{ doc: string; n: string }>) {
  const { doc, n } = await params;
  return <ImpactExplorer key={`${doc}/${n}`} source={{ kind: "version", doc, n: Number(n) }} />;
}
