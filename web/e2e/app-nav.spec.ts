import { expect, test } from "@playwright/test";

import { login } from "./helpers";

test("app nav: hidden when signed out, lists every area once signed in", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Oracle" })).toHaveCount(0);

  await login(page);
  const nav = page.getByRole("navigation", { name: "Oracle" });
  await expect(nav).toBeVisible();
  for (const [id, label] of [
    ["nav-baseline", "Baseline"],
    ["nav-runs", "Runs"],
    ["nav-prds", "PRDs"],
    ["nav-priorities", "Priorities"],
    ["nav-roadmap", "Roadmap"],
    ["nav-inbox", "Inbox"],
    ["nav-members", "Members"],
    ["nav-connections", "Connections"],
    ["nav-sources", "Sources"],
    ["nav-templates", "Templates"],
    ["nav-themes", "Themes"],
  ]) {
    await expect(nav.getByTestId(id)).toContainText(label);
  }
  await expect(nav.getByText("Settings")).toBeVisible();

  // On /documents the PRDs entry is the active one.
  await expect(nav.getByTestId("nav-prds")).toHaveAttribute("aria-current", "page");

  // Roadmap is a v1.1 placeholder: not a link, marked disabled.
  const roadmap = nav.getByTestId("nav-roadmap");
  await expect(roadmap).toHaveAttribute("aria-disabled", "true");
  await expect(roadmap).toContainText("v1.1");
  await expect(roadmap).not.toHaveAttribute("href");
  await expect(nav.getByRole("link", { name: /Roadmap/ })).toHaveCount(0);
});

test("app nav: each entry routes to its page", async ({ page }) => {
  await login(page);
  const nav = page.getByRole("navigation", { name: "Oracle" });

  for (const [id, path, heading] of [
    ["nav-baseline", "/baseline", "Baseline"],
    ["nav-runs", "/runs", "Runs"],
    ["nav-priorities", "/priorities", "Priorities"],
    ["nav-inbox", "/inbox", "Inbox"],
    ["nav-members", "/settings/members", "Members"],
    ["nav-connections", "/settings/connections", "Connections"],
    ["nav-sources", "/settings/sources", "Sources"],
    ["nav-templates", "/settings/templates", "Templates"],
    ["nav-themes", "/settings/themes", "Themes"],
    ["nav-prds", "/documents", "Documents"],
  ]) {
    await nav.getByTestId(id).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
    await expect(nav.getByTestId(id)).toHaveAttribute("aria-current", "page");
  }

  // A document page keeps PRDs highlighted.
  await page.getByRole("link", { name: "Checkout redesign PRD" }).click();
  await expect(page).toHaveURL(/\/documents\/checkout-redesign/);
  await expect(nav.getByTestId("nav-prds")).toHaveAttribute("aria-current", "page");
});

test("/settings redirects to members", async ({ page }) => {
  await login(page);
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/settings\/members$/);
  await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeVisible();
});
