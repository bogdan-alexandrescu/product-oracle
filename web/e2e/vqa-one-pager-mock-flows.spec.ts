import { betSubject, flowsOfBets, requestVisual, type VisualsDb } from "../lib/api/mock/simple-visuals";
import { expect, test } from "./test";

/**
 * vqa-one-pager 1: the mock's flowsOfBets reads each bet's flow as the API's visuals.flows_of_bets
 * (api/tests/test_simple_bet_flow_versions.py), so the one-pager specs on the mock see what the
 * API serves. Invented bets of the mock's PRD "guided-setup".
 *
 * Card mock-own-flow-first: protects = a bet whose key holds a flow drawn for a bet the page no
 * longer has shows its own flow (drawn on its key + "/own"); fails_when = it shows the other
 * bet's flow, its own one lost (a later version dropped a bet on a shifted page).
 * Card mock-kept-flow: protects = of two flows drawn from the same words, the bet shows the one
 * a person commented on; fails_when = the flows' place decides.
 */

const SETUP = "Setup checklist showing the next step";
const drawn = (briefs: Record<string, string>): VisualsDb => {
  const db: VisualsDb = { visuals: {} };
  for (const [key, brief] of Object.entries(briefs)) requestVisual(db, "one_pager_line", betSubject(key), brief);
  return db;
};

test("a bet shows its own flow before a flow left at its key", () => {
  const db = drawn({
    "mock-flows/bets-1": SETUP,
    "mock-flows/bets-2": "Invite suggestions from the admin calendar",
    "mock-flows/bets-3": "Sample project made on day one",
    "mock-flows/bets-1/own": "A welcome note that names the first three steps",
  });
  const found = flowsOfBets(db, "mock-flows", [
    { key: "mock-flows/bets-1", text: "A welcome note that names the first three steps" },
    { key: "mock-flows/bets-2", text: "Invite suggestions from the admin's calendar" },
    { key: "mock-flows/bets-3", text: "A sample project created on day one" },
  ]);
  expect(found.map((x) => x.subject)).toEqual([betSubject("mock-flows/bets-1/own"), betSubject("mock-flows/bets-2"), betSubject("mock-flows/bets-3")]);
  expect(found.every((x) => x.flow)).toBe(true);
});

test("of two alike flows, the bet keeps the one a person commented on", () => {
  const db = drawn({ "mock-kept/bets-1": SETUP, "mock-kept/bets-2": SETUP });
  const bets = [
    { key: "mock-kept/bets-1", text: "A setup checklist that shows the next step" },
    { key: "mock-kept/bets-2", text: "Welcome tour" },
  ];
  expect(flowsOfBets(db, "mock-kept", bets)[0].subject).toBe(betSubject("mock-kept/bets-1"));
  db.visuals[`one_pager_line:${betSubject("mock-kept/bets-2")}`].comments.push({} as never);
  const found = flowsOfBets(db, "mock-kept", bets)[0];
  expect(found.subject).toBe(betSubject("mock-kept/bets-2"));
  expect(found.flow).not.toBeNull();
});
