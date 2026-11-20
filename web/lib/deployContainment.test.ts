// #1569: node --test web/lib/deployContainment.test.ts (Node's own runner; no new package).
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { containment, servedSha } from "./deployContainment.ts";

const A = "1111111111111111111111111111111111111111";
const B = "2222222222222222222222222222222222222222";
const never = () => false;

test("the served commit is read from a version route's body", () => {
  assert.equal(servedSha({ git_sha: A }), A);
  assert.equal(servedSha({ git_sha: "1111111" }), "1111111");
  assert.equal(servedSha({ git_sha: "unknown" }), null);
  assert.equal(servedSha({ sha: A }), null);
  assert.equal(servedSha("nope"), null);
  assert.equal(servedSha(null), null);
});

test("0 served: every service serves the commit", () => {
  const r = containment(A, [
    { url: "https://api.example.com/version", sha: A },
    { url: "https://web.example.com/version", sha: A.slice(0, 12) },
  ], never);
  assert.equal(r.exit, 0);
});

test("0 served: a later commit that contains it", () => {
  const r = containment(A, [{ url: "https://api.example.com/version", sha: B }], (t, s) => t === A && s === B);
  assert.equal(r.exit, 0);
});

test("1 not served: one service serves a commit without it", () => {
  const r = containment(A, [
    { url: "https://api.example.com/version", sha: A },
    { url: "https://web.example.com/version", sha: B },
  ], never);
  assert.equal(r.exit, 1);
  assert.match(r.lines.join("\n"), /web\.example\.com.*not served/);
});

test("2 could not ask: a service did not answer", () => {
  const r = containment(A, [
    { url: "https://api.example.com/version", sha: A },
    { url: "https://web.example.com/version", error: "HTTP 503" },
  ], never);
  assert.equal(r.exit, 2);
});

test("2 could not ask: git can not tell whether the served commit contains it", () => {
  const r = containment(A, [{ url: "https://api.example.com/version", sha: B }], () => null);
  assert.equal(r.exit, 2);
});

test("1 wins over 2: a service that does not serve it is an answer", () => {
  const r = containment(A, [
    { url: "https://api.example.com/version", sha: B },
    { url: "https://web.example.com/version", error: "timed out" },
  ], never);
  assert.equal(r.exit, 1);
});

test("no service to ask is 2", () => {
  assert.equal(containment(A, [], never).exit, 2);
});

// The script end to end, against a local server standing in for the services.
const SCRIPT = fileURLToPath(new URL("../scripts/deploy-serves.ts", import.meta.url));

async function serving(routes: Record<string, [number, string]>, seen: (string | undefined)[] = []) {
  const server = createServer((req, res) => {
    seen.push(req.headers.authorization);
    const [code, body] = routes[req.url ?? ""] ?? [404, "not found"];
    res.writeHead(code, { "content-type": "application/json" });
    res.end(body);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((done) => server.close(() => done())) };
}

// A scratch repository: TARGET, LATER (which contains it) and OTHER (a branch beside it).
function scratchRepo() {
  const dir = mkdtempSync(join(tmpdir(), "deploy-serves-"));
  const git = (...a: string[]) =>
    execFileSync("git", ["-c", "user.name=Example Dev", "-c", "user.email=dev@example.com", ...a], {
      cwd: dir,
      encoding: "utf8",
    }).trim();
  git("init", "-q");
  const commit = (m: string) => (git("commit", "-q", "--allow-empty", "-m", m), git("rev-parse", "HEAD"));
  const base = commit("base");
  const target = commit("target");
  const later = commit("later");
  git("checkout", "-q", "-b", "side", base);
  const other = commit("other");
  return { dir, target, later, other, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

async function run(args: string[], cwd?: string, env: Record<string, string> = {}) {
  // Async, so the stand-in server above keeps answering while the script runs.
  return new Promise<number | null>((done) => {
    const child = spawn(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", SCRIPT, ...args], {
      cwd,
      env: { ...process.env, ORACLE_VERSION_TOKEN: "", ...env },
      stdio: "ignore",
    });
    child.on("exit", (code) => done(code));
  });
}

test("deploy-serves exits 0, 1 or 2", async () => {
  const repo = scratchRepo();
  const s = await serving({
    "/api": [200, JSON.stringify({ git_sha: repo.target })],
    "/later": [200, JSON.stringify({ git_sha: repo.later })],
    "/other": [200, JSON.stringify({ git_sha: repo.other })],
    "/stranger": [200, JSON.stringify({ git_sha: A })],
    "/unstamped": [200, JSON.stringify({ git_sha: "unknown" })],
    "/down": [503, "{}"],
  });
  const check = (...urls: string[]) => run([repo.target, ...urls.map((u) => `${s.base}${u}`)], repo.dir);
  try {
    assert.equal(await check("/api", "/later"), 0);
    assert.equal(await check("/api", "/other"), 1);
    assert.equal(await check("/api", "/down"), 2);
    assert.equal(await check("/api", "/unstamped"), 2);
    assert.equal(await check("/api", "/stranger"), 2);
    assert.equal(await run([repo.target, "http://127.0.0.1:1/version"], repo.dir), 2);
  } finally {
    await s.close();
    repo.remove();
  }
});

test("deploy-serves sends ORACLE_VERSION_TOKEN as a bearer token, and nothing without it", async () => {
  const repo = scratchRepo();
  const seen: (string | undefined)[] = [];
  const s = await serving({ "/api": [200, JSON.stringify({ git_sha: repo.target })] }, seen);
  try {
    assert.equal(await run([repo.target, `${s.base}/api`], repo.dir, { ORACLE_VERSION_TOKEN: "example-id-token" }), 0);
    assert.equal(await run([repo.target, `${s.base}/api`], repo.dir), 0);
    assert.deepEqual(seen, ["Bearer example-id-token", undefined]);
  } finally {
    await s.close();
    repo.remove();
  }
});

test("deploy-serves without a commit or a service is a usage error: 2", () => {
  assert.equal(spawnSync(process.execPath, [SCRIPT]).status, 2);
  assert.equal(spawnSync(process.execPath, [SCRIPT, A]).status, 2);
  assert.equal(spawnSync(process.execPath, [SCRIPT, A, "http://127.0.0.1:1/version", "--wait", ""]).status, 2);
  assert.equal(spawnSync(process.execPath, [SCRIPT, A, "http://127.0.0.1:1/version", "--wait", "-5"]).status, 2);
});
