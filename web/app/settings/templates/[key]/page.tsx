import { Suspense } from "react";

import { TemplateDetail } from "@/components/TemplateDetail";
import type { RouteProps } from "@/lib/route-props";
import { PageSkeleton } from "@/components/ds";

async function Detail({ params }: { params: RouteProps<{ key: string }>["params"] }) {
  const { key } = await params;
  return <TemplateDetail templateKey={key} />;
}

export default function TemplatePage({ params }: RouteProps<{ key: string }>) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Detail params={params} />
    </Suspense>
  );
}
