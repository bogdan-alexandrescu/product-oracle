import { expect, test } from "./test";

import { routeQuestionChanges, seedQuestions } from "../lib/api/mock/simple-questions";
import { stableUuid } from "../lib/api/mock/ids";

// The mock's PRD question changes route as the API's (changes.current_route): no page shows a
// question proposal's route (the mock's Inbox lists roadmap proposals only).
const OWNER = "u0000000-0000-4000-8000-000000000001";
const APPROVER = "u0000000-0000-4000-8000-000000000002";
const COMMENTER = "u0000000-0000-4000-8000-000000000003";
const MEMBERS = [
  { id: OWNER, name: "Olive Owner", role: "owner" as const, email: "owner@example.com" },
  { id: APPROVER, name: "Avery Approver", role: "approver" as const, email: "approver@example.com" },
  { id: COMMENTER, name: "Casey Commenter", role: "commenter" as const, email: "commenter@example.com" },
];

/**
 * Card question-proposal-follows-decider (dod-data-2 review major): protects = a
 * decide_question proposal made to Q3's decider (Avery) is routed to the new decider once an
 * owner names another one (Olive), as the API's current_route reads the question's decider
 * now; fails_when = the proposal stays routed to the old decider; no_claim = the Inbox page
 * (the API test test_open_question_proposal_follows_a_renamed_decider covers it).
 */
test("an open question proposal follows a newly named decider", async () => {
  const db = seedQuestions({ me: { id: OWNER, role: "owner" }, members: MEMBERS });
  const q3 = stableUuid("simple-question/3");
  const post = (me: string, role: "owner" | "commenter", body: unknown) =>
    routeQuestionChanges({ me: { id: me, role }, members: MEMBERS }, db, new Request("http://mock/v1/simple/changes", { method: "POST", body: JSON.stringify(body) }), ["v1", "simple", "changes"], () => false);
  const made = await post(COMMENTER, "commenter", { op: "decide_question", target: { decision_id: q3 }, before: {}, after: { option: "alt-1" } });
  expect(made!.status).toBe(201);
  const proposal = (await made!.json()).change;
  expect([proposal.status, proposal.routed_to]).toEqual(["proposed", [APPROVER]]);
  const named = await post(OWNER, "owner", { op: "name_decider", target: { decision_id: q3 }, before: {}, after: { decider_id: OWNER } });
  expect(named!.status).toBe(201);
  expect(db.changes.find((c) => c.change.id === proposal.id)!.change.routed_to).toEqual([OWNER]);
});
