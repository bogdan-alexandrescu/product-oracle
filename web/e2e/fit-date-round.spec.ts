import { round1 } from "../lib/api/mock/fit-date";
import { expect, test } from "./test";

/*
 * The fit-date mock rounds person-weeks as the API's round(x, 1) does: the number's exact value, a
 * tie to the even tenth, and a negative number as its size (never a "-0" whole part read as 0).
 * No page: the mock's rounding alone.
 */
test("the mock rounds person-weeks to a tenth as the API does, negatives too", () => {
  expect([1.25, 1.35, 2.8 - 1.5, 5.2 - 3, 0.04].map(round1)).toEqual([1.2, 1.4, 1.3, 2.2, 0]);
  expect([-0.3, -0.25, -1.25, -1.26, -2.8 + 1.5].map(round1)).toEqual([-0.3, -0.2, -1.2, -1.3, -1.3]);
});
