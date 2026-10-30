import { Suspense } from "react";

import { ThemeDetail } from "@/components/ThemeDetail";
import type { RouteProps } from "@/lib/route-props";
import { PageSkeleton } from "@/components/ds";

async function Detail({ params }: { params: RouteProps<{ key: string }>["params"] }) {
  const { key } = await params;
  return <ThemeDetail themeKey={key} />;
}

export default function ThemePage({ params }: RouteProps<{ key: string }>) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Detail params={params} />
    </Suspense>
  );
}
