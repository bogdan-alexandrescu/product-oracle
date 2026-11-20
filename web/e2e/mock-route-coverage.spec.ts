import fs from "node:fs";
import path from "node:path";

import { expect, test } from "./test";

/**
 * #1587: the mock API (web/lib/api/mock) answers every route a page reads. A page's read is
 * each `.GET("/route")` in web/app, web/components and web/lib (the mock aside); a mock
 * answers it when one of its replies names the route, `reply(path, "get", body)` (typed
 * against schema.d.ts, so its body cannot drift from the API's) or `rawReply` for a body that
 * is not JSON (lib/api/mock/typed.ts).
 * fails_when = a page reads a route the mock has no typed reply for, a page reads a route that
 * is not in openapi.json, or a route in RUNS_LEFT is typed (then drop it from the list).
 */

const WEB = path.resolve(__dirname, "..");
const MOCK_SOURCES = ["lib/api/mock", "app/oauth/consent/mock.ts"];

/**
 * The runs mock (runs.ts, simple-runs.ts) is another lane's until its run cost work lands: these
 * page reads are answered there, untyped, for now.
 */
const RUNS_LEFT = [
  "/v1/flows",
  "/v1/runs",
  "/v1/runs/{run_id}",
  "/v1/runs/{run_id}/checkpoints/{checkpoint_id}/agent-questions",
  "/v1/runs/{run_id}/checkpoints/{checkpoint_id}/review",
  "/v1/runs/{run_id}/checkpoints/{checkpoint_id}/review.yaml",
  "/v1/runs/{run_id}/decisions",
  "/v1/runs/{run_id}/segments/{seq}/artifacts/{name}",
];

function sources(rel: string): string[] {
  const full = path.join(WEB, rel);
  if (fs.statSync(full).isFile()) return [full];
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || e.name.startsWith(".")) return [];
    const child = path.join(rel, e.name);
    if (e.isDirectory()) return sources(child);
    return /\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts") ? [path.join(WEB, child)] : [];
  });
}

const isMock = (file: string) => MOCK_SOURCES.some((m) => file.startsWith(path.join(WEB, m)));

function pageReads(): Set<string> {
  const reads = new Set<string>();
  for (const file of ["app", "components", "lib"].flatMap(sources).filter((f) => !isMock(f))) {
    for (const m of fs.readFileSync(file, "utf8").matchAll(/\.GET\(\s*"([^"]+)"/g)) reads.add(m[1]);
  }
  return reads;
}

function mockedReads(): Set<string> {
  const mocked = new Set<string>();
  for (const file of MOCK_SOURCES.flatMap(sources)) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/\b(?:\w*[rR]eply|bodyOf)\(\s*"(\/[^"]*)",\s*([^,()]*?)"get"/g)) mocked.add(m[1]);
  }
  return mocked;
}

test("every route a page reads is in the API's schema", () => {
  const api = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(WEB, "lib/api/openapi.json"), "utf8")).paths));
  const reads = [...pageReads()];
  expect(reads.length).toBeGreaterThan(100);
  expect(reads.filter((r) => !api.has(r))).toEqual([]);
});

test("every route a page reads has a typed mock reply", () => {
  const mocked = mockedReads();
  const missing = [...pageReads()].filter((r) => !mocked.has(r) && !RUNS_LEFT.includes(r)).sort();
  expect(missing).toEqual([]);
});

test("the runs routes left untyped are still read and still untyped", () => {
  const reads = pageReads();
  const mocked = mockedReads();
  expect(RUNS_LEFT.filter((r) => !reads.has(r) || mocked.has(r))).toEqual([]);
});
