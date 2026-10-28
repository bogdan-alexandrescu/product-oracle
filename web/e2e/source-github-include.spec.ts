import { expect, type Page, test } from "./test";

import { SOURCES_STORAGE_KEY } from "../lib/api/mock/sources";
import { login } from "./helpers";

// GitHub's `include` option (api/oracle/sources/connectors/github.py INCLUDE): which kinds
// of a repository's content a GitHub source reads, ticked under its repositories. Every
// kind is ticked by default, which saves no `include` at all (the connector reads all).

/** A source's config as the mock API stored it (it runs in the page: no request to watch). */
async function savedConfig(page: Page, name: string): Promise<Record<string, unknown> | undefined> {
  return page.evaluate(
    ([key, name]) => JSON.parse(localStorage.getItem(key)!).sources.find((s: { name: string }) => s.name === name)?.config,
    [SOURCES_STORAGE_KEY, name],
  );
}

const KINDS = ["README", "Docs", "Issues", "Pull requests", "Releases", "Milestones"];

// Card github-include-add: protects = a new GitHub source can leave out kinds of content, and
// its row says what it reads; fails_when = the choice is missing, not saved as `include`, or
// the row does not show it; no_claim = the connector's reading (pytest covers it).
test("adding a GitHub source that reads only some kinds of content", async ({ page }) => {
  await login(page);
  await page.goto("/settings/sources");
  const form = page.getByRole("form", { name: "Add a source" });
  await form.getByLabel("Kind").selectOption("github");
  const reads = form.getByRole("group", { name: "What to read" });
  for (const k of KINDS) await expect(reads.getByRole("checkbox", { name: k })).toBeChecked();
  await reads.getByRole("checkbox", { name: "Issues" }).uncheck();
  await reads.getByRole("checkbox", { name: "Pull requests" }).uncheck();
  await form.getByRole("group", { name: "GitHub repositories" }).getByRole("checkbox", { name: "example-org/docs" }).check();
  await form.getByLabel("Name").fill("Docs only");
  await form.getByRole("button", { name: "Add source" }).click();
  const row = page.getByRole("listitem", { name: "Docs only" });
  await expect(row.getByTestId("github-include")).toHaveText("ReadsREADME, Docs, Releases, Milestones");
  // Stored sorted, as the connector's normalize_config stores it.
  expect((await savedConfig(page, "Docs only"))?.include).toEqual(["docs", "milestones", "readme", "releases"]);
});

// Card github-include-edit: protects = editing a source changes what it reads, reading less
// removes what is no longer read at once, the last kind cannot be unticked, and ticking all
// again stores no `include`; fails_when = the stored item stays after README is left out, a
// source can be saved reading nothing, or "all" is saved as a list; no_claim = the next sync.
test("editing what a GitHub source reads", async ({ page }) => {
  await login(page);
  await page.goto("/settings/sources");
  const repo = page.getByRole("listitem", { name: "Example repo" });
  await expect(repo).toContainText("1 item");
  await expect(repo.getByTestId("github-include")).toHaveCount(0);
  await repo.getByRole("button", { name: "More actions for Example repo" }).click();
  await repo.getByRole("menuitem", { name: "Edit repositories" }).click();
  const reads = repo.getByRole("group", { name: "What to read" });
  for (const k of KINDS.filter((k) => k !== "Issues")) await reads.getByRole("checkbox", { name: k }).uncheck();
  await expect(reads.getByRole("checkbox", { name: "Issues" })).toBeChecked();
  await expect(reads.getByRole("checkbox", { name: "Issues" })).toBeDisabled();
  await repo.getByRole("button", { name: "Save repositories" }).click();
  await expect(repo.getByTestId("github-include")).toHaveText("ReadsIssues");
  // The README it held is not read any more: removed on save.
  await expect(repo).toContainText("0 items");

  await repo.getByRole("button", { name: "More actions for Example repo" }).click();
  await repo.getByRole("menuitem", { name: "Edit repositories" }).click();
  for (const k of KINDS) await reads.getByRole("checkbox", { name: k }).check();
  await repo.getByRole("button", { name: "Save repositories" }).click();
  await expect(repo.getByText("Repositories saved.")).toBeVisible();
  await expect(repo.getByTestId("github-include")).toHaveCount(0);
  expect(await savedConfig(page, "Example repo")).not.toHaveProperty("include");
});
