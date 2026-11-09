import { MOCK_SCENARIO_KEY, MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY, TRACKS_CLOSED_SCENARIO } from "../lib/api/mock/server";
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
    test.setTimeout(90_000);
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
    // A PRD has one track: only the PRD with none is offered, beside No PRD (tracks-goal).
    await expect(sheet(page).getByLabel("New track PRD").locator("option")).toHaveText(["No PRD", "Plan changes"]);
    await sheet(page).getByLabel("New track PRD").selectOption({ label: "Plan changes" });
    await sheet(page).getByRole("button", { name: "Add", exact: true }).click();
    await expect(toasts(page)).toContainText("Added Partner setup track");
    await expect(row(page, "Partner setup track")).toContainText("No owner · 0 features");
    await expect(page.getByTestId("tracks-open")).toHaveText("Tracks · 4");

    // It shows its 16 live features (its own 4 and the 12 Goal map features the mock seeds on
    // its roadmap, one-feature-panel); Move to Trash moves its cut one (In-app tour) too, and
    // says so.
    await expect(row(page, "Setup and onboarding")).toContainText("16 features");
    await row(page, "Setup and onboarding").getByRole("button", { name: "Move to Trash" }).click();
    await expect(row(page, "Setup and onboarding").getByTestId("track-trash-confirm")).toHaveText(/Its 16 features and 1 cut or merged move to No track\./);
    await row(page, "Setup and onboarding").getByTestId("track-trash-confirm").getByRole("button", { name: "Move to Trash" }).click();
    await expect(toasts(page)).toContainText("Moved Setup and onboarding to Trash · 17 features now have no track");
    await expect(row(page, "Setup and onboarding")).toHaveCount(0);
    await expect(page.getByTestId("tracks-open")).toHaveText("Tracks · 3");

    await page.goto("/settings/trash");
    await page.getByRole("button", { name: "Restore Setup and onboarding" }).click();
    await expect(page.getByRole("button", { name: "Restore Setup and onboarding" })).toHaveCount(0);
    await page.goto("/simple/roadmap");
    await expect(page.getByTestId("tracks-open")).toHaveText("Tracks · 4");
  });

  test("the sheet counts each track's features over the whole roadmap, whatever the filters show", async ({ page }) => {
    await open(page);
    await page.getByLabel("Track", { exact: true }).selectOption({ label: "Guided setup track" });
    await expect(page.getByText("Alert rules engine")).toHaveCount(0);
    await page.getByTestId("tracks-open").click();
    await expect(row(page, "Usage alerts track")).toContainText("No owner · 5 features");
    // Its 4 and the Goal map's 12, though the filter shows only the track's own.
    await expect(row(page, "Guided setup track")).toContainText("16 features");
    await expect(row(page, "Welcome media track")).toContainText("0 features");
  });

  test("Move to Trash on a track with features asks once and names the count; Undo brings both back", async ({ page }) => {
    test.setTimeout(90_000);
    await open(page);
    await page.getByRole("radio", { name: "Gantt" }).or(page.getByRole("button", { name: "Gantt", exact: true })).first().click();
    await page.getByTestId("group-track").click();
    // A lane's name on the Gantt (the Track filter's options are left out).
    const lane = (name: string) => page.getByTestId("simple-roadmap").getByText(name, { exact: true }).and(page.locator(":not(option)"));
    await expect(lane("Usage alerts track")).toHaveCount(1);
    await page.getByTestId("tracks-open").click();
    const r = row(page, "Usage alerts track");
    await sheet(page).getByRole("button", { name: "Change Usage alerts track" }).click();
    await r.getByRole("button", { name: "Move to Trash" }).click();
    const confirm = r.getByTestId("track-trash-confirm");
    await expect(confirm).toHaveText(/Its 5 features move to No track\./);
    // Cancel keeps it; asking again then confirming moves it.
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toHaveCount(0);
    await expect(r).toBeVisible();
    await r.getByRole("button", { name: "Move to Trash" }).click();
    await confirm.getByRole("button", { name: "Move to Trash" }).click();
    await expect(toasts(page)).toContainText("Moved Usage alerts track to Trash · 5 features now have no track");
    await expect(row(page, "Usage alerts track")).toHaveCount(0);
    await page.getByRole("button", { name: "Close" }).first().click();
    // Its features now sit under No track on the Gantt.
    await expect(lane("Usage alerts track")).toHaveCount(0);
    await expect(lane("No track")).toBeVisible();
    await toasts(page).getByRole("button", { name: "Undo" }).click();
    await expect(lane("Usage alerts track")).toHaveCount(1);
    await page.getByTestId("tracks-open").click();
    await expect(row(page, "Usage alerts track")).toContainText("5 features");
  });

  test("Move to Trash names the live features, and the cut or merged ones only when there are any", async ({ page }) => {
    test.setTimeout(90_000);
    await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, TRACKS_CLOSED_SCENARIO] as const);
    await open(page);
    await page.getByTestId("tracks-open").click();
    const ask = async (title: string) => {
      await sheet(page).getByRole("button", { name: `Change ${title}` }).click();
      await row(page, title).getByRole("button", { name: "Move to Trash" }).click();
      return row(page, title).getByTestId("track-trash-confirm");
    };
    // 15 live (3 and the Goal map's 12) and 1 cut.
    await expect(row(page, "Guided setup track")).toContainText("15 features");
    await expect(await ask("Guided setup track")).toHaveText(/^Its 15 features and 1 cut or merged move to No track\./);
    // No live feature, 1 cut.
    await expect(row(page, "Welcome media track")).toContainText("0 features");
    await expect(await ask("Welcome media track")).toHaveText(/^Its 1 cut or merged feature moves to No track\./);
    // 5 live and 1 merged.
    await expect(row(page, "Usage alerts track")).toContainText("5 features");
    const confirm = await ask("Usage alerts track");
    await expect(confirm).toHaveText(/^Its 5 features and 1 cut or merged move to No track\./);
    await confirm.getByRole("button", { name: "Move to Trash" }).click();
    await expect(toasts(page)).toContainText("Moved Usage alerts track to Trash · 6 features now have no track");
  });

  test("a track with no features moves to Trash at once", async ({ page }) => {
    await open(page);
    await page.getByTestId("tracks-open").click();
    await sheet(page).getByRole("button", { name: "Change Welcome media track" }).click();
    await row(page, "Welcome media track").getByRole("button", { name: "Move to Trash" }).click();
    await expect(sheet(page).getByTestId("track-trash-confirm")).toHaveCount(0);
    await expect(toasts(page)).toContainText("Moved Welcome media track to Trash");
    await expect(toasts(page)).not.toContainText("no track");
    await expect(row(page, "Welcome media track")).toHaveCount(0);
  });

  test("when every PRD has a track, the add form offers No PRD and adds; Add without a name says why", async ({ page }) => {
    await open(page);
    await page.getByTestId("tracks-open").click();
    await sheet(page).getByTestId("track-add").click();
    await sheet(page).getByLabel("New track name").fill("Pricing track");
    await sheet(page).getByRole("button", { name: "Add", exact: true }).click();
    await expect(toasts(page)).toContainText("Added Pricing track");
    await sheet(page).getByTestId("track-add").click();
    // tracks-goal: a track's PRD is optional; with none free, No PRD is the one choice and the default.
    await expect(sheet(page).getByLabel("New track PRD").locator("option")).toHaveText(["No PRD"]);
    await expect(sheet(page).getByLabel("New track PRD")).toHaveValue("");
    const add = sheet(page).getByRole("button", { name: "Add", exact: true });
    await expect(add).toBeDisabled();
    await expect(add).toHaveAttribute("title", "Name the track");
    await sheet(page).getByLabel("New track name").fill("One more track");
    await expect(add).toBeEnabled();
    await expect(add).not.toHaveAttribute("title");
    await add.click();
    await expect(toasts(page)).toContainText("Added One more track");
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
    await expect(toasts(page)).toContainText("Pause proposed · waits for Avery Stone");
    await expect(r).not.toContainText("· Paused");
    await toasts(page).getByRole("button", { name: "Withdraw" }).click();
    await expect(toasts(page)).toContainText("Withdrawn");
    // Read again after Withdraw, the track is as it was.
    await expect(r).toContainText("No owner · 5 features");
    await expect(r).not.toContainText("· Paused");
  });

  // at-followups: until the tracks are read the button names no count, never "Tracks · 0".
  test("the button names no count until the tracks are read", async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __labels: string[] };
      w.__labels = [];
      const look = () => {
        const said = document.querySelector('[data-testid="tracks-open"]')?.textContent ?? null;
        if (said !== null && w.__labels.at(-1) !== said) w.__labels.push(said);
        requestAnimationFrame(look);
      };
      requestAnimationFrame(look);
    });
    await login(page);
    await page.evaluate(
      ([k, v, msKey]) => (localStorage.setItem(k, v), localStorage.setItem(msKey, "2500")),
      [MOCK_SLOW_KEY, "/v1/simple/tracks", MOCK_SLOW_MS_KEY] as const,
    );
    await page.goto("/simple/roadmap");
    await expect(page.getByTestId("simple-roadmap")).toBeVisible();
    await expect(page.getByTestId("tracks-open")).toHaveText("Tracks");
    await expect(page.getByTestId("tracks-open")).toHaveText("Tracks · 3");
    expect(await page.evaluate(() => (window as unknown as { __labels: string[] }).__labels)).toEqual(["Tracks", "Tracks · 3"]);
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
