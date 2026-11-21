// #1579: the only import for links and navigation. Pages and components import from here,
// never from the router itself (the lint ban in eslint.config.mjs); a lane that adds a next/*
// import runs `node scripts/nav-codemod.mjs` to re-point it. #1581: TanStack Router behind the
// names Next had, so no page changed in the move.
import {
  notFound as routerNotFound,
  redirect as routerRedirect,
  useParams as useRouterParams,
  useRouter as useTanstackRouter,
  useRouterState,
} from '@tanstack/react-router';
import {
  createElement,
  useMemo,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from 'react';

type Href = string;

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  href: Href;
  replace?: boolean;
  scroll?: boolean;
  prefetch?: boolean | null;
  children?: ReactNode;
  ref?: Ref<HTMLAnchorElement>;
};

/** A path in this app (not another site, a hash or a mailto). */
function inApp(href: string): boolean {
  return href.startsWith('/') && !href.startsWith('//');
}

/** An anchor that moves inside the app without a page load (a modified click opens a tab). */
function Link({ href, replace, scroll, prefetch, onClick, target, ...rest }: LinkProps) {
  void prefetch;
  const router = useTanstackRouter();
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if ((target && target !== '_self') || rest.download != null || !inApp(href)) return;
    e.preventDefault();
    void router.navigate({ href, replace, resetScroll: scroll !== false });
  };
  return createElement('a', { ...rest, href, target, onClick: handle });
}

const trimSlash = (p: string) => p.replace(/\/+$/, '') || '/';

/**
 * The location the page shows: during a navigation the router's own moves first, and the new
 * page renders before resolvedLocation follows it (#1581), so it is the location once the
 * rendered leaf match is its own.
 */
function useShownLocation() {
  return useRouterState({
    select: (s) => {
      const leaf = s.matches[s.matches.length - 1];
      const shown =
        leaf &&
        trimSlash(leaf.pathname) === trimSlash(s.location.pathname) &&
        JSON.stringify(leaf.search) === JSON.stringify(s.location.search);
      return shown ? s.location : (s.resolvedLocation ?? s.location);
    },
  });
}

function usePathname(): string {
  return useShownLocation().pathname;
}

class ReadonlyURLSearchParams extends URLSearchParams {}

function useSearchParams(): ReadonlyURLSearchParams {
  const searchStr = useShownLocation().searchStr;
  return useMemo(() => new ReadonlyURLSearchParams(searchStr), [searchStr]);
}

function useParams<T extends Record<string, string | string[]> = Record<string, string>>(): T {
  return useRouterParams({ strict: false }) as unknown as T;
}

type NavigateOptions = { scroll?: boolean };

function useRouter() {
  const router = useTanstackRouter();
  return useMemo(
    () => ({
      push: (href: string, opts?: NavigateOptions) =>
        void router.navigate({ href, resetScroll: opts?.scroll !== false }),
      replace: (href: string, opts?: NavigateOptions) =>
        void router.navigate({ href, replace: true, resetScroll: opts?.scroll !== false }),
      back: () => router.history.back(),
      forward: () => router.history.forward(),
      refresh: () => void router.invalidate(),
      prefetch: (href: string) =>
        void router.preloadRoute({ to: href.split(/[?#]/)[0] } as never).catch(() => undefined),
    }),
    [router],
  );
}

/** The root's not-found page (notFoundMode "root"), thrown from a page as Next's was. */
function notFound(): never {
  throw routerNotFound();
}

function redirect(href: string): never {
  throw routerRedirect({ href });
}

function permanentRedirect(href: string): never {
  throw routerRedirect({ href, statusCode: 308 });
}

function useSelectedLayoutSegments(): string[] {
  return usePathname().split('/').filter(Boolean);
}

function useSelectedLayoutSegment(): string | null {
  return useSelectedLayoutSegments()[0] ?? null;
}

export {
  Link,
  ReadonlyURLSearchParams,
  notFound,
  permanentRedirect,
  redirect,
  useParams,
  usePathname,
  useRouter,
  useSearchParams,
  useSelectedLayoutSegment,
  useSelectedLayoutSegments,
};
export type { LinkProps };
