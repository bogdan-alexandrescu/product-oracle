import { Suspense } from "react";

import { ConnectionsSettings } from "./ConnectionsSettings";

export default function ConnectionsPage() {
  return (
    <Suspense>
      <ConnectionsSettings />
    </Suspense>
  );
}
