import { expect, test } from "@playwright/test";

import { login } from "./helpers";

const DESTINATIONS = [
  ["nav-home", "Home", "/home"],
  ["nav-requests", "Requests", "/requests"],
  ["nav-baseline", "Baseline", "/baseline"],
  ["nav-prds", "PRDs", "/documents"],
  ["nav-priorities", "Priorities", "/priorities"],
  ["nav-roadmap", "Roadmap", "/roadmap"],
  ["nav-runs", "Runs", "/runs"],
  ["nav-inbox", "Inbox", "/inbox"],
  ["nav-settings", "Settings", "/settings/members"],
] as const;

test("app shell: hidden when signed out, the rail lists the nine destinations once signed in", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Oracle" })).toHaveCount(0);

  await login(page);
  const nav = page.getByRole("navigation", { name: "Oracle" });
  await expect(nav).toBeVisible();
  for (const [id, label] of DESTINATIONS) {
    await expect(nav.getByTestId(id)).toContainText(label);
  }

  // On /documents the PRDs entry is the active one.
  await expect(nav.getByTestId("nav-prds")).toHaveAttribute("aria-current", "page");
  // Inbox carries its count as a badge.
  await expect(nav.getByTestId("nav-inbox-badge")).toHaveText(/^\d+$/);
  // Roadmap (O4b) is a link to its own screen.
  await expect(nav.getByRole("link", { name: "Roadmap" })).toHaveAttribute("href", "/roadmap");
});

test("Home and Requests: placeholders with a one-line empty state", async ({ page }) => {
  await login(page);
  for (const name of ["home", "requests"]) {
    await page.goto(`/${name}`);
    await expect(page.getByTestId(`${name}-empty`)).toHaveText("Nothing yet");
    await expect(page.getByTestId(`${name}-empty`).locator("svg")).toBeVisible();
  }
});

test("app shell: each destination routes to its page", async ({ page }) => {
  await login(page);
  const nav = page.getByRole("navigation", { name: "Oracle" });

  for (const [id, heading, path] of [
    ["nav-home", "Home", "/home"],
    ["nav-requests", "Requests", "/requests"],
    ["nav-baseline", "Baseline", "/baseline"],
    ["nav-runs", "Runs", "/runs"],
    ["nav-priorities", "Priorities", "/priorities"],
    ["nav-roadmap", "Roadmap", "/roadmap"],
    ["nav-inbox", "Inbox", "/inbox"],
    ["nav-settings", "Members", "/settings/members"],
    ["nav-prds", "PRDs", "/documents"],
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

test("settings: its own strip routes to each section, Settings stays active", async ({ page }) => {
  await login(page);
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
  const strip = page.getByRole("navigation", { name: "Settings" });
  for (const [id, path, heading] of [
    ["nav-members", "/settings/members", "Members"],
    ["nav-connections", "/settings/connections", "Connections"],
    ["nav-claude-accounts", "/settings/claude-accounts", "Claude accounts"],
    ["nav-sources", "/settings/sources", "Sources"],
    ["nav-templates", "/settings/templates", "Templates"],
    ["nav-themes", "/settings/themes", "Themes"],
  ]) {
    await strip.getByTestId(id).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
    await expect(strip.getByTestId(id)).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings")).toHaveAttribute(
      "aria-current",
      "page",
    );
  }
});

for (const scheme of ["light", "dark"] as const) {
  test(`rail (${scheme}): SwarmCloud's colours, the same in both themes`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await login(page);
    const nav = page.getByTestId("app-nav");
    await expect(nav).toHaveCSS("background-image", "linear-gradient(rgb(11, 58, 122), rgb(6, 16, 30))");
    const prds = nav.getByTestId("nav-prds");
    await expect(prds).toHaveCSS("background-color", "rgb(34, 86, 147)");
    await expect(prds).toHaveCSS("color", "rgb(255, 255, 255)");
    // The selected item's sky bar, 6 px left of it.
    const bar = await prds.evaluate((el) => {
      const s = getComputedStyle(el, "::before");
      return [s.backgroundColor, s.width, s.left];
    });
    expect(bar).toEqual(["rgb(124, 200, 248)", "3px", "-9px"]);
    await expect(nav.getByTestId("nav-home")).toHaveCSS("color", "rgb(188, 214, 238)");
    const badge = nav.getByTestId("nav-inbox-badge");
    await expect(badge).toHaveCSS("background-color", "rgb(245, 196, 81)");
    await expect(badge).toHaveCSS("color", "rgb(6, 16, 30)");
  });
}

test("/settings redirects to members", async ({ page }) => {
  await login(page);
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/settings\/members$/);
  await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeVisible();
});

test("user menu: the theme switch overrides the system setting and is remembered", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await login(page);
  const html = page.locator("html");
  await expect(html).not.toHaveAttribute("data-theme");

  await page.getByTestId("user-menu").click();
  const theme = page.getByRole("radiogroup", { name: "Theme" });
  await expect(theme.getByRole("radio", { name: "System" })).toHaveAttribute("aria-checked", "true");
  await theme.getByRole("radio", { name: "Dark" }).click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(await bg()).toBe("rgb(6, 16, 30)");

  // Survives a full reload (applied before paint) while the system stays light.
  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "dark");
  expect(await bg()).toBe("rgb(6, 16, 30)");

  // Back to System: follows the system setting again.
  await page.getByTestId("user-menu").click();
  await page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "System" }).click();
  await expect(html).not.toHaveAttribute("data-theme");
  expect(await bg()).toBe("rgb(243, 246, 249)");
  await page.emulateMedia({ colorScheme: "dark" });
  expect(await bg()).toBe("rgb(6, 16, 30)");
});

test("phone: a tab bar with Home, PRDs, Roadmap, Inbox and More, no sideways scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const tabs = page.getByRole("navigation", { name: "Oracle" });
  await expect(tabs).toHaveAttribute("data-testid", "tab-bar");
  for (const label of ["Home", "PRDs", "Roadmap", "Inbox", "More"]) {
    await expect(tabs.getByText(label, { exact: true })).toBeVisible();
  }
  await tabs.getByTestId("tab-more").click();
  const more = page.getByRole("dialog", { name: "More" });
  await more.getByRole("link", { name: "Baseline" }).click();
  await expect(page).toHaveURL(/\/baseline$/);
  await expect(more).toHaveCount(0);
  const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(sw).toBeLessThanOrEqual(cw);
});
