import { Suspense } from "react";

import { TemplateDetail } from "@/components/TemplateDetail";
import { Loading } from "@/components/ui";
import type { RouteProps } from "@/lib/route-props";

async function Detail({ params }: { params: RouteProps<{ key: string }>["params"] }) {
  const { key } = await params;
  return <TemplateDetail templateKey={key} />;
}

export default function TemplatePage({ params }: RouteProps<{ key: string }>) {
  return (
    <Suspense fallback={<div className="px-6 py-8"><Loading /></div>}>
      <Detail params={params} />
    </Suspense>
  );
}
