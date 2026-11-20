import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * #1586 (phase 2, the pages outside Home, Simple, PRDs and the Inbox): a read that failed says
 * so, with its reason behind an (i), never the empty state an answer of none would draw. Each
 * case is checked both ways: answered first, then failed.
 */

const failGets = (page: Page, path: string) => page.evaluate((p) => localStorage.setItem("po-mock-fail", p), path);

/** The first GET the mock answered whose path (with its query) matches `re`. */
async function calledUrl(page: Page, re: RegExp): Promise<string> {
  const handle = await page.waitForFunction(
    (src) => ((globalThis as { __poMockCalls?: string[] }).__poMockCalls ?? []).map((l) => l.replace(/^GET /, "")).find((p) => new RegExp(src).test(p)),
    re.source,
  );
  return (await handle.jsonValue()) as string;
}

async function seesReason(page: Page, scope: ReturnType<Page["getByTestId"]>, what: string) {
  const failed = scope.getByTestId("load-error");
  await expect(failed).toContainText(`Could not load ${what}.`);
  await failed.getByRole("button", { name: "About the error" }).click();
  await expect(page.getByRole("tooltip")).toContainText("Mock failure");
}

async function openActivation(page: Page) {
  await page.goto("/ground-truth");
  await page.getByTestId("goal-g.activation").getByRole("button", { name: "Activation" }).click();
  return page.getByRole("dialog", { name: "Activation" });
}

test("Ground Truth: a goal's values that could not be read say so, never no values yet", async ({ page }) => {
  await login(page);
  let d = await openActivation(page);
  await expect(d.getByTestId("goal-measurements").getByTestId("measurement-row")).toHaveCount(7);
  await expect(d.getByTestId("goal-measurements").getByTestId("load-error")).toHaveCount(0);
  const url = await calledUrl(page, /^\/v1\/baseline\/entities\/[^/?]+\/measurements/);

  await failGets(page, url.split("?")[0]);
  await page.reload();
  d = await openActivation(page);
  await seesReason(page, d.getByTestId("goal-measurements"), "the values");
  await expect(d.getByTestId("goal-measurements")).not.toContainText(/No values recorded yet|No dated values yet/);
  await expect(d.getByTestId("goal-measurements").getByTestId("measurement-row")).toHaveCount(0);
});

test("Ground Truth: an item's history that could not be read says so, never no changes", async ({ page }) => {
  await login(page);
  let d = await openActivation(page);
  await expect(d.getByTestId("entity-history").getByRole("listitem").last()).toContainText("Created");
  await expect(d.getByTestId("entity-history").getByTestId("load-error")).toHaveCount(0);
  const url = await calledUrl(page, /^\/v1\/baseline\/entities\/[^/?]+\/revisions/);

  await failGets(page, url.split("?")[0]);
  await page.reload();
  d = await openActivation(page);
  await seesReason(page, d.getByTestId("entity-history"), "the history");
  await expect(d.getByTestId("entity-history")).not.toContainText("No changes recorded");
  await expect(d.getByTestId("entity-history").getByRole("listitem")).toHaveCount(0);
});

const inspector = (page: Page) => page.getByTestId("request-inspector").filter({ visible: true });

async function openRequest(page: Page) {
  await page.goto("/requests");
  const title = "Keep the delivery address between orders";
  await page.getByTestId("request-row").filter({ hasText: title }).getByRole("button", { name: title }).click();
  await expect(inspector(page).getByRole("heading", { name: title })).toBeVisible();
  return inspector(page).getByRole("group", { name: "Goals" });
}

test("Requests: goals that could not be read say so, never no confirmed goals yet", async ({ page }) => {
  await login(page);
  let goals = await openRequest(page);
  await expect(goals.getByRole("checkbox").first()).toBeVisible();
  await expect(goals.getByTestId("load-error")).toHaveCount(0);
  const url = await calledUrl(page, /^\/v1\/baseline\/entities\?(?=.*type=goal)(?=.*status=confirmed)/);

  await failGets(page, url);
  await page.reload();
  goals = await openRequest(page);
  await seesReason(page, goals, "the goals");
  await expect(goals).not.toContainText("No confirmed goals yet");
  await expect(goals.getByRole("checkbox")).toHaveCount(0);
});

test("Decisions: a linked item's evidence that could not be read says so, never no evidence", async ({ page }) => {
  await login(page, "commenter@example.com");
  await page.goto("/company/decisions");
  const propose = async () => {
    await page.getByRole("button", { name: "Propose decision" }).click();
    const dialog = page.getByRole("dialog", { name: "Propose decision" });
    const linked = dialog.getByRole("group", { name: "Linked items" });
    await linked.getByLabel("Find an item to link").fill("checklist");
    await linked.getByRole("button", { name: /^Setup checklist · Feature/ }).click();
    return dialog.getByRole("group", { name: "Evidence" });
  };
  let evidence = await propose();
  await expect(evidence.getByRole("checkbox", { name: /New accounts stall before adding a payment method/ })).toBeVisible();
  await expect(evidence.getByTestId("load-error")).toHaveCount(0);
  const url = await calledUrl(page, /^\/v1\/baseline\/entities\/[^/?]+$/);

  await failGets(page, url);
  await page.reload();
  evidence = await propose();
  await seesReason(page, evidence, "the evidence");
  await expect(evidence).not.toContainText("No evidence on this item");
  await expect(evidence.getByRole("checkbox")).toHaveCount(0);
});
