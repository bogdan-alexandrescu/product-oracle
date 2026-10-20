import type { NextConfig } from "next";

// The browser talks to the API through this app (same origin), so the session
// cookie needs no CORS. Resolved at build time in production builds.
const apiUrl = process.env.API_INTERNAL_URL ?? "http://localhost:8000";

/**
 * Settings > Sources opens Google's Drive picker (lib/google-picker.ts). Its CSP lets the
 * page load Google's two scripts from their own hosts and Google's picker and sign-in
 * frames, and nothing else outside this origin. 'unsafe-inline' scripts cover Next's
 * inline bootstrap and the theme script; development adds 'unsafe-eval' for React.
 */
const SOURCES_CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "production" ? "" : " 'unsafe-eval'"} https://apis.google.com https://accounts.google.com/gsi/`,
  "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
  "frame-src 'self' blob: https://docs.google.com https://accounts.google.com/gsi/",
  `connect-src 'self'${process.env.NODE_ENV === "production" ? "" : " ws:"} https://accounts.google.com/gsi/`,
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
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
    return [{ source: "/settings/sources", headers: [{ key: "Content-Security-Policy", value: SOURCES_CSP }] }];
  },
  async rewrites() {
    return [
      { source: "/v1/:path*", destination: `${apiUrl}/v1/:path*` },
      { source: "/healthz", destination: `${apiUrl}/healthz` },
    ];
  },
};

export default nextConfig;
