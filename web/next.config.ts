import type { NextConfig } from "next";

// The browser talks to the API through this app (same origin), so the session
// cookie needs no CORS. Resolved at build time in production builds.
const apiUrl = process.env.API_INTERNAL_URL ?? "http://localhost:8000";

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
  async rewrites() {
    return [
      { source: "/v1/:path*", destination: `${apiUrl}/v1/:path*` },
      { source: "/healthz", destination: `${apiUrl}/healthz` },
    ];
  },
};

export default nextConfig;
