import { expect, test, type Locator, type Page } from "./test";

import { login } from "./helpers";

/**
 * QA pass 4 on Settings › Members and My account (fix4-shell): a removed member's status fits
 * its column, role names and emails read whole, the Roles panel has one heading and a line for
 * the engineering lead, your own phone card shows role and status (and its Engineering lead box), and the password form
 * names whose password it is. Mock-backed, driven through the UI as a person would.
 */

const memberRow = (page: Page, email: string) => page.getByTestId("member-row").filter({ hasText: email });

/** The select is as wide as its longest role needs (nothing cut) and stays inside its cell. */
const selectFits = (select: Locator) =>
  select.evaluate((el) => {
    const probe = el.cloneNode(true) as HTMLSelectElement;
    probe.style.width = "max-content";
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    el.parentElement!.appendChild(probe);
    const needs = probe.getBoundingClientRect().width;
    probe.remove();
    const box = el.getBoundingClientRect();
    const cell = el.closest("td")!.getBoundingClientRect();
    return { whole: box.width + 0.5 >= needs, inCell: box.left >= cell.left - 0.5 && box.right <= cell.right + 0.5 };
  });

/** The email sits on one line, never wrapped (qa4-settings-10), and nothing of it is cut here. */
const emailWhole = (email: Locator) =>
  email.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getClientRects().length === 1 && el.scrollWidth <= el.clientWidth + 1;
  });

/** The status cell's content stays inside the cell, so it never covers Last sign-in. */
const statusInside = (row: Locator) =>
  row.evaluate((tr) => {
    const chip = tr.querySelector<HTMLElement>("[data-testid=member-removed]")!;
    const td = chip.closest("td")!;
    const cell = td.getBoundingClientRect();
    const boxes = [...td.querySelectorAll<HTMLElement>("*")].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0);
    const next = td.nextElementSibling as HTMLElement | null;
    const nextText = next && next.checkVisibility() ? next.querySelector("span[title]")?.getBoundingClientRect() : undefined;
    return {
      inside: boxes.every((r) => r.right <= cell.right + 0.5),
      clearOfNext: !nextText || boxes.every((r) => r.right <= nextText.left || r.bottom <= nextText.top || r.top >= nextText.bottom),
    };
  });

for (const width of [1440, 1512]) {
  for (const colorScheme of ["light", "dark"] as const) {
    test.describe(`at ${width} px, ${colorScheme}`, () => {
      test.use({ viewport: { width, height: 900 }, colorScheme });

      test("qa-shell-4 / qa-shell-5: Removed fits its column, role names and emails read whole", async ({ page }) => {
        await login(page);
        await page.goto("/settings/members");
        const former = memberRow(page, "former.pm@example.com");
        await expect(former).toBeVisible();

        // qa-shell-4: the chip says Removed; the date sits under it, inside the column (the settings
        // lane's status cell: its date is part of member-removed).
        await expect(former.getByTestId("member-removed")).toHaveText(/^Removed\s*[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
        expect(await statusInside(former)).toEqual({ inside: true, clearOfNext: true });

        // qa-shell-5: "Commenter" whole in its select, the select inside the Role column.
        for (const email of ["commenter@example.com", "approver@example.com", "viewer@example.com"]) {
          expect(await selectFits(page.getByLabel(`Role for ${email}`)), email).toEqual({ whole: true, inCell: true });
        }
        // Emails stay on one line, whole.
        const emails = page.getByTestId("member-email");
        await expect(emails.first()).toBeVisible();
        for (const el of await emails.all()) expect(await emailWhole(el), await el.innerText()).toBe(true);
        await expect(memberRow(page, "commenter@example.com").getByTestId("member-email")).toHaveText("commenter@example.com");
      });
    });
  }
}

test("qa-shell-27: the Roles panel has one heading and a line for the engineering lead", async ({ page }) => {
  await login(page, "viewer@example.com");
  await page.goto("/settings/members");
  const panel = page.getByRole("complementary", { name: "Roles" });
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Roles", { exact: true })).toHaveCount(1);
  await expect(panel).not.toContainText("Members · roles");
  for (const role of ["owner", "approver", "commenter", "viewer"]) {
    await expect(panel.getByTestId(`role-${role}`).getByTestId("role-can")).toBeVisible();
  }
  // The settings lane's Engineering lead section (qa-settings-7) is the lead's line.
  await expect(panel.getByTestId("roles-lead")).toContainText("Engineering lead");
  await expect(panel.getByTestId("roles-engineering-lead")).toContainText("Any commenter or above can carry it");
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("qa-shell-28: your own card shows your role and status only, on one line", async ({ page }) => {
    await login(page);
    await page.goto("/settings/members");
    const own = memberRow(page, "admin@example.com");
    await expect(own).toBeVisible();
    await expect(own.getByRole("button", { name: "Remove admin@example.com" })).toBeHidden();
    await expect(own.getByTestId("remove-reason")).toBeHidden();
    await expect(own.getByTestId("role-unavailable")).toBeHidden();
    const role = own.getByTestId("own-role");
    const status = own.getByText("Active", { exact: true });
    await expect(role).toHaveText("Owner");
    await expect(status).toBeVisible();
    const a = (await role.boundingBox())!;
    const b = (await status.boundingBox())!;
    expect(Math.abs(a.y + a.height / 2 - (b.y + b.height / 2))).toBeLessThanOrEqual(2);
    // review minor: your own card still has the Engineering lead box, and it saves.
    const lead = own.getByRole("checkbox", { name: "Engineering lead: admin@example.com" });
    await expect(lead).toBeVisible();
    const was = await lead.isChecked();
    await lead.click();
    await expect(lead).toBeChecked({ checked: !was });
    // The tick shows at once; reload only once the change is saved.
    await expect(page.getByTestId("lead-saved")).toHaveText("Saved");
    await page.reload();
    await expect(memberRow(page, "admin@example.com").getByRole("checkbox", { name: "Engineering lead: admin@example.com" })).toBeChecked({ checked: !was });
    // Someone else's card keeps its Remove.
    await expect(memberRow(page, "commenter@example.com").getByRole("button", { name: "Remove commenter@example.com" })).toBeVisible();
  });
});

test("qa-shell-29: the change-password form names whose password it is, for a password manager", async ({ page }) => {
  await login(page);
  await page.goto("/account");
  const form = page.getByRole("form", { name: "Change password" });
  await expect(form).toBeVisible();
  const user = form.locator('input[autocomplete="username"]');
  await expect(user).toHaveCount(1);
  await expect(user).toHaveValue("admin@example.com");
  await expect(user).toHaveAttribute("readonly", "");
  await expect(user).toBeHidden();
});
