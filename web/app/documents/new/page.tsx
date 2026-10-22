import { Suspense } from "react";

import { NewDraft, NewPrd } from "@/components/NewDraft";
import { Loading } from "@/components/ui";
import type { RouteProps } from "@/lib/route-props";

async function Picker({ searchParams }: { searchParams: RouteProps["searchParams"] }) {
  const { kind } = await searchParams;
  const k = kind === "roadmap" ? "roadmap" : "prd";
  // C4: New PRD is the brief door; the roadmap door is the template picker, unchanged.
  return k === "roadmap" ? <NewDraft key={k} kind={k} /> : <NewPrd key={k} />;
}

export default function NewDraftPage({ searchParams }: RouteProps) {
  return (
    <Suspense fallback={<div className="px-6 py-8"><Loading /></div>}>
      <Picker searchParams={searchParams} />
    </Suspense>
  );
}
