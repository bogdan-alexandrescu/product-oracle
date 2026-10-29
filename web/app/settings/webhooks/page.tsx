import { Suspense } from "react";

import { WebhooksSettings } from "./WebhooksSettings";
import { PageSkeleton } from "@/components/ds";

export default function WebhooksPage() {
  return (
    <Suspense fallback={<PageSkeleton bare />}>
      <WebhooksSettings />
    </Suspense>
  );
}
