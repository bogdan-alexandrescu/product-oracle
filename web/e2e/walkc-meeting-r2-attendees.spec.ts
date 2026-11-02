import { login, signOut } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * walkc-meeting r2: a live Simple review meeting's attendees, and the minutes' times and
 * whom things wait on, on the mock's invented PRDs "Guided setup" and "Usage alerts", desktop
 * and phone.
 *
 * Card invited-not-joined (5a): protects = an attendee the presenter invited reads
 * "invited, not joined yet" (grey dot, not counted as here) on the meeting screen until
 * they press Join, then reads here; the invited person sees Join; fails_when = an invited
 * attendee reads as here from the start, or has no Join; no_claim = the presenter's roll
 * call (Mark away / Mark here, qa4-simple-decide-meeting.spec.ts).
 *
 * Card minutes-times-and-whom (5j): protects = the Decisions page gives a meeting's and a
 * decision's day and time ("Fri Oct 16, 3:00 AM"), and the minutes' "What waits on whom"
 * names the person a working draft waits on, on the Decisions page and the end screen;
 * fails_when = only the day shows, or the wait names nobody; no_claim = the emailed minutes
 * (api tests/test_walkc_meeting.py).
 */

const TIME = /\w{3} \w{3} \d+, \d{1,2}:\d{2} [AP]M/;

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

/** Signs in as someone else: the account menu lives in the desktop rail. */
async function switchTo(page: Page, email: string) {
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: 1366, height: 820 });
  // The meeting screen covers the rail's account menu: sign out from Home.
  await page.goto("/home");
  await signOut(page);
  await login(page, email);
  await page.setViewportSize(size);
}

async function startWithTheo(page: Page) {
  await login(page);
  await page.goto("/simple/prds/guided-setup");
  await page.getByRole("button", { name: "Start review" }).click();
  const sheet = page.getByRole("dialog", { name: "Start a review" });
  await sheet.getByRole("checkbox", { name: "Theo Brandt" }).check();
  await sheet.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
}

async function openPeople(page: Page, phone: boolean) {
  if (phone && (await page.getByTestId("meeting-people-toggle").getAttribute("aria-expanded")) !== "true") {
    await page.getByTestId("meeting-people-toggle").click();
  }
}

const chip = (page: Page, name: string) => page.getByLabel("Attendees").locator("li", { hasText: name });

for (const phone of [false, true]) {
  const where = phone ? "phone" : "desktop";
  test.describe(where, () => {
    test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1366, height: 820 } });

    test(`an invited attendee reads not joined until they join (${where})`, async ({ page }) => {
      await startWithTheo(page);
      const url = page.url();
      if (phone) await expect(page.getByTestId("meeting-people-toggle")).toContainText("1 of 3 here");
      await openPeople(page, phone);
      await expect(chip(page, "Avery Stone")).toHaveAttribute("data-joined", "true");
      await expect(chip(page, "Avery Stone").getByTestId("attendee-invited")).toHaveCount(0);
      for (const name of ["Theo Brandt", "Priya Raman"]) {
        await expect(chip(page, name).getByTestId("attendee-invited")).toHaveText(/invited, not joined yet/);
        await expect(chip(page, name)).toHaveAttribute("data-joined", "false");
      }

      await switchTo(page, "commenter@example.com");
      await page.goto(url);
      await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
      await openPeople(page, phone);
      await expect(chip(page, "Theo Brandt").getByTestId("attendee-invited")).toBeVisible();
      await tap(page.getByRole("button", { name: "Join", exact: true }));
      await expect(page.getByRole("button", { name: "Join", exact: true })).toHaveCount(0);
      await openPeople(page, phone);
      await expect(chip(page, "Theo Brandt")).toHaveAttribute("data-joined", "true");
      await expect(chip(page, "Theo Brandt").getByTestId("attendee-invited")).toHaveCount(0);
      await expect(chip(page, "Priya Raman").getByTestId("attendee-invited")).toBeVisible();
      if (phone) await expect(page.getByTestId("meeting-people-toggle")).toContainText("2 of 3 here");
    });

    test(`the Decisions page gives times and the minutes name whom things wait on (${where})`, async ({ page }) => {
      await login(page, "viewer@example.com");
      await page.goto("/simple/decisions?view=meetings");
      const past = page.getByTestId("meeting-group").filter({ has: page.getByRole("link", { name: "Review: Usage alerts" }) });
      await expect(past.getByTestId("meeting-group-when")).toHaveText(new RegExp(`^${TIME.source}`));
      await expect(past.getByTestId("decision-row").first()).toContainText(TIME);
      await expect(past).toContainText("Usage alerts: the working draft is not approved yet · on Avery Stone");
    });

    test(`the end screen's minutes name whom the working draft waits on (${where})`, async ({ page }) => {
      await startWithTheo(page);
      await page.getByRole("button", { name: "Edit “A setup checklist that shows" }).click();
      await page.getByLabel("New wording for").fill("A checklist that names the next step");
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByRole("status", { name: "Working draft" })).toContainText("1 change");
      await tap(page.getByRole("button", { name: "End meeting" }));
      await page.getByRole("alertdialog").getByRole("button", { name: "End meeting" }).click();
      await expect(page.getByTestId("end-screen")).toBeVisible();
      await expect(page.getByRole("region", { name: "What still waits" })).toContainText("Guided setup: the working draft is not approved yet · on Avery Stone");
    });
  });
}
