import { login } from "./helpers";
import { expect, test } from "./test";

/**
 * simple-home-qa-nov12 #17: on a phone, the tab bar's More carries the Inbox's own count, so it
 * is the number the Inbox says (its New tab). Driven through the UI on the mock's invented data,
 * with no meeting live (Meetings adds nothing to More).
 *
 * Card more-inbox: protects = More's badge, the More sheet's Inbox count and the Inbox's New
 * tab are one number; fails_when = More leaves out what the Roadmap tab also counts and
 * shows a smaller number than the Inbox.
 */
test.use({ viewport: { width: 390, height: 844 } });

test("More on the phone's tab bar shows the Inbox's own count", async ({ page }) => {
  await login(page);
  await page.goto("/simple");
  const badge = page.getByTestId("simple-tab-more-count");
  await expect(badge).toBeVisible();
  await page.getByTestId("simple-tab-more").click();
  const sheet = page.getByRole("dialog", { name: "More" });
  const inbox = sheet.getByTestId("simple-more-inbox-count");
  await expect(inbox).toBeVisible();
  const n = (await inbox.textContent())!.trim();
  await expect(badge).toHaveText(n);
  await sheet.getByRole("link", { name: "Inbox", exact: true }).click();
  // The Inbox's own number: its New tab ("New 31").
  await expect(page.getByRole("tab", { name: `New ${n}`, exact: true })).toBeVisible();
});
