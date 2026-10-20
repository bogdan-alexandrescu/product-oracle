import { expect, test } from "@playwright/test";

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
    "",
    null,
  ]) {
    expect(safeNextPath(bad, ORIGIN), JSON.stringify(bad)).toBe("/home");
  }
});
