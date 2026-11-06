import { expect, test, type Page } from "./test";

import { MOCK_ROLE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * Pass F F-38 (owner's decision, Nov 5: "See the map on its line"): sharing a code map says
 * people can read it, so its line opens a small read-only view of the map: its parts, API
 * routes and data models with their counts. Owners and viewers open it; nothing in it
 * changes the map. On a phone it is a sheet. The "code-map-shared" scenario seeds a ready
 * map of the Example repo, shared with the company.
 */

const REPO = "example-org/example-app";

async function setKey(page: Page, key: string, value: string) {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [key, value]);
}

for (const phone of [false, true]) {
  test.describe(phone ? "phone" : "desktop", () => {
    test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 } });

    for (const role of ["owner", "viewer"] as const) {
      test(`F-38: ${role === "owner" ? "an owner" : "a viewer"} opens the code map from its line and reads it`, async ({ page }) => {
        // fails_when=the line has no See the map, the view lacks the map's parts, API routes or
        // data models with their counts, it carries a control that changes the map, or a phone
        // does not show it as a sheet.
        await setKey(page, MOCK_SCENARIO_KEY, "code-map-shared");
        await setKey(page, MOCK_ROLE_KEY, role);
        await login(page);
        await page.goto("/settings/sources");
        const line = page.getByTestId(`code-map-${REPO}`);
        await expect(line).toContainText("Shared with the company");
        // Only the owner has the line's Share control; both can see the map.
        await expect(line.getByRole("button", { name: "Make private" })).toHaveCount(role === "owner" ? 1 : 0);
        await line.getByRole("button", { name: "See the map" }).click();

        const view = page.getByRole("dialog", { name: `Code map of ${REPO}` });
        await expect(view).toBeVisible();
        await expect(view.getByRole("heading", { name: "Parts (2)" })).toBeVisible();
        await expect(view.getByRole("heading", { name: "API routes (2)" })).toBeVisible();
        await expect(view.getByRole("heading", { name: "Data models (1)" })).toBeVisible();
        const parts = view.getByRole("list", { name: "Parts" });
        await expect(parts.getByRole("listitem").filter({ hasText: "api/billing" })).toContainText("Invoices and payments");
        await expect(view.getByRole("list", { name: "API routes" })).toContainText("POST /v1/invoices");
        await expect(view.getByRole("list", { name: "Data models" })).toContainText("Invoice");
        // Read-only: the close X is its one control.
        await expect(view.getByRole("button")).toHaveCount(1);
        await expect(view.getByRole("textbox")).toHaveCount(0);

        const box = await view.boundingBox();
        if (phone) expect(box?.width).toBe(390);
        else expect(box?.width ?? 0).toBeLessThan(800);

        await view.getByRole("button", { name: "Close" }).click();
        await expect(view).toHaveCount(0);
      });
    }
  });
}

test("F-38: a map that will not load says so in its view", async ({ page }) => {
  // fails_when=a failed read of the map shows nothing, or an endless Loading. The
  // "code-map-unreadable" scenario: the shared map is listed, but reading it fails.
  await setKey(page, MOCK_SCENARIO_KEY, "code-map-unreadable");
  await login(page);
  await page.goto("/settings/sources");
  await page.getByTestId(`code-map-${REPO}`).getByRole("button", { name: "See the map" }).click();
  const view = page.getByRole("dialog", { name: `Code map of ${REPO}` });
  await expect(view.getByRole("alert")).toContainText("The code map could not be read");
  await expect(view).not.toContainText("Loading");
});

test("F-38: Try again reads a map that would not load", async ({ page }) => {
  // fails_when=the failed view has no Try again, or Try again does not read the map again.
  // The "code-map-unreadable" scenario refuses the first read only.
  await setKey(page, MOCK_SCENARIO_KEY, "code-map-unreadable");
  await login(page);
  await page.goto("/settings/sources");
  await page.getByTestId(`code-map-${REPO}`).getByRole("button", { name: "See the map" }).click();
  const view = page.getByRole("dialog", { name: `Code map of ${REPO}` });
  await expect(view.getByRole("alert")).toContainText("The code map could not be read");
  await view.getByRole("button", { name: "Try again" }).click();
  await expect(view.getByRole("heading", { name: "Parts (2)" })).toBeVisible();
  await expect(view.getByRole("alert")).toHaveCount(0);
});

test("F-38: a map with nothing in it says so once it has loaded", async ({ page }) => {
  // fails_when=the view shows no Loading line while the map is read, or shows empty lists
  // (or nothing) for a map with nothing mapped. The "code-map-empty" scenario reads slowly.
  await setKey(page, MOCK_SCENARIO_KEY, "code-map-empty");
  await login(page);
  await page.goto("/settings/sources");
  await page.getByTestId(`code-map-${REPO}`).getByRole("button", { name: "See the map" }).click();
  const view = page.getByRole("dialog", { name: `Code map of ${REPO}` });
  await expect(view).toContainText("Loading the map…");
  await expect(view).toContainText("Nothing mapped yet");
  await expect(view).not.toContainText("Loading");
  await expect(view.getByRole("heading", { name: /\(\d+\)/ })).toHaveCount(0);
});
