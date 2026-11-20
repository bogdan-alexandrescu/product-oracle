import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Unit tests beside their module (#1583): pure logic in `*.test.ts` runs in Node; a render
 * test, `*.test.tsx`, beside its component in happy-dom with Testing Library. Flows a person
 * drives stay in Playwright (e2e/).
 */
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    projects: [
      {
        extends: true,
        test: { name: "logic", environment: "node", include: ["{app,components,lib}/**/*.test.ts"] },
      },
      {
        extends: true,
        test: {
          name: "render",
          environment: "happy-dom",
          include: ["{app,components,lib}/**/*.test.tsx"],
          setupFiles: ["./vitest.setup.ts"],
        },
      },
    ],
  },
});
