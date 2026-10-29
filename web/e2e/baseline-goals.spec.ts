import { expect, test, type Page, mockNow } from "./test";

import { login, signOut } from "./helpers";

/**
 * B5 Typed goal fields (#148), driven through the Goals UI as a person would, on the mock
 * layer: the Goals table's typed cells and Not measurable chip, the goal edit form (target
 * row, horizon, owner picker, weight) with the API's problems under their field, Fill from
 * text, dated measurements and Home reading the typed values.
 */

async function openBaseline(page: Page, email?: string) {
  await login(page, email);
  await page.goto("/baseline");
  await expect(page.getByRole("heading", { level: 1, name: "Baseline" })).toBeVisible();
  await expect(page.getByTestId("goal-g.activation")).toBeVisible();
}

const drawer = (page: Page, title: string) => page.getByRole("dialog", { name: title });

async function editGoal(page: Page, key: string, title: string) {
  await page.getByTestId(`goal-${key}`).getByRole("button", { name: title }).click();
  const d = drawer(page, title);
  await d.getByRole("button", { name: "Edit" }).click();
  return d.getByRole("form", { name: "Edit" });
}

/** Today as the date field holds it (the browser's day). */
function today(): string {
  const d = mockNow();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// protects: a person can read each goal's typed target, horizon and owner at a glance, and
// sees which goals are not measurable yet and why.
// fails_when: the table prints raw attrs, loses the owner's name, or a goal without a typed
// target shows no chip or the wrong missing fields.
// no_claim: mock data; says nothing about the API's goal_check (pytest covers it).
test("goals table: typed target, horizon and owner; a Not measurable chip on a goal left as text", async ({ page }) => {
  await openBaseline(page);
  const activation = page.getByTestId("goal-g.activation");
  await expect(activation.locator('[data-attr="target"]')).toHaveText("≥ 45%");
  await expect(activation.locator('[data-attr="target"]')).toHaveAttribute("title", "At least 45%");
  await expect(activation.locator('[data-attr="horizon"]')).toHaveText("Short · Dec 31");
  await expect(activation.locator('[data-attr="owner"]')).toHaveText("Approver");
  await expect(activation.locator('[data-attr="owner"]')).toHaveAttribute("title", "approver@example.com");
  await expect(activation.getByTestId("not-measurable")).toHaveCount(0);

  const paid = page.getByTestId("goal-g.paid-conversion");
  await expect(paid.locator('[data-attr="owner"]')).toHaveText("—");
  await expect(paid.getByTestId("not-measurable")).toHaveAttribute("title", "Missing: owner");

  const churn = page.getByTestId("goal-g.early-churn");
  await expect(churn.locator('[data-attr="target"]')).toHaveText("< 8%");
  await expect(churn.locator('[data-attr="target"]')).toHaveAttribute("title", "Not checked yet: fill from text or edit");
  await expect(churn.locator('[data-attr="target"]')).toHaveAttribute("data-text", "true");
  await expect(churn.getByTestId("not-measurable")).toHaveText("Not measurable");
  await expect(churn.getByTestId("not-measurable")).toHaveAttribute("title", "Missing: unit, comparison, target, horizon, owner");
});

// protects: a target never saves without its unit and which way is success, and the person
// sees the API's words under the field they concern, fixes it there and saves.
// fails_when: the form saves anyway, shows the problem only as a page notice, or disables Save.
// no_claim: the mock implements the checks; pytest proves the API's.
test("edit form: a target without a unit shows the problem under Value and does not save; fixing it saves", async ({ page }) => {
  await openBaseline(page);
  const form = await editGoal(page, "g.early-churn", "Cut early churn");
  await form.getByLabel("Value", { exact: true }).fill("8");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form.getByTestId("field-error-target")).toHaveText("A target needs its unit and which way is success");
  await expect(form.getByRole("button", { name: "Save" })).toBeEnabled();
  await expect(page.getByTestId("goal-g.early-churn").locator('[data-attr="target"]')).toHaveText("< 8%");

  // The fix, in place.
  await form.getByLabel("Comparison").selectOption("below");
  await form.getByLabel("Unit").selectOption("%");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByTestId("goal-g.early-churn").locator('[data-attr="target"]')).toHaveText("< 8%");
  await expect(page.getByTestId("goal-g.early-churn").getByTestId("not-measurable")).toHaveAttribute(
    "title",
    "Missing: horizon, owner",
  );
});

// protects: a goal's owner is a member picked from GET /v1/people, and the table names them.
// fails_when: the picker lists nobody, saves a typed name, or the table keeps "—".
// no_claim: mock members; disabled-member refusal is proven in pytest.
test("owner picker: pick a member, save, and the table shows their name", async ({ page }) => {
  await openBaseline(page);
  const form = await editGoal(page, "g.paid-conversion", "Grow paid conversion");
  await form.getByLabel("Owner", { exact: true }).fill("comm");
  const options = form.getByRole("listbox", { name: "Members" }).getByRole("option");
  await expect(options).toHaveText([/Commenter/]);
  await options.first().click();
  await expect(form.getByTestId("owner-picked")).toContainText("Commenter");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toHaveCount(0);
  const paid = page.getByTestId("goal-g.paid-conversion");
  await expect(paid.locator('[data-attr="owner"]')).toHaveText("Commenter");
  await expect(paid.getByTestId("not-measurable")).toHaveCount(0);
});

// protects: someone without an account is invited first; whoever may invite gets the link.
// fails_when: an inviter (owner, or approver per A5) gets no link, or the owner's link does not open the
// invite form with role Commenter.
// no_claim: does not send an invite.
test("owner picker: an owner is sent to the invite form; an approver gets the link too (A5)", async ({ page }) => {
  await openBaseline(page);
  let form = await editGoal(page, "g.paid-conversion", "Grow paid conversion");
  await form.getByLabel("Owner", { exact: true }).fill("nobody");
  await expect(form.getByRole("listbox", { name: "Members" }).getByRole("option")).toHaveCount(0);
  const invite = form.getByRole("link", { name: "Invite them first" });
  await expect(form.getByTestId("owner-invite")).toHaveText("Not a member yet? Invite them first");
  await expect(invite).toHaveAttribute("href", "/settings/members?invite=1");
  await invite.click();
  await expect(page).toHaveURL(/\/settings\/members\?invite=1$/);
  await expect(page.getByLabel("Email")).toBeFocused();
  await expect(page.getByLabel("Role", { exact: true })).toHaveValue("commenter");

  await signOut(page);
  await openBaseline(page, "approver@example.com");
  form = await editGoal(page, "g.paid-conversion", "Grow paid conversion");
  await form.getByLabel("Owner", { exact: true }).fill("nobody");
  // A5 "Who invites": an approver invites viewers and commenters too, so they get the link.
  await expect(form.getByTestId("owner-invite")).toHaveText("Not a member yet? Invite them first");
  await expect(form.getByRole("link", { name: "Invite them first" })).toHaveAttribute("href", "/settings/members?invite=1");
});

// protects: Fill from text turns a goal's text into typed fields with Home's rules.
// fails_when: no notice, or early churn's target stays grey text.
// no_claim: no model call is made in the mock either; proposals on locked goals are pytest's.
test("Fill from text: the result notice, and early churn's target becomes < 8%", async ({ page }) => {
  await openBaseline(page);
  await page.getByRole("button", { name: "Fill goals from text (1 goal)" }).click();
  await page.getByRole("alertdialog", { name: "Fill 1 goal from text" }).getByRole("button", { name: "Fill 1 goal from text" }).click();
  await expect(page.getByRole("status")).toContainText("1 goal filled.");
  const churn = page.getByTestId("goal-g.early-churn");
  await expect(churn.locator('[data-attr="target"]')).toHaveText("< 8%");
  await expect(churn.getByTestId("not-measurable")).toHaveAttribute("title", "Missing: horizon, owner");
  await expect(page.getByRole("button", { name: /Fill from text/ })).toHaveCount(0);
});

// protects: Home reads typed current and target, and a recorded value moves both the
// drawer's chart and Home's distance.
// fails_when: Home still shows the old distance, or the drawer's list and chart miss the value.
// no_claim: mock data.
test("measurements: Home shows 7 pts to go; Record value 40 today moves the chart and Home to 5 pts", async ({ page }) => {
  await login(page);
  await page.goto("/home");
  await expect(page.getByTestId("home-goal-G1").getByTestId("goal-to-go")).toHaveText("7 pts to go");
  await expect(page.getByTestId("home-goal-G3").getByTestId("goal-to-go")).toHaveText("No current value yet");

  await page.goto("/baseline");
  await page.getByTestId("goal-g.activation").getByRole("button", { name: "Raise activation" }).click();
  const d = drawer(page, "Raise activation");
  const section = d.getByTestId("goal-measurements");
  await expect(section.getByTestId("measurement-row")).toHaveCount(7);
  await expect(section.getByTestId("measurement-row").first()).toContainText("38% · Oct 1");
  await expect(section.getByRole("img", { name: "Measurements" }).locator("circle")).toHaveCount(7);
  await section.getByRole("button", { name: "Record value" }).click();
  const rec = section.getByRole("form", { name: "Record value" });
  await expect(rec.getByLabel("Measured on")).toHaveValue(today());
  await rec.getByLabel("Value").fill("40");
  await rec.getByLabel("Note").fill("Weekly export");
  await rec.getByRole("button", { name: "Save" }).click();
  await expect(section.getByTestId("measurement-row")).toHaveCount(8);
  await expect(section.getByTestId("measurement-row").first()).toContainText("40% ·");
  await expect(section.getByTestId("measurement-row").first()).toContainText("Weekly export");
  await expect(section.getByRole("img", { name: "Measurements" }).locator("circle")).toHaveCount(8);

  await page.goto("/home");
  await expect(page.getByTestId("home-goal-G1").getByTestId("goal-figure")).toHaveText("40%/ 45%");
  await expect(page.getByTestId("home-goal-G1").getByTestId("goal-to-go")).toHaveText("5 pts to go");

  // Deleting it, with the in-page confirmation, rolls back to 38%.
  await page.goto("/baseline");
  await page.getByTestId("goal-g.activation").getByRole("button", { name: "Raise activation" }).click();
  const row = d.getByTestId("goal-measurements").getByTestId("measurement-row").first();
  await row.getByRole("button", { name: /^Delete/ }).click();
  await row.getByRole("button", { name: "Delete value" }).click();
  await expect(d.getByTestId("goal-measurements").getByTestId("measurement-row")).toHaveCount(7);
  await page.goto("/home");
  await expect(page.getByTestId("home-goal-G1").getByTestId("goal-to-go")).toHaveText("7 pts to go");
});

// protects: decided 2026-10-21, B5 "Vague goals": confirming a goal that is not measurable
// works, stays flagged, and Home says No target.
// fails_when: Confirm is refused, the chip disappears, or Home shows a distance.
// no_claim: B6's goals interview is not built here.
test("confirm a Not measurable goal: Confirmed with the chip still on, and Home shows No target", async ({ page }) => {
  await openBaseline(page);
  const churn = page.getByTestId("goal-g.early-churn");
  await churn.getByRole("button", { name: "Confirm" }).click();
  await expect(churn).toContainText("Confirmed");
  await expect(churn.getByTestId("not-measurable")).toBeVisible();

  await page.goto("/home");
  const g3 = page.getByTestId("home-goal-G3");
  // qa-plan-14: never "No target" beside the shown target "below 8%".
  await expect(g3.getByTestId("goal-to-go")).toHaveText("No current value yet");
  await expect(g3.getByTestId("goal-to-go").locator("[title]")).toHaveAttribute(
    "title",
    "Not measurable yet: missing unit, comparison, target, horizon, owner",
  );
});

// protects: the goal edit form is usable on a phone.
// fails_when: the target row or owner picker pushes the page wider than 390 px.
// no_claim: other screen sizes.
test("the goal edit form fits at 390 px without horizontal scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openBaseline(page);
  await page.getByTestId("goal-g.activation").click();
  const d = drawer(page, "Raise activation");
  await d.getByRole("button", { name: "Edit" }).click();
  const form = d.getByRole("form", { name: "Edit" });
  await expect(form.getByLabel("Comparison")).toBeVisible();
  await form.getByLabel("Owner", { exact: true }).fill("a");
  await expect(form.getByRole("listbox", { name: "Members" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

// protects: a goal an older Oracle stored with a value the checks refuse shows the API's
// problem (goal_check.problems) under its field when the form opens, and is fixed right there.
// fails_when: the problem is hidden, shown away from its field, or the untouched current value
// blocks saving the fixed target.
// no_claim: the large scenario's made-up regional goals; the API side is pytest's.
test("edit form: a stored refused value shows its problem under the field, and the fix saves", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "large"));
  await openBaseline(page);
  const region = page.getByTestId("goal-g.region-1");
  await expect(region.locator('[data-attr="target"]')).toHaveText("210 clinics");
  const form = await editGoal(page, "g.region-1", "Region 01 clinics");
  await expect(form.getByTestId("field-error-target")).toContainText("The target is a number");
  await form.getByLabel("Comparison").selectOption("at_least");
  await form.getByLabel("Value", { exact: true }).fill("210");
  await form.getByLabel("Unit").selectOption("count");
  await form.getByLabel("Counted noun").fill("clinics");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toHaveCount(0);
  await expect(region.locator('[data-attr="target"]')).toHaveText("≥ 210 clinics");
});
