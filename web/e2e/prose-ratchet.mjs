// Lowers the prose guard's ceilings (e2e/prose-ceilings.json) to today's counts: `npm run prose:ratchet`.
// Runs e2e/prose-guard.spec.ts (skip with --no-run to use the last run's test-results/prose),
// then for each page and role sets the ceiling to the count when that is lower, and records a
// page that has no ceiling yet at its count. It never raises a ceiling. Prints the ten pages
// with the most prose.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "..", "test-results", "prose");
const FILE = path.join(here, "prose-ceilings.json");

if (!process.argv.includes("--no-run")) {
  // A page above its ceiling fails the run; the others are still lowered.
  spawnSync("npx", ["playwright", "test", "e2e/prose-guard.spec.ts"], { cwd: path.join(here, ".."), stdio: "inherit" });
}
if (!fs.existsSync(OUT)) {
  console.error("No counts in test-results/prose: run npx playwright test e2e/prose-guard.spec.ts first.");
  process.exit(1);
}

const ceilings = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : {};
const counts = fs.readdirSync(OUT).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(OUT, f), "utf8")));
const changes = [];
for (const { role, route, words } of counts) {
  const byRole = (ceilings[role] ??= {});
  const was = byRole[route];
  if (was === undefined || words < was) {
    byRole[route] = words;
    changes.push(`${role} ${route}: ${was ?? "new"} -> ${words}`);
  }
}
const sorted = Object.fromEntries(Object.keys(ceilings).sort().map((role) => [role, Object.fromEntries(Object.entries(ceilings[role]).sort(([a], [b]) => a.localeCompare(b)))]));
fs.writeFileSync(FILE, JSON.stringify(sorted, null, 2) + "\n");

console.log(changes.length ? `Lowered or recorded ${changes.length} ceilings:\n  ${changes.join("\n  ")}` : "No ceiling could go lower.");
const top = [...counts].sort((a, b) => b.words - a.words).slice(0, 10);
console.log("\nMost prose (words in sentences of 8+ words):");
for (const c of top) console.log(`  ${String(c.words).padStart(5)}  ${c.mode} ${c.route} as ${c.role}  (${c.sentences.length} sentences)`);
