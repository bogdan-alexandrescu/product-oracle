'use client';

import { useEffect } from 'react';

/**
 * #1580: a page names the browser tab from its client view, not with Next's `metadata`, so
 * the same call works after the move off Next. Only the public pages AppShell leaves to name
 * themselves use it (a customer's interview link, a shared roadmap: AppShell's ownTitle);
 * every other page is named from its H1 by AppShell's DocumentTitle.
 */
export function useTitle(title: string) {
  useEffect(() => {
    document.title = title;
  }, [title]);
}
