#!/usr/bin/env node
// #1579: re-point every next/link and next/navigation import to @/lib/nav, the only import
// for links and navigation. Re-runnable and idempotent: a second run changes nothing, so a
// lane (or the train, after a merge) that brings in a next/* import just runs it again.
//
//   node scripts/nav-codemod.mjs [root]           rewrite the files under root (default: web/)
//   node scripts/nav-codemod.mjs [root] --check   change nothing; exit 1 if a file would change
//
//   import Link from "next/link";                       import { Link, useRouter } from "@/lib/nav";
//   import { useRouter } from "next/navigation";   ->
//
// A name lib/nav.ts does not export fails the run before any file is written: add it there
// first. The last line is the verdict: "NAV-CODEMOD: OK ..." or "NAV-CODEMOD: FAIL ...".
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const NAV_MODULE = "@/lib/nav";
const NAV_FILE = join("lib", "nav.ts");
const SKIP_DIRS = new Set(["node_modules", "test-results", "playwright-report", "out", "build"]);
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

// One import declaration from next/link or next/navigation, with its line break.
const NEXT_IMPORT = /^import\s+(type\s+)?([^;'"]*?)\s+from\s+(["'])next\/(link|navigation)\3;?[ \t]*(\r?\n)?/gm;
// The named import from @/lib/nav a file already has, if any.
const NAV_IMPORT = /^import\s+\{([^}]*)\}\s+from\s+(["'])@\/lib\/nav\2;?/m;

class CodemodError extends Error {}

/** The names lib/nav.ts exports, read from its source. */
export function navExports(navSource) {
  const names = new Set();
  for (const m of navSource.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop();
      if (name) names.add(name);
    }
  }
  return names;
}

function parseNamed(list, typeOnly) {
  return list
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const type = typeOnly || /^type\s/.test(s);
      const [imported, local = imported] = s.replace(/^type\s+/, "").split(/\s+as\s+/);
      return { imported: imported.trim(), local: local.trim(), type };
    });
}

/** The specifiers of one import clause, as imports from @/lib/nav. */
function specifiersOf(clause, typeOnly, module, file) {
  const m = clause.trim().match(/^(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\})?$/);
  if (!m) throw new CodemodError(`${file}: cannot read the import of next/${module}: ${clause.trim()}`);
  const specs = [];
  if (m[1]) {
    if (module !== "link") throw new CodemodError(`${file}: next/${module} has no default export`);
    specs.push({ imported: "Link", local: m[1], type: typeOnly });
  }
  if (m[2]) specs.push(...parseNamed(m[2], typeOnly));
  return specs;
}

function render(spec) {
  const name = spec.imported === spec.local ? spec.imported : `${spec.imported} as ${spec.local}`;
  return spec.type ? `type ${name}` : name;
}

function sortedUnique(specs) {
  const seen = new Map();
  for (const s of specs) {
    const key = `${s.imported} ${s.local}`;
    const had = seen.get(key);
    // A value import also brings its type, so one of each is a value import.
    seen.set(key, had ? { ...s, type: had.type && s.type } : s);
  }
  return [...seen.values()].sort((a, b) =>
    a.imported === b.imported ? (a.local < b.local ? -1 : 1) : a.imported < b.imported ? -1 : 1,
  );
}

/**
 * The file's text with its next/link and next/navigation imports re-pointed to @/lib/nav,
 * merged into the file's own @/lib/nav import when it has one. Unchanged text needs nothing.
 */
export function transform(source, file = "<source>", exported = null) {
  const found = [...source.matchAll(NEXT_IMPORT)];
  if (found.length === 0) return source;
  const specs = [];
  for (const m of found) specs.push(...specifiersOf(m[2], Boolean(m[1]), m[4], file));
  if (exported) {
    const missing = specs.filter((s) => !exported.has(s.imported)).map((s) => s.imported);
    if (missing.length) throw new CodemodError(`${file}: lib/nav.ts does not export ${[...new Set(missing)].join(", ")}`);
  }
  const quote = found[0][3];
  let first = -1;
  let out = "";
  let last = 0;
  for (const m of found) {
    out += source.slice(last, m.index);
    if (first === -1) first = out.length;
    last = m.index + m[0].length;
  }
  out += source.slice(last);

  const existing = out.match(NAV_IMPORT);
  if (existing) {
    const merged = sortedUnique([...parseNamed(existing[1], false), ...specs]);
    const statement = `import { ${merged.map(render).join(", ")} } from ${existing[2]}${NAV_MODULE}${existing[2]};`;
    return out.slice(0, existing.index) + statement + out.slice(existing.index + existing[0].length);
  }
  const eol = found[0][5] ?? "\n";
  const statement = `import { ${sortedUnique(specs).map(render).join(", ")} } from ${quote}${NAV_MODULE}${quote};${eol}`;
  return out.slice(0, first) + statement + out.slice(first);
}

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      yield* sourceFiles(join(dir, entry.name));
    } else if (entry.isFile() && SOURCE.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      yield join(dir, entry.name);
    }
  }
}

/** Plan every rewrite under root; nothing is written until every file has been read. */
export function plan(root) {
  const exported = navExports(readFileSync(join(root, NAV_FILE), "utf8"));
  const changes = [];
  for (const path of sourceFiles(root)) {
    const file = relative(root, path).split(sep).join("/");
    if (file === NAV_FILE.split(sep).join("/")) continue;
    const before = readFileSync(path, "utf8");
    const after = transform(before, file, exported);
    if (after !== before) changes.push({ path, file, after });
  }
  return changes;
}

function main(argv) {
  const check = argv.includes("--check");
  const rootArg = argv.find((a) => !a.startsWith("--"));
  const root = resolve(rootArg ?? join(fileURLToPath(new URL(".", import.meta.url)), ".."));
  let changes;
  try {
    changes = plan(root);
  } catch (err) {
    if (!(err instanceof CodemodError)) throw err;
    console.log(`NAV-CODEMOD: FAIL ${err.message}`);
    return 1;
  }
  if (check) {
    for (const c of changes) console.log(`would change ${c.file}`);
    console.log(
      changes.length
        ? `NAV-CODEMOD: FAIL ${changes.length} file(s) still import next/link or next/navigation`
        : "NAV-CODEMOD: OK nothing to change",
    );
    return changes.length ? 1 : 0;
  }
  for (const c of changes) writeFileSync(c.path, c.after);
  console.log(`NAV-CODEMOD: OK ${changes.length} file(s) changed`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
