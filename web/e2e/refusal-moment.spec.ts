import { expect, test } from "./test";

import { moment } from "../lib/api/mock/refusal";

/**
 * #604 re-review (minor): the mock reads a stored ISO moment as the API does
 * (oracle.claude_accounts.pool.readable_refusal): one Python's fromisoformat refuses passes
 * through as it was, a day past its month's end (Feb 30, Apr 31) included. No page: the
 * mock's rewrite on its own.
 */
test("a day past its month's end is no moment, as in Python", () => {
  const zone = "America/Los_Angeles";
  expect(moment("2026-02-30T10:00Z", zone)).toBe("2026-02-30T10:00Z");
  expect(moment("2026-04-31T10:00:00+00:00", zone)).toBe("2026-04-31T10:00:00+00:00");
  expect(moment("2026-13-40T99:99Z", zone)).toBe("2026-13-40T99:99Z");
  expect(moment("2028-02-29T22:00:00Z", zone)).toBe("Tue Feb 29, 2:00 PM PST");
  expect(moment("2026-10-25T22:00:00.475990+00:00", zone)).toBe("Sun Oct 25, 3:00 PM PDT");
});
