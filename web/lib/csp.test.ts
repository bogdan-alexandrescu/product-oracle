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

/*
 * protects=the Saga apps hub showing Oracle in its frame, and every other site being refused;
 * fails_when=frame-ancestors drops a hub host or allows a host beyond this origin and the hub;
 * no_claim=that the hub's own frame loads the app (the browser enforces the header).
 */
test('only this origin and the Saga apps hub may frame the app', () => {
  for (const dev of [false, true]) {
    const ancestors = appCsp(dev)
      .split('; ')
      .find((directive) => directive.startsWith('frame-ancestors '));
    expect(ancestors).toBe(
      "frame-ancestors 'self' https://hub.saga.xyz https://hub.galatia.saga.xyz",
    );
  }
});
