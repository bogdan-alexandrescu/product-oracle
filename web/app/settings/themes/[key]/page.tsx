import { Suspense } from "react";

import { ThemeDetail } from "@/components/ThemeDetail";
import { Loading } from "@/components/ui";
import type { RouteProps } from "@/lib/route-props";

async function Detail({ params }: { params: RouteProps<{ key: string }>["params"] }) {
  const { key } = await params;
  return <ThemeDetail themeKey={key} />;
}

export default function ThemePage({ params }: RouteProps<{ key: string }>) {
  return (
    <Suspense fallback={<div className="px-6 py-8"><Loading /></div>}>
      <Detail params={params} />
    </Suspense>
  );
}
