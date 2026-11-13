import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * Visual QA, Nov 12 2026 (docs/qa/2026-11-12/simple-home.md), the live meeting and its end
 * screen, driven through the UI on the mock's invented PRD "Guided setup" as the company's owner:
 * #1 a phone's Roadmap step keeps each name on its own row, the buttons below it; #2 every feature
 * in the meeting shows its code before its name; #8 the meeting screen keeps no scrollbar gutter of
 * its own; #9 the phone header's fold mark is the app's chevron, not a text glyph; #10 the Undo toast
 * keeps clear of the chat and times out; #11 the chat card does not repeat who changes things and
 * its hint sits behind an (i); #12 the end screen's Delivery checkboxes are the Start sheet's, a
 * disabled one's reason sits behind an (i), and "· name" stays with its decision.
 */

const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 } };

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function startReview(page: Page) {
  await login(page);
  await page.goto("/simple/meetings");
  await expect(page.getByRole("region", { name: "Upcoming" })).toBeVisible();
  await tap(page.getByRole("button", { name: "Start review" }).first());
  const s = page.getByRole("dialog", { name: "Start a review" });
  await s.getByLabel("PRD").selectOption({ label: "Guided setup" });
  await tap(s.getByRole("button", { name: "Start", exact: true }));
  await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
}

const step = (page: Page, name: string) => tap(page.getByRole("navigation", { name: "Steps" }).getByRole("button", { name }));

async function moveSetupChecklist(page: Page) {
  await step(page, "2 Roadmap");
  await tap(page.getByRole("button", { name: "Move Setup checklist to Next" }));
  await expect(page.getByRole("region", { name: "Decisions in this meeting" })).toContainText("Moved Setup checklist");
}

async function endIt(page: Page) {
  await tap(page.getByRole("button", { name: "End meeting" }));
  await page.getByRole("alertdialog").getByRole("button", { name: "End meeting" }).click();
  await expect(page.getByTestId("end-screen")).toBeVisible();
}

test.describe("phone", () => {
  test.use(PHONE);

  test("#1: on a phone each Roadmap row's name keeps a full row and its buttons sit below it", async ({ page }) => {
    // fails_when: the name is squeezed into a narrow column beside the Move and Cut buttons
    await startReview(page);
    await step(page, "2 Roadmap");
    const row = page.locator('li[data-item="setup-checklist"]');
    const name = row.locator(":scope > span").first();
    const moves = row.getByTestId("roadmap-moves");
    await expect(moves).toBeVisible();
    const n = (await name.boundingBox())!;
    const b = (await moves.boundingBox())!;
    expect(n.width).toBeGreaterThan(200);
    expect(b.y).toBeGreaterThanOrEqual(n.y + n.height - 1);
  });

  test("#9: the phone header's fold mark is the app's chevron icon, not a ▾ character", async ({ page }) => {
    // fails_when: "Everyone except viewers ▾" draws the mark as a text glyph
    await startReview(page);
    const toggle = page.getByTestId("meeting-people-toggle");
    await expect(toggle).toBeVisible();
    await expect(toggle).not.toContainText("▾");
    await expect(toggle.locator("svg")).toHaveCount(1);
    await tap(toggle);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(toggle).not.toContainText("▴");
    await expect(toggle.locator("svg")).toHaveCount(1);
  });

  test("#12: on a phone '· name' stays on the line of its decision in Decisions taken", async ({ page }) => {
    // fails_when: "· <name>" drops to a line of its own that starts with a dot
    await startReview(page);
    await moveSetupChecklist(page);
    await endIt(page);
    const row = page.getByTestId("decision-taken").filter({ hasText: "Moved Setup checklist" }).first();
    await expect(row).toBeVisible();
    const [linkTop, byTop] = await row.evaluate((el) => {
      const rects = el.querySelector("a")!.getClientRects();
      const by = el.querySelector("span.whitespace-nowrap")!;
      return [rects[rects.length - 1]!.top, by.getClientRects()[0]!.top];
    });
    expect(Math.abs(byTop - linkTop)).toBeLessThan(4);
  });
});

test.describe("desktop", () => {
  test.use(DESKTOP);

  test("#2: the Roadmap step and the agenda's Blocks line show each feature's code before its name", async ({ page }) => {
    // fails_when: a feature in the meeting reads by its name alone, with no code chip
    await startReview(page);
    await step(page, "2 Roadmap");
    // A slice row of a coded feature names it with its code (Setup checklist has none in the mock).
    await expect(page.locator("li[data-item]").getByRole("button", { name: /^F-\d+[a-j]? ?Health log$/ }).first()).toBeVisible();
    await step(page, "3 Decisions");
    const blocks = page.getByTestId("decisions-due").getByTestId("question-blocks-feature").first();
    await expect(blocks).toBeVisible();
    await expect(blocks.locator(".simple-code")).toHaveText(/^F-\d+[a-j]?$/);
  });

  test("#8: the meeting screen keeps no scrollbar gutter of its own", async ({ page }) => {
    // fails_when: the fixed meeting screen reserves a stable gutter, an empty strip on the right
    await startReview(page);
    const gutter = await page.getByTestId("meeting-screen").evaluate((el) => getComputedStyle(el).scrollbarGutter);
    expect(gutter).not.toContain("stable");
  });

  test("#10: the Undo toast keeps clear of the chat column and times out", async ({ page }) => {
    // fails_when: the toast sits over the chat's box in the corner, or stays on screen after its time
    await startReview(page);
    await moveSetupChecklist(page);
    const toast = page.getByTestId("toasts").getByRole("status");
    await expect(toast).toContainText("Moved Setup checklist to Next");
    await expect(toast.getByRole("button", { name: "Undo" })).toBeVisible();
    const t = (await toast.boundingBox())!;
    const chat = (await page.getByRole("complementary", { name: "Chat column" }).boundingBox())!;
    const overlaps = t.x < chat.x + chat.width && chat.x < t.x + t.width && t.y < chat.y + chat.height && chat.y < t.y + t.height;
    expect(overlaps).toBe(false);
    // A person goes on in the chat; the toast leaves on its own.
    await page.getByTestId("meeting-chat").getByRole("textbox", { name: "Message Oracle" }).click();
    await page.clock.runFor(11_000);
    await expect(toast).toHaveCount(0);
  });

  test("#11: the meeting's chat card does not repeat who changes things; its hint is behind an (i)", async ({ page }) => {
    // fails_when: the chat card repeats "Who changes things: …" and shows the Ask Oracle line as prose
    await startReview(page);
    const chat = page.getByTestId("meeting-chat");
    await expect(chat.getByRole("textbox", { name: "Message Oracle" })).toBeVisible();
    await expect(chat).not.toContainText("Who changes things");
    await expect(chat.getByText("For a question about the plan, use Ask Oracle.")).toBeHidden();
    const info = chat.getByRole("button", { name: "About Meeting chat" });
    await expect(info).toBeVisible();
    await info.focus();
    await expect(chat.getByRole("tooltip")).toContainText("For a question about the plan, use Ask Oracle.");
  });

  test("#12: the end screen's Delivery uses the Start sheet's checkboxes, a disabled one's reason behind an (i)", async ({ page }) => {
    // fails_when: tiny native checkboxes, and "· shows them already; Send marks them sent" beside the label
    await startReview(page);
    await moveSetupChecklist(page);
    await endIt(page);
    const d = page.getByRole("region", { name: "Delivery" });
    const inbox = d.getByRole("checkbox", { name: "Each attendee's Inbox" });
    await expect(inbox).toBeVisible();
    expect((await inbox.boundingBox())!.width).toBeGreaterThanOrEqual(19);
    await expect(d.getByText(/shows them already/i)).toBeHidden();
    await expect(d.getByRole("button", { name: "About Decisions page" })).toBeVisible();
    await expect(page.getByTestId("decision-taken").filter({ hasText: "Moved Setup checklist" }).first().locator("span.whitespace-nowrap")).toHaveCSS("white-space", "nowrap");
  });
});
