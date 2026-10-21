import type { ReactNode } from "react";

/*
 * Page and layout props by route, in the shapes Next's generated PageProps / LayoutProps
 * have. Those globals exist only after `next build` or `next typegen` (next-env.d.ts and
 * .next*\/types are not committed), so a fresh checkout's `tsc --noEmit` could not see them.
 */

/** "/documents/[doc]/v/[n]" -> { doc: string; n: string } */
type RouteParams<R extends string> = R extends `${string}[${infer K}]${infer Rest}`
  ? { [P in K]: string } & RouteParams<Rest>
  : unknown;

type Params<R extends string> = { [K in keyof RouteParams<R>]: RouteParams<R>[K] };

export type PageProps<R extends string> = {
  params: Promise<Params<R>>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export type LayoutProps<R extends string> = {
  children: ReactNode;
  params: Promise<Params<R>>;
};
