import type { Locator, Page } from "@playwright/test";

import { expect, test } from "./test";

import { login, signOut } from "./helpers";

/**
 * QA pass on Settings › Members (qa-settings-3, 4, 5, 25, 31, 32; prod-9, prod-10), driven as
 * a person would on the mock layer, at 1440 and 390 wide, light and dark.
 */

const memberRow = (page: Page, email: string) => page.getByTestId("member-row").filter({ hasText: email });
const inviteRow = (page: Page, email: string) => page.getByTestId("invite-row").filter({ hasText: email });
const people = (page: Page) => page.getByRole("region", { name: "People" });

/** Nothing cut: the text fits its own box and the cell around it. */
async function expectWhole(el: Locator) {
  await expect(el).toBeVisible();
  const cut = await el.evaluate((e) => {
    const cell = e.closest("td") ?? e.parentElement!;
    const box = e.getBoundingClientRect();
    const room = cell.getBoundingClientRect();
    return e.scrollWidth > e.clientWidth + 1 || cell.scrollWidth > cell.clientWidth + 1 || box.right > room.right + 1;
  });
  expect(cut, `${await el.textContent()} is cut`).toBe(false);
}

/** The select shows its whole role name: the text's width fits inside the select's paddings. */
async function expectWholeOption(select: Locator) {
  const fits = await select.evaluate((e) => {
    const s = e as HTMLSelectElement;
    const style = getComputedStyle(s);
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const text = ctx.measureText(s.options[s.selectedIndex]!.text).width;
    const room = s.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    return text <= room + 1;
  });
  expect(fits, "the role select cuts its role name").toBe(true);
}

/** An email that wraps breaks only after its "@", never inside the name or the domain. */
async function expectNoMidWordBreak(el: Locator) {
  await expect(el).toBeVisible();
  const breaks = await el.evaluate((e) => {
    const walker = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
    const chars: { ch: string; top: number }[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent ?? "";
      for (let i = 0; i < text.length; i++) {
        const range = document.createRange();
        range.setStart(n, i);
        range.setEnd(n, i + 1);
        chars.push({ ch: text[i]!, top: Math.round(range.getBoundingClientRect().top) });
      }
    }
    const out: string[] = [];
    for (let i = 1; i < chars.length; i++) {
      if (chars[i]!.top > chars[i - 1]!.top && chars[i - 1]!.ch !== "@") out.push(`${chars[i - 1]!.ch}|${chars[i]!.ch}`);
    }
    return out;
  });
  expect(breaks, `${await el.textContent()} breaks mid-word`).toEqual([]);
}

async function expectPeopleWhole(page: Page) {
  for (const email of ["admin@example.com", "approver@example.com", "commenter@example.com", "viewer@example.com", "former.pm@example.com"]) {
    const row = memberRow(page, email);
    await expectWhole(row.getByTestId("member-name"));
    await expectWhole(row.getByTestId("member-email"));
    await expectNoMidWordBreak(row.getByTestId("member-email"));
  }
  await expect(memberRow(page, "commenter@example.com").getByLabel("Role for commenter@example.com")).toHaveValue("commenter");
  await expectWholeOption(memberRow(page, "commenter@example.com").getByLabel("Role for commenter@example.com"));
}

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`members at 1440 (${colorScheme})`, () => {
    test.use({ colorScheme, viewport: { width: 1440, height: 900 } });

    test("qa-settings-3, prod-9: names, emails and the role select are whole beside the Invite inspector", async ({ page }) => {
      await login(page);
      await page.goto("/settings/members");
      await expect(page.getByRole("form", { name: "Invite" })).toBeVisible();
      await expectPeopleWhole(page);

      // prod-9: the owner's own row: "you" sits on its own line under the email, not beside it.
      const me = memberRow(page, "admin@example.com");
      const email = await me.getByTestId("member-email").boundingBox();
      const you = await me.getByTestId("member-you").boundingBox();
      expect(you!.y).toBeGreaterThanOrEqual(email!.y + email!.height - 1);
    });

    test("qa-settings-4: an open invite's email is whole, with one status line and no Last tried after it worked", async ({ page }) => {
      await login(page);
      await page.goto("/settings/members");
      const hire = inviteRow(page, "new.hire@example.com");
      await expectWhole(hire.getByTestId("invite-who").getByText("new.hire@example.com", { exact: true }));
      await expect(hire.getByTestId("invite-email")).toHaveText("Sent Oct 15");
      await expect(hire.getByTestId("invite-access")).toHaveText("Access granted Oct 15");
      await expect(hire.getByText(/Last tried/)).toHaveCount(0);

      // An expired invite does not look granted: its Expired chip and Resend say it.
      const old = inviteRow(page, "old.invite@example.com");
      await expect(old).toContainText("Expired");
      await expect(old.getByTestId("invite-access")).toHaveCount(0);
      await expect(old.getByText("Access granted")).toHaveCount(0);
      await expectWhole(old.getByTestId("invite-who").getByText("old.invite@example.com", { exact: true }));
    });
  });
}

test.describe("members at 390", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("qa-settings-3, 4: on a phone names, emails and invite emails are whole", async ({ page }) => {
    await login(page);
    await page.goto("/settings/members");
    for (const email of ["admin@example.com", "former.pm@example.com", "viewer@example.com"]) {
      await expectWhole(memberRow(page, email).getByTestId("member-email"));
      await expectNoMidWordBreak(memberRow(page, email).getByTestId("member-email"));
    }
    await expectWhole(inviteRow(page, "new.hire@example.com").getByTestId("invite-who").getByText("new.hire@example.com", { exact: true }));
  });
});

test("qa-settings-5: a new invite attempt clears the last outcome; the refusal has no code", async ({ page }) => {
  await login(page);
  await page.goto("/settings/members");
  const form = page.getByRole("form", { name: "Invite" });
  await page.getByLabel("Email").fill("sam@example.com");
  await page.getByRole("button", { name: "Send invite", exact: true }).click();
  await expect(page.getByTestId("invite-outcome")).toHaveText("Invite sent to sam@example.com");

  await page.getByLabel("Email").fill("sam@example.com");
  await page.getByRole("button", { name: "Send invite", exact: true }).click();
  await expect(form.getByRole("alert")).toHaveText("sam@example.com already has an open invite; revoke it first");
  await expect(form.getByRole("alert")).not.toContainText("409");
  // Only the latest outcome shows: the green "Invite sent" is gone.
  await expect(page.getByTestId("invite-outcome")).toHaveCount(0);
});

test("qa-settings-25, prod-10: one People count; a search with no match says so and clears", async ({ page }) => {
  await login(page);
  await page.goto("/settings/members");
  const panel = people(page);
  await expect(page.getByTestId("member-row")).toHaveCount(5);
  // Removed people are not counted (their row says Removed); the count matches the Active tile.
  await expect(panel.getByTestId("panel-count")).toHaveText("4 active");
  await expect(page.getByTestId("stat-active")).toContainText("4");
  await expect(memberRow(page, "former.pm@example.com")).toContainText("Removed");

  await panel.getByLabel("Find a person").fill("zzz");
  await expect(panel.getByTestId("table-empty")).toContainText("No one matches “zzz”");
  await expect(panel.getByTestId("table-empty")).not.toContainText("No members");
  await expect(panel.getByTestId("panel-count")).toHaveText("0 active");
  await panel.getByRole("button", { name: "Clear search" }).click();
  await expect(panel.getByLabel("Find a person")).toHaveValue("");
  await expect(page.getByTestId("member-row")).toHaveCount(5);

  await panel.getByLabel("Find a person").fill("approv");
  await expect(panel.getByTestId("panel-count")).toHaveText("1 active");
});

test("qa-settings-25: a viewer's people search with no match says so and clears", async ({ page }) => {
  await login(page, "viewer@example.com");
  await page.goto("/settings/members");
  const list = page.getByTestId("people-readonly");
  await list.getByLabel("Find a person").fill("zzz");
  await expect(list.getByTestId("table-empty")).toContainText("No one matches “zzz”");
  await expect(list.getByTestId("panel-count")).toHaveText("0");
  await list.getByRole("button", { name: "Clear search" }).click();
  await expect(list.getByTestId("person-row")).toHaveCount(4);
  await expect(list.getByTestId("panel-count")).toHaveText("4");
});

test("qa-settings-31: a person without a name is named the same way for the owner and for a viewer", async ({ page }) => {
  await login(page);
  await page.goto("/settings/members");
  const viewer = memberRow(page, "viewer@example.com");
  await expect(viewer.getByTestId("member-name")).toHaveText("Viewer");
  await expect(viewer.getByTestId("member-email")).toHaveText("viewer@example.com");
  await expect(memberRow(page, "former.pm@example.com").getByTestId("member-name")).toHaveText("Former Pm");
  // Searching finds them by that name too.
  await people(page).getByLabel("Find a person").fill("former pm");
  await expect(page.getByTestId("member-row")).toHaveCount(1);

  await signOut(page);
  await login(page, "viewer@example.com");
  await page.goto("/settings/members");
  const row = page.getByTestId("people-readonly").getByTestId("person-row").filter({ hasText: "viewer@example.com" });
  await expect(row).toContainText("Viewer");
  await expect(row).toContainText("viewer@example.com");
});

test("qa-settings-32: Send invite says what is missing next to the Email field", async ({ page }) => {
  await login(page);
  await page.goto("/settings/members");
  const form = page.getByRole("form", { name: "Invite" });
  const send = form.getByRole("button", { name: "Send invite", exact: true });
  const hint = form.getByTestId("invite-email-hint");
  await expect(send).toBeDisabled();
  await expect(hint).toHaveText("Enter an email address");

  await page.getByLabel("Email").fill("pat");
  await expect(send).toBeDisabled();
  await expect(hint).toHaveText("Enter a valid email address, like name@company.com");
  await expect(page.getByLabel("Email")).toHaveAttribute("aria-invalid", "true");

  await page.getByLabel("Email").fill("pat@example.com");
  await expect(hint).toHaveCount(0);
  await expect(send).toBeEnabled();
});
