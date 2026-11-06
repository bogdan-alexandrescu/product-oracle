import { expect, test, type Page } from "./test";

import { CODE_MAP_APPROVAL_SCENARIO, CODE_MAP_OVERRUN_SCENARIO } from "../lib/api/mock/engineering";
import { MOCK_ROLE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * Visual QA pass F, Settings › Sources and Connections (F-2, F-3, F-5, F-18, F-36, F-38,
 * F-56..F-59, F-61), driven through the UI on the mock as a person would.
 */

const REPO = "example-org/example-app";

async function asRole(page: Page, role: string) {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_ROLE_KEY, role]);
}

async function withScenario(page: Page, scenario: string) {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, scenario]);
}

async function noWiderThanTheScreen(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

for (const phone of [false, true]) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${phone ? "phone" : "desktop"} · ${scheme}`, () => {
      test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 }, colorScheme: scheme });

      test("F-2, F-3: a viewer reads the sources and their code maps, with no way to change them", async ({ page }) => {
        // fails_when=a viewer sees Add a source, Sync now, Pause, Edit, Map the code or the add form.
        await asRole(page, "viewer");
        await login(page);
        await page.goto("/settings/sources");
        await expect(page.getByText("View only")).toBeVisible();
        const repo = page.getByRole("listitem", { name: "Example repo" });
        await expect(repo.getByTestId(`code-map-${REPO}`)).toContainText("No code map yet");
        await expect(page.getByRole("button", { name: "Add a source" })).toHaveCount(0);
        await expect(page.getByRole("form", { name: "Add a source" })).toHaveCount(0);
        for (const name of ["Sync now", "Pause", "Map the code", "Share with the company", "Make private"]) {
          await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
        }
        await noWiderThanTheScreen(page);
      });

      test("F-5: a code map paused over budget says so and leads an owner to the run", async ({ page }) => {
        // fails_when=the line reads "Code map: building" with no word it is paused and no way to the run.
        await withScenario(page, CODE_MAP_OVERRUN_SCENARIO);
        await login(page);
        await page.goto("/settings/sources");
        const line = page.getByTestId(`code-map-${REPO}`);
        await expect(line).toContainText("Paused: over budget");
        await expect(line).not.toContainText("Code map: building");
        await noWiderThanTheScreen(page);
        await line.getByRole("link", { name: "Open the run to resume" }).click();
        await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
      });

      test("F-5: a code map waiting for an owner's approval leads to the run", async ({ page }) => {
        // fails_when=the line says only "waits for an owner to approve its cost", with no link.
        await withScenario(page, CODE_MAP_APPROVAL_SCENARIO);
        await login(page);
        await page.goto("/settings/sources");
        const line = page.getByTestId(`code-map-${REPO}`);
        await expect(line).toContainText("Waiting for an owner to approve its cost");
        await line.getByRole("link", { name: "Open the run to approve" }).click();
        await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
      });

      test("F-18: the count chips show the sources they count; a lost folder offers Choose another", async ({ page }) => {
        // fails_when="1 in error" and "3 need attention" are plain text, or a Lost access row has no action.
        await login(page);
        await page.goto("/settings/sources");
        const list = page.getByRole("list", { name: "My sources" });
        await expect(list.getByTestId("source-card")).toHaveCount(6);
        await page.getByRole("button", { name: "1 in error" }).click();
        await expect(list.getByTestId("source-card")).toHaveCount(1);
        await expect(list.getByTestId("source-card")).toHaveAttribute("aria-label", "Example repo");
        await page.getByRole("button", { name: "3 need attention" }).click();
        await expect(list.getByTestId("source-card")).toHaveCount(3);
        await expect(list.getByRole("listitem", { name: "Example repo" })).toHaveCount(0);
        await page.getByRole("button", { name: "Show all" }).click();
        await expect(list.getByTestId("source-card")).toHaveCount(6);

        const docs = page.getByRole("listitem", { name: "Product docs" });
        await docs.getByRole("button", { name: "Choose another in place of Vendor research" }).click();
        await expect(docs.getByRole("list", { name: "Picked files and folders" })).toBeVisible();
        await noWiderThanTheScreen(page);
      });
    });
  }
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("F-36, F-56: explanations sit behind an (i), not on the page", async ({ page }) => {
    // fails_when=the code map refresh cost, the Drive paragraphs, "Nothing to do: Oracle never reads it." or the empty-name hint show as sentences.
    await login(page);
    await page.goto("/settings/sources");
    const main = page.locator("main");
    for (const sentence of [
      "Each refresh is one code map run per stale repository",
      "Docs in a picked folder owned outside these domains are skipped",
      "A doc in a shared drive counts as the company",
      "Nothing to do: Oracle never reads it.",
      "— its docs are hidden until Oracle can read it again",
      "Name the source to add it",
    ]) {
      await expect(main.getByText(sentence)).toBeHidden();
    }
    await page.getByRole("button", { name: "About what a refresh costs" }).click();
    await expect(page.getByRole("tooltip")).toContainText("Each refresh costs like Map the code.");
  });

  test("F-38: a ready code map can be read on its line", async ({ page }) => {
    // fails_when=no page lets anyone read a code map.
    await login(page);
    await page.goto("/settings/sources");
    const line = page.getByTestId(`code-map-${REPO}`);
    await line.getByRole("button", { name: "Map the code" }).click();
    await expect(line).toContainText("Code map: ready", { timeout: 15_000 });
    await line.getByRole("button", { name: "See the map" }).click();
    await expect(page.getByTestId("code-map-contents")).toContainText("Parts");
    await expect(page.getByTestId("code-map-contents")).toContainText("The application (from its README)");
    await line.getByRole("button", { name: "Hide the map" }).click();
    await expect(page.getByTestId("code-map-contents")).toHaveCount(0);
  });

  test("F-57: plain words for a sync and for pasting", async ({ page }) => {
    // fails_when=the result reads "items seen, new versions, deleted", or the fallback says "Paste ids".
    await login(page);
    await page.goto("/settings/sources");
    const chat = page.getByRole("listitem", { name: "Product chat" });
    await chat.getByRole("button", { name: "Sync now" }).click();
    await expect(chat.getByRole("status")).toHaveText(/^Synced: \d+ items?, \d+ changed, \d+ removed\.$/);
    await chat.getByRole("button", { name: "More actions for Product chat" }).click();
    await chat.getByRole("menuitem", { name: "Edit channels" }).click();
    await expect(chat.getByRole("button", { name: "Paste ids" })).toHaveCount(0);
    await chat.getByRole("button", { name: "Paste links" }).click();
    // A channel's link reads as the channel.
    await chat.getByLabel("Channel links (one per line)").fill("https://example.slack.com/archives/C0123PRODUCT");
    await chat.getByRole("button", { name: "Pick from list" }).click();
    await expect(chat.getByRole("checkbox", { name: "#product" })).toBeChecked();
  });

  test("F-58: channels with no saved name read as Unknown channel, with a way to remove them", async ({ page }) => {
    // fails_when=the editor lists 120 raw channel ids as their names.
    await login(page);
    await page.goto("/settings/sources");
    const legacy = page.getByRole("listitem", { name: "Legacy all-hands chat" });
    await legacy.getByRole("button", { name: "Edit Legacy all-hands chat" }).click();
    await expect(legacy.getByRole("checkbox", { name: "C9001LEGACY" })).toHaveCount(0);
    await expect(legacy.getByRole("checkbox", { name: "Unknown channel" }).first()).toBeChecked();
    await expect(legacy.getByTestId("unknown-picks")).toHaveText("120 unknown channels");
    await legacy.getByRole("button", { name: "Remove unknown" }).click();
    await expect(legacy.getByTestId("unknown-picks")).toHaveCount(0);
    await expect(legacy.getByTestId("picked-count")).toHaveText("0 selected");
  });

  test("F-59: the Kind list shows Google Docs whole; Fireflies names its time zone", async ({ page }) => {
    // fails_when="Google Docs" is cut, or the form shows "America/Los_Angeles".
    await login(page);
    await page.goto("/settings/sources");
    const form = page.getByRole("form", { name: "Add a source" });
    const kind = form.getByLabel("Kind");
    await kind.selectOption({ label: "Google Docs" });
    const fits = await kind.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().width >= 200);
    expect(fits).toBe(true);
    await kind.selectOption({ label: "Fireflies" });
    await expect(form.getByTestId("fireflies-timezone")).toContainText("Pacific Time");
    await expect(form).not.toContainText("America/Los_Angeles");
  });

  test("F-61: Disconnect names the sources that stop syncing", async ({ page }) => {
    // fails_when=the confirm row shows only Confirm disconnect and Cancel.
    await login(page);
    await page.goto("/settings/connections");
    const github = page.getByTestId("connection-c0000000-0000-4000-8000-000000000002");
    await github.getByRole("button", { name: "Disconnect" }).click();
    await expect(github.getByTestId("disconnect-stops")).toHaveText("Stops syncing: Example repo");
    await github.getByRole("button", { name: "Cancel" }).click();
    await expect(github.getByTestId("disconnect-stops")).toHaveCount(0);
  });
});
