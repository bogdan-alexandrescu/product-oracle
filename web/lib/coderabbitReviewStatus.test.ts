// #1560: npm run test:unit (Vitest, #1583).
import assert from "node:assert/strict";
import { test } from "vitest";
import { reviewStatus } from "./coderabbitReviewStatus.ts";
import type { PrView } from "./coderabbitReviewStatus.ts";

const HEAD = "1111111111111111111111111111111111111111";
const OLD = "2222222222222222222222222222222222222222";
const bot = { login: "coderabbitai" };
const person = { login: "example-dev" };
const review = (body: string, oid = HEAD, at = "2026-11-20T09:00:00Z") => ({
  author: bot,
  body,
  commit: { oid },
  submittedAt: at,
});
const pr = (over: Partial<PrView>): PrView => ({ headRefOid: HEAD, comments: [], reviews: [], ...over });

test("reviewed: actionable comments on the head", () => {
  const s = reviewStatus(pr({ reviews: [review("**Actionable comments posted: 3**")] }));
  assert.equal(s.state, "reviewed");
});

test("reviewed-nothing-applicable: no actionable comments on the head", () => {
  const s = reviewStatus(pr({ reviews: [review("No actionable comments were generated in the recent review.")] }));
  assert.equal(s.state, "reviewed-nothing-applicable");
  assert.equal(
    reviewStatus(pr({ reviews: [review("**Actionable comments posted: 0**")] })).state,
    "reviewed-nothing-applicable",
  );
});

test("did-not-review: no CodeRabbit activity, only a person's review", () => {
  const s = reviewStatus(pr({ reviews: [{ author: person, body: "Looks good.", commit: { oid: HEAD } }] }));
  assert.equal(s.state, "did-not-review");
});

test("did-not-review: rate limited, with the reason", () => {
  const s = reviewStatus(pr({ comments: [{ author: bot, body: "<!-- rate limited by coderabbit.ai -->" }] }));
  assert.equal(s.state, "did-not-review");
  assert.deepEqual(s.reasons, ["rate limited"]);
});

test("reviewed-incompletely: the latest review is of an older commit", () => {
  const s = reviewStatus(pr({ reviews: [review("**Actionable comments posted: 1**", OLD)] }));
  assert.equal(s.state, "reviewed-incompletely");
});

test("reviewed-incompletely: files over the max files limit", () => {
  const body = "**Actionable comments posted: 2**\n\nFiles not processed due to max files limit (12)";
  assert.equal(reviewStatus(pr({ reviews: [review(body)] })).state, "reviewed-incompletely");
});

test("trivial files skipped do not make a review incomplete", () => {
  const body = "No actionable comments were generated.\n\nFiles skipped from review due to trivial changes (2)";
  assert.equal(reviewStatus(pr({ reviews: [review(body)] })).state, "reviewed-nothing-applicable");
});
