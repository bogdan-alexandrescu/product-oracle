import { expect, test, type Locator, type Page } from "./test";

import { login } from "./helpers";

/**
 * QA pass 4 on Settings › Members (qa4fix): the owner's role reads once, emails stay on one line,
 * the member panel closes on Escape and leaves the invite form reachable, "holds nothing" reads
 * once, the change-role dialog speaks plainly, nobody named as engineering lead reads in words,
 * dark checkboxes read unchecked, the phone's Active pill lines up, and a viewer sees View only.
 * Mock-backed, driven through the UI as a person would.
 */

const memberRow = (page: Page, email: string) => page.getByTestId("member-row").filter({ hasText: email });
const box = async (l: Locator) => (await l.boundingBox())!;
const centreY = (b: { y: number; height: number }) => b.y + b.height / 2;

async function openMembers(page: Page, email?: string) {
  await login(page, email);
  await page.goto("/settings/members");
}

test.describe("at 1512 px", () => {
  test.use({ viewport: { width: 1512, height: 900 } });

  test("qa4-settings-9: the only owner's role shows once, and why it can't change is a tooltip", async ({ page }) => {
    await openMembers(page);
    const own = memberRow(page, "admin@example.com");
    await expect(own).toBeVisible();
    const roleCell = own.getByRole("cell").nth(1);
    await expect(roleCell.getByText("Owner", { exact: true }).filter({ visible: true })).toHaveCount(1);
    await expect(own.getByTestId("own-role")).toBeHidden();
    await own.getByRole("button", { name: "Role for admin@example.com" }).hover();
    await expect(page.getByRole("tooltip").filter({ hasText: "You are the only owner. Make someone else owner first." })).toBeVisible();
  });

  test("qa4-settings-11: Escape closes the member panel, and Invite someone stays in reach while it is open", async ({ page }) => {
    await openMembers(page);
    const email = page.getByPlaceholder("name@company.com");
    await expect(email).toBeVisible();
    await memberRow(page, "commenter@example.com").getByTestId("member-open").click();
    const panel = page.getByTestId("member-inspector");
    await expect(panel).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(email).toBeVisible();

    // Open again: the People panel offers the way to the invite form.
    await memberRow(page, "commenter@example.com").getByTestId("member-open").click();
    await expect(panel).toBeVisible();
    await page.getByRole("link", { name: "Invite someone" }).click();
    await expect(panel).toHaveCount(0);
    await expect(email).toBeFocused();
  });

  test("qa4-settings-12: a member who holds nothing reads it once", async ({ page }) => {
    await openMembers(page);
    await memberRow(page, "commenter@example.com").getByTestId("member-open").click();
    const panel = page.getByTestId("member-inspector");
    await expect(panel.getByTestId("member-holds-nothing")).toHaveText("Commenter holds nothing: no approvals and no responsibilities.");
    await expect(panel).not.toContainText("Nothing assigned");
    await expect(panel.getByTestId("member-responsibilities")).toHaveCount(0);
  });

  test("qa4-settings-13: the change-role dialog says in plain words what the lower role can't do", async ({ page }) => {
    await openMembers(page);
    await page.getByLabel("Role for approver@example.com").selectOption("commenter");
    const dialog = page.getByTestId("role-dialog");
    const needs = dialog.getByTestId("preview-needs-holder");
    await expect(needs).toContainText("Approver can no longer decide 1 document review.");
    await expect(needs).not.toContainText("needs Approver");
    await expect(needs).not.toContainText("Decides document reviews");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
  });

  test("qa4-settings-14: with no engineering lead, the Roles panel says so in words", async ({ page }) => {
    await openMembers(page);
    const lead = page.getByTestId("roles-lead");
    await expect(lead).toContainText("Nobody named yet. Pick who carries engineering checks.");
    await expect(lead).not.toContainText("People named");
    // Naming one shows the count.
    await page.getByRole("checkbox", { name: "Engineering lead: commenter@example.com" }).check();
    await expect(lead.getByTestId("engineering-lead-count")).toHaveText("1");
    await expect(lead).not.toContainText("Nobody named yet");
  });

  test("qa4-settings-36: a viewer sees the View only chip on Members, as on Company", async ({ page }) => {
    await openMembers(page, "viewer@example.com");
    await expect(page.getByTestId("view-only")).toHaveText("View only");
    await page.goto("/settings/company");
    await expect(page.getByTestId("view-only")).toHaveText("View only");
  });
});

test.describe("at 1440 px", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("qa4-settings-10: member emails stay on one line, the full address on hover", async ({ page }) => {
    await openMembers(page);
    const emails = page.getByTestId("member-email");
    await expect(emails.first()).toBeVisible();
    const oneLine = (el: Locator) =>
      el.evaluate((e) => {
        const range = document.createRange();
        range.selectNodeContents(e);
        const tops = [...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top));
        return tops.every((t) => Math.abs(t - tops[0]) <= 1);
      });
    const check = async () => {
      for (const el of await emails.all()) {
        const text = await el.innerText();
        expect(await oneLine(el), text).toBe(true);
        await expect(el).toHaveAttribute("title", text);
      }
    };
    await check();
    // With a member's panel open the table is narrower: still one line.
    await memberRow(page, "viewer@example.com").getByTestId("member-open").click();
    await expect(page.getByTestId("member-inspector")).toBeVisible();
    await check();
  });
});

test.describe("dark", () => {
  test.use({ viewport: { width: 1512, height: 900 }, colorScheme: "dark" });

  test("qa4-settings-20: an unchecked box is an outline; a checked one is filled", async ({ page }) => {
    await openMembers(page);
    const lead = page.getByRole("checkbox", { name: "Engineering lead: commenter@example.com" });
    await expect(lead).not.toBeChecked();
    const look = () =>
      lead.evaluate((e) => {
        const s = getComputedStyle(e);
        return { appearance: s.appearance, bg: s.backgroundColor, border: parseFloat(s.borderTopWidth) };
      });
    const off = await look();
    expect(off.appearance).toBe("none");
    expect(off.bg).toBe("rgba(0, 0, 0, 0)");
    expect(off.border).toBeGreaterThan(0);
    await lead.check();
    await expect(lead).toBeChecked();
    const on = await look();
    expect(on.bg).not.toBe("rgba(0, 0, 0, 0)");
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("qa4-settings-21: the Active pill lines up with the row, not floating between lines", async ({ page }) => {
    await openMembers(page);
    for (const email of ["commenter@example.com", "approver@example.com"]) {
      const row = memberRow(page, email);
      await expect(row).toBeVisible();
      const chip = await box(row.getByText("Active", { exact: true }));
      const select = await box(row.getByLabel(`Role for ${email}`, { exact: true }));
      const roleCell = await box(row.getByLabel(`Role for ${email}`, { exact: true }).locator("xpath=ancestor::td[1]"));
      const tokens = await box(row.getByTestId("open-tokens"));
      // Either on the role's line, centred with its select, or on a line of its own below it,
      // centred with that line's other cells.
      const withSelect = Math.abs(centreY(chip) - centreY(select)) <= 3;
      const below = chip.y >= roleCell.y + roleCell.height - 1 && Math.abs(centreY(chip) - centreY(tokens)) <= 3;
      expect(withSelect || below, email).toBe(true);
    }
  });
});
