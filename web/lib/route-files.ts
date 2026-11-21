/**
 * #1581: which files under app/ are routes, for the router plugin (vite.config.mts) and the
 * guard (app/route-files.test.ts). Matched against each file and folder name: a `_`-prefixed
 * name (but `__root.tsx`) and any file other than page.tsx, layout.tsx, __root.tsx or `$.tsx`
 * (a catch-all) is not a route.
 */
export const ROUTE_FILE_IGNORE =
  '^_(?!_root\\.tsx$)|^(?!(page|layout|__root|\\$)\\.tsx$).+\\.\\w+$';
