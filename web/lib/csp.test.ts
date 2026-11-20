import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { appCsp } from './csp';

/*
 * #1581: one CSP for `vite dev`/`vite preview` (vite.config.mts) and nginx.
 * protects=the image sending another policy than the one the app is tested under;
 * fails_when=nginx/security-headers.conf's policy is not appCsp(false) word for word;
 * no_claim=the header on each nginx location (the nginx config includes the file in each).
 */
test("nginx's policy is the app's production policy", () => {
  const conf = readFileSync(join(__dirname, '..', 'nginx', 'security-headers.conf'), 'utf8');
  const sent = conf.match(/add_header Content-Security-Policy "([^"]+)" always;/)?.[1];
  expect(sent).toBe(appCsp(false));
  expect(appCsp(false)).not.toContain('unsafe-eval');
  expect(appCsp(true)).toContain("'unsafe-eval'");
});
