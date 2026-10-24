import { Suspense } from "react";

import { Loading } from "@/components/ui";

import { AnalyticsSettings } from "./AnalyticsSettings";

export default function AnalyticsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <AnalyticsSettings />
    </Suspense>
  );
}
