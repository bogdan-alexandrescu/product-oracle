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
window.addEventListener('vite:preloadError', () => {
  if (sessionStorage.getItem('oracle-reloaded') === location.href) return;
  sessionStorage.setItem('oracle-reloaded', location.href);
  location.reload();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
