import { expect, test, type Page } from "./test";

import { BEFORE_DRAFTING } from "../lib/api/mock/intake";
import { MOCK_INTERVIEW_TOKEN } from "../lib/api/mock/interviews";
import { login } from "./helpers";

/*
 * QA pass 3, docs lane: a feature's tech brief (/briefs/<id>), the brief before drafting
 * (/intakes/<id>, where Oracle's questions, Answer and Analyse with Oracle live), the
 * customer's interview page (/i/<token>) and a member's interview page under Requests.
 *
 * qa-docs-85: on a phone "What it touches" is a stack of short rows, not a table whose cells
 * wrap mid-phrase.
 * qa-docs-86: Answer sits in its question's card; the day's count says what it counts; one
 * line says what Analyse (Read the brief again) and Draft with Oracle each do.
 * qa-docs-87: a run of Oracle's messages is named "Assistant" once.
 * qa-docs-88: the interview's creator by their name, the shared back chevron, and room
 * between the title row and the Requests tabs.
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

async function openTechBrief(page: Page, title: string) {
  await page.goto("/documents/checkout-redesign");
  await page.getByTestId("tech-briefs").getByRole("link", { name: title }).click();
  await expect(page).toHaveURL(/\/briefs\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(title);
}

async function openIntake(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("po-mock-scenario", "before-drafting");
    localStorage.setItem("po-interview-follow-up", "off");
  });
  await login(page);
  await page.goto(`/intakes/${BEFORE_DRAFTING.intakeId}`);
  await expect(page.getByRole("heading", { level: 1, name: BEFORE_DRAFTING.title })).toBeAttached();
  await expect(page.getByTestId("intake-thread")).toBeVisible();
}

async function startInterview(page: Page) {
  await page.goto(`/i/${MOCK_INTERVIEW_TOKEN}`);
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByTestId("interview-input")).toBeVisible();
}

/** From the rail to the Interviews tab, then Ana Lima's interview. */
async function openInterview(page: Page) {
  await page.getByTestId("nav-requests").filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/requests$/);
  await page.getByTestId("requests-tab-interviews").filter({ visible: true }).click();
  await page.getByTestId("interview-row").filter({ hasText: "Ana Lima" }).click();
  await expect(page).toHaveURL(/\/requests\/interviews\/[^/]+$/);
  await expect(page.getByTestId("interview-about")).toBeVisible();
}

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  test("qa-docs-85: on a wide screen What it touches stays a table", async ({ page }) => {
    await login(page);
    await openTechBrief(page, "Show the full price early");
    await expect(page.getByRole("table", { name: "What it touches" })).toBeVisible();
    await expect(page.getByTestId("brief-touches-stack")).toBeHidden();
  });

  test("qa-docs-86: Answer is in its question's card, the count says analyses, each Oracle button is explained", async ({ page }) => {
    await openIntake(page);
    const answer = page.getByRole("button", { name: "Answer", exact: true }).first();
    await expect(answer).toBeVisible();
    const question = page.getByTestId("question").filter({ has: answer }).first();
    await expect(question.getByRole("article").getByRole("button", { name: "Answer", exact: true })).toBeVisible();

    const read = page.getByTestId("intake-read");
    await expect(read.getByTestId("intake-read-count")).toHaveText("3 of 3 analyses left today");
    const help = page.getByTestId("intake-oracle-help");
    await expect(help).toBeVisible();
    await expect(help).toContainText("Read the brief again: Oracle reads the brief and its sources");
    await expect(help).toContainText("Draft with Oracle: Oracle writes the PRD");
  });

  test("qa-docs-87: two Oracle messages in a row are named Assistant once", async ({ page }) => {
    await startInterview(page);
    await page.getByRole("button", { name: "Skip this question" }).click();
    await expect(page.getByTestId("interview-progress")).toHaveText("2 of 4");
    const oracle = page.getByTestId("msg-oracle");
    await expect(oracle.nth(1)).toBeVisible();
    await expect(page.getByTestId("msg-sender")).toHaveCount(1);
    await expect(page.getByTestId("msg-sender")).toHaveText("Assistant");
    await expect(oracle.nth(1).getByTestId("msg-sender")).toHaveCount(0);

    // The customer's reply starts a new run, named "You"; Oracle's next one is named again.
    await page.getByTestId("interview-input").fill("Every Friday our accountant types each supplier payment into the bank site by hand.");
    await page.getByTestId("interview-footer").getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByTestId("msg-customer").getByTestId("msg-sender")).toHaveText("You");
    await expect(page.getByTestId("interview-typing")).toHaveCount(0);
    await expect(page.getByTestId("msg-sender")).toHaveText(["Assistant", "You", "Assistant"]);
  });

  test("qa-docs-88: the creator by name, the shared back link, and room above the Requests tabs", async ({ page }) => {
    await login(page);
    // The creator names themself, as a person does on My account.
    await page.goto("/account");
    const mine = page.getByRole("form", { name: "Your name" });
    await mine.getByLabel("Name", { exact: true }).fill("Dana Reyes");
    await mine.getByRole("button", { name: "Save" }).click();
    await expect(mine.getByRole("button", { name: "Saved" })).toBeVisible();

    await openInterview(page);
    await expect(page.getByTestId("interview-about")).toContainText("Dana Reyes");

    const header = page.locator("[data-page-header]");
    const back = header.getByRole("link", { name: "All interviews" });
    await expect(back).toBeVisible();
    await expect(back).not.toContainText("←");
    await expect(back.locator("svg")).toHaveCount(1);

    // The tabs keep the page's 16 px from the title row, not 8.
    const title = await header.getByRole("heading", { level: 1 }).boundingBox();
    const action = await header.getByRole("button", { name: "Withdraw link" }).boundingBox();
    const tabs = await page.getByTestId("requests-nav").filter({ visible: true }).boundingBox();
    expect(title && action && tabs).toBeTruthy();
    const rowBottom = Math.max(title!.y + title!.height, action!.y + action!.height);
    expect(tabs!.y - rowBottom).toBeGreaterThanOrEqual(14);

    await back.click();
    await expect(page).toHaveURL(/\/requests\/interviews$/);
  });
});

test.describe("phone", () => {
  test.use({ viewport: PHONE });

  test("qa-docs-85: on a phone What it touches is a stack of label and value rows", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await login(page);
    await openTechBrief(page, "Show the full price early");
    await page.setViewportSize(PHONE);

    await expect(page.getByRole("table", { name: "What it touches" })).toHaveCount(0);
    const stack = page.getByTestId("brief-touches-stack");
    await expect(stack).toBeVisible();
    const item = stack.getByRole("listitem").filter({ hasText: "GET /v1/quotes" });
    await expect(item).toContainText("Not mapped");
    await expect(item.getByText("In the code map", { exact: true })).toHaveCSS("white-space", "nowrap");
    // "Not mapped" reads on one line.
    const notMapped = await item.getByText("Not mapped", { exact: true }).boundingBox();
    expect(notMapped && notMapped.height).toBeLessThan(30);
  });
});
