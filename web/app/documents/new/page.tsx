import { Suspense } from "react";

import { NewDraft, NewPrd } from "@/components/NewDraft";
import { Loading } from "@/components/ui";
import type { RouteProps } from "@/lib/route-props";

async function Picker({ searchParams }: { searchParams: RouteProps["searchParams"] }) {
  const { kind, requests } = await searchParams;
  const k = kind === "roadmap" ? "roadmap" : "prd";
  // C1 lane 2: Start a PRD on requests (`requests=<id,id>`) ticks them under "Requests behind it".
  const ids = (typeof requests === "string" ? requests.split(",") : []).filter(Boolean).slice(0, 50);
  // C4: New PRD is the brief door; the roadmap door is the template picker, unchanged.
  return k === "roadmap" ? <NewDraft key={k} kind={k} /> : <NewPrd key={`${k}:${ids.join(",")}`} requestIds={ids} />;
}

export default function NewDraftPage({ searchParams }: RouteProps) {
  return (
    <Suspense fallback={<div className="px-6 py-8"><Loading /></div>}>
      <Picker searchParams={searchParams} />
    </Suspense>
  );
}
