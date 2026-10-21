import { expect, test } from "@playwright/test";

import { dateMarks, routeRoadmap, seedRoadmap, type RoadmapContext } from "../lib/api/mock/roadmap";

// The mock's roadmap alignment and track routes mirror the API's (CR-11). The Plan screen
// (F1, e2e/plan.spec.ts) reads its own route, GET /v1/plan; these routes have no page yet.
const USER = "u0000000-0000-4000-8000-000000000001";
const PRD = { id: "d0000000-0000-4000-8000-000000000001", slug: "usage-alerts", title: "Usage alerts PRD", kind: "prd" };
const ROADMAP = { id: "d0000000-0000-4000-8000-000000000002", slug: "usage-alerts-roadmap", title: "Usage alerts roadmap", kind: "roadmap" };
const PRD_V1 = {
  id: "v0000000-0000-4000-8000-000000000001",
  document_id: PRD.id,
  number: 1,
  approved_at: "2026-10-03T10:05:00Z",
  sections: [{ section_key: "thresholds", heading: "Thresholds", level: 2, content_hash: "h1" }],
};
const ROADMAP_V1 = {
  id: "v0000000-0000-4000-8000-000000000002",
  document_id: ROADMAP.id,
  number: 1,
  approved_at: null,
  source: { document_id: PRD.id, slug: PRD.slug, title: PRD.title, kind: "prd" as const, version: 1, version_id: PRD_V1.id, approved_at: PRD_V1.approved_at },
  sections: [
    { section_key: "now", heading: "Now", level: 2, content_hash: "a" },
    { section_key: "item-thresholds", heading: "Thresholds", level: 3, content_hash: "b" },
    { section_key: "later", heading: "Later", level: 2, content_hash: "c" },
    { section_key: "item-digest", heading: "Weekly digest", level: 3, content_hash: "d" },
  ],
};

function api(role: RoadmapContext["role"] = "approver") {
  const ctx: RoadmapContext = { userId: USER, role, documents: [PRD, ROADMAP], versions: [PRD_V1, ROADMAP_V1] };
  const db = seedRoadmap(ctx);
  return {
    db,
    async call(method: string, path: string, body?: unknown) {
      const url = new URL(`http://mock/v1/${path}`);
      const req = new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });
      const res = (await routeRoadmap({ ...ctx, role }, db, req, ["v1", ...url.pathname.split("/").slice(2)], url.searchParams))!;
      return { status: res.status, json: await res.json() };
    },
  };
}

test("roadmap items are traced to the PRD version and section", async () => {
  const { call } = api("viewer");
  const out = await call("GET", `roadmaps/${ROADMAP.slug}/items`);
  expect(out.status).toBe(200);
  expect(out.json.items.map((i: { item_key: string; horizon: string }) => [i.item_key, i.horizon])).toEqual([
    ["item-thresholds", "now"],
    ["item-digest", "later"],
  ]);
  expect(out.json.items[0].prd).toMatchObject({ section_key: "thresholds", link: "/documents/usage-alerts/v/1#thresholds" });
  expect((await call("GET", `roadmaps/${PRD.slug}/items`)).status).toBe(422);
});

test("a dated milestone needs a verified basis that supports its date", async () => {
  const { call } = api();
  const track = (await call("GET", "tracks")).json[0];
  expect(track.health).toBe("on_track");
  const day = "2027-01-15";
  const refused = await call("POST", `tracks/${track.id}/milestones`, { name: "Beta", target_date: day });
  expect(refused.status).toBe(422);
  expect(refused.json.detail).toContain("never invents dates");
  // O4: a basis is recorded for the track's PRD; without one it is refused.
  expect((await call("POST", "schedule-bases", { kind: "estimate", reference: "ENG-1", supports_date: day })).status).toBe(422);
  const basis = await call("POST", "schedule-bases", { kind: "estimate", reference: "ENG-1", supports_date: day, prd: track.prd.slug });
  expect(basis.status).toBe(201);
  expect(basis.json.prd_document_id).toBe(track.prd.id);
  const ok = await call("POST", `tracks/${track.id}/milestones`, { name: "Beta", target_date: day, basis_ids: [basis.json.id], item_keys: ["item-thresholds"] });
  expect(ok.status).toBe(201);
  const withdrawn = await call("POST", `schedule-bases/${basis.json.id}/withdraw`, { reason: "Re-estimated" });
  expect(withdrawn.json.undated_milestones).toEqual([ok.json.id]);
});

test("tracker state is read-only and drift shows in the alignment report", async () => {
  const { call } = api();
  const track = (await call("GET", "tracks")).json[0];
  const rec = await call("POST", "tracker/records", {
    tracker: "linear",
    records: [
      { external_ref: "ENG-2", state: "in_progress", track_id: track.id, item_key: "item-digest" },
      { external_ref: "ENG-3", state: "todo", track_id: track.id, title: "Cleanup" },
    ],
  });
  expect(rec.json.created).toBe(2);
  const report = (await call("GET", `roadmaps/${ROADMAP.slug}/alignment`)).json;
  expect(report.mode).toBe("read_only");
  expect(report.items[1].drift[0].kind).toBe("ahead");
  expect(report.unplanned[0].tracker_ref).toBe("ENG-3");
  expect((await call("POST", `tracks/${track.id}/tracker-push`)).status).toBe(409);
  expect((await call("GET", "tracker/connector")).json.writes_allowed).toBe(false);
  const first = await call("POST", `tracks/${track.id}/monitor`);
  expect(first.json.change_event_id).toBeTruthy();
  expect((await call("POST", `tracks/${track.id}/monitor`)).json.change_event_id).toBeNull();
  expect((await call("GET", `tracks/${track.id}/changes`)).json).toHaveLength(1);
});

test("viewers read but cannot write", async () => {
  const { call } = api("viewer");
  const track = (await call("GET", "tracks")).json[0];
  expect((await call("POST", `tracks/${track.id}/monitor`)).status).toBe(403);
  expect((await call("POST", "schedule-bases", { kind: "estimate", reference: "X", supports_date: "2027-01-01" })).status).toBe(403);
  expect((await call("GET", "tracks/00000000-0000-4000-8000-000000000000")).status).toBe(404);
});

test("document dates: a withdrawn basis marks the roadmap's date, a verified one does not", async () => {
  const { db, call } = api("approver");
  const sections = [
    { section_key: "item-thresholds", level: 3, heading: "Thresholds", body_md: "Beta by 2026-11-30 (ENG-412 estimate)." },
    { section_key: "sources", level: 2, heading: "Sources", body_md: "- Retrieved 2026-11-30" },
  ];
  const statuses = () => dateMarks(db, PRD.id, sections).map((m) => [m.section_key, m.text, m.status, m.label]);
  const eng412 = db.bases.find((b) => b.reference === "ENG-412")!;
  expect(statuses()).toEqual([["item-thresholds", "2026-11-30", "verified", null]]);
  expect((await call("POST", `schedule-bases/${eng412.id}/withdraw`, { reason: "Re-estimated" })).status).toBe(200);
  expect(statuses()).toEqual([["item-thresholds", "2026-11-30", "withdrawn", "date withdrawn"]]);
  // A date nothing ever supported.
  expect(dateMarks(db, PRD.id, [{ ...sections[0], body_md: "GA 2027-02-01." }]).map((m) => m.status)).toEqual(["unverified"]);
});
