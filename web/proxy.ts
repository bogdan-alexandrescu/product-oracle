import { NextResponse, type NextRequest } from 'next/server';

import { resolveRedirect } from '@/lib/redirects';

/** #1580: the redirect table (lib/redirects.ts), applied before any page renders. */
export function proxy(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;
  // A client navigation's RSC request carries Next's own `_rsc`: not part of the address.
  const query = new URLSearchParams(searchParams);
  query.delete('_rsc');
  const hit = resolveRedirect(pathname, query.toString());
  if (!hit) return NextResponse.next();
  return NextResponse.redirect(new URL(hit.to, request.url), hit.permanent ? 308 : 307);
}

// Each table entry's `from`, literally (Next reads the matcher at build time); lib/redirects.test.ts
// fails when the two differ.
export const config = {
  matcher: ['/roadmap', '/baseline/:path*', '/simple/prds/:doc', '/requests/new'],
};
