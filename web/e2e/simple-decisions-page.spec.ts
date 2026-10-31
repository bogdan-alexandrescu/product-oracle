import { login, openRoadmapItem } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * Simple S8 (#723): the Decisions page (direction B "By meeting") and the links to it from
 * the roadmap's floating card and a one-pager's line, driven through the UI on the mock's
 * invented data (./lib/api/mock/simple-meetings.ts), desktop and phone, light and dark.
 *
 * Card decisions-by-meeting: protects = each meeting is a group with its title and date,
 * summary, attendees, open questions, action items (owner and date), what waits on whom
 * and its decisions (D-number, title, approver, date) newest first; decisions taken
 * outside meetings are their own group "Outside meetings"; the PRD, goal and meeting
 * filters narrow the groups and are kept in ?prd=, ?goal=, ?meeting=; a viewer reads it;
 * fails_when = a group or a part of it is missing, a filter shows decisions it should not,
 * or the query is not kept; no_claim = Detailed's decision log (/company/decisions).
 *
 * Card decisions-links: protects = a change made in a meeting makes the roadmap item's
 * floating card read "Decided in D-<n>" and the one-pager line "Decided in D-<n>", each a
 * link to the Decisions page's #d-<n> where that decision is shown; fails_when = the item
 * or the line does not link, or the link lands elsewhere; no_claim = decisions outside
 * Simple's subjects.
 */

const group = (page: Page, name: string) => page.getByRole("region", { name });

for (const phone of [false, true]) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${phone ? "phone" : "desktop"} · ${scheme}`, () => {
      test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1366, height: 820 }, colorScheme: scheme });

      test("decisions grouped by meeting, then outside meetings; the filters narrow them", async ({ page }) => {
        await login(page, "viewer@example.com");
        await page.goto("/simple/decisions");
        const past = group(page, "Review: Usage alerts");
        // qa-simple-decide-6: a prose summary; qa-simple-decide-1: the comment is no decision.
        await expect(past).toContainText("1 decision taken.");
        await expect(past).not.toContainText("Comment:");
        await expect(past).toContainText("Attendees: Admin, Approver, Commenter");
        await expect(past).toContainText("D-3: Should muted teams still get the weekly digest?");
        await expect(past).toContainText("Draft the quiet hours copy · Commenter · by");
        await expect(past).toContainText("Usage alerts: the working draft is not approved yet");
        const rows = past.getByTestId("decision-row");
        await expect(rows).toHaveCount(1);
        await expect(rows.first()).toContainText("D-4 Moved Weekly alert digest");
        const outside = group(page, "Outside meetings");
        // prd-decisions A1: a PRD's decided question sits here too, with its code and answer.
        // qa-simple-decide-20: D-3 is listed once, beside its meeting, not here as well.
        await expect(outside.getByTestId("decision-row")).toHaveCount(3);
        await expect(outside.getByTestId("decision-row").first()).toContainText("Q1 Data retention period");
        await expect(outside.getByTestId("decision-row").first()).toContainText("Keep 90 days · Admin");
        await expect(outside).not.toContainText("D-3");
        await expect(outside).toContainText("D-1 Start guided setup with the checklist");

        await page.getByRole("combobox", { name: "PRD", exact: true }).selectOption({ label: "Guided setup" });
        await expect(page).toHaveURL(/\?prd=guided-setup$/);
        await expect(past).toHaveCount(0);
        await expect(outside.getByTestId("decision-row")).toHaveCount(2);
        await expect(outside).toContainText("Q1 Data retention period");
        await expect(outside).toContainText("D-1 Start guided setup with the checklist");

        await page.getByRole("combobox", { name: "PRD", exact: true }).selectOption({ label: "All PRDs" });
        await page.getByRole("combobox", { name: "Goal", exact: true }).selectOption({ label: "Faster activation" });
        await expect(page).toHaveURL(/\?goal=faster-activation$/);
        await expect(past).toHaveCount(0);
        await expect(outside).toContainText("D-1 Start guided setup with the checklist");

        await page.getByRole("combobox", { name: "Goal", exact: true }).selectOption({ label: "All goals" });
        // qa-simple-decide-11: each meeting carries its day ("· live" for the one on).
        const meetingBox = page.getByRole("combobox", { name: "Meeting", exact: true });
        const pastOption = await meetingBox.locator("option", { hasText: /^Review: Usage alerts · \w{3} \w{3} \d+$/ }).first().textContent();
        await meetingBox.selectOption({ label: pastOption! });
        await expect(page).toHaveURL(/\?meeting=[0-9a-f-]+$/);
        await expect(past.getByTestId("decision-row")).toHaveCount(1);
        await expect(outside).toHaveCount(0);
        await page.reload();
        await expect(page.getByRole("combobox", { name: "Meeting", exact: true })).toHaveValue(/[0-9a-f-]{36}/);
        await expect(past).toBeVisible();
      });

      test("a roadmap item and a one-pager line link to the decisions that changed them", async ({ page }) => {
        await login(page);
        await page.goto("/simple/prds/guided-setup");
        await page.getByRole("button", { name: "Start review" }).click();
        await page.getByRole("dialog", { name: "Start a review" }).getByRole("button", { name: "Start", exact: true }).click();
        await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
        await page.getByRole("button", { name: "Edit “A sample project created on" }).click();
        await page.getByLabel("New wording for").fill("A sample project on day one");
        await page.getByRole("button", { name: "Save" }).click();
        const decisions = page.getByRole("region", { name: "Decisions in this meeting" });
        await expect(decisions).toContainText("New wording for a line of Guided setup");
        const lineNo = (await decisions.getByTestId("meeting-decision").first().locator("strong").textContent())!;
        await page.getByRole("navigation", { name: "Steps" }).getByRole("button", { name: "2 Roadmap" }).click();
        await page.getByRole("button", { name: "Move Sample data import to Next" }).click();
        await expect(decisions.getByTestId("meeting-decision").first()).toContainText("Moved Sample data import");
        const itemNo = (await decisions.getByTestId("meeting-decision").first().locator("strong").textContent())!;

        await page.goto("/simple/roadmap");
        await expect(page.getByTestId("simple-roadmap")).toBeVisible();
        await openRoadmapItem(page, "setup-import");
        const card = page.getByTestId("floating-card");
        // fix4 qa-simple-roadmap-3: the card names the decision by its title, no "D-<n>".
        await expect(card.getByTestId("card-decided-in")).toContainText("Moved Sample data import");
        await card.getByTestId("card-decided-in").getByRole("link", { name: "Moved Sample data import" }).click();
        await expect(page).toHaveURL(new RegExp(`/simple/decisions#d-${itemNo.slice(2)}$`));
        await expect(page.locator(`#d-${itemNo.slice(2)}`)).toContainText("Moved Sample data import");

        await page.goto("/simple/prds/guided-setup");
        const line = page.locator('[data-line="bets-3"]');
        await expect(line.getByTestId("line-decisions")).toHaveText(`Decided in ${lineNo}`);
        await line.getByRole("link", { name: lineNo }).click();
        await expect(page).toHaveURL(new RegExp(`/simple/decisions#d-${lineNo.slice(2)}$`));
        await expect(page.locator(`#d-${lineNo.slice(2)}`)).toContainText("New wording for a line of Guided setup: “A sample project on day one”");
      });
    });
  }
}
