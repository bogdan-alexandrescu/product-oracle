// #1579: the only import for links and navigation. Pages and components import from here,
// never from next/link or next/navigation (the lint ban in eslint.config.mjs); a lane that
// adds a next/* import runs `node scripts/nav-codemod.mjs` to re-point it. Today these are
// Next's own, so behaviour is unchanged; a move off Next changes this file only.
export { default as Link } from "next/link";
export type { LinkProps } from "next/link";
export {
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
} from "next/navigation";
