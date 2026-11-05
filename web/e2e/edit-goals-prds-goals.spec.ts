import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN, login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * edit-goals-prds EG1 a "Owner in the form" (the owner's pick, BGD Nov 5), driven through Goal
 * buckets on the mock's "simple-plan" scenario (invented: goals Reliability, Growth, Activation and
 * Revenue; archived goals Cut support tickets in half, Launch in two new regions and Faster first
 * report; members Avery Stone (owner), Priya Raman (approver), Theo Brandt (commenter), Lena Ortiz
 * (viewer)). Desktop 1440x900 and phone 390x844, light and dark.
 *
 * Card eg1-owner: protects = each goal names its owner under its measure; the pencil's form has an
 * Owner field; a picked owner is saved and read back; fails_when = no owner line or no Owner field,
 * or the pick is not kept.
 * Card eg1-archive-restore: protects = the ⋯ menu reads Edit goal, Archive goal, Delete goal;
 * archiving opens the "Archived goals" fold with the goal at its top; Restore puts it back in the
 * buckets; fails_when = the goal is not in the fold or Restore leaves it there.
 * Card eg1-delete: protects = Delete on an archived goal asks once more, says it goes to
 * Settings > Trash for 30 days, and takes it out of the fold; Delete goal on a live goal asks where
 * its features go; fails_when = no confirm, or the goal stays.
 * Card eg1-ask: protects = a commenter's ⋯ reads Ask to archive and Ask to delete, the confirm says
 * to whom it goes ("Send to Avery Stone"), and the note says it was sent; the goal stays; fails_when
 * = a commenter gets Archive goal or the goal is archived.
 * Card eg1-viewer: protects = a viewer reads owners and the archived list with no ⋯, Restore or
 * Delete; fails_when = any of them shows.
 */

const LOOKS = [
  {
    name: "desktop light",
    viewport: { width: 1440, height: 900 },
    theme: "light",
  },
  { name: "phone dark", viewport: { width: 390, height: 844 }, theme: "dark" },
] as const;
const MORE_LOOKS = [
  {
    name: "desktop dark",
    viewport: { width: 1440, height: 900 },
    theme: "dark",
  },
  {
    name: "phone light",
    viewport: { width: 390, height: 844 },
    theme: "light",
  },
] as const;

type Look = (typeof LOOKS)[number] | (typeof MORE_LOOKS)[number];

async function open(page: Page, look: Look, who = ADMIN.email) {
  await page.setViewportSize(look.viewport);
  await page.context().addInitScript(
    ([key, value, themeKey, theme]) => {
      localStorage.setItem(key, value);
      localStorage.setItem(themeKey, theme);
    },
    [MOCK_SCENARIO_KEY, "simple-plan", THEME_KEY, look.theme] as const,
  );
  await login(page, who);
  await page.goto("/simple/priorities?tab=buckets");
  await expect(page.getByTestId("buckets-head")).toBeVisible();
  await expect(
    bucket(page, "Reliability").getByTestId("goal-measure"),
  ).toBeVisible();
}

const bucket = (page: Page, goal: string) =>
  page.locator(`[data-testid="plan-goal"][data-goal="${goal}"]`);
const note = (page: Page) => page.getByTestId("bucket-note");
const fold = (page: Page) => page.getByTestId("archived-goals");

for (const look of [...LOOKS, ...MORE_LOOKS]) {
  test(`${look.name}: each goal names its owner; the menu reads Edit, Archive and Delete goal`, async ({
    page,
  }) => {
    await open(page, look);
    await expect(
      bucket(page, "Reliability").getByTestId("goal-owner"),
    ).toHaveText("Owner: Priya Raman");
    await expect(bucket(page, "Growth").getByTestId("goal-owner")).toHaveText(
      "Owner: Avery Stone",
    );
    await bucket(page, "Growth")
      .getByRole("button", { name: "More for Growth" })
      .click();
    await expect(page.getByRole("menuitem")).toHaveText([
      "Edit goal",
      "Archive goal",
      "Delete goal",
    ]);
    await expect(
      page.getByRole("menuitem", { name: "Delete goal" }),
    ).toBeInViewport();
    await expect(fold(page)).toContainText("Archived goals · 3");
  });
}

for (const look of LOOKS) {
  test.describe(look.name, () => {
    test("the pencil's form picks an owner, and the goal reads it", async ({
      page,
    }) => {
      await open(page, look);
      const card = bucket(page, "Growth");
      await card.getByRole("button", { name: "Edit Growth" }).click();
      const form = card.getByTestId("goal-form");
      await expect(form.getByLabel("Owner")).toHaveValue(/.+/);
      await form.getByLabel("Owner").selectOption({ label: "Theo Brandt" });
      await form.getByRole("button", { name: "Save goal" }).click();
      await expect(card.getByTestId("goal-owner")).toHaveText(
        "Owner: Theo Brandt",
      );
      await expect(note(page)).toContainText("Saved Growth");
      await note(page).getByRole("button", { name: "Undo" }).click();
      await expect(card.getByTestId("goal-owner")).toHaveText(
        "Owner: Avery Stone",
      );
    });

    test("archive a goal: it tops the opened Archived goals fold; Restore puts it back", async ({
      page,
    }) => {
      await open(page, look);
      await bucket(page, "Growth")
        .getByRole("button", { name: "More for Growth" })
        .click();
      await page.getByRole("menuitem", { name: "Archive goal" }).click();
      const dialog = page.getByRole("dialog", { name: "Archive Growth" });
      const go = dialog.getByRole("button", { name: "Archive goal" });
      if (await go.isDisabled())
        await dialog
          .getByLabel("Goal", { exact: true })
          .selectOption({ label: "1 · Reliability" });
      await go.click();
      await expect(dialog).toHaveCount(0);
      await expect(bucket(page, "Growth")).toHaveCount(0);
      const first = fold(page).getByTestId("archived-goal").first();
      await expect(first).toBeVisible();
      await expect(first).toContainText("Growth");
      await expect(fold(page)).toContainText("Archived goals · 4");
      await first.getByRole("button", { name: "Restore" }).click();
      await expect(note(page)).toContainText("Restored Growth.");
      await expect(bucket(page, "Growth")).toHaveCount(1);
      await expect(fold(page)).toContainText("Archived goals · 3");
    });

    test("delete an archived goal: it asks once more and goes to Settings > Trash", async ({
      page,
    }) => {
      await open(page, look);
      await fold(page).locator("summary").click();
      const row = fold(page)
        .getByTestId("archived-goal")
        .filter({ hasText: "Faster first report" });
      await row.getByRole("button", { name: "Delete" }).click();
      const dialog = page.getByRole("dialog", {
        name: "Delete Faster first report",
      });
      await expect(dialog).toContainText("Delete Faster first report?");
      await expect(dialog).toContainText(
        "It goes to Settings > Trash for 30 days.",
      );
      await dialog.getByRole("button", { name: "Delete goal" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(note(page)).toContainText(
        "Deleted Faster first report. It is in Settings > Trash for 30 days.",
      );
      await expect(row).toHaveCount(0);
    });

    test("Delete goal on a live goal asks where its features go, then sends it to Trash", async ({
      page,
    }) => {
      await open(page, look);
      await bucket(page, "Activation")
        .getByRole("button", { name: "More for Activation" })
        .click();
      await page.getByRole("menuitem", { name: "Delete goal" }).click();
      const dialog = page.getByRole("dialog", { name: "Delete Activation" });
      await expect(dialog).toContainText(
        "It goes to Settings > Trash for 30 days.",
      );
      const go = dialog.getByRole("button", { name: "Delete goal" });
      if (await go.isDisabled())
        await dialog
          .getByLabel("Goal", { exact: true })
          .selectOption({ label: "1 · Reliability" });
      await go.click();
      await expect(dialog).toHaveCount(0);
      await expect(bucket(page, "Activation")).toHaveCount(0);
      await expect(note(page)).toContainText("Deleted Activation.");
    });

    test("a commenter asks to archive and to delete; the confirm says to whom", async ({
      page,
    }) => {
      await open(page, look, "commenter@example.com");
      await bucket(page, "Growth")
        .getByRole("button", { name: "More for Growth" })
        .click();
      await expect(page.getByRole("menuitem")).toHaveText([
        "Ask to archive",
        "Ask to delete",
      ]);
      await page.getByRole("menuitem", { name: "Ask to archive" }).click();
      const dialog = page.getByRole("dialog", {
        name: "Ask to archive Growth",
      });
      const send = dialog.getByRole("button", { name: "Send to Avery Stone" });
      if (await send.isDisabled())
        await dialog
          .getByLabel("Goal", { exact: true })
          .selectOption({ label: "1 · Reliability" });
      await send.click();
      await expect(dialog).toHaveCount(0);
      await expect(note(page)).toContainText(
        "Sent to Avery Stone: archive Growth.",
      );
      await expect(bucket(page, "Growth")).toHaveCount(1);
      await bucket(page, "Growth")
        .getByRole("button", { name: "More for Growth" })
        .click();
      await page.getByRole("menuitem", { name: "Ask to delete" }).click();
      const del = page.getByRole("dialog", { name: "Ask to delete Growth" });
      const sendDel = del.getByRole("button", { name: "Send to Avery Stone" });
      if (await sendDel.isDisabled())
        await del
          .getByLabel("Goal", { exact: true })
          .selectOption({ label: "1 · Reliability" });
      await sendDel.click();
      await expect(note(page)).toContainText(
        "Sent to Avery Stone: delete Growth.",
      );
      await expect(bucket(page, "Growth")).toHaveCount(1);
    });

    test("a viewer reads owners and the archived goals, with no menu, Restore or Delete", async ({
      page,
    }) => {
      await open(page, look, "viewer@example.com");
      await expect(
        bucket(page, "Reliability").getByTestId("goal-owner"),
      ).toHaveText("Owner: Priya Raman");
      await expect(
        page.getByRole("button", { name: /^More for / }),
      ).toHaveCount(0);
      await fold(page).locator("summary").click();
      await expect(fold(page).getByTestId("archived-goal")).toHaveCount(3);
      await expect(fold(page).getByRole("button")).toHaveCount(0);
    });
  });
}
