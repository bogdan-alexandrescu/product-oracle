import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN, login, signOut } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * Simple's Definition of Done, item 4 (docs/simple-dod-actions-plan.md): the one-pager's and the
 * mode switch's actions no spec drove yet, on a desktop (1440x900) and a phone (390x844). The
 * one-pager is the mock's invented PRD "Guided setup" (version 3); the "simple-deciders" scenario
 * names Dana Decider its decider.
 */

const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const URL = "/simple/one-pagers/guided-setup";

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1440) <= 640;
const line = (page: Page, id: string) => page.locator(`[data-line="${id}"]`);
const notes = (page: Page) => page.getByRole("note").filter({ visible: true });

async function openOnePager(page: Page, email?: string, scenario?: string) {
  if (scenario) await page.context().addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, scenario] as const);
  await login(page, email);
  await page.goto(URL);
  await expect(page.getByTestId("one-pager")).toBeVisible();
}

/** Signs out from the desktop rail's account menu (a phone widens for it, then narrows back). */
async function switchPerson(page: Page, email: string) {
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/home");
  await signOut(page);
  await login(page, email);
  await page.setViewportSize(size);
}

/** Signs in from a bare /login, so the role's default (or the saved choice) decides where it lands. */
async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/** The mode switch on a phone: Simple's More drawer, or Detailed's More sheet. */
async function phoneSwitch(page: Page, to: "Simple" | "Detailed") {
  if (to === "Detailed") {
    await page.getByTestId("simple-tab-bar").getByRole("button", { name: "More" }).click();
    await page.getByRole("dialog", { name: "More" }).getByRole("radio", { name: "Detailed" }).click();
  } else {
    await page.getByTestId("tab-more").click();
    await page.getByTestId("mode-simple-sheet").click();
  }
}

const path = (p: string) => new RegExp(`localhost:\\d+${p.replace(/\//g, "\\/")}$`);

for (const [where, use] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
] as const) {
  test.describe(where, () => {
    test.use(use);

    /*
     * Card dod-one-pager-decider: protects = the PRD's named decider (not an owner) edits a line
     * straight into the working draft, as the full PRD's section change (the before/after names
     * the section); fails_when = the decider is only offered a proposal, or the line stays
     * published; no_claim = the API's patching of the sections (pytest).
     */
    test(`the PRD's decider edits a line into the working draft, as its section's change (${where})`, async ({ page }) => {
      await openOnePager(page, "dana.decider@example.com", "simple-deciders");
      await page.getByRole("button", { name: "Edit “A setup checklist that shows" }).click();
      await page.getByLabel("New wording for").fill("A setup checklist with the next two steps");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(line(page, "bets-1")).toHaveAttribute("data-state", "edited");
      await expect(line(page, "bets-1")).toContainText("A setup checklist with the next two steps");
      const note = notes(page).filter({ hasText: "You changed “A setup checklist" });
      await note.getByRole("button", { name: "See before/after" }).click();
      await expect(note.getByLabel("Before and after")).toContainText("In “What we will build”");
    });

    /*
     * Card dod-one-pager-approver: protects = an approver who does not decide the PRD proposes a
     * line's new wording (no Accept for them); the owner accepts it and the line reads edited;
     * fails_when = the approver's edit applies, or the owner cannot accept it; no_claim = the
     * commenter's (simple-one-pager.spec).
     */
    test(`an approver's line edit is a proposal the owner accepts (${where})`, async ({ page }) => {
      await openOnePager(page, "approver@example.com");
      await expect(page.getByRole("button", { name: /^Edit “A setup checklist/ })).toHaveCount(0);
      await page.getByRole("button", { name: "Propose wording for “A setup checklist that shows" }).click();
      await page.getByLabel("New wording for").fill("A setup checklist with the next two steps");
      await page.getByRole("button", { name: "Propose", exact: true }).click();
      await expect(line(page, "bets-1")).toHaveAttribute("data-state", "proposal");
      const mine = notes(page).filter({ hasText: "You propose new wording for “A setup checklist" });
      await expect(mine).toBeVisible();
      await expect(mine.getByRole("button", { name: "Accept" })).toHaveCount(0);

      await switchPerson(page, ADMIN.email);
      await page.goto(URL);
      const theirs = notes(page).filter({ hasText: "proposes new wording for “A setup checklist" });
      await theirs.getByRole("button", { name: "Accept" }).click();
      await expect(line(page, "bets-1")).toHaveAttribute("data-state", "edited");
      await expect(line(page, "bets-1")).toContainText("A setup checklist with the next two steps");
    });

    /*
     * Card dod-one-pager-export: protects = a commenter exports the one-pager as a PDF (a download
     * named for the PRD and its version, and the toast says so); fails_when = no download or no
     * toast for a commenter; no_claim = the PDF's pages (simple-prd-timeline.spec).
     */
    test(`a commenter exports the one-pager as a PDF (${where})`, async ({ page }) => {
      await openOnePager(page, "commenter@example.com");
      const download = page.waitForEvent("download");
      await page.getByRole("button", { name: "Export PDF" }).click();
      expect((await download).suggestedFilename()).toBe("Guided setup v3 one-pager.pdf");
      await expect(page.getByText("PDF downloaded")).toBeVisible();
    });
  });
}

test.describe("phone mode switch", () => {
  test.use(PHONE);

  /*
   * Card dod-mode-phone-default: protects = on a phone, with no saved choice, a viewer and a
   * commenter land in Simple, an approver and an owner in Detailed; fails_when = a role lands in
   * the other mode on a phone; no_claim = the desktop (simple-mode.spec).
   */
  for (const [email, home] of [
    ["viewer@example.com", "/simple"],
    ["commenter@example.com", "/simple"],
    ["approver@example.com", "/home"],
    [ADMIN.email, "/home"],
  ] as const)
    test(`with no saved mode, ${email.split("@")[0]} lands on ${home} on a phone`, async ({ page }) => {
      await signIn(page, email);
      await expect(page).toHaveURL(path(home));
      await expect(page.locator(`[data-mode="${home === "/simple" ? "simple" : "detailed"}"]`)).toHaveCount(1);
    });

  /*
   * Card dod-mode-phone-pairs: protects = on a phone the switch (the More drawer) lands on the
   * matching page both ways for the roadmap (Plan) and Priorities; fails_when = it lands on the
   * other mode's home or the wrong page; no_claim = the other pairs (simple-mode.spec, desktop).
   */
  test("the phone's switch lands on the matching roadmap and priorities pages, both ways", async ({ page }) => {
    await signIn(page, ADMIN.email);
    for (const [simple, detailed] of [
      ["/simple/roadmap", "/plan"],
      ["/simple/priorities", "/priorities"],
    ] as const) {
      await page.goto(detailed);
      await phoneSwitch(page, "Simple");
      await expect(page).toHaveURL(path(simple));
      await expect(page.locator('[data-mode="simple"]')).toHaveCount(1);
      await phoneSwitch(page, "Detailed");
      await expect(page).toHaveURL(path(detailed));
      await expect(page.locator('[data-mode="detailed"]')).toHaveCount(1);
    }
  });

  /*
   * Card dod-mode-phone-remembered: protects = a choice made on a phone is remembered across a
   * reload and the next sign-in (a commenter who picks Detailed lands there); fails_when = the
   * role's default wins after a reload or a sign-in; no_claim = the server's preference store
   * (the API's tests).
   */
  test("a commenter's choice of Detailed on a phone is remembered across a reload and the next sign-in", async ({ page }) => {
    await signIn(page, "commenter@example.com");
    await expect(page).toHaveURL(path("/simple"));
    await phoneSwitch(page, "Detailed");
    await expect(page).toHaveURL(path("/home"));
    await page.reload();
    await expect(page).toHaveURL(path("/home"));
    await page.goto("/");
    await expect(page).toHaveURL(path("/home"));
    const size = page.viewportSize()!;
    await page.setViewportSize({ width: 1440, height: 900 });
    await signOut(page);
    await page.setViewportSize(size);
    await signIn(page, "commenter@example.com");
    await expect(page).toHaveURL(path("/home"));
    expect(isPhone(page)).toBe(true);
  });
});
