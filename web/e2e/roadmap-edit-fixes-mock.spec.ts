import { expect, test } from "./test";

import { routeSimpleChanges } from "../lib/api/mock/simple-changes";
import { seedSimpleRoadmap, settleDrafting } from "../lib/api/mock/simple-roadmap";
import { stableUuid } from "../lib/api/mock/ids";

/*
 * roadmap-edit-fixes (draft-race review minors): the mock's Oracle draft of a new item as the
 * API's (additions.run_item_draft, changes._oracle_filled, changes._last_writer). No page lets
 * a person set a new item's feature while Oracle drafts it, so these drive the mock's route.
 *
 * - protects = Oracle's draft fills a new item's feature (when it has none), as the API's; a
 *   person who saw it empty and sets a feature keeps theirs; fails_when = the draft leaves the
 *   feature empty, or the person's save is refused as changed by Oracle.
 * - protects = Oracle's draft landing at the same moment as the item's own add (which wrote its
 *   empty outcome, as the API's add does) is the last writer, as the API names it; fails_when =
 *   the conflict names the person who added it.
 */

const OWNER = "u0000000-0000-4000-8000-000000000001";
const SNOOZE = stableUuid("roadmap-edit-fixes-mock/feature/snooze-rules");
const DIGEST = stableUuid("roadmap-edit-fixes-mock/feature/weekly-digest");

function api() {
  const db = seedSimpleRoadmap();
  // The Ground Truth features Oracle may pick (server.ts sets these from the baseline).
  db.feature_keys = { [SNOOZE]: "snooze-rules", [DIGEST]: "weekly-digest" };
  db.feature_titles = { [SNOOZE]: "Snooze rules", [DIGEST]: "Weekly digest" };
  const ctx = { id: OWNER, role: "owner" as const, owners: [OWNER], names: { [OWNER]: "Olive Owner" }, roles: { [OWNER]: "owner" as const } };
  const post = async (body: unknown) => {
    const req = new Request("http://mock/v1/simple/changes", { method: "POST", body: JSON.stringify(body) });
    const res = (await routeSimpleChanges(db, ctx, req, ["v1", "simple", "changes"], new URLSearchParams()))!;
    return { status: res.status, json: await res.json() };
  };
  /** Adds an item and lets Oracle's draft of it land (at the mock's one moment, the add's). */
  const addDrafted = async (title: string) => {
    const r = await post({ op: "add_item", target: { where: { kind: "horizon", value: "next" } }, before: {}, after: { title } });
    expect(r.status).toBe(201);
    const id = r.json.change.target.item_id as string;
    const item = db.items.find((x) => db.ids[x.key] === id)!;
    item.drafting_until = 1;
    settleDrafting(db);
    return { id, item, add: r.json.change };
  };
  return { db, post, addDrafted };
}

test("Oracle's draft fills a new item's feature, and a person's feature set over it stays", async () => {
  const { post, addDrafted } = api();
  const { id, item } = await addDrafted("Snooze an alert");
  expect(item.feature_id).toBe(SNOOZE);
  // The person opened the panel while Oracle drafted (no feature), and saves after it landed.
  const r = await post({ op: "set_feature", target: { item_id: id }, before: { feature_id: null }, after: { feature_id: DIGEST } });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  expect(item.feature_id).toBe(DIGEST);
  // A person's write since is theirs: another stale save is told who changed it.
  const again = await post({ op: "set_feature", target: { item_id: id }, before: { feature_id: null }, after: { feature_id: SNOOZE } });
  expect(again.status).toBe(409);
  expect(again.json.detail.changed_by.name).toBe("Olive Owner");
  expect(item.feature_id).toBe(DIGEST);
});

test("Oracle's draft landing with the item's own add is the last writer", async () => {
  const { post, addDrafted } = api();
  const { id, item, add } = await addDrafted("Mute a channel");
  // As the API's add: it writes the outcome, empty.
  expect(add.after.outcome).toBeNull();
  expect(item.outcome).not.toBeNull();
  const r = await post({ op: "edit_outcome", target: { item_id: id }, before: { outcome: "Something else" }, after: { outcome: "Mine" } });
  expect(r.status).toBe(409);
  expect(r.json.detail.changed_by).toEqual({ id: null, name: "Oracle" });
});
