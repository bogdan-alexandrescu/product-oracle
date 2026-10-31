import { expect, test, type Locator, type Page } from "./test";

import { login } from "./helpers";

/**
 * QA fixes on Settings › Members (fix4): a half-written invite asks before it is dropped, a
 * refusal replaces the last "Invite sent", roles and emails read whole in the People table,
 * expired invites stand apart, Resend says what it did, one name and role-chip rule, and the
 * phone's targets and panel. Mock-backed, driven through the UI as a person would.
 */

const memberRow = (page: Page, email: string) => page.getByTestId("member-row").filter({ hasText: email });
const inviteRow = (page: Page, email: string) => page.getByTestId("invite-row").filter({ hasText: email });
const box = async (l: Locator) => (await l.boundingBox())!;

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

/** Where the element's text wraps mid-word: each pair of characters split across lines, unless after an @ or before a dot. */
const midWordBreaks = (el: Locator) =>
  el.evaluate((root) => {
    const chars: { c: string; top: number }[] = [];
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const text = n.textContent ?? "";
      for (let i = 0; i < text.length; i++) {
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + 1);
        const rect = r.getBoundingClientRect();
        if (rect.width > 0) chars.push({ c: text[i], top: Math.round(rect.top) });
      }
    }
    const bad: string[] = [];
    for (let i = 1; i < chars.length; i++) {
      const [a, b] = [chars[i - 1], chars[i]];
      if (b.top > a.top + 2 && a.c !== "@" && b.c !== "." && a.c !== " " && b.c !== " ") bad.push(`${a.c}|${b.c}`);
    }
    return bad;
  });

for (const width of [1440, 1512]) {
  test.describe(`at ${width} px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test(`qa-onboarding-9 / qa-settings-3 / qa-settings-2 / qa-settings-1: roles, emails and the Removed chip fit (${width})`, async ({ page }) => {
      await login(page);
      await page.goto("/settings/members");
      await expect(page.getByTestId("member-row").first()).toBeVisible();
      for (const email of ["commenter@example.com", "approver@example.com", "viewer@example.com"]) {
        expect(await selectRoom(page.getByLabel(`Role for ${email}`, { exact: true })), email).toBeGreaterThanOrEqual(0);
      }
      for (const el of await page.getByTestId("member-email").all()) expect(await midWordBreaks(el), await el.innerText()).toEqual([]);

      // The removed member's chip stays inside Status; Last sign-in reads beside it.
      const removed = memberRow(page, "former.pm@example.com");
      const status = removed.getByRole("cell").nth(3);
      const chip = removed.getByTestId("member-removed");
      await expect(chip).toContainText("Removed");
      const [c, s] = [await box(chip), await box(status)];
      expect(c.x + c.width).toBeLessThanOrEqual(s.x + s.width + 1);
    });
  });
}

test("qa-onboarding-36: a half-written invite asks before Home drops it", async ({ page }) => {
  await login(page);
  await page.goto("/settings/members");
  const form = page.getByRole("form", { name: "Invite" });
  await form.getByLabel("Email").fill("pat@example.com");
  await form.getByLabel("Message (optional)").fill("Welcome aboard");
  const nav = page.getByRole("navigation", { name: "Oracle" });
  await nav.getByTestId("nav-home").click();
  const ask = page.getByRole("alertdialog", { name: "Discard your changes?" });
  await expect(ask).toBeVisible();
  await ask.getByRole("button", { name: "Keep editing" }).click();
  await expect(page).toHaveURL(/\/settings\/members/);
  await expect(form.getByLabel("Email")).toHaveValue("pat@example.com");
  await expect(form.getByLabel("Message (optional)")).toHaveValue("Welcome aboard");

  await nav.getByTestId("nav-home").click();
  await page.getByRole("alertdialog", { name: "Discard your changes?" }).getByRole("button", { name: "Discard" }).click();
  await expect(page).toHaveURL(/\/home$/);
});

test("qa-onboarding-8: a refused invite clears the last one's Invite sent", async ({ page }) => {
  await login(page);
  await page.goto("/settings/members");
  const form = page.getByRole("form", { name: "Invite" });
  await form.getByLabel("Email").fill("gone@example.com");
  await form.getByRole("button", { name: "Send invite" }).click();
  await expect(page.getByTestId("invite-outcome")).toHaveText("Invite sent to gone@example.com");
  await form.getByLabel("Email").fill("outside@gmail.com");
  await form.getByRole("button", { name: "Send invite" }).click();
  await expect(form.getByRole("alert")).toContainText("outside the company's email domains");
  await expect(page.getByTestId("invite-outcome")).toHaveCount(0);
});

test("qa-settings-4 / qa-onboarding-38: expired invites are counted and listed apart; an open one is ready for Google sign-in", async ({ page }) => {
  await login(page);
  await page.goto("/settings/members");
  await expect(page.getByTestId("stat-open-invites")).toContainText("1");
  await expect(page.getByTestId("stat-expired-invites")).toContainText("1");
  const open = page.getByTestId("open-invites");
  const expired = page.getByTestId("expired-invites");
  await expect(open.getByTestId("invite-row")).toHaveCount(1);
  await expect(open).not.toContainText("old.invite@example.com");
  await expect(expired.getByTestId("invite-row")).toHaveCount(1);
  await expect(expired.getByRole("button", { name: "Resend invite for old.invite@example.com" })).toBeVisible();
  await expect(inviteRow(page, "new.hire@example.com").getByTestId("invite-access")).toHaveText("Google sign-in ready");
  await expect(page.getByTestId("open-invites")).not.toContainText("Access granted");
});

test("qa-onboarding-37: Resend says on its row that it went", async ({ page }) => {
  await login(page);
  await page.goto("/settings/members");
  const row = inviteRow(page, "new.hire@example.com");
  await row.getByRole("button", { name: "Resend invitation to new.hire@example.com" }).click();
  await expect(row.getByTestId("invite-resent")).toHaveText("Resent just now");

  await inviteRow(page, "old.invite@example.com").getByRole("button", { name: "Resend invite for old.invite@example.com" }).click();
  await expect(inviteRow(page, "old.invite@example.com").getByTestId("invite-resent")).toContainText("Resent just now · expires");
});

test("qa-onboarding-18: the side panels' eyebrow is plain", async ({ page }) => {
  await login(page);
  await page.goto("/settings/members");
  await expect(page.getByRole("form", { name: "Invite" })).toBeVisible();
  await expect(page.getByText("Members · invite")).toHaveCount(0);
  await memberRow(page, "approver@example.com").getByTestId("member-open").click();
  await expect(page.getByTestId("member-inspector")).toBeVisible();
  await expect(page.getByText("Members · member")).toHaveCount(0);
});

test("qa-settings-10: Remove keeps its label while the preview loads", async ({ page }) => {
  await login(page);
  await page.goto("/settings/members");
  await expect(memberRow(page, "commenter@example.com")).toBeVisible();
  // Every label the dialog's confirm button shows, from before it opens.
  await page.evaluate(() => {
    const seen: string[] = ((window as unknown as { __labels: string[] }).__labels = []);
    const look = () => document.querySelectorAll('[data-testid="remove-dialog"] [data-testid="confirm-action"]').forEach((b) => seen.push(b.textContent ?? ""));
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await page.getByRole("button", { name: "Remove commenter@example.com" }).click();
  const dialog = page.getByTestId("remove-dialog");
  await expect(dialog.getByTestId("confirm-action")).toBeEnabled();
  await expect(dialog.getByTestId("confirm-action")).toHaveText("Remove member");
  const labels = await page.evaluate(() => (window as unknown as { __labels: string[] }).__labels);
  expect(labels.length).toBeGreaterThan(0);
  expect(labels.filter((l) => l !== "Remove member")).toEqual([]);
});

test("qa-settings-5 / qa-settings-6 / qa-settings-7: one name rule, one read-only role chip, Engineering lead apart", async ({ page }) => {
  await login(page);
  await page.goto("/settings/members");
  await expect(memberRow(page, "viewer@example.com").getByTestId("member-name")).toHaveText("Viewer");
  await expect(memberRow(page, "viewer@example.com").getByTestId("member-email")).toHaveText("viewer@example.com");

  // The only owner's own role and the removed member's: the same chip, no greyed select.
  const own = memberRow(page, "admin@example.com").getByRole("button", { name: "Role for admin@example.com" });
  await expect(own.locator('[data-kind="line"]')).toHaveText("Owner");
  await expect(memberRow(page, "former.pm@example.com").getByRole("cell").nth(1).locator('[data-kind="line"]')).toHaveText("Approver");

  const roles = page.getByTestId("roles-list");
  await expect(roles.locator('[data-testid^="role-"]:not([data-testid="role-can"])')).toHaveCount(4);
  await expect(roles).not.toContainText("Engineering lead");
  await expect(page.getByTestId("roles-lead")).toContainText("Engineering lead");
  await expect(page.getByTestId("roles-lead").getByTestId("engineering-lead-none")).toHaveText("Nobody named yet. Pick who carries engineering checks.");

});

test("qa-settings-5 (viewer) / qa-settings-8: the viewer reads the same name; a search for nobody says so and clears", async ({ page }) => {
  await login(page, "viewer@example.com");
  await page.goto("/settings/members");
  const people = page.getByTestId("people-readonly");
  await expect(people.getByTestId("person-row").filter({ hasText: "viewer@example.com" })).toContainText("Viewer");
  await people.getByLabel("Find a person").fill("zzzz");
  await expect(people.getByTestId("people-no-match")).toContainText("Nobody matches “zzzz”");
  await people.getByRole("button", { name: "Clear search" }).click();
  await expect(people.getByLabel("Find a person")).toHaveValue("");
  await expect(people.getByTestId("person-row").first()).toBeVisible();
});

test("qa-settings-8: the owner's search for nobody says so and clears", async ({ page }) => {
  await login(page);
  await page.goto("/settings/members");
  await page.getByLabel("Find a person").fill("zzzz");
  await expect(page.getByTestId("people-no-match")).toContainText("Nobody matches “zzzz”");
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(page.getByLabel("Find a person")).toHaveValue("");
  await expect(memberRow(page, "admin@example.com")).toBeVisible();
});

test("qa-settings-9: a sign-in rule says Saved when it lands", async ({ page }) => {
  await login(page);
  await page.goto("/settings/members");
  const rules = page.getByTestId("sign-in-rules");
  await rules.getByRole("button", { name: "Join at once" }).click();
  await expect(rules.getByTestId("sign-in-saved")).toHaveText("Saved");
  await expect(rules.getByRole("button", { name: "Join at once" })).toHaveAttribute("aria-pressed", "true");
  // The first Saved goes after a moment, so the second one is the second save's own.
  await expect(rules.getByTestId("sign-in-saved")).toHaveCount(0, { timeout: 8000 });
  await rules.getByLabel("Default role").selectOption("viewer");
  await expect(rules.getByTestId("sign-in-saved")).toHaveText("Saved");
  await expect(rules.getByTestId("sign-in-saved")).toHaveCount(1);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("qa-onboarding-31 / qa-settings-43: targets are big enough and a member who never signed in says so", async ({ page }) => {
    await login(page);
    await page.goto("/settings/members");
    const commenter = memberRow(page, "commenter@example.com");
    // The Eng lead column hides on a phone; its box sits in the role cell.
    const lead = commenter.locator('input[aria-label="Engineering lead: commenter@example.com"]:visible');
    const b = await box(lead);
    expect(Math.min(b.width, b.height)).toBeGreaterThanOrEqual(24);
    expect((await box(commenter.getByTestId("member-open"))).height).toBeGreaterThanOrEqual(44);
    await expect(memberRow(page, "viewer@example.com").getByTestId("never-signed-in")).toHaveText("Never signed in");
    await expect(memberRow(page, "viewer@example.com")).not.toContainText("Signed in —");
    const sources = page.getByTestId("sign-in-rules").getByRole("link", { name: "Settings › Sources" });
    expect((await box(sources)).height).toBeGreaterThanOrEqual(44);
  });

  test("qa-settings-44: a picked member's panel comes into view", async ({ page }) => {
    await login(page);
    await page.goto("/settings/members");
    await memberRow(page, "approver@example.com").getByTestId("member-open").click();
    await expect(page.getByTestId("member-inspector")).toBeInViewport();
  });
});
