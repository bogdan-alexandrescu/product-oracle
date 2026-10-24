import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "./test";

/*
 * #370 fixes 4: what the signed-in role may do comes from GET /v1/me/capabilities only (the
 * API's route roles), through can(action). No page or component keeps a second role list by
 * comparing the signed-in role itself. Checks of other people's roles (a member list, the
 * approvers to pick from) are not about the signed-in role and stay.
 */

const ROOTS = ["app", "components"];
// Signed-in role checks: hasRole(role, ...), hasRole(me.role, ...), role === "owner" and the like.
const SELF_ROLE = /hasRole\(\s*(role|me\??\.role)\s*,|(^|[^.\w])role\s*[!=]==\s*"(owner|approver|commenter|viewer)"/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

test("no page or component checks the signed-in role itself: can(action) decides", () => {
  const found: string[] = [];
  for (const root of ROOTS) {
    for (const file of files(root)) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => SELF_ROLE.test(line) && found.push(`${file}:${i + 1}: ${line.trim()}`));
    }
  }
  expect(found).toEqual([]);
});

test("no page keeps an \"Approvers and owners\" role note", () => {
  const found = ["app/requests/_components/Triage.tsx", "components/JobsPanel.tsx"].filter((f) =>
    /Approvers and owners (start|turn|run|write|can)/.test(readFileSync(f, "utf8")),
  );
  expect(found).toEqual([]);
});
