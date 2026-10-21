import type { ReactNode } from "react";

/**
 * Route props in the shape Next's generated `PageProps` / `LayoutProps` globals have, so
 * `tsc --noEmit` type-checks the routes without a build's `next typegen` output.
 */
type SearchParams = Record<string, string | string[] | undefined>;

export type RouteProps<P extends Record<string, string>> = {
  params: Promise<P>;
  searchParams: Promise<SearchParams>;
};

export type RootLayoutProps = { children: ReactNode };
