import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY, MOCK_SIMPLE_MODE_KEY } from "../lib/api/mock/server";
import { ADMIN, signOut } from "./helpers";

/*
 * #723 S1: the [Simple | Studio] switch, Simple's shell and routes, and the remembered mode.
 * protects=the mode a person lands in, keeps and switches to; fails_when=the switch shows
 * with Simple off, a role lands in the wrong mode, the choice is forgotten, a page switches
 * to an unrelated one, or Simple's rail shows Studio's destinations; no_claim=the final look
 * (the owner's mockup picks restyle it through the data-mode tokens).
 */

const EMAILS = {
  owner: ADMIN.email,
  approver: "approver@example.com",
  commenter: "commenter@example.com",
  viewer: "viewer@example.com",
} as const;

/** Signs in from the bare sign-in page (no `next`): Oracle picks where to land. */
async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

const simpleRail = (page: Page) => page.getByRole("navigation", { name: "Simple" });
const studioRail = (page: Page) => page.getByRole("navigation", { name: "Oracle" });
const modeSwitch = (page: Page) => page.getByRole("radiogroup", { name: "Mode" }).filter({ visible: true });

async function expectSimple(page: Page, path: string) {
  await expect(page).toHaveURL(new RegExp(`localhost:\\d+${path.replace(/\//g, "\\/")}$`));
  await expect(page.locator('[data-mode="simple"]')).toHaveCount(1);
  await expect(simpleRail(page)).toBeVisible();
  await expect(studioRail(page)).toHaveCount(0);
}

async function expectStudio(page: Page, path: string) {
  await expect(page).toHaveURL(new RegExp(`localhost:\\d+${path.replace(/\//g, "\\/")}$`));
  await expect(page.locator('[data-mode="simple"]')).toHaveCount(0);
  await expect(studioRail(page)).toBeVisible();
}

async function switchTo(page: Page, mode: "Simple" | "Studio") {
  await modeSwitch(page).getByRole("radio", { name: mode }).click();
}

test("the switch is hidden while Simple is off, and everyone stays in Studio", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "off"), MOCK_SIMPLE_MODE_KEY);
  await signIn(page, EMAILS.viewer);
  // A viewer would land in Simple; with Simple off they land on Studio's Home.
  await expectStudio(page, "/home");
  await expect(page.getByRole("heading", { level: 1, name: "Home", exact: true })).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "Mode" })).toHaveCount(0);
  // A Simple link opens Studio's matching page instead.
  await page.goto("/simple/decisions");
  await expectStudio(page, "/company/decisions");
});

test("while Simple is off, a Simple link never shows Simple's page before it opens Studio's", async ({ page }) => {
  await page.addInitScript((key) => {
    localStorage.setItem(key, "off");
    // Records whether Simple's page or rail was ever drawn, however briefly.
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="simple-page"], [data-testid="simple-nav"]')) localStorage.setItem("e2e-saw-simple", "yes");
    }).observe(document, { childList: true, subtree: true });
  }, MOCK_SIMPLE_MODE_KEY);
  await signIn(page, EMAILS.owner);
  await expectStudio(page, "/home");
  await page.goto("/simple/decisions");
  await expectStudio(page, "/company/decisions");
  expect(await page.evaluate(() => localStorage.getItem("e2e-saw-simple"))).toBeNull();
});

for (const [role, landing] of [
  ["viewer", "/simple"],
  ["owner", "/home"],
] as const) {
  test(`signed out, the bare site URL signs a${role === "owner" ? "n" : ""} ${role} in to their role's home`, async ({ page }) => {
    await page.goto("/");
    // Plain sign-in, no `next`: the landing rule decides where they go.
    await expect(page).toHaveURL(/localhost:\d+\/login$/);
    await page.getByLabel("Email").fill(EMAILS[role]);
    await page.getByLabel("Password").fill(ADMIN.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    if (landing === "/simple") await expectSimple(page, landing);
    else await expectStudio(page, landing);
  });
}

test("signed out, a deep link signs in and returns to it, in either mode", async ({ page }) => {
  await page.goto("/simple/one-pagers/checkout-redesign");
  await expect(page).toHaveURL(/\/login\?next=/);
  await page.getByLabel("Email").fill(EMAILS.owner);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expectSimple(page, "/simple/one-pagers/checkout-redesign");

  await signOut(page);
  await page.goto("/plan");
  await expect(page).toHaveURL(/\/login\?next=/);
  await page.getByLabel("Email").fill(EMAILS.viewer);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expectStudio(page, "/plan");
});

test("a one-pager link to a document that is not a PRD says so and links it in Studio", async ({ page }) => {
  await signIn(page, EMAILS.owner);
  await page.goto("/simple/one-pagers/usage-alerts-roadmap");
  await expectSimple(page, "/simple/one-pagers/usage-alerts-roadmap");
  const missing = page.getByTestId("one-pager-not-found");
  await expect(missing).toContainText("No one-pager here");
  await expect(page.getByTestId("one-pager-placeholder")).toHaveCount(0);
  await missing.getByRole("link", { name: "Open it in Studio" }).click();
  await expectStudio(page, "/documents/usage-alerts-roadmap");
});

test("the switch shows at the top of the rail while Simple is on", async ({ page }) => {
  await signIn(page, EMAILS.owner);
  await expectStudio(page, "/home");
  const rail = studioRail(page);
  const sw = rail.getByRole("radiogroup", { name: "Mode" });
  await expect(sw).toBeVisible();
  await expect(sw.getByRole("radio", { name: "Studio" })).toHaveAttribute("aria-checked", "true");
  await expect(sw.getByRole("radio", { name: "Simple" })).toHaveAttribute("aria-checked", "false");
  // At the top: above the first destination.
  const swBox = (await sw.boundingBox())!;
  const homeBox = (await rail.getByTestId("nav-home").boundingBox())!;
  expect(swBox.y).toBeLessThan(homeBox.y);

  await switchTo(page, "Simple");
  await expectSimple(page, "/simple");
  const simpleSw = simpleRail(page).getByRole("radiogroup", { name: "Mode" });
  await expect(simpleSw.getByRole("radio", { name: "Simple" })).toHaveAttribute("aria-checked", "true");
});

for (const [role, landing] of [
  ["viewer", "simple"],
  ["commenter", "simple"],
  ["approver", "studio"],
  ["owner", "studio"],
] as const) {
  test(`with no saved mode, a${role === "owner" || role === "approver" ? "n" : ""} ${role} lands in ${landing === "simple" ? "Simple" : "Studio"}`, async ({ page }) => {
    await signIn(page, EMAILS[role]);
    if (landing === "simple") {
      await expectSimple(page, "/simple");
      await expect(page.getByRole("heading", { level: 1, name: "Home", exact: true })).toBeVisible();
    } else {
      await expectStudio(page, "/home");
    }
    // The bare site URL lands in the same place.
    await page.goto("/");
    if (landing === "simple") await expectSimple(page, "/simple");
    else await expectStudio(page, "/home");
  });
}

test("the chosen mode is remembered across a reload and the next sign-in", async ({ page }) => {
  await signIn(page, EMAILS.owner);
  await expectStudio(page, "/home");
  await switchTo(page, "Simple");
  await expectSimple(page, "/simple");

  await page.reload();
  await expectSimple(page, "/simple");
  await page.goto("/");
  await expectSimple(page, "/simple");

  await signOut(page);
  await signIn(page, EMAILS.owner);
  await expectSimple(page, "/simple");

  // A viewer's own choice of Studio beats their role's default.
  await signOut(page);
  await signIn(page, EMAILS.viewer);
  await expectSimple(page, "/simple");
  await switchTo(page, "Studio");
  await expectStudio(page, "/home");
  await signOut(page);
  await signIn(page, EMAILS.viewer);
  await expectStudio(page, "/home");
  await page.goto("/");
  await expectStudio(page, "/home");
});

const PAIRS: [studio: string, simple: string][] = [
  ["/home", "/simple"],
  ["/documents/checkout-redesign", "/simple/one-pagers/checkout-redesign"],
  ["/plan", "/simple/roadmap"],
  ["/priorities", "/simple/priorities"],
  ["/company/rituals", "/simple/meetings"],
  ["/company/decisions", "/simple/decisions"],
];

test("the switch lands on the matching page, Studio to Simple", async ({ page }) => {
  await signIn(page, EMAILS.owner);
  for (const [studio, simple] of PAIRS) {
    await page.goto(studio);
    await expectStudio(page, studio);
    await switchTo(page, "Simple");
    await expectSimple(page, simple);
  }
  // Anything else: Simple's Home.
  await page.goto("/runs");
  await expectStudio(page, "/runs");
  await switchTo(page, "Simple");
  await expectSimple(page, "/simple");
});

test("the switch lands on the matching page, Simple to Studio", async ({ page }) => {
  await signIn(page, EMAILS.owner);
  for (const [studio, simple] of PAIRS) {
    await page.goto(simple);
    await expectSimple(page, simple);
    await switchTo(page, "Studio");
    await expectStudio(page, studio);
  }
  // Anything else: Studio's Home.
  await page.goto("/simple/one-pagers");
  await expectSimple(page, "/simple/one-pagers");
  await switchTo(page, "Studio");
  await expectStudio(page, "/home");
});

test("a /simple link opens in Simple for an owner whose saved mode is Studio", async ({ page }) => {
  await signIn(page, EMAILS.owner);
  // Saved as Studio through the switch.
  await switchTo(page, "Simple");
  await expectSimple(page, "/simple");
  await switchTo(page, "Studio");
  await expectStudio(page, "/home");

  await page.goto("/simple/one-pagers");
  await expectSimple(page, "/simple/one-pagers");
  await expect(page.getByRole("heading", { level: 1, name: "One-pagers" })).toBeVisible();
  await page.getByRole("link", { name: "Checkout redesign PRD" }).click();
  await expectSimple(page, "/simple/one-pagers/checkout-redesign");
  await expect(page.getByTestId("one-pager-placeholder")).toContainText("S5");
  await page.getByRole("link", { name: "Open the PRD in Studio" }).click();
  await expectStudio(page, "/documents/checkout-redesign");

  // The saved mode is still Studio: the next landing is Studio's Home.
  await page.goto("/");
  await expectStudio(page, "/home");
});

test("Simple's rail has its six destinations and none of Studio's", async ({ page }) => {
  await signIn(page, EMAILS.viewer);
  await expectSimple(page, "/simple");
  const rail = simpleRail(page);
  const links = rail.getByRole("link", { name: /^(Home|One-pagers|Roadmap|Priorities|Meetings|Decisions)$/ });
  await expect(links).toHaveText(["Home", "One-pagers", "Roadmap", "Priorities", "Meetings", "Decisions"]);
  for (const studio of ["Requests", "Baseline", "PRDs", "Plan", "Runs", "Inbox", "Company", "Settings"]) {
    await expect(rail.getByRole("link", { name: studio, exact: true })).toHaveCount(0);
  }
  // The Ask panel stays.
  await expect(page.getByTestId("hop-strip")).toBeVisible();

  for (const [name, path, heading] of [
    ["One-pagers", "/simple/one-pagers", "One-pagers"],
    ["Roadmap", "/simple/roadmap", "Roadmap"],
    ["Priorities", "/simple/priorities", "Priorities"],
    ["Meetings", "/simple/meetings", "Meetings"],
    ["Decisions", "/simple/decisions", "Decisions"],
    ["Home", "/simple", "Home"],
  ]) {
    await rail.getByRole("link", { name, exact: true }).click();
    await expectSimple(page, path);
    await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
    await expect(rail.getByRole("link", { name, exact: true })).toHaveAttribute("aria-current", "page");
  }
});

test("each placeholder names what arrives and links its Studio page", async ({ page }) => {
  await signIn(page, EMAILS.owner);
  for (const [path, studio] of [
    ["/simple/roadmap", "/plan"],
    ["/simple/priorities", "/priorities"],
    ["/simple/meetings", "/company/rituals"],
    ["/simple/decisions", "/company/decisions"],
  ]) {
    await page.goto(path);
    await expectSimple(page, path);
    const placeholder = page.getByTestId("simple-placeholder");
    await expect(placeholder).toContainText("Arrives");
    await placeholder.getByRole("link", { name: /in Studio/ }).click();
    await expectStudio(page, studio);
  }
});

test("Simple's Home: what waits on me, the next meeting and the plan's Now", async ({ page }) => {
  await signIn(page, EMAILS.owner);
  await page.goto("/simple");
  await expectSimple(page, "/simple");
  await expect(page.getByRole("heading", { level: 2, name: "Waiting for you" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Next meeting" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Now", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "This quarter" })).toHaveCount(0);
  await expect(page.getByTestId("simple-quarter").getByTestId("simple-quarter-item").first()).toBeVisible();
});

test("Simple's Home: each part says when it has nothing", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "empty"), MOCK_SCENARIO_KEY);
  await signIn(page, EMAILS.owner);
  // A new company still has its built-in rituals scheduled: the owner pauses them.
  await page.goto("/company/rituals");
  for (const title of ["Weekly goals check-in", "Monthly roadmap refresh", "Quarterly goals review"]) {
    const row = page.getByTestId("ritual-row").filter({ hasText: title });
    await row.click();
    await page.getByTestId("ritual-inspector").filter({ visible: true }).getByRole("button", { name: "Pause" }).click();
    await expect(row).toContainText("Paused");
  }
  await page.goto("/simple");
  await expectSimple(page, "/simple");
  await expect(page.getByTestId("simple-waiting-empty")).toContainText("Nothing waits on you");
  await expect(page.getByTestId("simple-meeting-empty")).toContainText("No meeting scheduled");
  await expect(page.getByTestId("simple-quarter-empty")).toContainText("Nothing in the plan's Now yet");
});

test("phone: Simple's rail is a tab bar and a More drawer, every page fits 390 px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, EMAILS.viewer);
  // On a phone Simple's rail is its tab bar: the desktop rail is hidden.
  await expectSimple(page, "/simple");
  const bar = page.getByTestId("simple-tab-bar");
  await expect(bar).toBeVisible();
  await expect(page.getByTestId("simple-nav")).toBeHidden();

  const fits = async () => {
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(390);
  };
  await fits();
  for (const [name, path] of [
    ["One-pagers", "/simple/one-pagers"],
    ["Roadmap", "/simple/roadmap"],
    ["Decisions", "/simple/decisions"],
  ]) {
    await bar.getByRole("link", { name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByTestId("phone-title")).toHaveText(name);
    await fits();
  }
  for (const [name, path] of [
    ["Priorities", "/simple/priorities"],
    ["Meetings", "/simple/meetings"],
  ]) {
    await bar.getByRole("button", { name: "More" }).click();
    const sheet = page.getByRole("dialog", { name: "More" });
    await sheet.getByRole("link", { name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await fits();
  }
  await page.goto("/simple/one-pagers/checkout-redesign");
  await expect(page.getByTestId("one-pager-placeholder")).toBeVisible();
  await fits();

  // The switch lives in the More drawer on a phone, and works there.
  await bar.getByRole("button", { name: "More" }).click();
  await page.getByRole("dialog", { name: "More" }).getByRole("radio", { name: "Studio" }).click();
  await expect(page).toHaveURL(/\/documents\/checkout-redesign$/);
  await expect(page.getByTestId("tab-bar")).toBeVisible();
  await page.getByTestId("tab-more").click();
  await page.getByRole("dialog", { name: "More" }).getByRole("radio", { name: "Simple" }).click();
  await expect(page).toHaveURL(/\/simple\/one-pagers\/checkout-redesign$/);
});
