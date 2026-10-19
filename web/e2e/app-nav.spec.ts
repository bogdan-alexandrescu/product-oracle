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
  expect(await bg()).toBe("rgb(14, 13, 26)");

  // Survives a full reload (applied before paint) while the system stays light.
  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "dark");
  expect(await bg()).toBe("rgb(14, 13, 26)");

  // Back to System: follows the system setting again.
  await page.getByTestId("user-menu").click();
  await page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "System" }).click();
  await expect(html).not.toHaveAttribute("data-theme");
  expect(await bg()).toBe("rgb(245, 244, 251)");
  await page.emulateMedia({ colorScheme: "dark" });
  expect(await bg()).toBe("rgb(14, 13, 26)");
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

test("brand (I3 logo): the Compass mark tops the rail and links Home; sign-in shows mark and wordmark; tab icons", async ({
  page,
  request,
}) => {
  await page.goto("/login");
  const brand = page.getByTestId("auth-brand");
  await expect(brand).toHaveText("Product Oracle");
  await expect(brand.locator("svg")).toHaveAttribute("width", "40");
  await expect(page.locator('link[rel="icon"][type="image/svg+xml"]')).toHaveCount(1);
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("sizes", "180x180");
  const icon = await page.locator('link[rel="icon"][type="image/svg+xml"]').getAttribute("href");
  expect((await request.get(icon!)).ok()).toBe(true);

  await login(page);
  const nav = page.getByRole("navigation", { name: "Oracle" });
  const home = nav.getByRole("link", { name: "Product Oracle" });
  await expect(nav.getByRole("link").first()).toHaveAccessibleName("Product Oracle");
  await expect(home.locator("svg")).toHaveAttribute("width", "44");
  // The full cut: ring, four ticks, needle; no tile behind it.
  await expect(home.locator("svg line")).toHaveCount(4);
  await expect(home).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await home.click();
  await expect(page).toHaveURL(/\/home$/);
});
