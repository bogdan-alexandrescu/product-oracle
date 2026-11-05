import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * trash-features-goals (owner's pick, Nov 4): a roadmap feature and a goal deleted to Trash are
 * listed in Settings › Trash beside documents (their kind in words, their name, who deleted them,
 * the days left), and Restore puts each back where it was. The screens that delete them are still
 * being drawn, so the delete is made through the mock API's own routes (as the API would get it);
 * Settings › Trash is driven as a person would.
 *
 * Card tfg-list-restore: protects = Settings › Trash lists "Feature <name>" and "Goal <name>"
 * with "Deleted by" and "30 days left"; Restore on each takes it out of Trash and the roadmap and
 * the goal buckets read it again; fails_when = either kind is missing from Trash, a bare kind
 * name ("feature") shows, or Restore leaves it out of its page's read; no_claim = the delete
 * screens (not drawn yet).
 *
 * Card tfg-deleter-restores (owner's answer, Nov 5: "Whoever deleted it, too"): protects = an
 * approver who deleted a feature and a goal finds Settings › Trash, sees both there with Restore
 * (and not what an owner deleted) and restores each without an owner; fails_when = the approver
 * has no Trash tab, no Restore, sees the owner's delete, or Restore is refused; no_claim = other
 * approvers (the API's tests).
 */

type Call = { status: number; body: unknown };

async function call(page: Page, method: string, path: string): Promise<Call> {
  return page.evaluate(
    async ([method, path]) => {
      const w = globalThis as unknown as { __poMockFetch?: (r: Request) => Promise<Response> };
      const res = await w.__poMockFetch!(new Request(new URL(path, location.origin), { method }));
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    [method, path] as const,
  );
}

type Item = { id: string; title: string; can_decide: boolean };
type Goal = { id: string; title: string };

async function items(page: Page): Promise<Item[]> {
  return ((await call(page, "GET", "/v1/simple/roadmap")).body as { items: Item[] }).items;
}

async function goals(page: Page): Promise<Goal[]> {
  return ((await call(page, "GET", "/v1/simple/goal-buckets")).body as { goals: Goal[] }).goals;
}

test("a deleted feature and goal are listed in Settings › Trash and restored from there", async ({ page }) => {
  await login(page);
  const feature = (await items(page)).find((i) => i.can_decide)!;
  const [goal, other] = await goals(page);
  expect(feature && goal && other).toBeTruthy();

  expect((await call(page, "DELETE", `/v1/simple/roadmap/items/${feature.id}`)).status).toBe(200);
  expect((await call(page, "DELETE", `/v1/simple/goal-buckets/goals/${goal.id}?to_goal_id=${other.id}`)).status).toBe(200);
  expect((await items(page)).map((i) => i.id)).not.toContain(feature.id);
  expect((await goals(page)).map((g) => g.id)).not.toContain(goal.id);

  await page.goto("/settings/trash");
  const entries = page.getByTestId("trash-entry");
  const featureRow = entries.filter({ hasText: feature.title });
  const goalRow = entries.filter({ hasText: goal.title });
  await expect(featureRow).toContainText("Feature");
  await expect(featureRow).toContainText("Deleted by");
  await expect(featureRow).toContainText("30 days left");
  await expect(goalRow).toContainText("Goal");
  await expect(goalRow).toContainText("30 days left");
  await expect(entries.filter({ hasText: /\bfeature\b|\bgoal\b/ })).toHaveCount(0);

  await page.getByRole("button", { name: `Restore ${feature.title}` }).click();
  await expect(featureRow).toHaveCount(0);
  await page.getByRole("button", { name: `Restore ${goal.title}` }).click();
  await expect(goalRow).toHaveCount(0);

  expect((await items(page)).map((i) => i.id)).toContain(feature.id);
  expect((await goals(page)).map((g) => g.id)).toContain(goal.id);
});

test("whoever deleted a feature or a goal sees it in Trash and restores it, with no owner", async ({ page }) => {
  // An owner deletes a feature: it is the owners' to restore, so the approver never sees it.
  await login(page);
  const theirs = (await items(page)).find((i) => i.can_decide)!;
  expect((await call(page, "DELETE", `/v1/simple/roadmap/items/${theirs.id}`)).status).toBe(200);

  await login(page, "approver@example.com");
  const feature = (await items(page)).find((i) => i.can_decide && i.id !== theirs.id)!;
  const [goal, other] = await goals(page);
  expect(feature && goal && other).toBeTruthy();
  const deleted = await call(page, "DELETE", `/v1/simple/roadmap/items/${feature.id}`);
  expect(deleted.status).toBe(200);
  expect((deleted.body as { can_restore: boolean }).can_restore).toBe(true);
  expect((await call(page, "DELETE", `/v1/simple/goal-buckets/goals/${goal.id}?to_goal_id=${other.id}`)).status).toBe(200);

  await page.goto("/settings");
  await page.getByTestId("nav-trash").filter({ visible: true }).click();
  await expect(page).toHaveURL(/\/settings\/trash$/);
  const entries = page.getByTestId("trash-entry");
  await expect(entries).toHaveCount(2);
  await expect(entries.filter({ hasText: theirs.title })).toHaveCount(0);
  const featureRow = entries.filter({ hasText: feature.title });
  const goalRow = entries.filter({ hasText: goal.title });
  await expect(featureRow).toContainText("Feature");
  await expect(goalRow).toContainText("Goal");

  await featureRow.getByRole("button", { name: `Restore ${feature.title}` }).click();
  await expect(featureRow).toHaveCount(0);
  await goalRow.getByRole("button", { name: `Restore ${goal.title}` }).click();
  await expect(goalRow).toHaveCount(0);
  await expect(page.getByTestId("trash-empty")).toBeVisible();

  expect((await items(page)).map((i) => i.id)).toContain(feature.id);
  expect((await goals(page)).map((g) => g.id)).toContain(goal.id);
  expect((await items(page)).map((i) => i.id)).not.toContain(theirs.id);
});
