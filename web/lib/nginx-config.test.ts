import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { nginxAnswer, nginxLocations } from './nginx-locations.testing';

/*
 * #1609, #1708: the web image's nginx config (nginx/default.conf.template and
 * nginx/40-oracle-config.sh), read as text and its regex locations run as JavaScript patterns.
 * protects=a redirect that sends a person to plain http on port 3000, a Location header split
 * by a decoded CR LF, an open redirect through a backslash, share and interview pages without
 * their no-referrer and noindex headers, and /v1 or /uploads answered with the app shell (200)
 * when the image has no API behind it;
 * fails_when=absolute_redirect is on, control characters reach the regex redirects, a redirect
 * target can start with "//" or "/\", the /i/ and /s/ headers are dropped, or the empty proxy
 * file comes back;
 * no_claim=nginx itself (no nginx here: the Docker build runs it).
 */

const NGINX = join(__dirname, '..', 'nginx');
const conf = readFileSync(join(NGINX, 'default.conf.template'), 'utf8');

test('redirects are relative, so nginx never adds the scheme or its own port', () => {
  expect(conf).toMatch(/^\s*absolute_redirect off;$/m);
});

test('a control character in the path is refused before any redirect copies it', () => {
  const guard = conf.indexOf('if ($uri ~ "[\\x00-\\x1f\\x7f]") { return 400; }');
  expect(guard).toBeGreaterThan(-1);
  expect(guard).toBeLessThan(conf.indexOf('location '));
});

test('no redirect sends a person to another host', () => {
  const locations = nginxLocations(conf);
  for (const path of [
    '/\\evil.com/',
    '/\\\\evil.com/',
    '/simple/prds/\\evil.com',
    '/baseline/\\x',
  ]) {
    for (const query of ['', 'a=1']) {
      const to = nginxAnswer(locations, path, query)?.to;
      if (to) expect(to, path).not.toMatch(/^(\/[/\\]|[a-z]+:)/i);
    }
  }
  // The trailing-slash rule still drops a slash on an ordinary path.
  expect(nginxAnswer(locations, '/plan/', 'a=1')).toEqual({ code: 308, to: '/plan?a=1' });
});

test('share and interview pages are the app shell with no-referrer and noindex', () => {
  const locations = nginxLocations(conf);
  for (const path of ['/i/example-token', '/s/example-token']) {
    const at = locations.find((l) => l.kind === '~' && new RegExp(l.pattern).test(path));
    expect(at, path).toBeDefined();
    expect(at!.body).toContain('add_header Referrer-Policy "no-referrer" always;');
    expect(at!.body).toContain('add_header X-Robots-Tag "noindex, nofollow" always;');
    expect(at!.body).toContain('include /etc/nginx/security-headers.conf;');
    expect(at!.body).toContain('add_header Cache-Control "no-cache" always;');
    expect(at!.body).toMatch(/try_files \/index\.html =404;/);
  }
  // Only those two: an ordinary page is not caught by them.
  const plan = locations.find((l) => l.kind === '~' && new RegExp(l.pattern).test('/plan'));
  expect(plan).toBeUndefined();
});

/** Runs 40-oracle-config.sh against a scratch copy of /etc/nginx; returns the proxy file. */
function renderProxy(apiUrl: string | undefined): string {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'nginx-'));
  mkdirSync(join(dir, 'oracle'));
  mkdirSync(join(dir, 'conf.d'));
  mkdirSync(join(dir, 'bin'));
  for (const name of ['default.conf.template', 'api-proxy.conf.template'])
    writeFileSync(join(dir, 'oracle', name), readFileSync(join(NGINX, name)));
  // A stand-in envsubst (the image has gettext's): the names it is given, from the environment.
  const envsubst = join(dir, 'bin', 'envsubst');
  writeFileSync(
    envsubst,
    "#!/bin/sh\nexec perl -pe 's/\\$\\{(API_INTERNAL_URL|ORACLE_GIT_SHA)\\}/$ENV{$1}/g'\n",
  );
  chmodSync(envsubst, 0o755);
  const env: Record<string, string> = {
    PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
    ORACLE_NGINX_DIR: dir,
  };
  if (apiUrl !== undefined) env.API_INTERNAL_URL = apiUrl;
  const r = spawnSync('sh', [join(NGINX, '40-oracle-config.sh')], { env, encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  expect(readFileSync(join(dir, 'conf.d', 'default.conf'), 'utf8')).toContain(
    '"git_sha":"unknown"',
  );
  return readFileSync(join(dir, 'api-proxy.conf'), 'utf8');
}

test('without an API behind the image, /v1 and /uploads are a 404, never the app shell', () => {
  for (const unset of [undefined, '']) {
    const locations = nginxLocations(renderProxy(unset));
    for (const prefix of ['/v1/', '/uploads/']) {
      const at = locations.find((l) => l.kind === '^~' && l.pattern === prefix);
      expect(at?.body.trim(), prefix).toBe('return 404;');
    }
  }
  const proxied = renderProxy('http://api.example.com:8000');
  expect(proxied).toContain('location ^~ /v1/ {\n    proxy_pass http://api.example.com:8000;');
  expect(proxied).toContain('location ^~ /uploads/ {\n    proxy_pass http://api.example.com:8000;');
  expect(proxied).not.toContain('return 404');
});
