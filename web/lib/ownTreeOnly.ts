// #1570: the web's tests read only their own tree. A value that crosses trees is published by
// its owner as JSON in docs/contracts and read in that form (contract(name)); ownTreeOnly()
// makes node's fs throw ForeignRead on any other file of the checkout outside web/.
// e2e/test.ts arms it for every Playwright spec (e2e/own-tree-only.spec.ts proves it).
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

export const WEB = path.resolve(__dirname, "..");
export const ROOT = path.dirname(WEB);
export const CONTRACTS = path.join(ROOT, "docs", "contracts");

export class ForeignRead extends Error {
  name = "ForeignRead";
}

const inside = (file: string, dir: string) => file === dir || file.startsWith(dir + path.sep);

/** The file's path from the repo root when it is in the checkout outside web/ and docs/contracts. */
export function foreign(file: fs.PathLike | number): string | null {
  if (typeof file === "number") return null;
  const resolved = path.resolve(file instanceof URL ? file.pathname : String(file));
  if (!inside(resolved, ROOT) || inside(resolved, WEB) || inside(resolved, CONTRACTS)) return null;
  return path.relative(ROOT, resolved);
}

/** docs/contracts/<name>.json, a value another tree publishes for the web's tests. */
export function contract(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(CONTRACTS, `${name}.json`), "utf8"));
}

const READS = ["readFileSync", "readFile", "readdirSync", "readdir", "openSync", "open", "opendirSync", "opendir", "createReadStream"] as const;
const PROMISE_READS = ["readFile", "readdir", "open", "opendir"] as const;
let armed = false;

/**
 * Makes fs throw ForeignRead on a read outside web/ and docs/contracts. A census that reads
 * every tree on purpose is named in `census` (paths from web/): a read it makes is allowed.
 */
export function ownTreeOnly(census: string[] = []) {
  if (armed) return;
  armed = true;
  const allowed = census.map((f) => path.join(WEB, f));
  const check = (file: fs.PathLike | number) => {
    const rel = foreign(file);
    if (rel === null) return;
    const stack = new Error().stack ?? "";
    if (allowed.some((f) => stack.includes(f))) return;
    throw new ForeignRead(`${rel} is outside web/: read its published copy in docs/contracts (contract() in lib/ownTreeOnly.ts)`);
  };
  const guard = (target: Record<string, unknown>, name: string, rejects = false) => {
    const original = target[name] as (file: fs.PathLike | number, ...rest: unknown[]) => unknown;
    target[name] = function (this: unknown, file: fs.PathLike | number, ...rest: unknown[]) {
      try {
        check(file);
      } catch (error) {
        if (rejects) return Promise.reject(error);
        throw error;
      }
      return original.call(this, file, ...rest);
    };
  };
  for (const name of READS) guard(fs as unknown as Record<string, unknown>, name);
  for (const name of PROMISE_READS) guard(fs.promises as unknown as Record<string, unknown>, name, true);
  syncBuiltinESMExports();
}
