import type { NextConfig } from "next";

// The browser talks to the API through this app (same origin), so the session
// cookie needs no CORS. Resolved at build time in production builds.
const apiUrl = process.env.API_INTERNAL_URL ?? "http://localhost:8000";

/**
 * Settings > Sources opens Google's Drive picker (lib/google-picker.ts). The page is
 * usually reached by in-app navigation, which keeps the CSP of the document first loaded,
 * so this policy is sent on every page. Everything defaults to this origin only
 * (default-src 'self'); on top of it the policy allows Google's two scripts from their own
 * hosts, Google's picker frame (docs.google.com), and Google sign-in's frame, requests and
 * stylesheet (accounts.google.com/gsi/), and images from the hosts Notion serves page
 * icons from (the Notion page picker shows only icons from those hosts:
 * settings/sources/NotionPicker.tsx, ICON_HOSTS), and no other outside host.
 * 'unsafe-inline' scripts cover Next's inline bootstrap and the theme script; development
 * adds 'unsafe-eval' for React and ws: for hot reload. Inline styles and data: images and
 * fonts are allowed: the picker's dialog and theme previews (sandboxed srcdoc frames,
 * which inherit this policy; theme CSS may use no URL but data:) use them.
 */
const NOTION_ICONS = [
  "https://notion.so",
  "https://*.notion.so",
  "https://notion.site",
  "https://*.notion.site",
  "https://notion-static.com",
  "https://*.notion-static.com",
  "https://prod-files-secure.s3.us-west-2.amazonaws.com",
].join(" ");
const DEV = process.env.NODE_ENV !== "production";
const APP_CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${DEV ? " 'unsafe-eval'" : ""} https://apis.google.com https://accounts.google.com/gsi/`,
  "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
  `img-src 'self' data: ${NOTION_ICONS}`,
  "font-src 'self' data:",
  "frame-src 'self' https://docs.google.com https://accounts.google.com/gsi/",
  `connect-src 'self'${DEV ? " ws:" : ""} https://accounts.google.com/gsi/`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join("; ");

const nextConfig: NextConfig = {
  // The Playwright suites build into their own directories (.next-mock, .next-e2e) and
  // serve them with `next start`; the default build (Docker image) is standalone.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  output: process.env.NEXT_DIST_DIR ? undefined : "standalone",
  cacheComponents: true,
  // Simple (#723) behind ORACLE_SIMPLE_MODE, off by default; on in the mock build, whose
  // specs drive Simple's screens (app/simple/_flag.ts).
  env: { ORACLE_SIMPLE_MODE: process.env.ORACLE_SIMPLE_MODE ?? (process.env.NEXT_PUBLIC_API_MOCKS === "1" ? "1" : "") },
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [{ source: "/:path*", headers: [{ key: "Content-Security-Policy", value: APP_CSP }] }];
  },
  // c7 Plan rename: the Roadmap page became Plan; old links and bookmarks keep working (308).
  async redirects() {
    return [
      { source: "/roadmap", destination: "/plan", permanent: true },
      // qa-simple-prd-12: a PRD's one-pager has one address (the rail, the links and the mode switch know it).
      { source: "/simple/prds/:doc", destination: "/simple/one-pagers/:doc", permanent: false },
    ];
  },
  async rewrites() {
    return [
      { source: "/v1/:path*", destination: `${apiUrl}/v1/:path*` },
      { source: "/healthz", destination: `${apiUrl}/healthz` },
      // O5 lane 4: the company's logos, served to members by the API.
      { source: "/uploads/:path*", destination: `${apiUrl}/uploads/:path*` },
    ];
  },
};

export default nextConfig;
