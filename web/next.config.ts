import type { NextConfig } from "next";

// The browser talks to the API through this app (same origin), so the session
// cookie needs no CORS. Resolved at build time in production builds.
const apiUrl = process.env.API_INTERNAL_URL ?? "http://localhost:8000";

/**
 * Settings > Sources opens Google's Drive picker (lib/google-picker.ts). The page is
 * usually reached by in-app navigation, which keeps the CSP of the document first loaded,
 * so this policy is sent on every page. It allows Google's two scripts from their own
 * hosts, Google's picker frame (docs.google.com) and sign-in frame and requests
 * (accounts.google.com/gsi/), and no other outside host for scripts, frames or requests.
 * 'unsafe-inline' scripts cover Next's inline bootstrap and the theme script; development
 * adds 'unsafe-eval' for React and ws: for hot reload. Styles, images and fonts are left
 * open: theme previews (sandboxed srcdoc frames, which inherit this policy) may use any.
 */
const DEV = process.env.NODE_ENV !== "production";
const APP_CSP = [
  `script-src 'self' 'unsafe-inline'${DEV ? " 'unsafe-eval'" : ""} https://apis.google.com https://accounts.google.com/gsi/`,
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
  async rewrites() {
    return [
      { source: "/v1/:path*", destination: `${apiUrl}/v1/:path*` },
      { source: "/healthz", destination: `${apiUrl}/healthz` },
    ];
  },
};

export default nextConfig;
