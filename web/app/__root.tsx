import { Outlet, createRootRoute, redirect } from '@tanstack/react-router';
import { Suspense, useEffect } from 'react';

import { AppShell } from '@/components/ds/AppShell';
import { ScrollbarRoom } from '@/components/ds/ScrollbarRoom';
import { CommandPalette } from '@/components/palette/Palette';
import { tellHubReady } from '@/lib/app-hub';
import { watchHubEdge } from '@/lib/app-hub-edge';
import { MeProvider, MeSync } from '@/lib/me';
import { resolveRedirect } from '@/lib/redirects';

import AppError from './error';
import NotFound from './not-found';
import './globals.css';

// The html, head, fonts and the before-paint theme and mode scripts are in index.html (#1581).
function RootLayout() {
  useEffect(() => tellHubReady(window), []);
  useEffect(() => watchHubEdge(window), []);
  return (
    <>
      <ScrollbarRoom />
      <MeProvider>
        <Suspense fallback={null}>
          <MeSync />
        </Suspense>
        <AppShell>
          <Outlet />
          <CommandPalette />
        </AppShell>
      </MeProvider>
    </>
  );
}

export const Route = createRootRoute({
  // #1580: the one redirect table (lib/redirects.ts), which nginx serves to a full page load.
  beforeLoad: ({ location }) => {
    const hit = resolveRedirect(location.pathname, location.searchStr);
    if (hit) throw redirect({ href: hit.to, replace: true, statusCode: hit.permanent ? 308 : 307 });
  },
  component: RootLayout,
  notFoundComponent: NotFound,
  errorComponent: ({ error, reset }) => <AppError error={error as Error} reset={reset} />,
});
