// #1560: what CodeRabbit did with a pull request, in the four states of the CLI review script.
//
//   node web/scripts/coderabbit-review-status.ts <pr-number> [--json]
//   node web/scripts/coderabbit-review-status.ts --from <file.json>   a saved `gh pr view` result
//
// Reads `gh pr view <n> --json headRefOid,comments,reviews`. Exits 0 for reviewed and
// reviewed-nothing-applicable, 1 otherwise.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { exitCodeFor } from "../lib/coderabbitCliReview.ts";
import { reviewStatus } from "../lib/coderabbitReviewStatus.ts";
import type { PrView } from "../lib/coderabbitReviewStatus.ts";

const args = process.argv.slice(2);
const from = args.indexOf("--from");
let pr: PrView;
if (from !== -1) {
  pr = JSON.parse(readFileSync(args[from + 1], "utf8"));
} else {
  const number = args.find((a) => /^\d+$/.test(a));
  if (!number) {
    console.error("usage: coderabbit-review-status.ts <pr-number> [--json] | --from <file.json>");
    process.exit(2);
  }
  pr = JSON.parse(
    execFileSync("gh", ["pr", "view", number, "--json", "headRefOid,comments,reviews"], { encoding: "utf8" }),
  );
}
const status = reviewStatus(pr);
console.log(
  args.includes("--json")
    ? JSON.stringify(status, null, 2)
    : [`coderabbit pr review: ${status.state}`, ...status.reasons.map((r) => `  - ${r}`)].join("\n"),
);
process.exitCode = exitCodeFor(status.state);
