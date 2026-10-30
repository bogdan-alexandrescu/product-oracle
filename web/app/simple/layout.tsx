"use client";

import { usePathname } from "next/navigation";
import { Suspense, type ReactNode } from "react";

import { HomeSkeleton } from "@/app/simple/_home/skeleton";
import { SimplePageSkeleton, useSimpleShown } from "@/components/simple/SimpleShell";
import { useMe } from "@/lib/me";
import { SIMPLE_HOME } from "@/lib/experience";

/**
 * Simple's pages draw only once Simple is known to be on (#725 review: no flash while off).
 * Home draws its frame and skeleton until then (#723 production walk: no blank first paint),
 * the other pages a page skeleton (qa-shell-20), and Home's queries start only once Simple is
 * on; nothing once Simple is known to be off.
 */
export default function SimpleLayout({ children }: { children: ReactNode }) {
  // The pathname is read on the client only (a prerender draws nothing, as before).
  return (
    <Suspense fallback={null}>
      <Gate>{children}</Gate>
    </Suspense>
  );
}

function Gate({ children }: { children: ReactNode }) {
  const shown = useSimpleShown();
  const { me, capsReady, simpleMode } = useMe();
  const home = usePathname() === SIMPLE_HOME;
  if (shown) return children;
  if (me && capsReady && !simpleMode) return null;
  // qa-shell-20: every other Simple page shows its frame too, never a blank page.
  return home ? <HomeSkeleton /> : <SimplePageSkeleton />;
}
