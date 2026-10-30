import { MOCK_FAIL_ONCE_KEY, MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY } from "../lib/api/mock/server";
import { login, signOut } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * Simple backlog leftovers, driven through the UI on the mock layer:
 * - Detailed's roadmap diff writes a milestone's day month first ("Nov 30, 2026"), as the
 *   app does everywhere (web/lib/dates), never day first ("30 Nov 2026").
 * - Home's welcome and its Set up checklist each keep their own save state: a failed Dismiss
 *   keeps the welcome with its error by it, and neither's spinner or error shows in the other.
 *
 * no_claim for every test here: the API (the mock stands in: api/tests/test_setup.py covers
 * the welcome preference, the roadmap diff's own pytest its fields).
 */

const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const GB_DAY = /\b\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\b/;
const NEW_OWNER = "nia.example@example.com";

const visible = (page: Page, testId: string) => page.getByTestId(testId).filter({ visible: true });
const welcome = (page: Page) => visible(page, "home-welcome");
const setup = (page: Page) => visible(page, "home-setup");

/** An owner invites a second owner in the empty company; the new owner's first Home shows the welcome above Set up. */
async function newOwner(page: Page) {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "empty"));
  await login(page);
  await page.goto("/settings/members");
  const form = page.getByRole("form", { name: "Invite" });
  await form.getByLabel("Email").fill(NEW_OWNER);
  await form.getByLabel("Role", { exact: true }).selectOption("owner");
  await form.getByRole("button", { name: "Send invite", exact: true }).click();
  await expect(page.getByTestId("invite-outcome")).toHaveText(`Invite sent to ${NEW_OWNER}`);
  await signOut(page);
  await login(page, NEW_OWNER);
  await expect(welcome(page).getByRole("heading", { name: "Welcome to Oracle" })).toBeVisible();
  await expect(setup(page)).toBeVisible();
}

for (const [name, device] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
] as const) {
  test.describe(name, () => {
    test.use(device);

    // Card simple-leftovers-diff-days: protects = the PRD diff's "What changed" line writes a
    // milestone's day month first; fails_when = it reads "30 Nov 2026" (en-GB, day first);
    // no_claim = the chips' dates (the same writer, no mock item moves a date).
    test("the roadmap diff writes a milestone's day month first", async ({ page }) => {
      await login(page);
      await page.goto("/documents/checkout-redesign/diff?from=1&to=2");
      const item = visible(page, "diff-item").filter({ hasText: "Shipping step" });
      await expect(item).toContainText("Date: Nov 30, 2026 → none");
      await expect(visible(page, "diff-items")).not.toContainText(GB_DAY);
    });

    // Card simple-leftovers-welcome-failed-save: protects = a Dismiss that fails to save keeps
    // the welcome (nothing lost: its words and its Dismiss), says so by the welcome, and never
    // in or as Set up's; a second Dismiss saves; fails_when = the welcome goes, no error shows,
    // or the error shows as Set up's; no_claim = the error's exact words (errorMessage's).
    test("a welcome whose Dismiss fails to save stays, with its error", async ({ page }) => {
      await newOwner(page);
      const role = await welcome(page).getByTestId("welcome-role").innerText();
      await page.evaluate((k) => localStorage.setItem(k, "PATCH /v1/me/preferences"), MOCK_FAIL_ONCE_KEY);
      await welcome(page).getByRole("button", { name: "Dismiss" }).click();
      await expect(visible(page, "home-welcome-error")).toBeVisible();
      await expect(visible(page, "home-welcome-error")).not.toContainText(/500|Mock/);
      await expect(welcome(page)).toBeVisible();
      await expect(welcome(page).getByTestId("welcome-role")).toHaveText(role);
      await expect(welcome(page).getByRole("button", { name: "Dismiss" })).toBeEnabled();
      await expect(visible(page, "home-setup-error")).toHaveCount(0);
      await expect(setup(page)).toBeVisible();
      await expect(setup(page).getByRole("button", { name: "Hide" })).toBeEnabled();
      // Again: it saves, the welcome goes and its error with it.
      await welcome(page).getByRole("button", { name: "Dismiss" }).click();
      await expect(welcome(page)).toHaveCount(0);
      await expect(visible(page, "home-welcome-error")).toHaveCount(0);
      await page.reload();
      await expect(setup(page)).toBeVisible();
      await expect(welcome(page)).toHaveCount(0);
    });

    // Card simple-leftovers-welcome-setup-apart: protects = while the welcome's Dismiss saves,
    // Set up's Hide stays on (and the other way round), and Set up's failed Hide shows its
    // error as Set up's, not the welcome's; fails_when = one's save disables the other's
    // button or its error shows as the other's; no_claim = the spinner's look.
    test("the welcome and Set up never share a save's spinner or error", async ({ page }) => {
      await newOwner(page);
      await page.evaluate(
        ([k, v, mk]) => {
          localStorage.setItem(k, v);
          localStorage.setItem(mk, "4000");
        },
        [MOCK_SLOW_KEY, "PATCH /v1/me/preferences", MOCK_SLOW_MS_KEY] as const,
      );
      await welcome(page).getByRole("button", { name: "Dismiss" }).click();
      await expect(welcome(page).getByRole("button", { name: "Dismiss" })).toBeDisabled();
      await expect(setup(page).getByRole("button", { name: "Hide" })).toBeEnabled();
      await expect(welcome(page)).toHaveCount(0, { timeout: 10_000 });
      await page.evaluate((k) => localStorage.removeItem(k), MOCK_SLOW_KEY);
      // Set up's own failed Hide: its error is Set up's; the panel comes back.
      await page.evaluate((k) => localStorage.setItem(k, "PATCH /v1/me/preferences"), MOCK_FAIL_ONCE_KEY);
      await setup(page).getByRole("button", { name: "Hide" }).click();
      await expect(visible(page, "home-setup-error")).toBeVisible();
      await expect(setup(page)).toBeVisible();
      await expect(visible(page, "home-welcome-error")).toHaveCount(0);
    });
  });
}
