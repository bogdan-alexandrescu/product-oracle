import { Suspense } from "react";

import { RebuildSeenHere } from "@/components/RebuildSign";

/** Every pane of a version: opening it ends the rebuild sign's "v<n> ready: review it". */
export default function VersionLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Suspense fallback={null}>
        <RebuildSeenHere />
      </Suspense>
      {children}
    </>
  );
}
