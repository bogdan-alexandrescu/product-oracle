'use client';

import { Outlet, createFileRoute } from '@tanstack/react-router';
import { usePathname, useSearchParams } from '@/lib/nav';
import { Suspense, lazy, useEffect, useRef, type ReactNode } from 'react';

import { HomeSkeleton } from '@/app/simple/_home/skeleton';
import { LinkedDiscussion } from '@/components/discuss/LinkedDiscussion';
import { SimplePageSkeleton, useSimpleShown } from '@/components/simple/SimpleShell';
import { useMe } from '@/lib/me';
import { SIMPLE_HOME } from '@/lib/experience';

import { warmSimple } from './roadmap/_warm';

/**
 * Simple's pages draw only once Simple is known to be on (#725 review: no flash while off).
 * Home draws its frame and skeleton until then (#723 production walk: no blank first paint),
 * the other pages a page skeleton (qa-shell-20), and Home's queries start only once Simple is
 * on; nothing once Simple is known to be off. A discussion link (`?discussion=`, the Inbox's
 * Review changes) opens its thread on any Simple page (ask-phone QA row 3); a feature link
 * (`?feature=`) opens its panel (#1796).
 */
// Read only when a page's address names a feature, so no other page loads the panel for it.
const LinkedFeature = lazy(() =>
  import('./roadmap/_panel').then((m) => ({ default: m.LinkedFeature })),
);

function SimpleLayout() {
  // The pathname is read on the client only (a prerender draws nothing, as before).
  return (
    <Suspense fallback={null}>
      <Gate>
        <Outlet />
      </Gate>
    </Suspense>
  );
}

function Gate({ children }: { children: ReactNode }) {
  const shown = useSimpleShown();
  const { me, loading, capsReady, simpleMode } = useMe();
  const pathname = usePathname();
  const home = pathname === SIMPLE_HOME;
  const linked = !!useSearchParams().get('feature');
  // simple-speed: once, and only while who is signed in is not known yet (a cold load).
  const cold = useRef(loading);
  useEffect(() => {
    if (cold.current) warmSimple(window.location.pathname, window.location.search);
  }, []);
  if (shown)
    return (
      <>
        {children}
        <LinkedDiscussion />
        {linked && (
          <Suspense fallback={null}>
            <LinkedFeature />
          </Suspense>
        )}
      </>
    );
  if (me && capsReady && !simpleMode) return null;
  // qa-shell-20: every other Simple page shows its frame too, never a blank page.
  return home ? <HomeSkeleton /> : <SimplePageSkeleton />;
}

export const Route = createFileRoute('/simple')({ component: SimpleLayout });
