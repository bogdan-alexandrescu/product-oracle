import { readFileSync } from "node:fs";

import { AREA_PRDS, COMPANY_SLUG, OLD_PRD } from "../lib/api/mock/one-roadmap";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * A roadmap's Markdown export names the PRDs that feed it (owner, Nov 10: 'Name the PRDs that feed
 * it'), as the HTML, PDF and deck say where it came from: one plain line under its title,
 * "From the PRDs: Scale, User Safety", in the company's PRD order, by name, never an HTML comment
 * (api/oracle/export/render.py prds_line). Downloaded from the roadmap's Export menu against the
 * mock (invented data).
 */

test.use({ viewport: { width: 1440, height: 900 } });

async function exportMarkdown(page: Page, path: string): Promise<string> {
  await page.goto(path);
  await expect(page.getByTestId("document-sections")).toBeVisible();
  await page.getByTestId("version-toolbar").getByRole("button", { name: "Export", exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export Markdown (.md)" }).click();
  return readFileSync((await (await download).path())!, "utf8");
}

test("a roadmap's Markdown export names its PRD under the title", async ({ page }) => {
  await login(page);
  const md = await exportMarkdown(page, "/documents/usage-alerts-roadmap/v/1");
  const lines = md.split("\n");
  const title = lines.findIndex((l) => /^# .+ \{#title\}$/.test(l));
  expect(title).toBeGreaterThan(0);
  expect(lines.slice(title + 1, title + 4)).toEqual(["", "From the PRDs: Usage alerts PRD", ""]);
  expect(md).not.toContain("<!-- ");
});

test("the company roadmap's Markdown export names every PRD that feeds it, in the company order", async ({ page }) => {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "one-roadmap"] as const);
  await login(page);
  // The company PRD order, as Simple › One-pagers lists it: read, never guessed.
  await page.goto("/simple/one-pagers");
  const links = page.getByTestId("one-pager-row").getByRole("link");
  await expect(links.first()).toBeVisible();
  const area = AREA_PRDS.map(([, title]) => title);
  const order = (await links.allTextContents()).map((t) => t.trim()).filter((t) => area.includes(t));
  expect([...order].sort()).toEqual([...area].sort());

  const md = await exportMarkdown(page, `/documents/${COMPANY_SLUG}/v/1`);
  // No title heading in this version: the line opens the body, right after the front matter.
  expect(md).toMatch(new RegExp(`\\n---\\nFrom the PRDs: ${order.join(", ")}\\n\\n## `));
  // The PRD both replaced feeds it no more.
  expect(md).not.toContain(OLD_PRD[1]);
  expect(md).not.toContain("<!-- ");
});
