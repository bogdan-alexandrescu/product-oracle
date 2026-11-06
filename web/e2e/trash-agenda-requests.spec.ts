import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, signOut } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * port-an-decisions: a removed meeting agenda item and a deleted request wait in Settings › Trash.
 * In a live review of the invented Usage alerts PRD (the mock's "meeting-agenda-sheet" scenario;
 * Priya Raman decides the PRD), the owner removes Alert history export from the Agenda sheet: the
 * done line has Undo and Open Trash, Trash lists it with its kind chip (Agenda item) and who
 * removed it, and Restore puts it back on the agenda. Undo takes it back out of Trash, so Trash
 * reads its one short line with the reason behind the (i). Priya (an approver, the decider) sees and
 * restores what she removed; Dana Whitfield (an approver) sees none of it. On Requests an owner's
 * ⋮ menu has Delete…: the request leaves the list, Trash lists it (Request) and Restore brings it
 * back; an approver has no such menu.
 */

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function startReview(page: Page): Promise<string> {
  await page.goto("/simple/meetings");
  await tap(page.getByRole("button", { name: /^Start review/ }).first());
  const sheet = page.getByRole("dialog", { name: "Start a review" });
  await sheet.getByLabel("PRD").selectOption({ label: "Usage alerts PRD" });
  await sheet.getByRole("checkbox", { name: "Theo Brandt" }).check();
  await tap(sheet.getByRole("button", { name: "Start", exact: true }));
  await expect(
    page.getByRole("heading", { name: "Review: Usage alerts PRD" }),
  ).toBeVisible();
  return page.url();
}

async function switchTo(page: Page, email: string, url: string) {
  await page.goto("/home");
  await signOut(page);
  await login(page, email);
  await page.goto(url);
}

const strip = (page: Page) => page.getByTestId("agenda-strip");
const sheet = (page: Page) => page.getByRole("dialog", { name: "Agenda" });
const entry = (page: Page, title: string) =>
  page.getByTestId("trash-entry").filter({ hasText: title });

async function removeFromAgenda(page: Page, title: string) {
  await tap(strip(page).getByTestId("agenda-open"));
  await tap(sheet(page).getByRole("button", { name: `Remove ${title}` }));
  await expect(
    sheet(page).getByTestId("agenda-row").filter({ hasText: title }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toBeHidden();
}

test.describe("agenda items", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(
      (key) => localStorage.setItem(key, "meeting-agenda-sheet"),
      MOCK_SCENARIO_KEY,
    );
  });

  test("a removed agenda item waits in Trash, Open Trash finds it and Restore puts it back", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await login(page);
    const url = await startReview(page);
    await expect(strip(page)).toContainText("Item 2 of 5");
    await removeFromAgenda(page, "Alert history export");
    const done = page.getByTestId("agenda-done");
    await expect(done).toContainText("Removed Alert history export.");
    await expect(done.getByRole("button", { name: "Undo" })).toBeVisible();
    await tap(done.getByRole("link", { name: "Open Trash" }));
    await expect(page).toHaveURL(/\/settings\/trash$/);
    const row = entry(page, "Alert history export");
    await expect(row.getByTestId("trash-kind")).toHaveText("Agenda item");
    await expect(row).toContainText("Deleted by Avery Stone");
    await tap(
      row.getByRole("button", { name: "Restore Alert history export" }),
    );
    await expect(row).toHaveCount(0);
    await page.goto(url);
    await expect(strip(page)).toContainText("Item 2 of 5");
    await tap(strip(page).getByTestId("agenda-open"));
    await expect(
      sheet(page)
        .getByTestId("agenda-row")
        .filter({ hasText: "Alert history export" }),
    ).toHaveCount(1);
  });

  test("Undo takes the removed item back out of Trash; an empty Trash says who restores behind its (i)", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await login(page);
    await startReview(page);
    await removeFromAgenda(page, "Alert history export");
    const done = page.getByTestId("agenda-done");
    await tap(done.getByRole("button", { name: "Undo" }));
    await expect(done).toBeHidden();
    await expect(strip(page)).toContainText("Item 2 of 5");
    await page.goto("/settings/trash");
    const empty = page.getByTestId("trash-empty");
    await expect(empty).toContainText("Trash is empty.");
    await expect(page.getByTestId("trash-entry")).toHaveCount(0);
    await empty.getByRole("button", { name: "About deleted items" }).click();
    await expect(empty.getByRole("tooltip")).toContainText(
      "whoever deleted a feature, goal, decision or agenda item",
    );
  });

  test("the decider sees and restores what she removed; another approver sees none of it", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await login(page);
    const url = await startReview(page);
    await switchTo(page, "approver@example.com", url);
    await removeFromAgenda(page, "Mobile alert push");
    await tap(
      page.getByTestId("agenda-done").getByRole("link", { name: "Open Trash" }),
    );
    const row = entry(page, "Mobile alert push");
    await expect(row.getByTestId("trash-kind")).toHaveText("Agenda item");
    await expect(row).toContainText("Deleted by Priya Raman");
    await expect(
      row.getByRole("button", { name: "Restore Mobile alert push" }),
    ).toBeVisible();

    await switchTo(page, "dana.whitfield@example.com", "/settings/trash");
    await expect(page.getByTestId("trash-empty")).toContainText(
      "Trash is empty.",
    );

    await switchTo(page, "approver@example.com", "/settings/trash");
    await tap(
      entry(page, "Mobile alert push").getByRole("button", {
        name: "Restore Mobile alert push",
      }),
    );
    await expect(entry(page, "Mobile alert push")).toHaveCount(0);
    await page.goto(url);
    await tap(strip(page).getByTestId("agenda-open"));
    await expect(
      sheet(page)
        .getByTestId("agenda-row")
        .filter({ hasText: "Mobile alert push" }),
    ).toHaveCount(1);
  });
});

test.describe("requests", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  async function pick(page: Page, title: string) {
    await page.goto("/requests");
    await tap(
      page
        .getByTestId("request-row")
        .getByRole("button", { name: title, exact: true }),
    );
    await expect(page.getByTestId("request-inspector")).toContainText(title);
  }

  test("an owner deletes a request to Trash from the inspector's menu and restores it", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await login(page);
    await pick(page, "Dark mode");
    const inspector = page.getByTestId("request-inspector");
    await tap(inspector.getByRole("button", { name: "Actions for Dark mode" }));
    await tap(page.getByRole("menuitem", { name: "Delete…" }));
    const dialog = page.getByTestId("delete-dialog");
    await expect(dialog).toContainText("Nothing else goes with it.");
    await tap(dialog.getByRole("button", { name: "Move to Trash" }));
    await expect(dialog).toBeHidden();
    await expect(
      page.getByTestId("request-row").filter({ hasText: "Dark mode" }),
    ).toHaveCount(0);

    await page.goto("/settings/trash");
    const row = entry(page, "Dark mode");
    await expect(row.getByTestId("trash-kind")).toHaveText("Request");
    await expect(row).toContainText("Deleted by Avery Stone");
    await tap(row.getByRole("button", { name: "Restore Dark mode" }));
    await expect(row).toHaveCount(0);
    await pick(page, "Dark mode");
  });

  test("a request others are merged into stays, with the reason", async ({
    page,
  }) => {
    await login(page);
    const title = "Keep the delivery address between orders";
    await pick(page, title);
    await tap(
      page
        .getByTestId("request-inspector")
        .getByRole("button", { name: `Actions for ${title}` }),
    );
    await tap(page.getByRole("menuitem", { name: "Delete…" }));
    const dialog = page.getByTestId("delete-dialog");
    await tap(dialog.getByRole("button", { name: "Move to Trash" }));
    await expect(dialog).toContainText("merged into it");
    await expect(dialog).toContainText("reopen them first");
  });

  test("an approver has no Delete… on a request", async ({ page }) => {
    await login(page, "approver@example.com");
    await pick(page, "Dark mode");
    await expect(
      page
        .getByTestId("request-inspector")
        .getByRole("button", { name: "Actions for Dark mode" }),
    ).toHaveCount(0);
  });
});
