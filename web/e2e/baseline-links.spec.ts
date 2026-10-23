import { expect, test, type Page } from "@playwright/test";

import { login } from "./helpers";

// #338: link items to goals and to each other, and manage their evidence, from the drawer.

async function openItem(page: Page, key: string, title: string, email?: string) {
  await login(page, email);
  await page.goto("/baseline");
  await expect(page.getByRole("heading", { level: 1, name: "Baseline" })).toBeVisible();
  await page.getByTestId(`feature-${key}`).getByRole("button", { name: title }).click();
  return page.getByRole("dialog", { name: title });
}

test("baseline: link a feature to a goal, change its contribution, unlock it and remove it; the matrix follows", async ({
  page,
}) => {
  const d = await openItem(page, "f.dark-mode", "Dark mode");
  const row = page.getByTestId("feature-f.dark-mode");
  await expect(row.getByTestId("flag")).toHaveText(["Serves no goal"]);

  await d.getByRole("button", { name: "Link to goal" }).click();
  const form = d.getByRole("form", { name: "Link to goal" });
  await form.getByLabel("Goal").selectOption({ label: "Raise activation" });
  await form.getByLabel("Contribution").selectOption("2");
  await form.getByRole("button", { name: "Link" }).click();
  await expect(d.getByRole("status")).toContainText("Linked to “Raise activation”");
  await expect(d.getByRole("list", { name: "Supports" })).toContainText("Raise activation");
  // The feature × goal matrix shows the new link, and the flag goes.
  await expect(row.getByRole("img", { name: "Contribution 2 of 3" })).toBeVisible();
  await expect(row.getByTestId("flag")).toHaveCount(0);

  await d.getByLabel("Contribution to Raise activation").selectOption("3");
  await expect(d.getByRole("status")).toContainText("Contribution set to 3");
  await expect(row.getByRole("img", { name: "Contribution 3 of 3" })).toBeVisible();

  // A person's link is locked against agents; Unlock frees it.
  await d.getByRole("button", { name: "Unlock link to Raise activation" }).click();
  await expect(d.getByRole("status")).toContainText("Unlocked");
  await expect(d.getByRole("button", { name: "Unlock link to Raise activation" })).toHaveCount(0);

  await d.getByRole("button", { name: "Remove link to Raise activation" }).click();
  const ask = d.getByRole("form", { name: "Remove link" });
  await ask.getByRole("button", { name: "Back" }).click();
  await expect(d.getByRole("list", { name: "Supports" })).toContainText("Raise activation");
  await d.getByRole("button", { name: "Remove link to Raise activation" }).click();
  await d.getByRole("form", { name: "Remove link" }).getByRole("button", { name: "Remove" }).click();
  await expect(d.getByRole("status")).toContainText("Removed the link");
  await expect(d.getByRole("list", { name: "Supports" })).toHaveCount(0);
  await expect(row.getByTestId("flag")).toHaveText(["Serves no goal"]);
});

test("baseline: add depends-on, blocks and part-of links, and confirm a proposed link", async ({ page }) => {
  const d = await openItem(page, "f.saved-carts", "Saved carts");
  // An agent proposed that Saved carts depends on Team invites.
  const deps = d.getByRole("list", { name: "Depends on" });
  await expect(deps).toContainText("Team invites");
  await expect(deps).toContainText("Proposed");
  await deps.getByRole("button", { name: "Confirm link to Team invites" }).click();
  await expect(d.getByRole("status")).toContainText("Confirmed the link");
  await expect(deps).not.toContainText("Proposed");

  for (const [relation, entry, list] of [
    ["Depends on", "Sample data", "Depends on"],
    ["Blocks", "Dark mode", "Blocks"],
    ["Part of", "Admin console", "Part of"],
  ] as const) {
    await d.getByRole("button", { name: "Add dependency" }).click();
    const form = d.getByRole("form", { name: "Add dependency" });
    await form.getByLabel("Relation").selectOption({ label: relation });
    await form.getByLabel("Entry").selectOption({ label: entry });
    await form.getByRole("button", { name: "Add", exact: true }).click();
    await expect(d.getByRole("status")).toContainText(`“${entry}”`);
    await expect(d.getByRole("list", { name: list })).toContainText(entry);
  }
  // The same link twice is refused, with the API's reason.
  await d.getByRole("button", { name: "Add dependency" }).click();
  const again = d.getByRole("form", { name: "Add dependency" });
  await again.getByLabel("Relation").selectOption({ label: "Blocks" });
  await again.getByLabel("Entry").selectOption({ label: "Dark mode" });
  await again.getByRole("button", { name: "Add", exact: true }).click();
  await expect(d.getByText("That link already exists")).toBeVisible();
});

test("baseline: cite a source item as evidence, then remove evidence with a reason", async ({ page }) => {
  const d = await openItem(page, "f.dark-mode", "Dark mode");
  await d.getByRole("button", { name: "Cite a source item" }).click();
  const form = d.getByRole("form", { name: "Cite a source item" });
  await form.getByLabel("Search your sources").fill("pricing");
  await form.getByRole("button", { name: "Search" }).click();
  const hits = form.getByRole("list", { name: "Source items" });
  await expect(hits).toContainText("Pricing strategy");
  await hits.getByRole("button", { name: "Cite Pricing strategy" }).click();
  await expect(d.getByRole("status")).toContainText("Cited “Pricing strategy”");
  const evidence = d.getByRole("list", { name: "Evidence" });
  await expect(evidence.getByTestId("evidence-row")).toHaveCount(1);
  await expect(evidence).toContainText("Pricing strategy");

  await evidence.getByRole("button", { name: "Remove Pricing strategy" }).click();
  const ask = d.getByRole("form", { name: "Remove evidence" });
  // A reason is required.
  await ask.getByRole("button", { name: "Remove" }).click();
  await expect(ask.getByText("Say why it is removed.")).toBeVisible();
  await ask.getByLabel("Reason").fill("Cited on the wrong feature.");
  await ask.getByRole("button", { name: "Remove" }).click();
  await expect(d.getByRole("status")).toContainText("Removed “Pricing strategy”");
  await expect(d.getByRole("list", { name: "Evidence" })).toHaveCount(0);
});

test("baseline: a viewer sees the link and evidence controls disabled, with the reason", async ({ page }) => {
  const d = await openItem(page, "f.guided-setup", "Guided setup", "viewer@example.com");
  for (const name of ["Link to goal", "Add dependency", "Cite a source item"]) {
    const b = d.getByRole("button", { name });
    await expect(b).toBeDisabled();
    await expect(b).toHaveAttribute("title", /approvers/i);
  }
  await expect(d.getByRole("button", { name: /^Remove link/ })).toHaveCount(0);
  await expect(d.getByRole("button", { name: /^Remove / })).toHaveCount(0);
  await expect(d.getByLabel(/^Contribution to/)).toHaveCount(0);
});

test("baseline: on a phone the Link to goal form fits", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const d = await openItem(page, "f.dark-mode", "Dark mode");
  await d.getByRole("button", { name: "Link to goal" }).click();
  const form = d.getByRole("form", { name: "Link to goal" });
  await form.getByLabel("Goal").selectOption({ label: "Grow paid conversion" });
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(390);
  await form.getByRole("button", { name: "Link" }).click();
  await expect(d.getByRole("list", { name: "Supports" })).toContainText("Grow paid conversion");
});
