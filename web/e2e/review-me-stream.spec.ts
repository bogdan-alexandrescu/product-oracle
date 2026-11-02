import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "./test";

import { PENDING_MARKS } from "../lib/boundaries";
import { login, pickZone } from "./helpers";

/**
 * trainag-mock-fixes-3 review: GET /v1/me waits for a page's streamed boundaries
 * (lib/boundaries.ts) only while the first page loads, and it knows them by the comment
 * React writes for them, so a React that writes another one fails here, not silently.
 */

// protects: lib/boundaries.ts knows every comment React's server writes for a boundary whose
// content is not in place yet ("$?" when it streams, "$~" while it waits to be shown).
// fails_when: a Next or React upgrade writes another comment, or none that this test can
// find: me.tsx would stop waiting and the server's copy of a page would show twice again.
// no_claim: that the wait works in a browser (qa3-docs-new covers the New PRD form).
test("the streamed-boundary comments me.tsx waits on are the ones Next's React writes", () => {
  const next = join(__dirname, "../node_modules/next");
  for (const name of ["app-page.runtime.prod.js", "app-page-turbo.runtime.prod.js"]) {
    const src = readFileSync(join(next, "dist/compiled/next-server", name), "utf8");
    const streaming = [...src.matchAll(/'\\x3c!--([^']*?)--\\x3e<template id="'/g)].map((m) => m[1]);
    const waiting = [...src.matchAll(/previousSibling\.data=(?:\\n)?"([^"]*)"/g)].map((m) => m[1]);
    expect(streaming.length, `${name}: the comment of a streaming boundary`).toBeGreaterThan(0);
    expect(waiting.length, `${name}: the comment of a boundary waiting to be shown`).toBeGreaterThan(0);
    for (const mark of [...streaming, ...waiting]) expect(PENDING_MARKS, `${name} writes "${mark}"`).toContain(mark);
  }
});

// protects: once the first page has loaded, a new GET /v1/me answer lands at once, even
// while the page still holds a boundary that has not streamed in (here a stray "$?"
// comment stands in for it): the new Company time zone shows on the next page right away.
// fails_when: every answer waits up to 5 s for the page's boundaries (the role and the
// zone known late on a slow page).
// no_claim: the first page's own wait (qa3-docs-new).
test("after the first page, a new time zone shows at once on a page still streaming", async ({ page }) => {
  await login(page);
  await page.goto("/settings/company");
  await pickZone(page, "Pacific/Auckland");
  await page.evaluate(() => document.body.appendChild(document.createComment("$?")));
  await page.getByTestId("timezone-panel").getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("timezone-panel").getByRole("status")).toHaveText("Saved");
  await page.getByTestId("settings-nav").getByRole("link", { name: "Sources", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/sources$/);
  const form = page.getByRole("form", { name: "Add a source" });
  await form.getByLabel("Kind").selectOption("fireflies");
  await expect(form.getByTestId("fireflies-timezone")).toContainText("Pacific/Auckland", { timeout: 2500 });
});
