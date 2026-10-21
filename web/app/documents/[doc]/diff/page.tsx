import { Suspense } from "react";

import { DiffView } from "@/components/DiffView";
import { Loading } from "@/components/ui";
import type { RouteProps } from "@/lib/route-props";

type Props = RouteProps<{ doc: string }>;

function num(v: string | string[] | undefined): number | undefined {
  const n = Number(Array.isArray(v) ? v[0] : v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

async function Diff({ params, searchParams }: Pick<Props, "params" | "searchParams">) {
  const [{ doc }, q] = await Promise.all([params, searchParams]);
  return <DiffView doc={doc} from={num(q.from)} to={num(q.to)} />;
}

export default function DiffPage({ params, searchParams }: Props) {
  return (
    <Suspense fallback={<div className="px-6 py-8"><Loading /></div>}>
      <Diff params={params} searchParams={searchParams} />
    </Suspense>
  );
}
