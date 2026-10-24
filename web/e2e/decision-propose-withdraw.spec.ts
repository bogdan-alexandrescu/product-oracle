import { expect, test, type Page, mockNow } from "./test";

import { MOCK_SLOW_KEY, MOCK_SLOW_MS } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * #404 Right after Propose the new decision's inspector opens without a reload, and a
 * withdrawn decision says who withdrew it, when and why. Driven through the UI on the mock
 * layer. Each test states its card: protects / fails_when / no_claim.
 */

const APPROVER = "approver@example.com";
const COMMENTER = "commenter@example.com";
const TITLE = "Offer annual billing at launch";
const CAPS = "Ship usage caps before anomaly detection";

const row = (page: Page, text: string) => page.getByTestId("decision-row").filter({ hasText: text });
const inspector = (page: Page) => page.getByTestId("decision-inspector").filter({ visible: true });
const today = () => mockNow().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

async function propose(page: Page) {
  await page.getByRole("button", { name: "Propose decision" }).click();
  const dialog = page.getByRole("dialog", { name: "Propose decision" });
  await dialog.getByLabel("Decision", { exact: true }).fill(TITLE);
  await dialog.getByLabel("Option 1", { exact: true }).fill("Annual at launch");
  await dialog.getByLabel("Option 2", { exact: true }).fill("Monthly only");
  await dialog.getByLabel("Approver", { exact: true }).selectOption({ label: APPROVER });
  await dialog.getByRole("button", { name: "Propose", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row(page, TITLE)).toContainText("Proposed");
}

test("the inspector opens on a just-proposed decision, and its Edit works, without a reload", async ({ page }) => {
  // protects=after Propose decision the new decision is selected and its inspector shows
  // it with Edit, which opens the form and saves; fails_when=the inspector stays empty (or
  // shows another decision) until a reload; no_claim=the mock's slowed path stands in for
  // a network answering out of order.
  await login(page, COMMENTER);
  await page.goto("/company/decisions?state=all");
  await row(page, CAPS).click();
  await expect(inspector(page)).toContainText(CAPS);
  // The reload of the decision open before (D-5) answers after the new one's read, as a
  // slow network may: the new decision's inspector must still open.
  await page.evaluate(([key, path]) => localStorage.setItem(key, path), [MOCK_SLOW_KEY, "/v1/decisions/5"]);
  await propose(page);
  await expect(page).toHaveURL(/[?&]d=\d+/);
  // Past the slowed reply: the inspector must still show the new decision then.
  await page.waitForTimeout(MOCK_SLOW_MS + 500);
  await expect(inspector(page)).toContainText(TITLE);
  await inspector(page).getByRole("button", { name: "Edit", exact: true }).click();
  const form = inspector(page).getByRole("form", { name: "Edit decision" });
  await expect(form.getByLabel("Decision", { exact: true })).toHaveValue(TITLE);
  await form.getByLabel("Question").fill("Annual billing on day one?");
  await form.getByRole("button", { name: "Save changes" }).click();
  await expect(form).toHaveCount(0);
  await expect(inspector(page)).toContainText("Annual billing on day one?");
  await expect(inspector(page).getByRole("button", { name: "Withdraw" })).toBeVisible();
});

test("a withdrawn decision's inspector says who withdrew it, when and why", async ({ page }) => {
  // protects=after Withdraw with a reason the inspector reads "Withdrawn by <name>, <date>:
  // <reason>", also after a reload; fails_when=the reason is shown nowhere; no_claim=the
  // API's record of it is pytest's.
  await login(page, COMMENTER);
  await page.goto("/company/decisions?state=all");
  await propose(page);
  await inspector(page).getByRole("button", { name: "Withdraw" }).click();
  const form = inspector(page).getByRole("form", { name: "Withdraw" });
  await form.getByLabel("Reason").fill("Pricing moved to next quarter");
  await form.getByRole("button", { name: "Withdraw" }).click();
  const line = `Withdrawn by ${COMMENTER}, ${today()}: Pricing moved to next quarter`;
  await expect(inspector(page).getByTestId("decision-withdrawn")).toHaveText(line);
  await expect(inspector(page).getByRole("button", { name: "Withdraw" })).toHaveCount(0);

  await page.reload();
  await expect(inspector(page).getByTestId("decision-withdrawn")).toHaveText(line);
});
