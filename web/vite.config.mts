import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin, type UserConfig } from 'vite';

import { appCsp } from './lib/csp';
import { ROUTE_FILE_IGNORE } from './lib/route-files';

/**
 * #1581: the web's Vite config for dev, build and preview, after ai-studio's createViteConfig.
 * Routes are the files under app/ (TanStack's file convention: page.tsx is a route's index,
 * layout.tsx its layout, `$name` a param); every other file there is ignored
 * (lib/route-files.ts). `vite build --mode mock` builds the mock app into dist-mock.
 */

const API_PATHS = ['/v1', '/uploads', '/healthz'];

/** #1569: the commit this build serves at /version (nginx answers it in the image). */
function versionRoute(): Plugin {
  const serve = (server: { middlewares: { use: (path: string, fn: never) => void } }) =>
    server.middlewares.use('/version', ((
      _req: unknown,
      res: { setHeader: (k: string, v: string) => void; end: (b: string) => void },
    ) => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ git_sha: process.env.ORACLE_GIT_SHA || 'unknown' }));
    }) as never);
  return { name: 'oracle-version', configureServer: serve, configurePreviewServer: serve };
}

export function createViteConfig(command: 'build' | 'serve', mode: string): UserConfig {
  const root = fileURLToPath(new URL('.', import.meta.url));
  const env = loadEnv(mode, root, '');
  const mock = env.VITE_API_MOCKS === '1';
  // Until the deploy writes the VITE_ name, its .env.production's old names turn Simple on.
  const simple = [
    env.VITE_ORACLE_SIMPLE_MODE,
    env.NEXT_PUBLIC_ORACLE_SIMPLE_MODE,
    env.ORACLE_SIMPLE_MODE,
  ].includes('1');
  const api = env.API_INTERNAL_URL || 'http://localhost:8000';
  const proxy = mock
    ? undefined
    : Object.fromEntries(
        API_PATHS.map((p) => [p, { target: api, timeout: 120_000, proxyTimeout: 120_000 }]),
      );
  return {
    root,
    plugins: [
      tanstackRouter({
        target: 'react',
        autoCodeSplitting: true,
        routesDirectory: './app',
        generatedRouteTree: './routeTree.gen.ts',
        indexToken: 'page',
        routeToken: 'layout',
        routeFileIgnorePattern: ROUTE_FILE_IGNORE,
      }),
      react(),
      tailwindcss(),
      versionRoute(),
    ],
    resolve: { alias: { '@': root } },
    // Tailwind's output goes through Lightning CSS only: PostCSS rejects some arbitrary-property
    // rules Tailwind makes from text in the source (a citation such as "[c:x]").
    css: { transformer: 'lightningcss' },
    define: { 'import.meta.env.VITE_ORACLE_SIMPLE_MODE': JSON.stringify(simple ? '1' : '') },
    server: {
      port: 3000,
      proxy,
      headers: { 'Content-Security-Policy': appCsp(command === 'serve') },
    },
    preview: { port: 3000, proxy, headers: { 'Content-Security-Policy': appCsp(false) } },
    build: {
      outDir: mode === 'production' || mode === 'development' ? 'dist' : `dist-${mode}`,
      assetsDir: 'assets',
      emptyOutDir: true,
    },
  };
}

export default defineConfig(({ command, mode }) => createViteConfig(command, mode));
