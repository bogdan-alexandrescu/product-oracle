import { expect, test } from "./test";

import { login } from "./helpers";

/*
 * QA F-72 on Settings › Analytics, driven through the UI on the mock layer as an owner would:
 * the page's own explanation and each field's hint sit behind an (i), not loose text; the host
 * options read "US", "EU" and "Your own server"; picking "Your own server" shows the host
 * address field. (The default mock has PostHog disconnected, nothing saved: the API itself has
 * no default host - oracle/integrations/router.py and the mock both return host: null until a
 * host is saved - so the Host select starts on "Pick a host".)
 */

// fails_when=the page's own sentence or a field's hint shows loose on the page instead of
// behind an (i).
test("analytics: the page's and each field's explanation sit behind an (i)", async ({ page }) => {
  await login(page);
  await page.goto("/settings/analytics");
  const form = page.getByTestId("analytics-posthog");

  const panelAbout = form.getByRole("button", { name: "About PostHog" });
  const panelTip = form.locator('[role="tooltip"]').filter({ hasText: "Oracle reads each metric" });
  await expect(panelAbout).toBeVisible();
  await expect(panelTip).toBeHidden();
  await panelAbout.click();
  await expect(panelTip).toHaveText(
    "Oracle reads each metric's weekly value with a query in your PostHog project. Use a personal API key that may only read queries.",
  );
  await panelAbout.click();

  const projectAbout = form.getByRole("button", { name: "About where to find the project" });
  const projectTip = form.locator('[role="tooltip"]').filter({ hasText: "Find it in PostHog" });
  await expect(projectTip).toBeHidden();
  await projectAbout.click();
  await expect(projectTip).toHaveText("Find it in PostHog › Project settings.");
  await projectAbout.click();

  const keyAbout = form.getByRole("button", { name: "About making a key" });
  const keyTip = form.locator('[role="tooltip"]').filter({ hasText: "Make one in PostHog" });
  await expect(keyTip).toBeHidden();
  await keyAbout.click();
  await expect(keyTip).toHaveText("Make one in PostHog › Account settings › Personal API keys.");
  await keyAbout.click();

  // The field's own label still reads in plain words, with no hint loose beside it.
  await expect(form.getByLabel("Project ID")).toBeVisible();
  await expect(form.getByLabel("Personal API key")).toBeVisible();
});

// fails_when=an option still reads "Own host", or picking "Your own server" leaves the host
// address field hidden.
test("analytics: the host options are US, EU and Your own server; Your own server asks for the address", async ({ page }) => {
  await login(page);
  await page.goto("/settings/analytics");
  await expect(page.getByTestId("analytics-state")).toHaveText("Not connected");
  const select = page.getByLabel("Host");
  await expect(select.locator("option")).toHaveText(["Pick a host", "US", "EU", "Your own server"]);
  // Owner's decision (Nov 5): with nothing saved the list starts on "Pick a host", not EU, and
  // Save waits until one is picked.
  await expect(select).toHaveValue("");
  await page.getByLabel("Project ID").fill("67890");
  await page.getByLabel("Personal API key").fill("phx_example_key_for_tests");
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
  await expect(page.getByTestId("analytics-save-why")).toHaveText("Pick a host to save.");
  await expect(page.getByLabel("Server address")).toHaveCount(0);

  await select.selectOption({ label: "Your own server" });
  const address = page.getByLabel("Server address");
  await expect(address).toBeVisible();
  // Your own server with no address yet: Save still waits, and says for what.
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
  await expect(page.getByTestId("analytics-save-why")).toHaveText("Add the server address to save.");
  await address.fill("https://posthog.example.com");

  await expect(page.getByRole("button", { name: "Save" })).toBeEnabled();
  await expect(page.getByTestId("analytics-save-why")).toHaveCount(0);

  await select.selectOption({ label: "US" });
  await expect(page.getByLabel("Server address")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save" })).toBeEnabled();
});
