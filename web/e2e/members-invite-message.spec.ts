import { expect, test, type Page } from "@playwright/test";

import { login } from "./helpers";

/** #203 (A5) AC10: an owner adds a personal message to an invite; the open invite shows it. */

const inviteRow = (page: Page, email: string) => page.getByTestId("invite-row").filter({ hasText: email });

test("invite message: an owner writes a note, sends, and sees it on the open invite", async ({ page }) => {
  await login(page);
  await page.goto("/settings/members");
  const form = page.getByRole("form", { name: "Invite" });
  await form.getByLabel("Email").fill("pat@example.com");
  await form.getByLabel("Role", { exact: true }).selectOption("approver");
  const message = form.getByLabel("Message (optional)");
  await message.fill("Excited to have you review the roadmap with us.\nSee you Monday.");
  // The counter shows only near the limit.
  await expect(form.getByTestId("invite-message-count")).toHaveCount(0);
  await form.getByRole("button", { name: "Send invite" }).click();

  await expect(page.getByTestId("invite-outcome")).toHaveText("Invite sent to pat@example.com");
  const note = inviteRow(page, "pat@example.com").getByTestId("invite-note");
  await expect(note).toContainText("Note: Excited to have you review the roadmap with us.");
  await expect(note).toHaveAttribute("title", "Excited to have you review the roadmap with us.\nSee you Monday.");
  // The form is ready for the next invite.
  await expect(message).toHaveValue("");
  await page.reload();
  await expect(inviteRow(page, "pat@example.com").getByTestId("invite-note")).toContainText("Note: Excited");
});

test("invite message: near the limit a counter shows, and it stops at 500 characters", async ({ page }) => {
  await login(page);
  await page.goto("/settings/members");
  const form = page.getByRole("form", { name: "Invite" });
  const message = form.getByLabel("Message (optional)");
  await message.fill("x".repeat(460));
  await expect(form.getByTestId("invite-message-count")).toHaveText("460/500");
  await message.fill("y".repeat(520));
  await expect(message).toHaveValue("y".repeat(500));
  await expect(form.getByTestId("invite-message-count")).toHaveText("500/500");
});

test("invite message: an invite with no message shows no note", async ({ page }) => {
  await login(page);
  await page.goto("/settings/members");
  const form = page.getByRole("form", { name: "Invite" });
  await form.getByLabel("Email").fill("sam@example.com");
  await form.getByRole("button", { name: "Send invite" }).click();
  await expect(page.getByTestId("invite-outcome")).toHaveText("Invite sent to sam@example.com");
  await expect(inviteRow(page, "sam@example.com").getByTestId("invite-note")).toHaveCount(0);
});

test("invite message: the Message field is not shown to a non-owner", async ({ page }) => {
  await login(page, "approver@example.com");
  await page.goto("/settings/members");
  await expect(page.getByTestId("not-for-role")).toContainText("Not available for your role");
  await expect(page.getByLabel("Message (optional)")).toHaveCount(0);
  await expect(page.getByRole("form", { name: "Invite" })).toHaveCount(0);
});
