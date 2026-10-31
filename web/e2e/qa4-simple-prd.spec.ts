import { ADMIN, login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * QA pass 4 on the Simple PRD pages (qa4-simple-prd-N), driven through the UI on the mock's
 * invented PRDs: Saved carts PRD (two versions, never approved, last changed Oct 18), Usage
 * alerts PRD and Guided setup (the seeded one-pager, with a drawn flow on its first bet).
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const VIEWER = "viewer@example.com";
const COMMENTER = "commenter@example.com";

async function openFromList(page: Page, title: string, email: string = ADMIN.email) {
  await login(page, email);
  await page.goto("/simple/one-pagers");
  await page.getByTestId("simple-one-pagers").getByRole("link", { name: title, exact: true }).click();
  await expect(page.getByRole("article", { name: "One-pager" })).toBeVisible();
}

const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  test("Start review opens the form for any PRD, named by its title (qa4-simple-prd-1, 28)", async ({ page }) => {
    await openFromList(page, "Saved carts PRD");
    await page.getByRole("button", { name: "Start review" }).click();
    const sheet = page.getByRole("dialog", { name: "Start a review" });
    await expect(sheet.getByRole("button", { name: "Start", exact: true })).toBeVisible();
    await expect(sheet).toContainText("Saved carts PRD");
    await expect(sheet).not.toContainText("No such PRD");
    await sheet.getByRole("button", { name: "Close" }).click();

    await page.goto("/simple/one-pagers/usage-alerts");
    await page.getByRole("button", { name: "Start review" }).click();
    await expect(page.getByRole("dialog", { name: "Start a review" })).toContainText("Usage alerts PRD");
  });

  test("a never-published PRD is not called published, and its dates agree with the list (qa4-simple-prd-3, 9, 25, 34)", async ({ page }) => {
    await login(page);
    await page.goto("/simple/one-pagers");
    await expect(page.getByText("Open a PRD to read it on one page, change its wording or start a review.")).toBeVisible();
    const row = page.getByTestId("one-pager-row").filter({ hasText: "Saved carts PRD" });
    await expect(row).toContainText("Updated Oct 18, 2026");
    await row.getByRole("link", { name: "Saved carts PRD" }).click();
    const meta = page.getByTestId("one-pager-meta");
    await expect(meta).toContainText("Version 2");
    await expect(meta).not.toContainText("Oct 20");
    await expect(page.getByRole("link", { name: "Open in Detailed" })).toHaveAttribute("href", "/documents/saved-carts");

    await page.getByRole("button", { name: "Edit “Single sign-on setup" }).click();
    // qa4-simple-prd-16: the editor and its Save come into view.
    await expect(page.getByRole("button", { name: "Save" })).toBeInViewport();
    await page.getByLabel("New wording for").fill("Single sign-on setup for every plan");
    await page.getByRole("button", { name: "Save" }).click();
    const banner = page.getByRole("status", { name: "Working draft" });
    await expect(banner).toContainText("nothing is published until approved");
    await expect(banner).not.toContainText("published v");
  });

  test("the change card says You, once a before/after, and Hide closes it (qa4-simple-prd-17, 18, 23)", async ({ page }) => {
    await openFromList(page, "Saved carts PRD");
    await page.getByRole("button", { name: "Edit “Single sign-on setup" }).click();
    await page.getByLabel("New wording for").fill("Single sign-on setup for every plan");
    await page.getByRole("button", { name: "Save" }).click();
    const note = page.getByRole("note").filter({ visible: true }).filter({ hasText: "changed “Single sign-on setup" });
    await expect(note).toContainText("You changed");
    await note.getByRole("button", { name: "See before/after" }).click();
    const diff = note.getByTestId("note-diff");
    await expect(diff).toContainText("Before:");
    await expect(diff).not.toContainText("In “");
    await note.getByRole("button", { name: "Hide before/after" }).click();
    await expect(diff).toHaveCount(0);

    await page.reload();
    await expect(page.getByRole("note").filter({ visible: true }).filter({ hasText: "changed “Single sign-on setup" })).toContainText("You changed");

    // qa4-simple-prd-23: the file and the note say which text was exported.
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export PDF" }).click();
    expect((await download).suggestedFilename()).toBe("Saved carts PRD v2 last version one-pager.pdf");
    await expect(page.getByRole("status").filter({ hasText: "PDF downloaded" })).toContainText("without the working draft's changes");
  });

  test("Present centres the page (qa4-simple-prd-5)", async ({ page }) => {
    await openFromList(page, "Saved carts PRD");
    await page.getByRole("button", { name: "Present" }).click();
    await expect(page.getByTestId("one-pager")).toHaveAttribute("data-presenting", "true");
    const card = (await page.getByRole("article", { name: "One-pager" }).boundingBox())!;
    expect(Math.abs(card.x + card.width / 2 - DESKTOP.width / 2)).toBeLessThan(24);
    const stop = (await page.getByRole("button", { name: "Stop presenting" }).boundingBox())!;
    expect(stop.x + stop.width).toBeLessThanOrEqual(card.x + card.width + 1);
  });

  test("the timeline's labels keep their phrases whole and its words agree (qa4-simple-prd-14, 15)", async ({ page }) => {
    await openFromList(page, "Saved carts PRD");
    const strip = page.getByLabel("Timeline strip");
    const parts = strip.getByTestId("plan-strip-label").locator("span");
    await expect(parts.first()).toBeVisible();
    // Each part (the name, the count) on one line: one line's height, never two.
    for (const h of await parts.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))) expect(h).toBeLessThan(30);
    await expect(strip.getByTestId("plan-strip-edge")).toHaveText("1 roadmap item with no milestone ends after Jan");
    await expect(strip.getByTestId("plan-strip-row").filter({ hasText: "No milestone" }).getByTestId("plan-strip-ends")).toHaveText("ends after Jan");
  });

  test("today is the company's day, as the change times read (qa4-simple-prd-10)", async ({ page }) => {
    // 03:11 UTC on Oct 31 is the evening of Oct 30 in the company's zone (Los Angeles).
    await page.clock.setSystemTime(new Date("2026-10-31T03:11:00Z"));
    await login(page);
    await page.goto("/simple/one-pagers/guided-setup");
    await expect(page.getByLabel("Timeline strip").getByTestId("plan-strip-legend")).toContainText("Today Oct 30");
  });

  test("a commenter's card starts at its own padding (qa4-simple-prd-21)", async ({ page }) => {
    await openFromList(page, "Saved carts PRD", COMMENTER);
    const card = (await page.getByRole("article", { name: "One-pager" }).boundingBox())!;
    const first = (await page.getByRole("region", { name: "Problem and who has it" }).boundingBox())!;
    expect(first.y - card.y).toBeLessThan(36);
  });

  test("a viewer's flow offers no Comment (qa4-simple-prd-33)", async ({ page }) => {
    await login(page, VIEWER);
    await page.goto("/simple/one-pagers/guided-setup");
    await page.getByRole("button", { name: "Open the flow" }).first().click();
    const opened = page.getByTestId("flow-detail");
    await expect(opened).toBeVisible();
    await expect(opened.getByRole("button", { name: "See comments" })).toBeVisible();
    await expect(opened.getByRole("button", { name: "Comment", exact: true })).toHaveCount(0);
  });

  test("the flow's notes cite the section in words, and its comment submit reads Post comment (qa4-simple-prd-31, 32)", async ({ page }) => {
    await login(page, COMMENTER);
    await page.goto("/simple/one-pagers/guided-setup");
    await page.getByRole("button", { name: "Flow for “A setup checklist that shows" }).click();
    const opened = page.getByTestId("flow-detail");
    await opened.getByRole("button", { name: "Full screen" }).click();
    const full = page.getByTestId("flow-fullscreen");
    await full.getByRole("button", { name: "Comment" }).click();
    await expect(full.getByTestId("flow-annotations")).toContainText("The checklist shows the next step · From “What we will build”");
    await expect(full.getByTestId("flow-annotations")).not.toContainText("Requirement");
    const panel = full.getByTestId("flow-comments-panel");
    await panel.getByLabel("Comment on the flow").fill("Name the invite step after the calendar");
    await expect(panel.getByRole("button", { name: "Comment", exact: true })).toHaveCount(0);
    await panel.getByRole("button", { name: "Post comment" }).click();
    await expect(panel.getByTestId("flow-comments")).toContainText("Name the invite step after the calendar · open");
  });

  test("a bet's first flow is titled after its line, as Version 1 (qa4-simple-prd-22)", async ({ page }) => {
    await openFromList(page, "Saved carts PRD");
    const line = page.locator("li", { hasText: "Invite suggestions from the admin" }).first();
    await line.getByRole("button", { name: "Draw the flow" }).click();
    await page.getByRole("button", { name: /^Flow for “Invite suggestions/ }).click();
    const opened = page.getByTestId("flow-detail");
    await expect(opened).toContainText("Invite suggestions from the admin's calendar · flow");
    await expect(opened.getByTestId("flow-drawn")).toContainText("Version 1 · drawn");
    await expect(opened).not.toContainText("(revised)");
  });
});

test.describe("phone", () => {
  test.use({ viewport: PHONE });

  test("a viewer sees no Start review (qa4-simple-prd-26)", async ({ page }) => {
    await openFromList(page, "Saved carts PRD", VIEWER);
    await expect(page.getByRole("link", { name: "Open in Detailed" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start review" })).toHaveCount(0);
    await expect(page.getByTestId("start-review-why")).toHaveCount(0);
  });

  test("a commenter's reason to ask an owner sits on its own line, over nothing (qa4-simple-prd-2)", async ({ page }) => {
    await openFromList(page, "Saved carts PRD", COMMENTER);
    const why = page.getByTestId("start-review-why");
    await expect(why).toHaveText("Ask an owner to start a review");
    const box = (await why.boundingBox())!;
    for (const name of ["Present", "Export PDF", "Start review"]) expect(overlaps(box, (await page.getByRole("button", { name }).boundingBox())!)).toBe(false);
    expect(overlaps(box, (await page.getByRole("link", { name: "Open in Detailed" }).boundingBox())!)).toBe(false);
  });
});
