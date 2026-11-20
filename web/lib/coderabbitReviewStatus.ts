// #1560: the same four states as lib/coderabbitCliReview.ts, for CodeRabbit's review of a pull
// request, read from `gh pr view <n> --json headRefOid,comments,reviews`. A PR with no
// CodeRabbit review, a skipped or rate-limited one, or one still in progress did not get a
// review; a review of an older commit, or one that left files out, is incomplete.
import type { CliReviewState } from "./coderabbitCliReview.ts";

export type ReviewStatusState = CliReviewState;

type Author = { login?: string } | null | undefined;

export type PrView = {
  headRefOid: string;
  comments?: Array<{ author?: Author; body?: string }>;
  reviews?: Array<{ author?: Author; body?: string; commit?: { oid?: string } | null; submittedAt?: string }>;
};

export type ReviewStatus = { state: ReviewStatusState; reasons: string[] };

const BOT = /^coderabbitai(\[bot\])?$/i;

// Markers in CodeRabbit's summary comment that mean no review ran for the latest push.
const NOT_REVIEWED: Array<[RegExp, string]> = [
  [/rate limited by coderabbit\.ai|rate limit exceeded/i, "rate limited"],
  [/review skipped|skip review by coderabbit\.ai/i, "review skipped"],
  [/reviews? paused/i, "reviews paused"],
  [/currently processing new changes|review in progress/i, "review in progress"],
];

// Markers in a review body that mean some files were left out.
const PARTIAL: Array<[RegExp, string]> = [
  [/not processed due to max files limit/i, "files over the max files limit"],
  [/files? (?:not reviewed|skipped from review) due to (?!trivial)/i, "files skipped from review"],
  [/review (?:was )?(?:cut short|truncated|incomplete)/i, "review truncated"],
];

const ACTIONABLE = /actionable comments posted:\s*\**\s*(\d+)/i;
const NONE = /no actionable comments were generated/i;

function byBot(author: Author): boolean {
  return BOT.test(author?.login ?? "");
}

export function reviewStatus(pr: PrView): ReviewStatus {
  const comments = (pr.comments ?? []).filter((c) => byBot(c.author));
  const reviews = (pr.reviews ?? [])
    .filter((r) => byBot(r.author))
    .sort((a, b) => (a.submittedAt ?? "").localeCompare(b.submittedAt ?? ""));
  const onHead = reviews.filter((r) => r.commit?.oid === pr.headRefOid);
  const summary = comments.map((c) => c.body ?? "").join("\n");

  if (onHead.length === 0) {
    const blocked = NOT_REVIEWED.filter(([re]) => re.test(summary)).map(([, why]) => why);
    if (reviews.length === 0) {
      return { state: "did-not-review", reasons: blocked.length ? blocked : ["no CodeRabbit review on this PR"] };
    }
    return {
      state: "reviewed-incompletely",
      reasons: [`the latest CodeRabbit review is of ${reviews.at(-1)?.commit?.oid?.slice(0, 7) ?? "an older commit"}, not the head`, ...blocked],
    };
  }

  const bodies = onHead.map((r) => r.body ?? "");
  const partial = PARTIAL.filter(([re]) => bodies.some((b) => re.test(b) || re.test(summary))).map(([, why]) => why);
  if (partial.length) return { state: "reviewed-incompletely", reasons: partial };

  // Every review of the head counts: an earlier one may hold the comments a later one does not.
  let actionable = 0;
  let counted = false;
  for (const body of bodies) {
    const m = ACTIONABLE.exec(body);
    if (m) {
      counted = true;
      actionable += Number(m[1]);
    } else if (NONE.test(body)) counted = true;
  }
  if (!counted) return { state: "reviewed", reasons: ["the review gives no comment count"] };
  if (actionable === 0) return { state: "reviewed-nothing-applicable", reasons: [] };
  return { state: "reviewed", reasons: [`${actionable} actionable comment${actionable === 1 ? "" : "s"}`] };
}
