"use client";

import type { ReactNode } from "react";

import { useSimpleShown } from "@/components/simple/SimpleShell";

/** Simple's pages draw only once Simple is known to be on (#725 review: no flash while off). */
export default function SimpleLayout({ children }: { children: ReactNode }) {
  return useSimpleShown() ? children : null;
}
