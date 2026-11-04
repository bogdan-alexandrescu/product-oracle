import { Suspense } from "react";

import { DatesTab } from "../_dates";

/** F3 Plan › Dates (/plan/dates); ?prd=&dates= filters it to a roadmap's dates that lack a basis. */
export default function DatesPage() {
  return (
    <Suspense>
      <DatesTab />
    </Suspense>
  );
}
