import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { expect, test } from "@playwright/test";

import { PAGE_CONTEXT, pageNameOnly } from "../lib/page-context";

/*
 * ask-page-context: every route says what Ask Oracle's "This page" reads (lib/page-context.ts).
 * protects=no route falls back to a section-only context unnoticed; fails_when=a page under
 * app/ has no entry, an entry names no route, or a person's own page sends its content;
 * no_claim=what each page's text holds (the run review's own spec drives that).
 */

const APP = join(__dirname, "..", "app");

function routes(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...routes(full));
    else if (name === "page.tsx") {
      const parts = relative(APP, dir).split(sep).filter((p) => p && !/^\(.*\)$/.test(p));
      out.push(`/${parts.join("/")}`);
    }
  }
  return out;
}

test("every route has a page-context provider", () => {
  const found = routes(APP).sort();
  expect(found.length).toBeGreaterThan(50);
  const missing = found.filter((r) => !(r in PAGE_CONTEXT));
  expect(missing, "routes with no page-context provider in lib/page-context.ts").toEqual([]);
  const stale = Object.keys(PAGE_CONTEXT).filter((r) => !found.includes(r));
  expect(stale, "entries in lib/page-context.ts with no route").toEqual([]);
  for (const [route, ctx] of Object.entries(PAGE_CONTEXT)) {
    expect(ctx.reads.trim(), route).not.toBe("");
    // A person's own page holds its name only; every other page in the shell sends what it shows.
    if (ctx.provider === "name-only") expect(pageNameOnly(route), route).toBe(true);
    else expect(pageNameOnly(route), route).toBe(false);
  }
});

test("the run review page has its own provider", () => {
  expect(PAGE_CONTEXT["/runs/[id]/review/[checkpoint]"].provider).toBe("own");
});
