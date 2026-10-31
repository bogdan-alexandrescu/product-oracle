import { expect, test, type Page } from "./test";

import { login, signOut } from "./helpers";

/**
 * C9 Move and pin on the mock: approvers move and pin features with a reason, Oracle
 * pushes back once when the numbers (or its reading of the reason) disagree, and every
 * change is logged in the Changes panel.
 *
 * protects=the screen end to end on the mock; fails_when=the order, chips or log disagree
 * with the API rules; no_claim=the real API (the mock mirrors its rules).
 */

const APPROVER = "approver@example.com";
const FORMULA = ["F-5", "F-2", "F-1", "F-7", "F-8", "F-4", "F-3", "F-6"];

async function rankedKeys(page: Page) {
  const rows = page.locator('tr[data-testid^="priority-row-"]');
  await expect(rows.first()).toBeVisible();
  return rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!.replace("priority-row-", "")));
}

async function expectOrder(page: Page, keys: string[]) {
  await expect.poll(() => rankedKeys(page)).toEqual(keys);
}

async function open(page: Page, email = APPROVER) {
  await login(page, email);
  await page.goto("/priorities");
  await expectOrder(page, FORMULA);
}

/** ▲ ▼ ⋯ show on every row: bring the row into view, as a person scrolls, then press. */
async function rowAction(page: Page, key: string, name: "Move up" | "Move down" | "More actions") {
  const row = page.getByTestId(`priority-row-${key}`);
  // Rows with every goal whole are taller: bring the row to the middle, so its menu opens on screen.
  await row.evaluate((e) => e.scrollIntoView({ block: "center" }));
  const button = row.getByRole("button", { name, exact: true });
  await expect(button).toBeVisible();
  await button.click();
}

function sheet(page: Page) {
  return page.getByRole("dialog");
}

/**
 * ⋯ → Pin at… → the Rank box (cld-3): each step waits for what it opens. The menu closes on any
 * scroll, which a busy machine can still be settling when it opens, so a closed menu is opened
 * again (never toggled shut) until the sheet shows.
 */
async function pinAt(page: Page, key: string, title: string, rank: number) {
  const s = sheet(page);
  const menu = page.getByRole("menu", { name: `Change ${title}` });
  await expect(async () => {
    if (!(await s.isVisible())) {
      if (!(await menu.isVisible())) await rowAction(page, key, "More actions");
      await expect(menu).toBeVisible({ timeout: 2000 });
      await menu.getByRole("menuitem", { name: "Pin at…" }).click({ timeout: 2000 });
    }
    await expect(s.getByLabel("Rank")).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await s.getByLabel("Rank").fill(String(rank));
}

test("move up with a reason: the row moves, shows who moved it and Oracle's rank", async ({ page }) => {
  await open(page);
  const row = page.getByTestId("priority-row-F-1");
  await rowAction(page, "F-1", "Move up");
  const s = sheet(page);
  await expect(s).toBeVisible();
  await expect(s).toContainText("Move above Shipping cost shown in the cart");
  const save = s.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeDisabled();
  await s.getByLabel("Why?").fill("A launch partner needs it in the first release");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(s).toBeHidden();

  await expectOrder(page, ["F-5", "F-1", "F-2", "F-7", "F-8", "F-4", "F-3", "F-6"]);
  await expect(row.getByTestId("override-chip")).toHaveText("Moved by Approver");
  await expect(row.getByTestId("formula-rank")).toHaveText("3");
  await expect(page.getByRole("columnheader", { name: "Oracle #" })).toBeVisible();
});

test("pushback on a pin: take Oracle's advice, then keep my change", async ({ page }) => {
  await open(page);
  await pinAt(page, "F-6", "Dark mode", 1);
  await sheet(page).getByLabel("Why?").fill("Our largest account asked for it this quarter");
  await sheet(page).getByRole("button", { name: "Save", exact: true }).click();

  const s = sheet(page);
  await expect(s).toContainText("Oracle disagrees");
  const rule = s.getByTestId("pushback-no_confirmed_goal");
  await expect(rule).toContainText("Dark mode serves no confirmed goal");
  await expect(rule).toContainText("Address lookup service serves");
  await s.getByRole("button", { name: "Take Oracle's advice" }).click();
  await expect(s).toBeHidden();
  await expectOrder(page, FORMULA);

  await pinAt(page, "F-6", "Dark mode", 1);
  await sheet(page).getByLabel("Why?").fill("Our largest account asked for it this quarter");
  await sheet(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(sheet(page).getByTestId("pushback")).toBeVisible();
  await sheet(page).getByRole("button", { name: "Keep my change" }).click();
  await expect(sheet(page)).toBeHidden();
  await expectOrder(page, ["F-6", "F-5", "F-2", "F-1", "F-7", "F-8", "F-4", "F-3"]);
  await expect(page.getByTestId("priority-row-F-6").getByTestId("override-chip")).toHaveText(
    "Pinned #1 by Approver",
  );
  const log = page.getByTestId("change-log");
  await expect(log.getByRole("listitem")).toHaveCount(1);
  await expect(log).toContainText("Dark mode");
  await expect(log).toContainText("kept after pushback");
});

test("remove my change in the inspector; the log keeps it as removed", async ({ page }) => {
  await open(page);
  await rowAction(page, "F-7", "Move up");
  await sheet(page).getByLabel("Why?").fill("Support load doubles without it");
  await sheet(page).getByRole("button", { name: "Save", exact: true }).click();
  await expectOrder(page, ["F-5", "F-2", "F-7", "F-1", "F-8", "F-4", "F-3", "F-6"]);

  await page.getByTestId("priority-row-F-7").getByRole("button", { name: "Bulk export" }).click();
  const change = page.getByTestId("your-change");
  await expect(change).toContainText("Support load doubles without it");
  await expect(change).toContainText("Approver");
  await change.getByRole("button", { name: "Remove my change" }).click();
  await expectOrder(page, FORMULA);
  await expect(page.getByTestId("priority-row-F-7").getByTestId("override-chip")).toHaveCount(0);

  const log = page.getByTestId("change-log");
  await expect(log.getByRole("listitem")).toHaveCount(0);
  await page.getByRole("radiogroup", { name: "Changes filter" }).getByRole("radio", { name: "All" }).click();
  await expect(log.getByRole("listitem")).toHaveCount(1);
  await expect(log).toContainText("removed");
});

test("Oracle's order shows the formula; switching back shows the changes", async ({ page }) => {
  await open(page);
  await pinAt(page, "F-3", "Shared projects", 2);
  await sheet(page).getByLabel("Why?").fill("The design partner pilot starts in November");
  await sheet(page).getByRole("button", { name: "Save", exact: true }).click();
  // Shared projects rises five places past scores far above its own: keep it.
  await expect(sheet(page).getByTestId("pushback-against_score")).toContainText("Score 0.13 against 8.1");
  await sheet(page).getByRole("button", { name: "Keep my change" }).click();
  await expectOrder(page, ["F-5", "F-3", "F-2", "F-1", "F-7", "F-8", "F-4", "F-6"]);

  const order = page.getByRole("radiogroup", { name: "Order" });
  await order.getByRole("radio", { name: "Oracle's order" }).click();
  await expectOrder(page, FORMULA);
  await expect(page.getByTestId("override-chip")).toHaveCount(0);
  await order.getByRole("radio", { name: "With your changes" }).click();
  await expectOrder(page, ["F-5", "F-3", "F-2", "F-1", "F-7", "F-8", "F-4", "F-6"]);
});

test("a commenter sees the changes but cannot move or pin", async ({ page }) => {
  await open(page);
  await rowAction(page, "F-1", "Move up");
  await sheet(page).getByLabel("Why?").fill("A launch partner needs it in the first release");
  await sheet(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("priority-row-F-1").getByTestId("override-chip")).toBeVisible();
  await signOut(page);

  await login(page, "commenter@example.com");
  await page.goto("/priorities");
  const row = page.getByTestId("priority-row-F-1");
  await expect(row.getByTestId("override-chip")).toHaveText("Moved by Approver");
  await row.hover();
  await expect(page.getByRole("button", { name: /^Move (up|down)$/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "More actions" })).toHaveCount(0);
  await expect(page.getByTestId("row-actions")).toHaveCount(0);
  await expect(page.getByTestId("change-log").getByRole("listitem")).toHaveCount(1);
  await row.getByRole("button", { name: "Saved addresses at checkout" }).click();
  await expect(page.getByTestId("your-change")).toBeVisible();
  await expect(page.getByTestId("your-change").getByRole("button", { name: "Remove my change" })).toHaveCount(0);
});

test("a dependency holds a pin below its prerequisite and offers to move it too", async ({ page }) => {
  await open(page);
  await pinAt(page, "F-2", "Shipping cost shown in the cart", 1);
  await sheet(page).getByLabel("Why?").fill("Cart abandonment spikes on shipping surprises");
  await sheet(page).getByRole("button", { name: "Save", exact: true }).click();
  const held = page.getByTestId("priority-row-F-2");
  await expect(held.getByTestId("held-chip")).toHaveText("Held below Address lookup service");
  await held.getByRole("button", { name: "Shipping cost shown in the cart" }).click();
  const change = page.getByTestId("your-change");
  await expect(change).toContainText("Held below Address lookup service: it depends on it");
  await change.getByRole("button", { name: "Move Address lookup service too" }).click();
  await expect(sheet(page).getByLabel("Why?")).toHaveValue("Cart abandonment spikes on shipping surprises");
});

test("at 390 px the sheet is a bottom sheet and the row card shows the chip", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, APPROVER);
  await page.goto("/priorities");
  const row = page.getByTestId("priority-row-F-1");
  await rowAction(page, "F-1", "Move up");
  const s = sheet(page);
  await expect(s).toBeVisible();
  const box = (await s.boundingBox())!;
  expect(Math.round(box.y + box.height)).toBe(844);
  expect(Math.round(box.width)).toBe(390);
  await s.getByLabel("Why?").fill("A launch partner needs it in the first release");
  await s.getByRole("button", { name: "Save", exact: true }).click();
  await expect(row.getByTestId("override-chip")).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("Oracle reads the reason: a contradiction shows its evidence; keep stores it", async ({ page }) => {
  await open(page);
  const row = page.getByTestId("priority-row-F-1");
  await rowAction(page, "F-1", "Move up");
  await sheet(page).getByLabel("Why?").fill("customers keep asking");
  await sheet(page).getByRole("button", { name: "Save", exact: true }).click();
  const s = sheet(page);
  await expect(s).toContainText("Oracle disagrees");
  const about = s.getByTestId("pushback-reason");
  await expect(about).toContainText("About your reason");
  await expect(about).toContainText("You wrote 'customers keep asking'");
  await expect(about.getByTestId("evidence-chip").first()).toBeVisible();
  await s.getByRole("button", { name: "Take Oracle's advice" }).click();
  await expectOrder(page, FORMULA);

  await rowAction(page, "F-1", "Move up");
  await sheet(page).getByLabel("Why?").fill("customers keep asking");
  await sheet(page).getByRole("button", { name: "Save", exact: true }).click();
  await sheet(page).getByRole("button", { name: "Keep my change" }).click();
  await expectOrder(page, ["F-5", "F-1", "F-2", "F-7", "F-8", "F-4", "F-3", "F-6"]);
  await row.getByRole("button", { name: "Saved addresses at checkout" }).click();
  const change = page.getByTestId("your-change");
  await expect(change).toContainText("Reason checked by Oracle");
  await expect(change).toContainText("kept after pushback");
});

test("when the reason check does not run, Oracle checked the numbers only", async ({ page }) => {
  await open(page);
  const row = page.getByTestId("priority-row-F-1");
  await rowAction(page, "F-1", "Move up");
  await sheet(page).getByLabel("Why?").fill("slow-check: the partner's launch date");
  await sheet(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Oracle checked the numbers only this time.")).toBeVisible();
  await expectOrder(page, ["F-5", "F-1", "F-2", "F-7", "F-8", "F-4", "F-3", "F-6"]);
  await row.getByRole("button", { name: "Saved addresses at checkout" }).click();
  await expect(page.getByTestId("your-change")).toContainText("Numbers only");
});

test("cite evidence: the feature's own items, at most five, shown on the stored change", async ({ page }) => {
  await open(page);
  const row = page.getByTestId("priority-row-F-1");
  await rowAction(page, "F-1", "Move up");
  const s = sheet(page);
  const picker = s.getByRole("group", { name: "Cite evidence (optional)" });
  const boxes = picker.getByRole("checkbox");
  await expect(boxes).toHaveCount(7);
  await expect(picker).toContainText("Interview 07");
  for (let i = 0; i < 5; i++) await boxes.nth(i).check();
  await expect(boxes.nth(5)).toBeDisabled();
  await expect(picker.getByTestId("cited-count")).toHaveText("5 picked, up to 5");
  await s.getByLabel("Why?").fill("A launch partner needs it in the first release");
  await s.getByRole("button", { name: "Save", exact: true }).click();
  await expect(s).toBeHidden();
  await row.getByRole("button", { name: "Saved addresses at checkout" }).click();
  const cited = page.getByTestId("your-change").getByTestId("cited-evidence");
  await expect(cited.getByRole("listitem")).toHaveCount(5);
  await expect(cited).toContainText("Interview 07");
});
