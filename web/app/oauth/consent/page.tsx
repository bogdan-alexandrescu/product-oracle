import { Suspense } from "react";

import { ConsentScreen } from "./ConsentScreen";

export default function ConsentPage() {
  return (
    <Suspense>
      <ConsentScreen />
    </Suspense>
  );
}
