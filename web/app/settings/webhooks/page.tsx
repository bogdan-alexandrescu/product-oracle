import { Suspense } from "react";

import { Loading } from "@/components/ui";

import { WebhooksSettings } from "./WebhooksSettings";

export default function WebhooksPage() {
  return (
    <Suspense fallback={<Loading />}>
      <WebhooksSettings />
    </Suspense>
  );
}
