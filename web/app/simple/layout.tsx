"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { useSimpleShown } from "@/components/simple/SimpleShell";
import { SIMPLE_HOME } from "@/lib/experience";

/**
 * Simple's pages draw only once Simple is known to be on (#725 review: no flash while off).
 * Home is the exception: it starts its queries at once and draws its own skeleton until then
 * (#723 production walk: no blank first paint).
 */
export default function SimpleLayout({ children }: { children: ReactNode }) {
  const shown = useSimpleShown();
  const home = usePathname() === SIMPLE_HOME;
  return shown || home ? children : null;
}
