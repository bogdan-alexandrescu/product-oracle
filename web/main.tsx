import { RouterProvider, createRouter } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { parseQuery, stringifyQuery } from './lib/router-query';
import { routeTree } from './routeTree.gen';
import { PageSkeleton } from '@/components/ds';

/**
 * #1581: the app is a single page served as static files (nginx in production, `vite preview`
 * for the Playwright suite). The query stays plain text, as the pages read it through
 * URLSearchParams (lib/nav.ts); a page whose param changes mounts afresh, as under Next.
 */
const router = createRouter({
  routeTree,
  notFoundMode: 'root',
  // qa-shell-10: a page whose code is still loading draws its skeleton, as Next's fallback did.
  defaultPendingComponent: PageSkeleton,
  defaultRemountDeps: ({ params }) => params,
  parseSearch: parseQuery,
  stringifySearch: stringifyQuery,
  scrollRestoration: true,
});

// A link changes the URL once the code of the page it opens has loaded, as under Next, so the
// address never names a page while the one before it is still on screen. Commits keep their order.
const commitLocation = router.commitLocation;
let committing: Promise<unknown> = Promise.resolve();
router.commitLocation = (next) => {
  const routes = next.external ? [] : router.getMatchedRoutes(next.pathname)[0];
  const code = Promise.all(routes.map((r) => router.loadRouteChunk(r))).catch(() => undefined);
  const done = Promise.all([code, committing]).then(() => commitLocation(next));
  committing = done.catch(() => undefined);
  return done;
};

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

// The mock build hands specs its router, to move inside the app as a link would.
if (process.env.VITE_API_MOCKS === '1') {
  (window as unknown as { __poRouter?: typeof router }).__poRouter = router;
}

// A chunk from an older deploy is gone (nginx answers 404, no-store): load the new build once.
// #1714: the mark is cleared once a page loads, so a later deploy reloads again; a browser that
// blocks storage throws here, and without the mark a reload could loop, so it does not reload.
const RELOADED = 'oracle-reloaded';
function reloadMark(write?: string | null): string | null | undefined {
  try {
    if (write === undefined) return sessionStorage.getItem(RELOADED);
    if (write === null) sessionStorage.removeItem(RELOADED);
    else sessionStorage.setItem(RELOADED, write);
    return write;
  } catch {
    return undefined;
  }
}
window.addEventListener('vite:preloadError', () => {
  const mark = reloadMark();
  if (mark === undefined || mark === location.href) return;
  if (reloadMark(location.href) === undefined) return;
  location.reload();
});
router.subscribe('onResolved', () => reloadMark(null));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
