import { expect, test, type Page } from "@playwright/test";

import { login } from "./helpers";

/*
 * C1 Requests, lane 3 (triage), driven through the UI as a person would, on the mock API:
 * Classify now and its status line, and the requests Oracle found in the signed-in
 * person's own sources (seeded: two for admin@example.com), filed with what filing shares.
 *
 * Each test states its card: protects (the observable), fails_when (the wrong result it
 * rejects), no_claim (what green does not prove).
 */

const SHARING =
  "Filing shares this item: everyone who can see Requests will read your text, the item's title and link, and this excerpt";

/** From the rail, as a person gets there. */
async function openRequests(page: Page) {
  await page.getByTestId("nav-requests").filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/requests$/);
  await expect(page.getByRole("heading", { name: "Requests", level: 1 })).toBeAttached();
}

const found = (page: Page) => page.getByTestId("found-in-sources");
const foundRow = (page: Page, title: string) => found(page).getByTestId("found-item").filter({ hasText: title });

test("found in your sources: file one, seeing what filing shares", async ({ page }) => {
  // protects=criteria 16 and 19c (the panel for its owner only; File as request opens Add
  // request pre-filled with the sharing line and the 400-character excerpt; the count drops);
  // fails_when=the panel is missing, the dialog files without showing what it shares, or the
  // count stays; no_claim=the real API (tests/test_requests_triage.py) and the inspector (lane 2).
  await login(page);
  await openRequests(page);
  await expect(found(page)).toContainText("Oracle found 2 possible requests in your sources");
  const row = foundRow(page, "Reorder last week's basket");
  await expect(row).toContainText("#support thread");
  await expect(row).toContainText("Support");
  await row.getByRole("button", { name: "File as request" }).click();

  const dialog = page.getByRole("dialog", { name: "Add request" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Title")).toHaveValue("Reorder last week's basket");
  await expect(dialog.getByLabel("Where it came from")).toHaveValue("support");
  await expect(dialog.getByTestId("filing-shares")).toContainText(SHARING);
  const excerpt = dialog.getByTestId("filing-excerpt");
  await expect(excerpt).toContainText("Could I reorder what I bought last week in one click?");
  expect(((await excerpt.textContent()) ?? "").length).toBeLessThanOrEqual(400);
  await dialog.getByLabel("Title").fill("Reorder a past basket in one click");
  await dialog.getByRole("button", { name: "Add request" }).click();

  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("filed-notice")).toContainText("Reorder a past basket in one click");
  await expect(found(page)).toContainText("Oracle found 1 possible request in your sources");
  await expect(foundRow(page, "Reorder last week's basket")).toHaveCount(0);
  await expect(foundRow(page, "Pick a delivery slot")).toBeVisible();
});

test("found in your sources: dismiss one, then the last; the panel goes", async ({ page }) => {
  // protects=Dismiss (the item leaves the panel; with none open the panel is gone);
  // fails_when=a dismissed item stays listed or the panel shows "0"; no_claim=re-finding it.
  await login(page);
  await openRequests(page);
  await foundRow(page, "Pick a delivery slot").getByRole("button", { name: "Dismiss" }).click();
  await expect(found(page)).toContainText("Oracle found 1 possible request in your sources");
  await foundRow(page, "Reorder last week's basket").getByRole("button", { name: "Dismiss" }).click();
  await expect(found(page)).toHaveCount(0);
});

test("Classify now: an approver starts triage and sees it finish", async ({ page }) => {
  // protects=Classify now (approver+) and the header's status line ("Oracle is classifying ·
  // started …", then "N suggestions, M found in your sources"); the found panel is absent for
  // someone with no found items (criterion 16's second half); the daily-run tip; fails_when=the
  // button is missing for an approver, the status never changes, or another person's found items
  // show; no_claim=SwarmCloud (the mock finishes the run itself).
  await login(page, "approver@example.com");
  await openRequests(page);
  await expect(found(page)).toHaveCount(0);
  await page.getByRole("button", { name: "About Classify now" }).click();
  await expect(page.getByText("Oracle also classifies new requests every day at 07:00 PT")).toBeVisible();
  await page.getByRole("button", { name: "Classify now", exact: true }).click();
  const status = page.getByTestId("triage-status");
  await expect(status).toContainText(/Oracle is classifying · started (just now|\d+ min ago)/);
  await expect(page.getByRole("button", { name: "Classify now", exact: true })).toBeDisabled();
  await expect(status).toContainText("4 suggestions, 0 found in your sources", { timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Classify now", exact: true })).toBeEnabled();
});

test("the daily run that could not start says why", async ({ page }) => {
  // protects=the reason Oracle's daily triage did not start (no active member to run it as),
  // shown where the triage status is, then replaced by a run's status; fails_when=nothing says
  // why, or the reason stays after Classify now; no_claim=choosing the member (the API's tests).
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "triage-skipped"));
  await login(page, "approver@example.com");
  await openRequests(page);
  const status = page.getByTestId("triage-status");
  await expect(status).toContainText("Oracle's daily triage did not run on 2026-10-22");
  await expect(status).toContainText("none of them is an active member");
  await page.getByRole("button", { name: "Classify now", exact: true }).click();
  await expect(status).toContainText(/Oracle is classifying · started/);
  await expect(status).not.toContainText("did not run");
});

for (const email of ["commenter@example.com", "viewer@example.com"]) {
  test(`${email.split("@")[0]}s do not start triage`, async ({ page }) => {
    // protects=behaviour rule 2 (approvers and owners start triage); fails_when=Classify now is
    // offered to a commenter or a viewer, or someone else's found items show; no_claim=the API's
    // 403 (tests/test_requests_triage.py).
    await login(page, email);
    await openRequests(page);
    await expect(page.getByTestId("requests-empty")).toBeVisible();
    await expect(page.getByRole("button", { name: "Classify now", exact: true })).toHaveCount(0);
    await expect(found(page)).toHaveCount(0);
  });
}

test("phone: the found panel and the filing dialog fit 390 px", async ({ page }) => {
  // protects=the phone layout of lane 3's parts (no horizontal scroll; the dialog fits);
  // fails_when=the panel or dialog overflows the screen; no_claim=the table's cards (lane 2).
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.goto("/requests");
  await expect(found(page)).toContainText("Oracle found 2 possible requests in your sources");
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(await overflow()).toBeLessThanOrEqual(0);
  await foundRow(page, "Pick a delivery slot").getByRole("button", { name: "File as request" }).click();
  const dialog = page.getByRole("dialog", { name: "Add request" });
  await expect(dialog.getByTestId("filing-excerpt")).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(await overflow()).toBeLessThanOrEqual(0);
});
