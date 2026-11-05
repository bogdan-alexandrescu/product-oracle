import { wantedRow, type PlanItem } from "../app/plan/_lib";
import { expect, test } from "./test";

/**
 * Card plan-open-from-simple (fix round): protects = a /plan?item= link that names a roadmap
 * matches only that roadmap's rows (key, then PRD among them), and never takes the same key
 * from another roadmap; a link that names no roadmap keeps the key-alone match; fails_when =
 * the key in roadmap A stands in for the one in roadmap B; no_claim = the page around it
 * (plan-open-scope.spec.ts). Invented data.
 */

const row = (id: string, key: string, roadmap: string, prd: { id: string; slug: string } | null = null) =>
  ({
    id,
    key,
    title: id,
    roadmap: { slug: roadmap, version: 1, anchor: key },
    prd,
  }) as unknown as PlanItem;

const A1 = row("a1", "k", "roadmap-a", { id: "prd-a", slug: "prd-a" });
const A2 = row("a2", "k", "roadmap-a", { id: "prd-c", slug: "prd-c" });
const B1 = row("b1", "k", "roadmap-b", { id: "prd-b", slug: "prd-b" });
const OTHER = row("o", "other", "roadmap-b", { id: "prd-b", slug: "prd-b" });

test("a link naming a roadmap picks the key in that roadmap", () => {
  expect(wantedRow([A1, B1], "k", null, "roadmap-b")?.id).toBe("b1");
  expect(wantedRow([A1, A2, B1], "k", "prd-c", "roadmap-a")?.id).toBe("a2");
  expect(wantedRow([A1, A2, B1], "k", "prd-b", "roadmap-a")?.id).toBe("a1");
});

test("a link naming a roadmap without the key on the Plan finds nothing, not another roadmap's row", () => {
  expect(wantedRow([A1, A2, OTHER], "k", "prd-b", "roadmap-b")).toBeUndefined();
  expect(wantedRow([A1], "k", null, "roadmap-b")).toBeUndefined();
  expect(wantedRow([A1], "prd-a:k", null, "roadmap-b")).toBeUndefined();
  expect(wantedRow([A1], "prd-a", null, "roadmap-b")).toBeUndefined();
});

test("an old link naming no roadmap keeps the key alone, a report's <prd>:<key> and a PRD", () => {
  expect(wantedRow([A1, B1], "k", null)?.id).toBe("a1");
  expect(wantedRow([A1, B1], "k", "prd-b")?.id).toBe("b1");
  expect(wantedRow([A1, B1], "prd-b:k", null)?.id).toBe("b1");
  expect(wantedRow([OTHER, A1], "prd-a", null)?.id).toBe("a1");
  expect(wantedRow([A1], "missing", null)).toBeUndefined();
});
