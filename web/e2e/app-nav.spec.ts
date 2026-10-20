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

test("Requests: a placeholder with a one-line empty state", async ({ page }) => {
  await login(page);
  await page.goto("/requests");
  await expect(page.getByTestId("requests-empty")).toHaveText("Nothing yet");
  await expect(page.getByTestId("requests-empty").locator("svg")).toBeVisible();
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

test("phone header (I3): navy bar, compact mark to Home, the page's title once, the user menu", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/login");
  const bar = page.getByTestId("phone-header");
  await expect(bar.getByTestId("phone-title")).toHaveText("Sign in");
  await expect(bar.getByTestId("phone-user-menu")).toHaveCount(0);

  await login(page);
  await page.goto("/settings/members");
  await expect(bar).toBeVisible();
  const box = (await bar.boundingBox())!;
  expect(box.y).toBe(0);
  expect(box.height).toBe(44);
  await expect(bar).toHaveCSS("background-color", "rgb(11, 58, 122)");
  const title = bar.getByTestId("phone-title");
  await expect(title).toHaveText("Members");
  await expect(title).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(title).toHaveCSS("font-weight", "600");
  // The page's H1 stays for screen readers but is not drawn a second time.
  const h1 = page.getByRole("heading", { level: 1, name: "Members" });
  await expect(h1).toHaveCount(1);
  expect((await h1.boundingBox())!.height).toBeLessThanOrEqual(1);

  // The title follows the open page, a document's name and version included.
  await page.goto("/documents/checkout-redesign/v/2");
  await expect(title).toHaveText("Checkout redesign PRD v2");

  const user = bar.getByTestId("phone-user-menu");
  await user.click();
  await expect(bar.getByRole("dialog", { name: "Account" })).toContainText("admin@example.com");
  await page.keyboard.press("Escape");

  const home = bar.getByRole("link", { name: "Product Oracle" });
  await expect(home.locator("svg")).toHaveAttribute("width", "22");
  await home.click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(title).toHaveText("Home");
  await expect(page.getByTestId("tab-bar")).toBeVisible();

  await page.setViewportSize({ width: 1366, height: 820 });
  await expect(bar).toBeHidden();
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  expect((await page.getByRole("heading", { level: 1, name: "Home" }).boundingBox())!.height).toBeGreaterThan(20);
});

// UI test findings E1 and E2 (2026-10-20).

test("the bare site URL lands on Home, the rail's first destination", async ({ page }) => {
  await login(page);
  await page.goto("/");
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByRole("heading", { level: 1, name: "Home", exact: true })).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Oracle" });
  await expect(nav.getByTestId("nav-home")).toHaveAttribute("aria-current", "page");
  await expect(nav.getByTestId("nav-prds")).not.toHaveAttribute("aria-current", "page");
});

test("a roadmap document's pages highlight Roadmap; a PRD's highlight PRDs", async ({ page }) => {
  await login(page);
  const nav = page.getByRole("navigation", { name: "Oracle" });
  const roadmap = nav.getByTestId("nav-roadmap");
  const prds = nav.getByTestId("nav-prds");

  // Opened from the Roadmap screen, and loaded directly: the overview and a version.
  await roadmap.click();
  await page.getByTestId("roadmap-row").getByRole("link", { name: "Usage alerts roadmap" }).click();
  await expect(page).toHaveURL(/\/documents\/usage-alerts-roadmap$/);
  await expect(roadmap).toHaveAttribute("aria-current", "page");
  await expect(prds).not.toHaveAttribute("aria-current", "page");
  for (const path of ["/documents/usage-alerts-roadmap", "/documents/usage-alerts-roadmap/v/1"]) {
    await page.goto(path);
    await expect(page.getByRole("navigation", { name: "Breadcrumb" }).filter({ visible: true }).first()).toContainText("Roadmap");
    await expect(roadmap).toHaveAttribute("aria-current", "page");
    await expect(prds).not.toHaveAttribute("aria-current", "page");
  }

  // From the roadmap to a PRD inside the app: the highlight follows the document.
  await page.evaluate(() =>
    (window as unknown as { next: { router: { push: (href: string) => void } } }).next.router.push("/documents/saved-carts/v/2"),
  );
  await expect(page).toHaveURL(/\/documents\/saved-carts\/v\/2$/);
  await expect(prds).toHaveAttribute("aria-current", "page");
  await expect(roadmap).not.toHaveAttribute("aria-current", "page");

  // The phone's tab bar says the same.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/documents/usage-alerts-roadmap/v/1");
  const tabs = page.getByTestId("tab-bar");
  await expect(tabs.getByTestId("tab-roadmap")).toHaveAttribute("aria-current", "page");
  await expect(tabs.getByTestId("tab-prds")).not.toHaveAttribute("aria-current", "page");
});
