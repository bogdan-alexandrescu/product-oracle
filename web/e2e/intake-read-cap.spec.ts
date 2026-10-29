import { expect, test, type Page } from "./test";

import { BEFORE_DRAFTING } from "../lib/api/mock/intake";
import { login } from "./helpers";

/*
 * INT2: reading an intake again is capped per Company day (owner decision 2026-10-26, on
 * #624's review). The "before-drafting" mock scenario's brief is admin@example.com's (an
 * owner: owners get the same cap), and Oracle read it when it was created; that read is
 * not counted.
 *
 * Test card:
 * - "read again until the cap": protects=three reads the author starts in a Company day,
 *   counted beside Read the brief again ("1 of 3 left today"), then the button disabled with the
 *   owner's sentence; fails_when=a fourth read can be started, the count is missing, or
 *   the button gives no reason; no_claim=the API's own count (api/tests/test_intake_read_cap.py).
 */

const CAPPED = "This intake was read 3 times today; read it again tomorrow";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("po-mock-scenario")) localStorage.setItem("po-mock-scenario", "before-drafting");
  });
});

const readLine = (page: Page) => page.getByTestId("intake-read");
const readAgain = (page: Page) => readLine(page).getByRole("button", { name: "Read the brief again" });

test("read again until the cap: the fourth read waits for tomorrow, and says so", async ({ page }) => {
  await login(page);
  await page.goto(`/intakes/${BEFORE_DRAFTING.intakeId}`);
  await expect(page.getByRole("heading", { level: 1, name: BEFORE_DRAFTING.title })).toBeAttached();

  // The read on create finished; it is not one of today's three.
  await expect(readLine(page)).toContainText("Oracle assumed");
  await expect(readAgain(page)).toBeEnabled();
  await expect(readLine(page).getByTestId("intake-read-count")).toHaveText("3 of 3 left today");

  await readAgain(page).click();
  await expect(readLine(page).getByTestId("intake-read-count")).toHaveText("2 of 3 left today");
  await readAgain(page).click();
  await expect(readLine(page).getByTestId("intake-read-count")).toHaveText("1 of 3 left today");
  await expect(readAgain(page)).toBeEnabled();
  await expect(readLine(page)).not.toContainText(CAPPED);

  await readAgain(page).click();
  await expect(readAgain(page)).toBeDisabled();
  await expect(readLine(page).getByTestId("intake-read-capped")).toHaveText(CAPPED);
  await expect(readAgain(page)).toHaveAttribute("title", CAPPED);

  // It holds across a reload: the count is the mock API's, not the page's.
  await page.reload();
  await expect(readAgain(page)).toBeDisabled();
  await expect(readLine(page).getByTestId("intake-read-capped")).toHaveText(CAPPED);
});
