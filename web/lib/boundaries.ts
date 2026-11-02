/**
 * The comments React writes before a streamed Suspense boundary whose content is not in
 * place yet: "$?" while it streams, "$~" while it waits to be shown. They are React's own,
 * not an API, so e2e/review-me-stream.spec.ts reads Next's React to check them.
 */
export const PENDING_MARKS: readonly string[] = ["$?", "$~"];

/** True while the page is still streaming in, or holds a boundary whose content is not in place yet. */
export function streamPending(): boolean {
  // The document is still loading while the server streams it, whatever React writes.
  if (document.readyState === "loading") return true;
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_COMMENT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (PENDING_MARKS.includes((n as Comment).data)) return true;
  }
  return false;
}

/** Resolves once every streamed boundary of the page is in place (at most 5 s). */
export function streamed(): Promise<void> {
  const start = performance.now();
  return new Promise((resolve) => {
    const check = () => (!streamPending() || performance.now() - start > 5000 ? resolve() : window.setTimeout(check, 20));
    check();
  });
}
