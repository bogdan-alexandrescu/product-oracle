import { prioritiesOut, shortCodes } from "../lib/api/mock/simple-priorities";
import { seedSimpleRoadmap } from "../lib/api/mock/simple-roadmap";
import { expect, test } from "./test";

/*
 * simple-priorities-slice-own-key (lib/api/mock/simple-priorities): the mock reads a feature code as the API's
 * priorities.FEATURE_CODE does, slice letter included ([A-Z]{1,3}-\d+[a-j]?): a slice such as F-15a keeps its
 * own code as its short code and its own_key, as the API gives them. Runs the mock module in Node; no page.
 *
 * fails_when = a slice key (F-15a) is read as a name (initials) or its row has no own_key, unlike the API.
 */

test("a slice key is its own short code, as the API reads it", () => {
  // protects: the mock turns the feature codes F-15a (a slice) and F-15 into themselves as short codes, and F-15k, whose letter is not a slice letter (a to j), into the initials form FK15
  // fails_when: a slice code such as F-15a is read as a name and shortened to initials, or F-15k is kept as a slice code
  // no_claim: the real API's code reader (the pytest covers it), any page, and codes with more than one slice letter
  expect(shortCodes(["F-15a", "F-15", "F-15k"])).toEqual(["F-15a", "F-15", "FK15"]);
});

test("a slice item's Priorities row carries its own code as own_key", () => {
  // protects: in the mock's Priorities rows, the invented "Example slice of quiet hours" item with code F-15a has F-15a as both its short code and its own_key
  // fails_when: the slice's row has no own_key, or its short code or own_key is not F-15a
  // no_claim: row order or ranking, other fields of the row, and what a person sees on the page (this runs the mock module in Node, no page)
  const db = seedSimpleRoadmap();
  const first = db.items.find((i) => !i.trashed)!;
  db.items.push({ ...first, key: "F-15a", title: "Example slice of quiet hours" });
  const out = prioritiesOut(db, { id: "member-example", role: "owner", owners: [], names: {} }, () => [], () => false);
  const row = out.rows.find((r) => r.title === "Example slice of quiet hours");
  expect(row?.short_code).toBe("F-15a");
  expect(row?.own_key).toBe("F-15a");
});
