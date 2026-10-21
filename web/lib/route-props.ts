/**
 * A page's props, typed here rather than with Next's generated `PageProps<route>` global, which
 * exists only once a build has generated the route types: `tsc --noEmit` passes on a clean checkout.
 */
export type RouteProps<P extends Record<string, string> = Record<string, never>> = {
  params: Promise<P>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};
