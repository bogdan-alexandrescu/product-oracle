import { expect, test } from "./test";

import { ADMIN, feedbackState, login, openSection, openTab, outlineRow, section, sectionStrip, selectText } from "./helpers";

test("login: rejects a wrong password, then signs in", async ({ page }) => {
  await page.goto("/documents");
  await expect(page).toHaveURL(/\/login/);

  await page.getByLabel("Email").fill("admin@example.com");
  await page.getByLabel("Password").fill("wrong");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Invalid" })).toHaveText("Invalid email or password.");

  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/documents$/);
  await expect(page.getByRole("heading", { level: 1, name: "PRDs", exact: true })).toBeVisible();
  await expect(page.getByTestId("signed-in-as")).toHaveText("admin@example.com");
});

test("login page skips the form when already signed in (e.g. by IAP)", async ({ page }) => {
  await login(page);
  await page.goto("/login?next=/documents/checkout-redesign");
  await expect(page).toHaveURL(/\/documents\/checkout-redesign$/);
});

test("open a version: sections in order with citation chips", async ({ page }) => {
  await login(page);
  await page.getByRole("link", { name: "Checkout redesign PRD" }).click();
  await page.getByRole("link", { name: "Version 2" }).click();
  await expect(page).toHaveURL(/\/documents\/checkout-redesign\/v\/2$/);

  // One section at a time: the outline lists them in order, the first unreviewed one is open.
  const headings = page.locator("section[data-section-key] :is(h1,h2,h3)").filter({ visible: true });
  // The opening section, titled with the document's own title, reads as the Introduction (qa-docs-50).
  await expect(headings).toHaveText(["Introduction"]);
  await sectionStrip(page).getByRole("button", { name: "Unfold 5. Proposed flow" }).click();
  await expect(sectionStrip(page).getByTestId("outline-name")).toHaveText([
    "Introduction",
    "1. Goal trace",
    "2. Problem",
    "3. Users and jobs",
    "4. Scope",
    "5. Proposed flow",
    "5.1 Cart review",
    "5.2 Shipping step",
    "5.3 Saved addresses",
    "6. Risks and open questions",
    "7. Success metrics",
  ]);

  // Hovering a chip previews source, title and excerpt.
  const chip = (await openSection(page, "problem")).getByTestId("cite-c1");
  await expect(chip).toHaveText(/Slack/);
  await chip.hover();
  const card = page.getByRole("tooltip");
  await expect(card).toContainText("#product thread on checkout drop-off");
  await expect(card).toContainText("Most users who abandon do it at the shipping step");
  await expect(card.getByRole("link", { name: /Open source/ })).toHaveAttribute("href", /example\.slack\.com/);
});

test("add an anchored comment that survives reload", async ({ page }) => {
  await login(page);
  await page.goto("/documents/checkout-redesign/v/2");
  const scope = await openSection(page, "scope");

  // Select again until the Comment button shows: under load the view can still be wiring its
  // selection listener (or re-rendering the section) when the first selection lands.
  const commentButton = page.getByRole("button", { name: /^Comment(\s+c)?$/ });
  await expect(async () => {
    await selectText(page, "scope", "the order review page");
    await expect(commentButton).toBeVisible({ timeout: 1000 });
  }).toPass();
  await commentButton.click();
  const dialog = page.getByRole("dialog", { name: "New comment" });
  await expect(dialog).toContainText("the order review page");
  await dialog.getByLabel("Comment").fill("Is the order review page a separate step or a summary panel?");
  await dialog.getByLabel("Comment").press("Control+Enter");
  await expect(dialog).toBeHidden();

  const mark = scope.locator("mark.hl-comment");
  await expect(mark).toHaveText("the order review page");
  await expect(page.getByTestId("comment").filter({ hasText: "separate step or a summary panel" })).toBeVisible();

  await page.reload();
  const markAfter = section(page, "scope").locator("mark.hl-comment");
  await expect(markAfter).toHaveText("the order review page");
  const comment = page.getByTestId("feedback-item").filter({ hasText: "separate step or a summary panel" });
  await expect(comment.getByTestId("feedback-goto")).toHaveText("Go to 4. Scope");

  // The comment is also an open feedback item, raised on v2.
  await expect(comment.getByTestId("feedback-state-chip")).toHaveText("Open");
  await expect(comment).toContainText("raised on v2");
});

test("a citation of Oracle's baseline reads 'Oracle baseline', its ref as text, not a link", async ({ page }) => {
  await login(page);
  // Version 2 of checkout-redesign cites a baseline goal in its Problem section.
  await page.evaluate(() => {
    const key = "po-mock-db-v2";
    const db = JSON.parse(localStorage.getItem(key)!);
    const doc = db.documents.find((d: { slug: string }) => d.slug === "checkout-redesign");
    const v = db.versions.find((x: { document_id: string; number: number }) => x.document_id === doc.id && x.number === 2);
    v.citations.push({
      id: crypto.randomUUID(),
      cite_key: "o-g1",
      source: "oracle",
      ref: "baseline goal g1 (activation), locked",
      title: "Goal G1: raise first-order completion",
      excerpt: "Raise first-order completion from 61% to 70% by the end of Q4.",
      retrieved_at: "2026-10-20T17:02:00Z",
    });
    const problem = v.sections.find((s: { section_key: string }) => s.section_key === "problem");
    problem.body_md += " Serves G1 [c:o-g1].";
    problem.citation_keys.push("o-g1");
    localStorage.setItem(key, JSON.stringify(db));
  });
  await page.goto("/documents/checkout-redesign/v/2");

  const chip = (await openSection(page, "problem")).getByTestId("cite-o-g1");
  await expect(chip).toHaveText(/Oracle baseline/);
  await chip.hover();
  const card = page.getByRole("tooltip");
  await expect(card).toContainText("Goal G1: raise first-order completion");
  await expect(card.getByTestId("cite-ref")).toHaveText("baseline goal g1 (activation), locked");
  await expect(card.getByRole("link")).toHaveCount(0);

  await openTab(page, "Sources");
  const row = page.getByTestId("sources-list").filter({ visible: true }).getByRole("listitem").filter({ hasText: "Oracle baseline" });
  await expect(row).toContainText("Goal G1: raise first-order completion");
  await expect(row.getByRole("link")).toHaveCount(0);
});

test("set a section verdict; approval shows the section as locked", async ({ page }) => {
  await login(page);
  await page.goto("/documents/checkout-redesign/v/2");
  const users = await openSection(page, "users");
  const bar = users.getByTestId("review-bar");
  await expect(bar.getByTestId("verdict-state")).toHaveText("Not reviewed");

  await bar.getByRole("button", { name: "Request changes" }).click();
  await bar.getByLabel(/What should change/).fill("Add the support agent's main job in one line.");
  await bar.getByTestId("verdict-submit").click();
  await expect(bar.getByTestId("verdict-state")).toContainText("Changes requested");
  await expect(bar.getByTestId("verdict-state")).toContainText("support agent's main job");

  await bar.getByRole("button", { name: "Approve" }).click();
  await bar.getByTestId("verdict-submit").click();
  await expect(bar.getByTestId("verdict-state")).toContainText("Approved");
  await expect(bar.getByTestId("verdict-state")).toContainText("Locked");

  // The changes-requested item was superseded by the approval: it is Done.
  await page.getByRole("tab", { name: /^Feedback/ }).click();
  await feedbackState(page, "Done");
  await expect(page.getByTestId("feedback-item").filter({ hasText: "support agent's main job" })).toBeVisible();

  await page.reload();
  await expect(section(page, "users").getByTestId("verdict-state")).toContainText("Locked");
});

test("switch versions with the version switcher", async ({ page }) => {
  await login(page);
  await page.goto("/documents/checkout-redesign/v/2");
  await openSection(page, "s-5-3");

  await page.getByRole("group", { name: "Version" }).getByRole("link", { name: "v1", exact: true }).click();
  await expect(page).toHaveURL(/\/v\/1$/);
  await openSection(page, "rollout");
  await expect(outlineRow(page, "s-5-3")).toHaveCount(0);
  await expect(page.getByText("You are viewing an earlier version.")).toBeVisible();
  // v1 carries the earlier review: the goal trace was approved.
  await expect((await openSection(page, "goal-trace")).getByTestId("verdict-state")).toContainText("Locked");

  // { and } switch versions ([ and ] step sections).
  await page.keyboard.press("}");
  await expect(page).toHaveURL(/\/v\/2$/);
});

test("open the diff: section badges and word-level changes", async ({ page }) => {
  await login(page);
  await page.goto("/documents/checkout-redesign/v/2");
  await page.getByRole("link", { name: "Compare with v1" }).click();
  await expect(page).toHaveURL(/\/diff\?from=1&to=2$/);
  await expect(page.getByRole("heading", { name: "Changes from v1 to v2" })).toBeVisible();

  // A section is named by its heading, never its #anchor (qa-docs-28).
  const HEADINGS: Record<string, string> = {
    "goal-trace": "1. Goal trace",
    problem: "2. Problem",
    "s-5-2": "5.2 Shipping step",
    "s-5-3": "5.3 Saved addresses",
    risks: "6. Risks and open questions",
    metrics: "7. Success metrics",
    rollout: "8. Rollout",
  };
  const byKey = (k: string) =>
    page.getByTestId("diff-section").filter({ has: page.getByRole("heading", { name: HEADINGS[k], exact: true }) });
  await expect(byKey("s-5-3")).toHaveAttribute("data-status", "added");
  await expect(byKey("rollout")).toHaveAttribute("data-status", "removed");
  await expect(byKey("problem")).toHaveAttribute("data-status", "changed");
  await expect(byKey("risks").getByText("Moved")).toBeVisible();

  const words = byKey("s-5-2").getByTestId("word-diff");
  await expect(words.locator("ins").first()).toContainText("and the cheapest option is preselected");
  await expect(byKey("metrics").locator("ins").first()).toContainText("Refund rate");
  // A markdown table is drawn as a table, as in the version view, not as pipe text.
  const table = byKey("metrics").getByTestId("diff-table");
  await expect(table.getByRole("columnheader")).toHaveText(["Metric", "Baseline", "Target"]);
  await expect(table.getByRole("row").filter({ hasText: "Refund rate" }).locator("ins").first()).toBeVisible();
  await expect(byKey("metrics")).not.toContainText("Metric | Baseline");

  // Unchanged sections are collapsed until asked for.
  await expect(byKey("goal-trace")).toHaveCount(0);
  await page.getByLabel("Show unchanged sections").check();
  await expect(byKey("goal-trace")).toHaveAttribute("data-status", "unchanged");
});

test("publish a version and export it", async ({ page }) => {
  await login(page);
  await page.goto("/documents/team-workspaces/v/2");
  await expect(page.getByRole("status").filter({ hasText: "scope" })).toBeVisible();

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByRole("button", { name: "Export PDF" }).click();
  expect((await download).suggestedFilename()).toBe("team-workspaces-v2.pdf");

  // A PRD is published from the Publish screen (T2 publish gate); team-workspaces is ready.
  await expect(page.getByRole("button", { name: "Approve version" })).toHaveCount(0);
  await page.getByTestId("doc-header").getByRole("link", { name: "Publish", exact: true }).click();
  await expect(page).toHaveURL(/\/documents\/team-workspaces\/publish$/);
  await page.getByTestId("publish-button").click();
  await page.getByRole("dialog", { name: "Publish v2?" }).getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByTestId("published-chip")).toHaveText("Published v2");

  await page.goto("/documents/team-workspaces/v/2");
  await expect(page.getByText(/✓ Approved/)).toBeVisible();
  await expect(page.getByTestId("doc-status")).toHaveText("Approved");
  await expect(page.getByText(/review is closed/)).toBeVisible();
});
