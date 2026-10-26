import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/**
 * v2 screen 4 (picks.md: A's canvas + review inspector, C's "no comments" annotation filter,
 * B's side-by-side compare for 2-4 wireframe screens): a spec's user flow and wireframes,
 * reached from the tech brief, each output in a sandboxed, script-free frame, with verdicts,
 * numbered annotations and their threads, version reviews and provenance. Driven on the mock
 * layer as a person would, per role and per state.
 */

const BRIEF = "/documents/checkout-redesign-early-shipping-cost-spec/v/1";
const SPEC_ID = "c3000000-0000-4000-8000-000000000001";
const FLOW = "c3000000-0000-4000-8000-000000000012";

const inspector = (page: Page) => page.getByRole("complementary", { name: "Design review" }).filter({ visible: true });
const canvas = (page: Page) => page.getByTestId("design-canvas").filter({ visible: true });

/** Opens the spec's user flow from its tech brief, as a reader does. */
async function openFlow(page: Page) {
  await page.goto(BRIEF);
  const design = page.getByTestId("spec-design").filter({ visible: true });
  await design.getByRole("link", { name: /Early shipping cost: user flows/ }).click();
  await expect(page).toHaveURL(new RegExp(`/specs/${SPEC_ID}/design/${FLOW}$`));
}

test("an approver opens the flow from the tech brief: sandboxed canvas, Approve off while potentially stale", async ({ page }) => {
  await login(page, "approver@example.com");
  await openFlow(page);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Early shipping cost: user flows");
  const frame = canvas(page).locator("iframe");
  await expect(frame).toHaveAttribute("sandbox", "");
  await expect(frame).toHaveAttribute("title", /checkout-flow\.svg/);
  await expect(page.frameLocator('[data-testid="design-canvas"] iframe').first().locator("svg")).toBeVisible();
  await expect(canvas(page)).toContainText("image/svg+xml");

  const panel = inspector(page);
  await expect(panel).toContainText("Potentially stale");
  await expect(panel).toContainText("section s-5-2 changed in checkout-redesign");
  await expect(panel.getByRole("button", { name: "Approve" })).toBeDisabled();
  await expect(panel.getByRole("link", { name: "Open tech brief" })).toHaveAttribute("href", BRIEF);

  // Request changes needs a note: the API's message is shown.
  await panel.getByRole("button", { name: "Request changes" }).click();
  await expect(panel.getByRole("alert")).toContainText("say why: a note is required to request changes or reject");
  await panel.getByLabel("Note (required to request changes or reject)").fill("The quote needs the postcode step first.");
  await panel.getByRole("button", { name: "Request changes" }).click();
  await expect(panel.getByTestId("version-reviews")).toContainText("Changes requested");
  await expect(panel.getByTestId("version-reviews")).toContainText("The quote needs the postcode step first.");
});

test("annotations are numbered as Oracle labels them, with a thread each and the 'no comments' filter", async ({ page }) => {
  await login(page, "commenter@example.com");
  await openFlow(page);
  const panel = inspector(page);
  const notes = panel.getByTestId("annotations");
  await expect(notes.getByTestId("annotation")).toHaveCount(2);
  await expect(notes.getByTestId("annotation").first()).toContainText("1");
  await expect(notes.getByTestId("annotation").first()).toContainText("The quote shows before the address step.");
  await expect(notes.getByTestId("annotation").first()).toContainText("No comments on this annotation yet.");

  // C's filter: annotations with no comments.
  await notes.getByRole("button", { name: "No comments" }).click();
  await expect(notes.getByTestId("annotation")).toHaveCount(2);

  // An empty comment is refused with the API's message.
  await notes.getByTestId("annotation").first().getByRole("button", { name: "Comment" }).click();
  await expect(notes.getByRole("alert")).toContainText("a comment needs a body");
  await notes.getByLabel("Comment on annotation 1").fill("Is 'from' price enough before the postcode?");
  await notes.getByTestId("annotation").first().getByRole("button", { name: "Comment" }).click();
  // Commented: it leaves the 'no comments' list.
  await expect(notes.getByTestId("annotation")).toHaveCount(1);
  await notes.getByRole("button", { name: "All" }).click();
  await expect(notes.getByTestId("annotation").first()).toContainText("Is 'from' price enough before the postcode?");
  await expect(notes.getByTestId("annotation").first()).toContainText("You");

  // A commenter has no verdicts.
  await expect(panel.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await expect(panel).toContainText("Verdicts are for the spec's engineering approvers.");

  // Version-level comment, oldest first, after the empty state.
  const reviews = panel.getByTestId("version-reviews");
  await expect(reviews).toContainText("No reviews yet. Comments and verdicts on this version show here.");
  await reviews.getByLabel("Comment on v1").fill("Holding until the PRD change is reviewed.");
  await reviews.getByRole("button", { name: "Comment" }).click();
  await expect(reviews).toContainText("Holding until the PRD change is reviewed.");
  await expect(reviews).not.toContainText("No reviews yet");
});

test("a viewer reads the review without composer or verdicts", async ({ page }) => {
  await login(page, "viewer@example.com");
  await openFlow(page);
  const panel = inspector(page);
  await expect(panel).toContainText("You can read this review. Commenting needs the commenter role.");
  await expect(panel.getByRole("textbox")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Comment", exact: true })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Approve" })).toHaveCount(0);
  // Provenance and version meta.
  await expect(panel.getByTestId("version-meta")).toContainText("prd_to_spec/1");
  await expect(panel.getByTestId("version-meta")).toContainText("claude-code");
});

test("wireframes: switch screens, compare 2-4 side by side, see the sanitised notice, and an owner approves", async ({ page }) => {
  await login(page);
  await openFlow(page);
  await page.getByRole("navigation", { name: "Design artifacts" }).getByRole("link", { name: /Early shipping cost: wireframes/ }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Early shipping cost: wireframes");
  const files = page.getByRole("group", { name: "Files" });
  await expect(files.getByRole("button", { name: "cart-1.html" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.frameLocator('[data-testid="design-canvas"] iframe').first().locator(".oracle-annotations")).toContainText("1. cost-early [s-5-2]");
  await files.getByRole("button", { name: "cart-2.html" }).click();
  await expect(canvas(page).locator("iframe")).toHaveAttribute("title", /cart-2\.html/);
  await expect(page.getByTestId("sanitised").filter({ visible: true })).toContainText("Sanitised");

  // B's compare: every screen side by side.
  await page.getByRole("button", { name: "Side by side" }).click();
  await expect(canvas(page).locator("iframe")).toHaveCount(2);
  await page.getByRole("button", { name: "One at a time" }).click();
  await expect(canvas(page).locator("iframe")).toHaveCount(1);

  // Fresh: an owner approves; the version shows who and when, and is read only.
  const panel = inspector(page);
  await expect(panel).toContainText("Owners always decide.");
  await panel.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByTestId("page-header").filter({ visible: true })).toContainText("Approved");
  await expect(panel.getByTestId("version-reviews")).toContainText("Approved");
  await expect(panel.getByTestId("version-meta")).toContainText("Approved");
});

test("an owner rejects with a note; the rejected version is read only", async ({ page }) => {
  await login(page);
  await openFlow(page);
  const panel = inspector(page);
  await panel.getByLabel("Note (required to request changes or reject)").fill("Superseded by the postcode-first flow.");
  await panel.getByRole("button", { name: "Reject" }).click();
  await expect(page.getByTestId("page-header").filter({ visible: true })).toContainText("Rejected");
  await expect(panel).toContainText("version 1 is rejected");
  await expect(panel.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Reject" })).toHaveCount(0);
});

test("while a regeneration runs, the design page says so and links the run", async ({ page }) => {
  await login(page);
  await page.goto(BRIEF);
  const stale = page.getByTestId("spec-staleness").filter({ visible: true });
  await stale.getByRole("button", { name: "Reconcile" }).click();
  await stale.getByRole("button", { name: "Regenerate from the PRD" }).click();
  await expect(stale).toContainText("regeneration running");
  await page.getByTestId("spec-design").filter({ visible: true }).getByRole("link", { name: /Early shipping cost: user flows/ }).click();
  await expect(page.getByTestId("stale-notice").filter({ visible: true })).toContainText("regeneration running");
  await expect(page.getByTestId("stale-notice").filter({ visible: true }).getByRole("link", { name: "Open the run" })).toHaveAttribute("href", /^\/runs\//);
});

test("an old link to a version that does not exist says so", async ({ page }) => {
  await login(page);
  await page.goto(`/specs/${SPEC_ID}/design/c3000000-0000-4000-8000-0000000000ff`);
  await expect(page.getByRole("alert").filter({ hasText: "design artifact version not found" })).toBeVisible();
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the canvas fits a phone and the review opens in a bottom sheet", async ({ page }) => {
    await login(page, "approver@example.com");
    await openFlow(page);
    await expect(canvas(page).locator("iframe")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.getByRole("button", { name: "Review" }).click();
    const sheet = page.getByRole("dialog", { name: /Review · Early shipping cost: user flows/ });
    await expect(sheet.getByRole("button", { name: "Approve" })).toBeDisabled();
    await expect(sheet.getByTestId("annotation")).toHaveCount(2);
  });
});
