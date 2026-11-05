import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * removed-tracks, the owner's pick 'A Tracks sheet' (et B): "Tracks · N" beside the Roadmap's
 * filters opens a sheet of every track (paused, closed and empty ones too) with owner, state and
 * feature count; a row opens to Name, Owner, State and Move to Trash; "+ Add track" in its head;
 * a moved track is restored from Settings › Trash. An approver who does not decide proposes; a
 * viewer reads. Invented people and products (the mock's seed).
 */

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const SHOTS = process.env.RT_COMPARE_DIR;
const SCHEME: "light" | "dark" = process.env.RT_SCHEME === "dark" ? "dark" : "light";

async function open(page: Page, email?: string) {
  await page.context().addInitScript(([k, v]) => localStorage.setItem(k, v), [THEME_KEY, SCHEME] as const);
  await page.emulateMedia({ colorScheme: SCHEME });
  await login(page, email);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
}
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}${SCHEME === "dark" ? "-dark" : ""}.png` });
};
const sheet = (page: Page) => page.getByTestId("tracks-sheet");
const row = (page: Page, title: string) => sheet(page).getByTestId("track-row").filter({ has: page.getByText(title, { exact: true }) });
const toasts = (page: Page) => page.getByTestId("toasts");

test.describe("Tracks sheet", () => {
  test("an owner adds, renames, sets an owner, pauses, closes and moves a track to Trash, then restores it", async ({ page }) => {
    await open(page);
    await shot(page, "et-b-rest");
    await expect(page.getByTestId("tracks-open")).toHaveText("Tracks · 3");
    // The Track filter is a labelled select; Tracks · 3 is a button of its own.
    await expect(page.getByLabel("Track", { exact: true })).toBeVisible();
    await page.getByTestId("tracks-open").click();
    await expect(sheet(page).getByTestId("track-row")).toHaveCount(3);
    await expect(row(page, "Welcome media track")).toContainText("Paused");

    await sheet(page).getByRole("button", { name: "Change Guided setup track" }).click();
    await shot(page, "et-b-open");
    await sheet(page).getByRole("button", { name: "Rename Guided setup track" }).click();
    await sheet(page).getByLabel("Track name").fill("Setup and onboarding");
    await shot(page, "et-b-mid");
    await sheet(page).getByRole("button", { name: "Save" }).click();
    await expect(toasts(page)).toContainText("Renamed Guided setup track to Setup and onboarding");
    await expect(row(page, "Setup and onboarding")).toBeVisible();
    await shot(page, "et-b-result");

    const r = row(page, "Setup and onboarding");
    await r.getByLabel("Owner").selectOption({ label: "Priya Raman" });
    await expect(r).toContainText("Priya Raman ·");
    await r.getByRole("button", { name: "Paused" }).click();
    await expect(r).toContainText("· Paused");
    await r.getByRole("button", { name: "Closed" }).click();
    await expect(r).toContainText("· Closed");

    await sheet(page).getByTestId("track-add").click();
    await sheet(page).getByLabel("New track name").fill("Partner setup track");
    await sheet(page).getByRole("button", { name: "Add", exact: true }).click();
    await expect(toasts(page)).toContainText("Added Partner setup track");
    await expect(row(page, "Partner setup track")).toContainText("No owner · 0 features");
    await expect(page.getByTestId("tracks-open")).toHaveText("Tracks · 4");

    await row(page, "Setup and onboarding").getByRole("button", { name: "Move to Trash" }).click();
    await expect(toasts(page)).toContainText("Moved Setup and onboarding to Trash");
    await expect(row(page, "Setup and onboarding")).toHaveCount(0);
    await expect(page.getByTestId("tracks-open")).toHaveText("Tracks · 3");

    await page.goto("/settings/trash");
    await page.getByRole("button", { name: "Restore Setup and onboarding" }).click();
    await page.goto("/simple/roadmap");
    await expect(page.getByTestId("tracks-open")).toHaveText("Tracks · 4");
  });

  test("the sheet counts a track's features as its Gantt lane draws them", async ({ page }) => {
    await open(page);
    await page.getByRole("radio", { name: "Gantt" }).or(page.getByRole("button", { name: "Gantt", exact: true })).first().click();
    await page.getByTestId("group-track").click();
    await page.getByTestId("tracks-open").click();
    await expect(row(page, "Usage alerts track")).toContainText(/ · \d+ features?/);
  });

  test("an approver who does not decide proposes, naming who decides", async ({ page }) => {
    await open(page, "approver@example.com");
    await page.getByTestId("tracks-open").click();
    await sheet(page).getByRole("button", { name: "Change Usage alerts track" }).click();
    const r = row(page, "Usage alerts track");
    await expect(r.getByText("Waits for Avery Stone")).toBeVisible();
    await expect(r.getByRole("button", { name: "Move to Trash" })).toHaveCount(0);
    await shot(page, "et-b-propose");
    await r.getByRole("button", { name: "Paused" }).click();
    await expect(toasts(page)).toContainText("Proposed · waits for Avery Stone");
    await expect(r).not.toContainText("· Paused");
  });

  test("a viewer reads", async ({ page }) => {
    await open(page, "viewer@example.com");
    await page.getByTestId("tracks-open").click();
    await expect(sheet(page).getByText("View only")).toBeVisible();
    await expect(sheet(page).getByTestId("track-add")).toHaveCount(0);
    await sheet(page).getByRole("button", { name: "Open Guided setup track" }).click();
    await expect(row(page, "Guided setup track").getByLabel("Owner")).toHaveCount(0);
    await shot(page, "et-b-viewer");
  });

  test.describe("on a phone", () => {
    test.use(PHONE);
    test("the sheet rises from the bottom", async ({ page }) => {
      await open(page);
      await page.getByTestId("tracks-open").click();
      await sheet(page).getByRole("button", { name: "Change Guided setup track" }).click();
      const box = (await sheet(page).boundingBox())!;
      expect(box.y + box.height).toBeGreaterThan(800);
      await shot(page, "et-b-open-390");
    });
  });
});
