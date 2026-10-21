import { expect, test } from "@playwright/test";

import { sectionFor, toItemRow } from "../components/roadmap/item-row";
import fixture from "../lib/api/mock/roadmap-items.json";
import { routeRoadmap, seedRoadmap, type RoadmapContext } from "../lib/api/mock/roadmap";

// E2 Items tab, without a page: the helper that finds the roadmap section naming an item
// ("Open in document"), and the mock's roadmap-items scenario serving the shared fixture.

const sections = [
  { section_key: "title", heading: "Usage alerts roadmap" },
  { section_key: "now", heading: "Now" },
  { section_key: "now-item-behaviour", heading: "Alerts at the limit" },
  { section_key: "item-behaviour", heading: "Behaviour (detail)" },
  { section_key: "item-metrics", heading: "Success metrics" },
  { section_key: "later", heading: "Later" },
];
const item = (key: string, title: string, horizon: "now" | "next" | "later" = "now") => ({ key, title, horizon });

// Card section-for: protects = "Open in document" lands on the section that names the item,
// by {horizon}-{key}, then {key}, then heading, then the first section; fails_when = another
// order of preference, or no section; no_claim = how a roadmap draft keys its sections.
test("sectionFor: {horizon}-{key} first", () => {
  expect(sectionFor(item("item-behaviour", "Behaviour"), sections)).toBe("now-item-behaviour");
});

test("sectionFor: then {key}", () => {
  expect(sectionFor(item("item-metrics", "Metrics", "next"), sections)).toBe("item-metrics");
});

test("sectionFor: then the heading that equals the title", () => {
  expect(sectionFor(item("item-x", "Later", "later"), sections)).toBe("later");
});

test("sectionFor: else the version's first section, or none", () => {
  expect(sectionFor(item("item-y", "Nowhere"), sections)).toBe("title");
  expect(sectionFor(item("item-y", "Nowhere"), [])).toBeNull();
});

// Card mock-serves-fixture: protects = the roadmap-items scenario serves the fixture the API
// contract test checks (api/tests/test_roadmap_items_contract.py), and a withdrawn basis
// re-checks the date as the API does; fails_when = the mock's items drift from the fixture;
// no_claim = the real API's values (the contract test).
test("the roadmap-items scenario serves the shared fixture, and re-checks dates live", async () => {
  const PRD = { id: "d0000000-0000-4000-8000-000000000101", slug: "usage-alerts", title: "Usage alerts PRD", kind: "prd" };
  const ROADMAP = { id: "d0000000-0000-4000-8000-000000000102", slug: "usage-alerts-roadmap", title: "Usage alerts roadmap", kind: "roadmap" };
  const prdV1 = {
    id: "v0000000-0000-4000-8000-000000000101",
    document_id: PRD.id,
    number: 1,
    approved_at: "2026-10-03T10:05:00Z",
    sections: [
      { section_key: "behaviour", heading: "1. Behaviour", level: 2, content_hash: "h1" },
      { section_key: "metrics", heading: "2. Success metrics", level: 2, content_hash: "h2" },
    ],
  };
  const roadmapV1 = {
    id: "v0000000-0000-4000-8000-000000000102",
    document_id: ROADMAP.id,
    number: 1,
    approved_at: null,
    source: { document_id: PRD.id, slug: PRD.slug, title: PRD.title, kind: "prd" as const, version: 1, version_id: prdV1.id, approved_at: prdV1.approved_at },
    sections: [
      { section_key: "now", heading: "Now", level: 2, content_hash: "a" },
      { section_key: "item-behaviour", heading: "Behaviour", level: 3, content_hash: "b" },
      { section_key: "next", heading: "Next", level: 2, content_hash: "c" },
      { section_key: "item-metrics", heading: "Success metrics", level: 3, content_hash: "d" },
    ],
  };
  const ctx: RoadmapContext = { userId: "u0000000-0000-4000-8000-000000000001", role: "approver", documents: [PRD, ROADMAP], versions: [prdV1, roadmapV1] };
  const db = seedRoadmap(ctx, "roadmap-items");
  const call = async (method: string, path: string) => {
    const url = new URL(`http://mock/v1/${path}`);
    const res = (await routeRoadmap(ctx, db, new Request(url, { method }), ["v1", ...url.pathname.split("/").slice(2)], url.searchParams))!;
    return res.json();
  };
  const eng412 = db.bases.find((b) => b.reference === "ENG-412")!;

  const served = (await call("GET", "roadmaps/usage-alerts-roadmap/items?version=1&view=full")).items;
  // The fixture, with the mock's own ids.
  const own = (i: Record<string, unknown>) => {
    const { id, track_id, prd, milestone, ...rest } = i as { id: string; track_id: string; prd: { document: object; section_hash: string }; milestone: { basis_ids?: string[] } | null };
    void id;
    void track_id;
    return { ...rest, prd: { ...prd, document: { ...prd.document, id: null }, section_hash: null }, milestone: milestone && { ...milestone, basis_ids: milestone.basis_ids?.length } };
  };
  expect(served.map(own)).toEqual(fixture.items.map(own));
  expect(served[0].milestone.basis_ids).toEqual([eng412.id]);
  expect(toItemRow(served[0]).milestone).toMatchObject({ name: "Beta", date: "2026-11-30", refused_date: null });

  // The default seed is unchanged: no dates, nothing stale (the track stays on track).
  const plain = seedRoadmap({ ...ctx, versions: [prdV1, { ...roadmapV1, id: "v0000000-0000-4000-8000-000000000103" }] });
  expect(Object.values(plain.items).flat().map((i) => [i.freshness, i.confidence])).toEqual([["fresh", null], ["fresh", null]]);

  // Withdrawn: the date is refused on the next read, as the API's live re-check does.
  eng412.status = "withdrawn";
  const after = (await call("GET", "roadmaps/usage-alerts-roadmap/items?version=1&view=full")).items[0];
  expect(after.milestone).toMatchObject({ date: null, refused_date: "2026-11-30", basis_ids: [] });
  expect(after.milestone.refused).toContain("verified estimate, capacity or commitment");
});
