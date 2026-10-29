import { MOCK_ROLE_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * QA pass 2, simple-decide lane: Simple's Decisions page (List, Board, By meeting) on the
 * mock's invented data, driven through the UI.
 *
 * protects = qa-simple-decide-8 (the same actions for a question in every view), -9 (only
 * people who can decide are offered), -10 (Ask Oracle's panel does not reopen on the next
 * load), -15 (nothing waits on a viewer), -17 (readable action-item days), -19 (plain status
 * words), -20 (a decision listed once), -21 (the Board's Decided column says what it holds),
 * -22 (two wide Board columns at 1440 px), -23 (a compact row on a phone), -24 (one primary
 * button while the answer form is open), -25 (a disabled button looks disabled), -26 (Clear
 * filters), -27 (a filtered meeting says so), -28 (Show fewer), -29 (the footer in plain
 * words), -30 (Ask someone to answer; the picker replaces its button), -31 (meeting titles
 * look like links), -32 (the summary does not repeat the title and count), -33 (no repeated
 * column header on a phone).
 */

async function decisions(page: Page, view: "list" | "board" | "meetings" = "list") {
  await login(page);
  await page.goto("/simple/decisions");
  await page.getByTestId(`decisions-view-${view}`).click();
}

const row = (page: Page, code: string) => page.getByTestId("question-row").filter({ visible: true }).and(page.locator(`[data-code="${code}"]`));
const buttons = async (page: Page, code: string) =>
  (await row(page, code).locator(".simple-actions button").allInnerTexts()).map((x) => x.trim()).sort();

for (const phone of [false, true]) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${phone ? "phone" : "desktop"} · ${scheme}`, () => {
      test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 }, colorScheme: scheme });

      test("a question has the same actions in the List and on the Board; By meeting reads plainly", async ({ page }) => {
        await decisions(page, "list");
        const list2 = await buttons(page, "Q2");
        const list6 = await buttons(page, "Q6");
        expect(list2).toContain("Decide as recommended");
        expect(list2).toContain("Name a decider");
        await page.getByTestId("decisions-view-board").click();
        if (phone) {
          await expect(page.getByTestId("board-needs_input").locator("header")).toBeHidden();
          await page.getByTestId("board-tab-needs_input").click();
        }
        expect(await buttons(page, "Q2")).toEqual(list2);
        if (phone) await page.getByTestId("board-tab-recommended").click();
        expect(await buttons(page, "Q6")).toEqual(list6);
        if (phone) await page.getByTestId("board-tab-decided").click();
        await expect(page.getByTestId("board-decided")).toHaveAttribute("aria-label", "Decided PRD questions");

        if (phone) {
          await page.getByTestId("decisions-view-list").click();
          const actions = row(page, "Q6").locator(".simple-actions");
          expect(await actions.evaluate((el) => getComputedStyle(el).flexDirection)).toBe("row");
        }

        await page.getByTestId("decisions-view-meetings").click();
        const group = page.getByTestId("meeting-group").filter({ hasText: "Review: Usage alerts" });
        await expect(group).not.toContainText("decisions in Review: Usage alerts");
        await expect(page.getByTestId("simple-page")).not.toContainText(/\b\d{4}-\d{2}-\d{2}\b/);
        await expect(page.getByTestId("simple-page")).not.toContainText(/ · proposed$/m);
        // D-3 shows once, beside its meeting.
        const outside = page.getByRole("region", { name: "Outside meetings" });
        if (await outside.count()) await expect(outside).not.toContainText("Should muted teams still get the weekly digest?");
        const link = group.getByRole("link", { name: "Review: Usage alerts" });
        const [linkColour, textColour] = await link.evaluate((el) => [getComputedStyle(el).color, getComputedStyle(el.closest("section")!).color]);
        expect(linkColour).not.toBe(textColour);
        const foot = page.getByTestId("decisions-approvals");
        if (await foot.count()) {
          await expect(foot).toContainText("for Oracle's own work");
          await expect(foot).not.toContainText("run approvals");
        }
      });
    });
  }
}

test.describe("desktop · Decisions", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("one primary button while answering, a disabled Decide that looks disabled, Show fewer", async ({ page }) => {
    await decisions(page, "list");
    const q5 = row(page, "Q5");
    await q5.getByRole("button", { name: "Another answer" }).click();
    await q5.getByRole("radio", { name: "Something else…" }).click();
    await expect(q5.getByRole("button", { name: "Decide as recommended" })).toHaveCount(0);
    const decide = q5.getByRole("button", { name: "Decide", exact: true });
    await expect(decide).toBeDisabled();
    expect(await decide.evaluate((el) => getComputedStyle(el).opacity)).toBe("0.5");
    const more = page.getByRole("button", { name: /^Show \d+ more$/ });
    await more.click();
    await page.getByRole("button", { name: "Show fewer" }).click();
    await expect(page.getByRole("button", { name: /^Show \d+ more$/ })).toBeVisible();
  });

  test("Board: two wide columns at 1440 px; a decider is picked among those who decide; Ask someone to answer", async ({ page }) => {
    await decisions(page, "board");
    const a = await page.getByTestId("board-needs_input").boundingBox();
    const b = await page.getByTestId("board-decided").boundingBox();
    expect(a!.width).toBeGreaterThan(560);
    expect(b!.y).toBeGreaterThan(a!.y);
    const q2 = row(page, "Q2");
    await q2.getByRole("button", { name: "Name a decider" }).click();
    const people = q2.getByTestId("question-people");
    await expect(people).toContainText("Only approvers and owners decide.");
    await expect(people.getByRole("button", { name: "Approver" })).toBeVisible();
    await expect(people.getByRole("button", { name: "Viewer" })).toHaveCount(0);
    await expect(q2.getByRole("button", { name: "Name a decider" })).toHaveCount(0);
    const q3 = row(page, "Q3");
    await q3.getByRole("button", { name: "Ask someone to answer" }).click();
    await expect(q3.getByRole("button", { name: "Ask someone to answer" })).toHaveCount(0);
    await expect(q3.getByTestId("question-people")).toBeVisible();
  });

  test("filters: Clear filters when nothing matches; a filtered meeting says so", async ({ page }) => {
    await decisions(page, "meetings");
    await page.getByRole("combobox", { name: "Goal" }).selectOption({ index: 1 });
    const group = page.getByTestId("meeting-group").first();
    if (await group.count()) await expect(group.getByTestId("meeting-group-filtered")).toContainText("of this meeting match");
    await page.getByRole("combobox", { name: "Goal" }).selectOption({ index: 0 });
    await page.getByRole("combobox", { name: "PRD" }).selectOption({ label: "Guided setup" });
    await page.getByRole("combobox", { name: "Meeting" }).selectOption({ label: "Review: Usage alerts" });
    await expect(page.getByTestId("decisions-empty")).toContainText("No decision matches.");
    await page.getByTestId("decisions-clear-filters").click();
    await expect(page.getByTestId("decisions-empty")).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "PRD" })).toHaveValue("");
  });

  test("a viewer: nothing waits, no rail count", async ({ page }) => {
    await page.addInitScript(([key]) => localStorage.setItem(key, "viewer"), [MOCK_ROLE_KEY] as const);
    await decisions(page, "list");
    const mine = page.getByTestId("questions-mine");
    await expect(mine).toContainText("Nothing waits on you.");
    await expect(page.getByTestId("questions-mine-count")).toHaveCount(0);
    await expect(page.getByTestId("simple-nav-decisions-count")).toHaveCount(0);
  });

  test("Ask Oracle on a row does not reopen its panel on the next load", async ({ page }) => {
    await decisions(page, "list");
    await row(page, "Q6").getByRole("button", { name: "Ask Oracle" }).click();
    await expect(page.getByTestId("hop-panel").filter({ visible: true })).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("question-row").first()).toBeVisible();
    await expect(page.getByTestId("hop-panel").filter({ visible: true })).toHaveCount(0);
  });
});
