/**
 * A page's props, typed here rather than with Next's generated `PageProps` global, which
 * exists only after a build (in the build directory): a plain `tsc --noEmit` checks the pages too.
 */
export type RouteProps<Params extends Record<string, string> = Record<string, never>> = {
  params: Promise<Params>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};
