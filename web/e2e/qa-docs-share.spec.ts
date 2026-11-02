import { expect, test, type Page } from "./test";

import { login } from "./helpers";

// QA pass 1, docs lane: a roadmap's Share sheet, its audience preview, the Public version
// page and the link holder's /s/<token> page. The "sharing" scenario seeds a published
// roadmap (Platform roadmap, autumn v1); Usage alerts roadmap v1 is not published (its date
// Dec 15, 2026 lost its schedule basis).

const DOC = "/documents/example-labs-roadmap";

async function sharing(page: Page, email?: string) {
  await page.addInitScript(() =>
    localStorage.setItem("po-mock-scenario", "sharing"),
  );
  await login(page, email);
}

async function openSheet(page: Page) {
  await page.getByRole("button", { name: "Share a link", exact: true }).click();
  return page.getByRole("dialog", { name: "Share roadmap" });
}

/** Creates a Board link with a passcode through the sheet; returns its path and passcode. */
async function createLink(page: Page) {
  const sheet = await openSheet(page);
  await sheet.getByLabel("Audience").selectOption({ label: "Board" });
  await sheet.getByLabel("Label").fill("Board, October meeting");
  await sheet.getByLabel("Passcode (optional)").fill("board-oct-2026");
  await sheet.getByRole("button", { name: "Create link" }).click();
  const url = await sheet.getByLabel("Link", { exact: true }).inputValue();
  await sheet.getByRole("button", { name: "Done" }).click();
  return { path: new URL(url).pathname, code: "board-oct-2026" };
}

async function openShared(page: Page) {
  const { path, code } = await createLink(page);
  await page.goto(path);
  await page.getByLabel("Passcode").fill(code);
  await page.getByRole("button", { name: "Open" }).click();
  await expect(
    page
      .frameLocator('iframe[title="Shared roadmap"]')
      .getByText(/^Shared with you/),
  ).toBeVisible();
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("qa-docs-2: the Share sheet of an unpublished roadmap says what still blocks publishing", async ({
    page,
  }) => {
    await sharing(page);
    await page.goto("/documents/usage-alerts-roadmap");
    const sheet = await openSheet(page);
    await expect(sheet.getByTestId("share-not-published")).toContainText(
      "v1 can't be published yet",
    );
    await expect(sheet.getByTestId("share-blocks")).toContainText(
      "Dec 15, 2026",
    );
    await expect(sheet.getByTestId("share-blocks")).not.toContainText(
      "2026-12-15",
    );
    await expect(
      sheet.getByRole("link", { name: "Plan › Dates" }),
    ).toHaveAttribute("href", "/plan/dates");
  });

  test("qa-docs-20, qa-docs-37: Label is marked required, a disabled Create link says why, no publication numbers", async ({
    page,
  }) => {
    await sharing(page);
    await page.goto(DOC);
    const sheet = await openSheet(page);
    await expect(sheet.getByTestId("share-shares")).toHaveText(
      /^Shares the published v1 \([A-Z][a-z]{2} \d{1,2}\)\.$/,
    );
    await expect(sheet).not.toContainText("publication 1");
    const label = sheet.getByLabel("Label");
    await expect(label).toHaveAttribute("required", "");
    // No placeholder that reads as a filled-in value.
    expect(await label.getAttribute("placeholder")).toBeNull();
    await expect(sheet.getByText("Label (required)")).toBeVisible();
    const create = sheet.getByRole("button", { name: "Create link" });
    // qa4-docs-share-23: the missing label is said once Create link is tried without one.
    await expect(sheet.getByTestId("create-why")).toHaveCount(0);
    await create.click();
    await expect(sheet.getByTestId("create-why")).toHaveText(
      "Add a label first.",
    );
    await expect(create).toHaveAccessibleDescription("Add a label first.");
    await label.fill("Board, October meeting");
    await expect(sheet.getByTestId("create-why")).toHaveCount(0);
    await expect(create).toBeEnabled();
  });

  test("qa-docs-39: the audience preview's banner gives the state in words and a readable date", async ({
    page,
  }) => {
    await sharing(page);
    await page.goto("/documents/usage-alerts-roadmap");
    const banner = page
      .frameLocator('iframe[title="Roadmap for Team"]')
      .locator(".banner");
    await expect(banner).toContainText(
      /(Approved|Imported) [A-Z][a-z]{2} \d{1,2}, \d{4}/,
    );
    await expect(banner).not.toContainText("_");
    await expect(banner).not.toContainText(/\d{4}-\d{2}-\d{2}/);
  });

  test("qa-docs-38, qa-docs-63: the Public version says what the check is, plain counts, Plan in the rail, a back arrow", async ({
    page,
  }) => {
    await sharing(page);
    await page.goto(`${DOC}/public`);
    await expect(page.getByTestId("public-check")).toContainText(
      "Nobody has checked this public page yet",
    );
    const summary = page.getByTestId("public-summary");
    await expect(summary).toContainText(
      "2 items on the public page · 3 left out",
    );
    await expect(summary).not.toContainText("shown");
    await expect(summary).not.toContainText("serve");
    const nav = page.getByRole("navigation", { name: "Oracle" });
    await expect(nav.getByTestId("nav-plan")).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(nav.getByTestId("nav-prds")).not.toHaveAttribute(
      "aria-current",
      "page",
    );
    const back = page.getByRole("link", { name: "Back to the roadmap" });
    await expect(back.locator("svg")).toHaveCount(1);
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`qa-docs-70, qa-docs-71: the shared page names the roadmap, sender and end; one scroll (${scheme})`, async ({
      page,
    }) => {
      await sharing(page);
      await page.goto(DOC);
      await page.emulateMedia({ colorScheme: scheme });
      await openShared(page);
      const header = page.getByTestId("shared-header");
      await expect(header.getByRole("heading", { level: 1 })).toHaveText(
        "Platform roadmap, autumn",
      );
      await expect(page.getByTestId("shared-about")).toHaveText(
        /^Shared by .+ · Link ends [A-Z][a-z]{2} \d{1,2}, \d{4}$/,
      );
      // qa-docs-71: the person who made the link (signed in as Avery Stone), not the company alone.
      await expect(page.getByTestId("shared-about")).toContainText(
        "Shared by Avery Stone at ",
      );
      await expect(page).toHaveTitle(/Platform roadmap, autumn/);
      // The bar matches the frame's page in its scheme (qa-docs-11: dark when the reader prefers dark).
      expect(
        await header.evaluate((el) => getComputedStyle(el).backgroundColor),
      ).toBe(scheme === "light" ? "rgb(255, 255, 255)" : "rgb(15, 23, 42)");
      // The frame is as tall as its page: it never scrolls on its own.
      const frame = page.getByTestId("shared-frame");
      await expect
        .poll(() =>
          frame.evaluate((el: HTMLIFrameElement) => {
            const doc = el.contentDocument;
            return doc
              ? doc.documentElement.scrollHeight <= el.clientHeight + 1
              : null;
          }),
        )
        .toBe(true);
    });
  }

  test("the shared page's frame never runs a script (no allow-scripts beside allow-same-origin)", async ({
    page,
  }) => {
    await sharing(page);
    await page.goto(DOC);
    await openShared(page);
    // allow-same-origin is safe only without allow-scripts: the frame must never run one.
    const sandbox = await page
      .getByTestId("shared-frame")
      .getAttribute("sandbox");
    expect(sandbox).not.toBeNull();
    expect(sandbox!.split(/\s+/)).not.toContain("allow-scripts");
    expect(sandbox!.split(/\s+/)).not.toContain("allow-top-navigation");
    await expect(page).toHaveTitle(/Platform roadmap, autumn · Shared roadmap/);
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("qa-docs-71: the shared page's header wraps on a phone", async ({
    page,
  }) => {
    await sharing(page);
    await page.goto(DOC);
    await openShared(page);
    await expect(
      page.getByTestId("shared-header").getByRole("heading", { level: 1 }),
    ).toHaveText("Platform roadmap, autumn");
    await expect(page.getByTestId("shared-about")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });

  test("the shared page's frame shrinks to its page when the window widens: no blank gap", async ({
    page,
  }) => {
    await sharing(page);
    await page.goto(DOC);
    await openShared(page);
    const frame = page.getByTestId("shared-frame");
    const tall = () => frame.evaluate((el: HTMLElement) => el.clientHeight);
    /** How far the frame runs past the bottom of what its page shows. */
    const gap = () =>
      frame.evaluate((el: HTMLIFrameElement) => {
        const doc = el.contentDocument;
        if (!doc) return null;
        const bottoms = [...doc.body.querySelectorAll("*")].map(
          (e) => e.getBoundingClientRect().bottom,
        );
        return el.clientHeight - Math.max(0, ...bottoms);
      });
    await expect.poll(gap).toBeLessThan(64);
    const onPhone = await tall();
    // The phone turned into a desktop window: the frame follows its page and never keeps a
    // blank gap. The link holder's page is now cards and tables (qa-docs-26) that are as tall
    // on a desktop as on a phone, so it does not shrink; it grows by no more than the page's
    // own 1.5rem margin.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(gap).toBeLessThan(64);
    expect(await tall()).toBeLessThanOrEqual(onPhone + 24);
  });
});
