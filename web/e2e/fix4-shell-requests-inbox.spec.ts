import { expect, test, type Page } from "./test";

import { login, signOut } from "./helpers";

/**
 * QA pass 4, shell lane: Requests' header actions and the Inbox's sources panel, driven
 * through the UI on the mock's default company.
 *
 * protects = qa-shell-19 (a viewer is not asked to fix a source they cannot edit, nor shown a
 * grey View only for it; an owner still is), qa-shell-26 (on a phone Requests has one primary
 * button, New request, and the rest under More, each still reachable; the sorting control
 * says what it does).
 * no_claim = the API's roles (the in-browser mock's capabilities stand in).
 */

const PHONE = { width: 390, height: 844 };

/** From the rail, as a person gets there. */
async function openRequests(page: Page) {
  const nav = page.getByTestId("nav-requests").filter({ visible: true });
  if (await nav.count()) await nav.first().click();
  else {
    await page.getByTestId("tab-more").click();
    await page.getByRole("dialog", { name: "More" }).getByRole("link", { name: "Requests" }).click();
  }
  await expect(page).toHaveURL(/\/requests$/);
  await expect(page.getByTestId("request-row").first()).toBeVisible();
}

const actions = (page: Page) => page.getByTestId("requests-actions");

test("qa-shell-19: a viewer's Inbox has no source to fix; the owner's has it with Edit", async ({ page }) => {
  await login(page, "viewer@example.com");
  await page.getByTestId("nav-inbox").filter({ visible: true }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
  await expect(page.getByTestId("inbox-needs")).toBeVisible();
  await expect(page.getByText("Sources that need attention")).toHaveCount(0);
  await expect(page.getByText(/edit this source/)).toHaveCount(0);
  await expect(page.getByTestId("need-by-role").filter({ hasText: "View only" })).toHaveCount(0);

  await signOut(page);
  await login(page);
  await page.getByTestId("nav-inbox").filter({ visible: true }).first().click();
  const sources = page.getByTestId("inbox-sources");
  await expect(sources).toContainText("Legacy all-hands chat");
  await expect(sources.getByRole("link", { name: "Edit Legacy all-hands chat" })).toBeVisible();
});

test("qa-shell-26: on a desktop the sorting control says what it does", async ({ page }) => {
  await login(page);
  await openRequests(page);
  await expect(actions(page).getByRole("button", { name: "Sort new requests automatically: Off" })).toBeVisible();
  await expect(actions(page).getByRole("button", { name: "Interview a customer" })).toBeVisible();
  await expect(actions(page).getByRole("button", { name: "New request", exact: true })).toBeVisible();
  await expect(page.getByTestId("requests-more")).toHaveCount(0);
});

test.describe("on a phone", () => {
  test.use({ viewport: PHONE });

  test("qa-shell-26: one primary New request; Interview a customer and the sorting under More", async ({ page }) => {
    await login(page);
    await openRequests(page);
    // Two buttons on one line, not three stacked.
    await expect(actions(page).getByRole("button")).toHaveCount(2);
    const add = (await actions(page).getByRole("button", { name: "New request", exact: true }).boundingBox())!;
    const more = (await page.getByTestId("requests-more").boundingBox())!;
    expect(Math.abs(add.y - more.y)).toBeLessThan(1);
    await expect(page.getByRole("button", { name: "Interview a customer" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Sort new requests automatically/ })).toHaveCount(0);

    // Everything the desktop offers is under More.
    await page.getByTestId("requests-more").click();
    const panel = page.getByTestId("requests-more-panel");
    await expect(panel.getByRole("switch", { name: /^Auto-sort new requests daily/ })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Sort now", exact: true })).toBeVisible();
    await expect(page.getByRole("group", { name: "Sort new requests automatically" })).toBeVisible();
    // The panel stays on the screen.
    const box = (await panel.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(page.getByTestId("requests-more")).toBeFocused();

    await page.getByTestId("requests-more").click();
    await panel.getByRole("button", { name: "Interview a customer" }).click();
    await expect(page.getByRole("dialog", { name: "Interview a customer" })).toBeVisible();
  });
});
