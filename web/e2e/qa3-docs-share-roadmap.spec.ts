import { expect, test, type Page } from "./test";

import { login } from "./helpers";

// QA pass 3, docs lane: a roadmap document's header and Share sheet, and its Public version
// page (/documents/<doc>/public). The "sharing" scenario seeds a published roadmap (Platform
// roadmap, autumn v1); Usage alerts roadmap v1 is not published (a date lost its schedule
// basis), and Saved carts PRD is a PRD.

const PUBLISHED = "/documents/example-labs-roadmap";
const UNPUBLISHED = "/documents/usage-alerts-roadmap";

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

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  for (const scheme of ["light", "dark"] as const) {
    test(`qa-docs-16: an unpublished roadmap's Share sheet says why and gives the way to fix it, then Close (${scheme})`, async ({
      page,
    }) => {
      await sharing(page);
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(UNPUBLISHED);
      const sheet = await openSheet(page);
      await expect(sheet.getByTestId("share-not-published")).toContainText(
        "v1 can't be published yet",
      );
      const fix = sheet.getByRole("link", { name: "Go to Plan › Dates" });
      await expect(fix).toHaveAttribute("href", "/plan/dates");
      await expect(fix).toHaveAttribute("data-variant", "primary");
      await expect(
        sheet.getByRole("link", { name: "See v1's items" }),
      ).toHaveAttribute("href", "/documents/usage-alerts-roadmap/v/1/items");
      // Nothing to create, so nothing to cancel: the footer closes (the X is the other Close).
      await expect(sheet.getByRole("button", { name: "Cancel" })).toHaveCount(0);
      await expect(
        sheet.getByRole("button", { name: "Close", exact: true }),
      ).toHaveCount(2);
      // The fix button is readable on the warning box in either theme.
      const [fg, bg] = await fix.evaluate((el) => {
        const s = getComputedStyle(el);
        return [s.color, s.backgroundColor];
      });
      expect(fg).not.toBe(bg);
      await sheet.getByRole("button", { name: "Close", exact: true }).last().click();
      await expect(sheet).toHaveCount(0);
    });
  }

  test("qa-docs-68: a roadmap's header has no Open latest, plainly named sharing actions with a hint, one template pill", async ({
    page,
  }) => {
    await sharing(page);
    await page.goto(UNPUBLISHED);
    await expect(
      page.getByRole("button", { name: "Share a link", exact: true }),
    ).toBeVisible();
    // The page already shows v1 (the audience view): no Open latest in the header.
    await expect(page.getByRole("link", { name: /^Open latest/ })).toHaveCount(
      0,
    );
    // The latest still opens from its inspector.
    await expect(
      page.getByTestId("version-inspector").getByRole("link", { name: "Open v1" }),
    ).toHaveAttribute("href", "/documents/usage-alerts-roadmap/v/1/items");
    const check = page.getByRole("link", { name: "Check public text" });
    await expect(check).toHaveAttribute(
      "href",
      "/documents/usage-alerts-roadmap/public",
    );
    await expect(check).toHaveAttribute("title", /.+/);
    await expect(page.getByRole("link", { name: "Public version" })).toHaveCount(
      0,
    );
    const hint = page.getByTestId("sharing-hint");
    await expect(hint).toContainText("Share a link sends");
    await expect(hint).toContainText("Check public text is where");
    // Template and theme share one pill on a roadmap.
    await expect(page.getByTestId("doc-theme")).toHaveCount(0);
    await expect(page.getByTestId("doc-template")).toContainText("Theme:");
  });

  test("qa-docs-69: the Share sheet's labels match and the reason sits under its field, as a sentence", async ({
    page,
  }) => {
    await sharing(page);
    await page.goto(PUBLISHED);
    const sheet = await openSheet(page);
    for (const name of ["Label", "Passcode"]) {
      const suffix = sheet
        .locator("label")
        .filter({ hasText: new RegExp(`^${name} \\(`) })
        .locator("span");
      await expect(suffix).toHaveClass(/font-normal/);
    }
    await expect(sheet.getByText("Label (required)")).toBeVisible();
    await expect(sheet.getByLabel("Passcode (optional)")).toBeVisible();
    await expect(
      sheet.getByText("A downloaded PDF can't be revoked.", { exact: true }),
    ).toBeVisible();
    const why = sheet.getByTestId("create-why");
    await expect(why).toHaveText("Add a label first.");
    const create = sheet.getByRole("button", { name: "Create link" });
    await expect(create).toHaveAccessibleDescription("Add a label first.");
    // Under the Label field, above Expires: not squeezed in the footer beside Cancel.
    const whyBox = (await why.boundingBox())!;
    const labelBox = (await sheet.getByLabel("Label (required)").boundingBox())!;
    const expiresBox = (await sheet.getByLabel("Expires").boundingBox())!;
    const cancelBox = (await sheet.getByRole("button", { name: "Cancel" }).boundingBox())!;
    expect(whyBox.y).toBeGreaterThan(labelBox.y);
    expect(whyBox.y).toBeLessThan(expiresBox.y);
    expect(whyBox.y + whyBox.height).toBeLessThan(cancelBox.y);
    await sheet.getByLabel("Label (required)").fill("Board, October meeting");
    await expect(why).toHaveCount(0);
    await expect(create).toBeEnabled();
  });

  test("qa-docs-3: a PRD has no public version: plain words, back to the PRD, PRDs in the rail", async ({
    page,
  }) => {
    await sharing(page);
    // Nothing on a PRD's page links to a public version.
    await page.goto("/documents/saved-carts");
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "Saved carts PRD",
    );
    await expect(page.getByRole("link", { name: "Check public text" })).toHaveCount(
      0,
    );
    await expect(page.locator('a[href$="/public"]')).toHaveCount(0);

    await page.goto("/documents/saved-carts/public");
    const note = page.getByTestId("public-check-not-roadmap");
    await expect(note).toContainText("Only a roadmap has a public version");
    await expect(note).toContainText("Saved carts PRD is a PRD");
    await expect(page.getByText("Public texts are for roadmaps only")).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("link", { name: "Back to the PRD" }),
    ).toHaveAttribute("href", "/documents/saved-carts");
    await expect(
      page.getByRole("link", { name: "Back to the roadmap" }),
    ).toHaveCount(0);
    const nav = page.getByRole("navigation", { name: "Oracle" });
    await expect(nav.getByTestId("nav-prds")).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(nav.getByTestId("nav-plan")).not.toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("qa-docs-17: the Public version gives one ordered next step with the control that does it", async ({
    page,
  }) => {
    await sharing(page);
    await page.goto(`${UNPUBLISHED}/public`);
    await expect(page.getByTestId("public-check")).toHaveText(
      "Nobody has checked this public page yet. A public link needs the check.",
    );
    const next = page.getByTestId("public-next");
    await expect(next).toHaveCount(1);
    await expect(next).toContainText("Next, step 1 of 3:");
    await expect(next).toContainText("Approve or exclude the public text of");
    // No competing instructions or controls for later steps.
    await expect(page.getByRole("button", { name: "Mark as checked" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Publish/ })).toHaveCount(0);
    await expect(page.getByText("Read it, then mark it as checked")).toHaveCount(0);
    await expect(page.getByText("Approve or exclude every item")).toHaveCount(0);
    // Its control does the step: the items to approve, in the editing pane.
    await page.getByRole("radiogroup", { name: "Pane" }).getByRole("radio", { name: "Preview" }).click();
    await next.getByRole("button", { name: /^Show/ }).click();
    await expect(
      page.getByRole("radiogroup", { name: "Filter" }).getByRole("radio", { name: /To approve/ }),
    ).toHaveAttribute("aria-checked", "true");
    await expect(
      page.getByRole("radiogroup", { name: "Pane" }).getByRole("radio", { name: "Edit texts" }),
    ).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("public-row").first()).toBeVisible();
  });

  test("qa-docs-67: What is removed is in plain words; the pane switch and the list have their own names", async ({
    page,
  }) => {
    await sharing(page);
    await page.goto(`${UNPUBLISHED}/public`);
    const removed = page.getByRole("region", { name: "What is removed" });
    for (const label of [
      "Internal working titles:",
      "Links to the issue tracker:",
      "Long write-ups:",
      "Cost and pricing figures:",
    ]) {
      await expect(removed).toContainText(label);
    }
    for (const jargon of ["economics", "prose sections", "tracker links", "internal titles"]) {
      await expect(removed).not.toContainText(jargon);
    }
    // A zero reads as "none", never "0 …".
    await expect(removed).not.toContainText(/:\s*0\b/);
    const pane = page.getByRole("radiogroup", { name: "Pane" });
    await expect(pane.getByRole("radio")).toHaveText(["Edit texts", "Preview"]);
    await expect(
      page.getByRole("region", { name: /Each item's public text/ }),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: "Review", exact: true })).toHaveCount(0);
  });
});
