import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * QA fixes on Settings › Members (fix2): the People table and Open invites read in full, an
 * expired invite has one state and one Resend, unavailable controls say why, the invite
 * outcome reaches "Invite sent", the Set up steps that land here work, one date format.
 * Mock-backed, driven through the UI as a person would.
 */

const memberRow = (page: Page, email: string) => page.getByTestId("member-row").filter({ hasText: email });
const inviteRow = (page: Page, email: string) => page.getByTestId("invite-row").filter({ hasText: email });
const setupRow = (page: Page, key: string) => page.getByTestId(`setup-row-${key}`);
const scenario = (page: Page, name: string) => page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, name]);

/** True when the element shows all its text: nothing clipped, no ellipsis. */
const showsAll = (el: Locator) =>
  el.evaluate((e) => {
    const s = getComputedStyle(e);
    return e.scrollWidth <= e.clientWidth + 1 && s.textOverflow !== "ellipsis";
  });

/** The select's inner width minus the text of its chosen option: below 0, the word is cut. */
const selectRoom = (select: Locator) =>
  select.evaluate((e) => {
    const el = e as HTMLSelectElement;
    const s = getComputedStyle(el);
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.font = `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
    const text = ctx.measureText(el.options[el.selectedIndex].text).width;
    return el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight) - text;
  });

async function backToHome(page: Page) {
  await page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Back to Home" }).click();
  await expect(page).toHaveURL(/\/home$/);
}

test.describe("at 1440 px", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("qa-settings-2 / qa-onboarding-6 / qa-settings-13: names, emails and roles read in full, with the side panel open too", async ({ page }) => {
    await login(page);
    await page.goto("/settings/members");
    const rows = page.getByTestId("member-row");
    await expect(rows.first()).toBeVisible();
    const check = async () => {
      for (const el of await page.getByTestId("member-name").all()) expect(await showsAll(el), await el.innerText()).toBe(true);
      for (const el of await page.getByTestId("member-email").all()) expect(await showsAll(el), await el.innerText()).toBe(true);
      // The "you" chip sits under the name, so the name keeps its width.
      const name = memberRow(page, "admin@example.com").getByTestId("member-name");
      expect((await name.boundingBox())!.width).toBeGreaterThan(30);
      await expect(name).toHaveText("Admin");
      // "Commenter" fits its select.
      expect(await selectRoom(page.getByLabel("Role for commenter@example.com"))).toBeGreaterThanOrEqual(0);
    };
    await check();
    await memberRow(page, "viewer@example.com").getByTestId("member-open").click();
    const panel = page.getByTestId("member-inspector");
    await expect(panel).toBeVisible();
    await check();
    // qa-settings-15: the panel closes back to the members page, not "Back to invites".
    await expect(panel.getByRole("button", { name: "Back to invites" })).toHaveCount(0);
    await panel.getByRole("button", { name: "Close", exact: true }).click();
    await expect(panel).toHaveCount(0);
  });
});

test("qa-onboarding-7 / qa-settings-3 / qa-settings-4: an open invite reads in full with no repeated lines; an expired one has one state and one Resend", async ({ page }) => {
  await login(page);
  await page.goto("/settings/members");
  const open = inviteRow(page, "new.hire@example.com");
  await expect(open).toBeVisible();
  expect(await showsAll(open.getByTestId("invite-who"))).toBe(true);
  await expect(open.getByTestId("invite-who")).toHaveText("new.hire@example.com");
  await expect(open.getByText(/Last tried/)).toHaveCount(0);
  await expect(open.getByRole("button", { name: "Copy link for new.hire@example.com" })).toBeVisible();

  const expired = inviteRow(page, "old.invite@example.com");
  await expect(expired.getByTestId("invite-expiry")).toContainText("Expired");
  await expect(expired.getByTestId("invite-access")).toHaveCount(0);
  await expect(expired.getByTestId("invite-email")).toHaveCount(0);
  await expect(expired.getByRole("button", { name: /^Resend/ })).toHaveCount(1);
  await expect(expired.getByRole("button", { name: /^Copy link/ })).toHaveCount(0);
  await expect(expired).not.toContainText("Access granted");
});

test("qa-onboarding-17 / qa-onboarding-36: one invite button, primary; disabled controls say why", async ({ page }) => {
  await login(page);
  await page.goto("/settings/members");
  // One way in: the header's "+ Invite" is gone, the form's Send invite is the primary button.
  await expect(page.getByRole("button", { name: "Invite", exact: true })).toHaveCount(0);
  const send = page.getByRole("button", { name: "Send invite", exact: true });
  await expect(send).toHaveAttribute("data-variant", "primary");
  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.getByRole("form", { name: "Invite" }).getByRole("alert")).toHaveText("Enter an email to send an invite.");

  // The owner's own Remove, and a viewer's Eng lead box, say why in words.
  await expect(memberRow(page, "admin@example.com").getByTestId("remove-reason")).toHaveText("You can't remove yourself");
  await expect(memberRow(page, "viewer@example.com")).toContainText("Not for viewers");
  const form = page.getByRole("form", { name: "Invite" });
  await form.getByLabel("Role", { exact: true }).selectOption("viewer");
  await expect(form.getByTestId("invite-lead-reason")).toContainText("Viewers can't be the engineering lead");
});

test("qa-onboarding-19: after Send invite the outcome says it was sent", async ({ page }) => {
  await login(page);
  await page.goto("/settings/members");
  await page.getByPlaceholder("name@company.com").fill("pat@example.com");
  await page.getByRole("button", { name: "Send invite", exact: true }).click();
  await expect(page.getByTestId("invite-outcome")).toHaveText("Invite sent to pat@example.com");
  await expect(inviteRow(page, "pat@example.com").getByTestId("invite-email")).toContainText("Sent");
  await expect(inviteRow(page, "pat@example.com").getByTestId("invite-email")).not.toContainText("Sending");
});

// fix2-settings review (qa-onboarding-19): an email Oracle never gets out stops saying
// "Sending" after the page's 30 looks and hands over the sign-in link instead.
test("qa-onboarding-19: an invite email that stalls hands over the sign-in link after 30 s", async ({ page }) => {
  test.setTimeout(90_000);
  await scenario(page, "mail-stalls");
  await login(page);
  await page.goto("/settings/members");
  await page.getByPlaceholder("name@company.com").fill("pat@example.com");
  await page.getByRole("button", { name: "Send invite", exact: true }).click();
  const outcome = page.getByTestId("invite-outcome");
  await expect(outcome).toHaveText("Sending the invite to pat@example.com…");
  await expect(outcome).toContainText("Oracle hasn't emailed pat@example.com yet. Send them this link yourself:", { timeout: 60_000 });
  await expect(outcome).not.toContainText("Sending the invite");
  await expect(outcome.getByTestId("invite-link")).toContainText("http");
  await outcome.getByRole("button", { name: "Copy sign-in link" }).click();
  await expect(outcome.getByRole("button", { name: "Copied" })).toBeVisible();
});

test("qa-onboarding-21: #engineering-lead marks the column, says what to pick and says Saved", async ({ page }) => {
  await login(page);
  await page.goto("/settings/members#engineering-lead");
  await expect(page.getByTestId("lead-step-hint")).toContainText("Pick who checks feasibility");
  await expect(page.locator("#engineering-lead")).toHaveAttribute("data-highlight", "true");
  await page.getByRole("checkbox", { name: "Engineering lead: commenter@example.com" }).check();
  await expect(page.getByTestId("lead-saved")).toHaveText("Saved");
});

test("qa-settings-16: a viewer reads their role capitalised and what each role can do", async ({ page }) => {
  await login(page, "viewer@example.com");
  await page.goto("/settings/members");
  await expect(page.getByTestId("role-note")).toContainText("Your role is Viewer.");
  await expect(page.getByTestId("role-viewer").getByTestId("role-can")).toHaveText("Reads documents, versions, diffs, feedback and exports.");
  await expect(page.getByTestId("role-owner").getByTestId("role-can")).toBeVisible();
});

test("qa-settings-17: Sign-in's Company domains says it is the Sources list too, with a link", async ({ page }) => {
  await login(page);
  await page.goto("/settings/members");
  const hint = page.getByTestId("sign-in-domains-hint");
  await expect(hint).toContainText("Who may sign in");
  await expect(hint.getByRole("link", { name: "Settings › Sources" })).toHaveAttribute("href", "/settings/sources#company-domains");
});

test("qa-settings-43: the panel's dates read like the table's", async ({ page }) => {
  await login(page);
  await page.goto("/settings/members");
  const row = memberRow(page, "approver@example.com");
  const tableDate = await row.locator("[title]").filter({ hasText: /^\w{3} \d{1,2}, \d{4}$/ }).first().innerText();
  await row.getByTestId("member-open").click();
  const panel = page.getByTestId("member-inspector");
  await expect(panel.getByTestId("member-last-sign-in")).toHaveText(tableDate);
  await expect(panel.getByTestId("member-joined")).toHaveText(/^\w{3} \d{1,2}, \d{4}/);
});

// fix2-settings review: with the header's "+ Invite" gone, a window under 1100 px puts the
// invite form below the People table; the People panel offers a jump to it.
test.describe("under 1100 px", () => {
  test.use({ viewport: { width: 1000, height: 800 } });

  test("the People panel's Invite someone jumps to the invite form", async ({ page }) => {
    await login(page);
    await page.goto("/settings/members");
    const email = page.getByPlaceholder("name@company.com");
    await expect(email).not.toBeInViewport();
    await page.getByRole("link", { name: "Invite someone" }).click();
    await expect(email).toBeFocused();
    await expect(email).toBeInViewport();
  });
});

test("beside the table, at 1512 px, the jump to the invite form is not shown", async ({ page }) => {
  await page.setViewportSize({ width: 1512, height: 900 });
  await login(page);
  await page.goto("/settings/members");
  await expect(page.getByPlaceholder("name@company.com")).toBeVisible();
  await expect(page.getByRole("link", { name: "Invite someone" })).toBeHidden();
});

test.describe("on a phone, dark", () => {
  test.use({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });

  test("qa-settings-42: the Eng lead box and the token count are 44 px tap targets", async ({ page }) => {
    await login(page);
    await page.goto("/settings/members");
    const row = memberRow(page, "commenter@example.com");
    const lead = row.locator("label").filter({ has: page.getByRole("checkbox", { name: "Engineering lead: commenter@example.com" }) });
    const box = (await lead.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    const tokens = (await row.getByTestId("open-tokens").boundingBox())!;
    expect(tokens.height).toBeGreaterThanOrEqual(44);
    expect(tokens.width).toBeGreaterThanOrEqual(44);
  });
});

test("qa-onboarding-42: Set up › Invite team › Open, send an invite, see it sent, the step stays ticked on Home", async ({ page }) => {
  await scenario(page, "empty");
  await login(page);
  await setupRow(page, "invite").getByRole("link", { name: "Open" }).click();
  await expect(page).toHaveURL(/\/settings\/members\?from=setup$/);
  await page.getByPlaceholder("name@company.com").fill("new.teammate@example.com");
  await page.getByRole("button", { name: "Send invite", exact: true }).click();
  await expect(page.getByTestId("invite-outcome")).toHaveText("Invite sent to new.teammate@example.com");
  await expect(inviteRow(page, "new.teammate@example.com")).toBeVisible();
  await backToHome(page);
  await expect(setupRow(page, "invite")).toHaveAttribute("data-done", "true");
  await expect(setupRow(page, "invite").getByTestId("setup-status")).toHaveText("4 people");
});

test("qa-onboarding-43: Set up › Company domains › Open, add and remove a domain, Home follows", async ({ page }) => {
  await scenario(page, "empty");
  await login(page);
  await expect(setupRow(page, "domains").getByTestId("setup-status")).toHaveText("example.com");
  await setupRow(page, "domains").getByRole("link", { name: "Open" }).click();
  await expect(page).toHaveURL(/\/settings\/sources\?from=setup#company-domains$/);
  const section = page.getByTestId("company-domains");
  await expect(section).toBeVisible();
  await section.getByLabel("Add a domain").fill("acme.dev");
  await section.getByRole("button", { name: "Add", exact: true }).click();
  await expect(section.getByRole("listitem", { name: "acme.dev" })).toBeVisible();
  await backToHome(page);
  await expect(setupRow(page, "domains").getByTestId("setup-status")).toHaveText("2 domains");

  await setupRow(page, "domains").getByRole("link", { name: "Open" }).click();
  const again = page.getByTestId("company-domains");
  await again.getByRole("button", { name: "Remove acme.dev" }).click();
  await expect(again.getByRole("listitem", { name: "acme.dev" })).toHaveCount(0);
  await backToHome(page);
  await expect(setupRow(page, "domains").getByTestId("setup-status")).toHaveText("example.com");
});
