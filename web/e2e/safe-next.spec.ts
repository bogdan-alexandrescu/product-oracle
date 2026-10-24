import { expect, test } from "./test";

import { safeNextPath } from "../lib/safe-next";

const ORIGIN = "https://oracle.example";

test("safeNextPath keeps same-site paths and refuses everything that can leave the site", () => {
  expect(safeNextPath("/home", ORIGIN)).toBe("/home");
  expect(safeNextPath("/runs/x?y=1#z", ORIGIN)).toBe("/runs/x?y=1#z");
  for (const bad of [
    "//evil.com",
    "/\\evil.com",
    "/\tevil",
    "/\nevil",
    "/\r/evil.com",
    "https://evil.com",
    "javascript:alert(1)",
    "%2F%2Fevil.com",
    decodeURIComponent("%2F%2Fevil.com"),
    "evil.com",
    // Dot-segments pass a same-site check, then resolve to //evil.com (another host).
    "/.//evil.com",
    "/..//evil.com",
    "/%2e//evil.com",
    "/a/..//evil.com",
    "/home/..//..//evil.com",
    "/.///evil.com",
    "/.//evil.com/path?q=1#h",
    "",
    null,
  ]) {
    expect(safeNextPath(bad, ORIGIN), JSON.stringify(bad)).toBe("/home");
  }
});
