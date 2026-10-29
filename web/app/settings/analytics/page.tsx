import { Suspense } from "react";

import { AnalyticsSettings } from "./AnalyticsSettings";
import { PageSkeleton } from "@/components/ds";

export default function AnalyticsPage() {
  return (
    <Suspense fallback={<PageSkeleton bare />}>
      <AnalyticsSettings />
    </Suspense>
  );
}
