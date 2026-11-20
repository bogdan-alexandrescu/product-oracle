// Vite phase 0 (#1578): the tables in nginx.md, generated from web/next.config.ts so the
// nginx config is written from what Next serves today, not from memory.
//
//   node docs/vite-migration/next-config-tables.mjs          # print the tables
//   node docs/vite-migration/next-config-tables.mjs --write  # replace them in nginx.md
//
// Node 22.18+ reads the .ts config directly (types are stripped). The production CSP is
// the one shown: NODE_ENV is set to production before the config is loaded.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
process.env.NODE_ENV = "production";
process.env.API_INTERNAL_URL ??= "http://api:8000";
const { default: config } = await import(pathToFileURL(join(here, "../../web/next.config.ts")).href);

/** A Next path pattern as an nginx location and the target with its captures. */
function toNginx(source, destination) {
  // `/:name*` (zero or more segments) captures its leading slash; `/:name` one segment.
  const params = [];
  const re = source.replace(/\/:(\w+)(\*)?/g, (_, name, star) => {
    params.push({ name, star: !!star });
    return star ? "(/.*)?" : "/([^/]+)";
  });
  let target = destination;
  params.forEach(({ name, star }, i) => {
    target = star ? target.replace(`/:${name}*`, `$${i + 1}`) : target.replace(`:${name}`, `$${i + 1}`);
  });
  return params.length ? { location: `location ~ ^${re}$`, target } : { location: `location = ${source}`, target };
}

const lines = [];
lines.push("| Next `redirects()` source | Destination | Status | nginx |", "|---|---|---|---|");
for (const r of await config.redirects()) {
  const status = r.permanent ? 308 : 307;
  const { location, target } = toNginx(r.source, r.destination);
  lines.push(`| \`${r.source}\` | \`${r.destination}\` | ${status} | \`${location} { return ${status} ${target}$is_args$args; }\` |`);
}
lines.push("", "| Next `rewrites()` source | Upstream today | nginx |", "|---|---|---|");
for (const w of await config.rewrites()) {
  const prefix = w.source.replace(/\/:path\*$/, "/");
  const location = prefix === w.source ? `location = ${w.source}` : `location ^~ ${prefix}`;
  lines.push(`| \`${w.source}\` | \`${w.destination}\` | \`${location}\` → \`proxy_pass \${API_INTERNAL_URL};\` |`);
}
lines.push("", "| CSP directive (production) | Value |", "|---|---|");
const headers = (await config.headers()).flatMap((h) => h.headers);
const csp = headers.find((h) => h.key === "Content-Security-Policy").value;
for (const d of csp.split("; ")) {
  const [name, ...value] = d.split(" ");
  lines.push(`| \`${name}\` | \`${value.join(" ")}\` |`);
}
const tables = lines.join("\n");

if (process.argv.includes("--write")) {
  const file = join(here, "nginx.md");
  const begin = "<!-- generated:next-config begin -->";
  const end = "<!-- generated:next-config end -->";
  const doc = readFileSync(file, "utf8");
  const from = doc.indexOf(begin);
  const to = doc.indexOf(end);
  if (from < 0 || to < 0) throw new Error(`markers missing in ${file}`);
  writeFileSync(file, `${doc.slice(0, from + begin.length)}\n${tables}\n${doc.slice(to)}`);
} else {
  console.log(tables);
}
