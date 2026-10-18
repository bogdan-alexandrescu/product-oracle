import { Suspense } from "react";

import { PresentMode } from "@/components/PresentMode";
import { Loading } from "@/components/ui";

type Props = PageProps<"/documents/[doc]/v/[n]/present">;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

async function Present({ params, searchParams }: Pick<Props, "params" | "searchParams">) {
  const [{ doc, n }, q] = await Promise.all([params, searchParams]);
  const slide = Number(first(q.slide));
  return (
    <PresentMode
      key={`${doc}/${n}`}
      doc={doc}
      n={Number(n)}
      presenter={first(q.view) === "presenter"}
      start={Number.isInteger(slide) && slide > 0 ? slide : 1}
    />
  );
}

export default function PresentPage({ params, searchParams }: Props) {
  return (
    <Suspense fallback={<div className="px-6 py-8"><Loading /></div>}>
      <Present params={params} searchParams={searchParams} />
    </Suspense>
  );
}
