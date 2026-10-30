import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * QA pass 4: a new company's first baseline build from Home's Set up (qa-onboarding-2, 17, 29),
 * walked through the UI on the mock's "empty" scenario. Each test's card: protects=<the
 * observable>; fails_when=<the wrong result>; no_claim=<what green does not prove>. The
 * in-browser mock's /v1/setup, sources and runs stand in for the API.
 */

const DESKTOP = { width: 1440, height: 900 };

const row = (page: Page, key: string) => page.getByTestId(`setup-row-${key}`);
const sheet = (page: Page) => page.getByRole("dialog", { name: "Build the baseline" });
const settingsNav = (page: Page) => page.getByRole("navigation", { name: "Settings" });

async function newCompany(page: Page) {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "empty"));
  await login(page);
  await expect(page.getByTestId("home-setup").getByRole("heading", { name: "Set up" })).toBeVisible();
}

/** Set up > Build baseline > Open: the Baseline page with its start sheet. */
async function openBuildFromSetup(page: Page) {
  const build = row(page, "build_baseline");
  await expect(build.getByTestId("setup-status")).toHaveText("Not built");
  await build.getByTestId("setup-action").click();
  await expect(page).toHaveURL(/\/baseline\?build=1&from=setup$/);
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).getByTestId("build-estimate")).toContainText("estimated");
}

/** On the Sources page: an upload source with one file in it. */
async function addFileSource(page: Page) {
  const form = page.getByRole("form", { name: "Add a source" });
  await form.getByLabel("Kind").selectOption("upload");
  await form.getByLabel("Name").fill("Research notes");
  await form.getByRole("button", { name: "Add source" }).click();
  const notes = page.getByRole("listitem", { name: "Research notes" });
  await expect(notes).toBeVisible();
  await notes.getByLabel("Upload files to Research notes").setInputFiles([
    { name: "interview.md", mimeType: "text/markdown", buffer: Buffer.from("# Interview\nThe export button is hard to find.") },
  ]);
  await expect(notes.getByTestId("source-items")).toHaveText("1 item");
}

test.use({ viewport: DESKTOP });

// protects=qa-onboarding-2 (and -17 on the way): with no source holding items, Start waits and
// says why, the note's link is the next step; once a file is in, Start starts the build;
// fails_when=Start is active with nothing to read (the first build spends money on nothing), no
// reason shows, or Start stays off once a source has items; no_claim=the API's own start rule.
test("qa-onboarding-2: Start waits for a source with items, then the first build starts", async ({ page }) => {
  test.setTimeout(120_000);
  await newCompany(page);
  await expect(row(page, "sources")).toHaveAttribute("data-done", "false");

  // 1. Set up > Build baseline > Open, with no sources yet.
  await openBuildFromSetup(page);
  const s = sheet(page);
  await expect(s.getByTestId("build-no-items")).toContainText(
    "You have no sources yet, so the build has nothing to read. Add files or sync a source first.",
  );
  const start = s.getByRole("button", { name: "Start" });
  await expect(start).toBeDisabled();
  await expect(s.getByTestId("build-start-reason")).toHaveText("Start once a source has items");
  await expect(start).toHaveAccessibleDescription("Start once a source has items");

  // 2. The note's link is the next step: Sources, with the way back to Home.
  await s.getByRole("link", { name: "Add files or sync a source" }).click();
  await expect(page).toHaveURL(/\/settings\/sources\?from=setup$/);
  await expect(settingsNav(page).getByRole("link", { name: "Back to Home" })).toBeVisible();
  await addFileSource(page);
  await settingsNav(page).getByRole("link", { name: "Back to Home" }).click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(row(page, "sources")).toHaveAttribute("data-done", "true");
  await expect(row(page, "sources").getByTestId("setup-status")).toHaveText("1 source");

  // 3. Build baseline > Open again: nothing in the way, Start starts the build.
  await openBuildFromSetup(page);
  await expect(sheet(page).getByTestId("build-no-items")).toHaveCount(0);
  await expect(sheet(page).getByTestId("build-start-reason")).toHaveCount(0);
  await expect(sheet(page).getByRole("button", { name: "Start" })).toBeEnabled();
  await sheet(page).getByRole("button", { name: "Start" }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page.getByTestId("baseline-build-banner")).toContainText("Baseline being built");

  // 4. Home: the row follows the build.
  await page.getByTestId("nav-home").filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(row(page, "build_baseline").getByTestId("setup-status")).toHaveText("Building…");
});

// protects=qa-onboarding-17: the no-sources note's link keeps ?from=setup when the sheet was
// opened from Set up (so Sources shows Back to Home), and not when opened from the Baseline
// page; fails_when=the link drops it and Back to Home is missing; no_claim=other settings pages.
test("qa-onboarding-17: the no-sources link keeps the way back to Home when opened from Set up", async ({ page }) => {
  await newCompany(page);
  await openBuildFromSetup(page);
  const link = sheet(page).getByRole("link", { name: "Add files or sync a source" });
  await expect(link).toHaveAttribute("href", "/settings/sources?from=setup");
  await link.click();
  await expect(page).toHaveURL(/\/settings\/sources\?from=setup$/);
  await settingsNav(page).getByRole("link", { name: "Back to Home" }).click();
  await expect(page).toHaveURL(/\/home$/);

  // From the Baseline page's own Build baseline, the link is plain Sources.
  await page.goto("/baseline");
  await page.getByRole("button", { name: "Build baseline" }).click();
  await expect(sheet(page).getByRole("link", { name: "Add files or sync a source" })).toHaveAttribute("href", "/settings/sources");
});

// protects=qa-onboarding-29: on a desktop the sheet's overlay covers the whole window, the Ask
// column too; fails_when=a click at the Ask column lands on it, bright beside the dimmed page;
// no_claim=dialogs outside the Baseline page.
test("qa-onboarding-29: the build sheet's overlay covers the Ask column", async ({ page }) => {
  await newCompany(page);
  const dock = page.getByTestId("hop-dock");
  await expect(dock).toBeVisible();
  await openBuildFromSetup(page);
  const b = (await dock.boundingBox())!;
  const covered = await page.evaluate(
    ([x, y]) => !document.elementFromPoint(x, y)?.closest("[data-testid=hop-dock]"),
    [b.x + b.width / 2, b.y + b.height / 2],
  );
  expect(covered).toBe(true);
});
