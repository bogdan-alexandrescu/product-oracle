#!/usr/bin/env node
// #1566: fail on OSV findings in the lockfiles that are not in the committed baseline.
//
//   node .github/scripts/osv-scan.mjs            runs `osv-scanner` (on PATH, or $OSV_SCANNER)
//   node .github/scripts/osv-scan.mjs out.json   reads a saved `osv-scanner scan --format json`
//   node .github/scripts/osv-scan.mjs --self-test
//
// The baseline (.github/scripts/osv-baseline.json) lists accepted findings by package and advisory
// id, each with a reason. A finding matches when its package and any of its ids or aliases match an
// entry, so a fixed version that is still affected stays accepted and a new advisory does not.
// Entries no longer found are printed so they can be removed; the baseline only shrinks.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const LOCKFILES = ["uv.lock", "api/uv.lock", "web/package-lock.json"];

export function findings(report) {
  const out = [];
  for (const result of report.results ?? []) {
    const source = relative(root, result.source?.path ?? "") || result.source?.path;
    for (const pkg of result.packages ?? []) {
      const vulns = new Map((pkg.vulnerabilities ?? []).map((v) => [v.id, v]));
      const groups = pkg.groups?.length ? pkg.groups : [...vulns.keys()].map((id) => ({ ids: [id] }));
      for (const group of groups) {
        const ids = new Set(group.ids);
        for (const id of group.ids) for (const alias of vulns.get(id)?.aliases ?? []) ids.add(alias);
        out.push({
          source,
          package: pkg.package.name,
          version: pkg.package.version,
          id: group.ids[0],
          ids: [...ids],
        });
      }
    }
  }
  return out;
}

export function compare(found, baseline) {
  const matches = (f, e) => e.package === f.package && f.ids.includes(e.id);
  const fresh = found.filter((f) => !baseline.some((e) => matches(f, e)));
  const stale = baseline.filter((e) => !found.some((f) => matches(f, e)));
  return { fresh, stale };
}

function scan() {
  const bin = process.env.OSV_SCANNER || "osv-scanner";
  const args = ["scan", "--format", "json", ...LOCKFILES.flatMap((l) => ["--lockfile", join(root, l)])];
  try {
    return execFileSync(bin, args, { encoding: "utf8", maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "inherit"] });
  } catch (err) {
    // osv-scanner exits 1 when it finds anything; the baseline decides.
    if (err.status === 1 && err.stdout) return err.stdout;
    throw err;
  }
}

function report(found, baseline) {
  const { fresh, stale } = compare(found, baseline);
  console.log(`osv: ${found.length} findings, ${baseline.length} in the baseline`);
  for (const e of stale) console.log(`not found any more, remove from the baseline: ${e.package} ${e.id}`);
  if (!fresh.length) return 0;
  console.log(`${fresh.length} new findings (not in the baseline):`);
  for (const f of fresh) console.log(`  ${f.source}: ${f.package} ${f.version} ${f.id} https://osv.dev/${f.id}`);
  console.log("Upgrade the package, or add it to .github/scripts/osv-baseline.json with a reason.");
  return 1;
}

function selfTest() {
  const pkg = (name, version, vulns, groups) => ({ package: { name, version }, vulnerabilities: vulns, groups });
  const rep = {
    results: [
      {
        source: { path: join(root, "web/package-lock.json") },
        packages: [
          pkg("left-pad", "1.0.0", [{ id: "GHSA-aaaa", aliases: ["CVE-1"] }, { id: "PYSEC-1", aliases: ["GHSA-aaaa"] }], [
            { ids: ["GHSA-aaaa", "PYSEC-1"] },
          ]),
          pkg("right-pad", "2.0.0", [{ id: "GHSA-bbbb", aliases: [] }]),
        ],
      },
    ],
  };
  const found = findings(rep);
  const assert = (ok, msg) => {
    if (!ok) throw new Error(`osv-scan self-test: ${msg}`);
  };
  assert(found.length === 2, "one finding per advisory group");
  assert(found[0].source === "web/package-lock.json", "source is relative");
  const base = [
    { package: "left-pad", id: "CVE-1", reason: "example" },
    { package: "right-pad", id: "GHSA-bbbb", reason: "example" },
  ];
  assert(compare(found, base).fresh.length === 0, "aliases match the baseline");
  // A planted finding fails: a new advisory, and a known id on another package.
  assert(compare(found, base.slice(0, 1)).fresh.length === 1, "a new advisory is fresh");
  assert(compare(found, [{ package: "other", id: "CVE-1" }, base[1]]).fresh.length === 1, "package must match");
  assert(compare(found.slice(1), base).stale.length === 1, "a fixed finding is stale");
  console.log("osv-scan self-test: ok");
  return 0;
}

function main(argv) {
  if (argv[0] === "--self-test") return selfTest();
  const baseline = JSON.parse(readFileSync(join(here, "osv-baseline.json"), "utf8")).accepted;
  const raw = argv[0] ? readFileSync(argv[0], "utf8") : scan();
  return report(findings(JSON.parse(raw)), baseline);
}

process.exitCode = main(process.argv.slice(2));
