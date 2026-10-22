import { expect, test } from "@playwright/test";

import { routeIntake, type IntakeContext } from "../lib/api/mock/intake";
import { seedV2 } from "../lib/api/mock/v2";

/**
 * The intake mock (CR-03), its routes driven directly: the shapes the API returns, and the
 * same rules. Its screens (New PRD, Before drafting) have their own specs
 * (new-prd-door.spec.ts, intake-page.spec.ts).
 */
const USER = "b1000000-0000-4000-8000-000000000001";

function setup(role: IntakeContext["role"] = "commenter") {
  const db = seedV2("d1000000-0000-4000-8000-000000000001", null, USER);
  const runs: unknown[] = [];
  const ctx: IntakeContext = {
    userId: USER,
    role,
    createRun: async (body) => {
      runs.push(body);
      return new Response(JSON.stringify({ id: "r1000000-0000-4000-8000-000000000001", status: "draft" }), { status: 201 });
    },
  };
  const call = async (method: string, path: string, body?: unknown, as: IntakeContext = ctx) => {
    const url = new URL(path, "http://mock");
    const req = new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    const resp = await routeIntake(db, as, req, url.pathname.split("/").filter(Boolean), url.searchParams);
    return { status: resp?.status ?? 0, body: resp ? await resp.json() : null };
  };
  return { db, ctx, runs, call };
}

test("intake mock: new idea, summary, a batch, answers and research", async () => {
  const { call, ctx, runs } = setup();
  const created = await call("POST", "/v1/intakes", {
    title: "Saved addresses",
    brief: "Returning buyers retype their address at every checkout. Add saved addresses.",
  });
  expect(created.status).toBe(201);
  const intake = created.body.intake;
  expect(intake.status).toBe("awaiting_answers");
  expect(created.body.gaps).toHaveLength(17);
  expect(created.body.batch.current).toBe(1);
  expect(created.body.template.modules.map((m: { policy: string }) => m.policy)).toContain("required");
  expect(created.body.readiness.gate).toBe("clear");

  const batch = await call("GET", `/v1/intakes/${intake.id}/question-batch`);
  expect(batch.body.questions).toHaveLength(5);
  expect(batch.body.questions[0].answer_paths).toEqual(["answer", "dont_know", "defer", "delegate", "research"]);
  const first = batch.body.questions[0].question;

  const answered = await call("POST", `/v1/questions/${first.id}/answers`, { kind: "answer", body: "Repeat checkout time" });
  expect(answered.status).toBe(201);
  // B4: a commenter's answer never clears a critical gap on its own.
  expect(answered.body.gap.status).toBe(answered.body.gap.importance === "critical" ? "answered_pending_review" : "answered");
  expect((await call("POST", `/v1/questions/${first.id}/answers`, { kind: "answer", body: "Again" })).status).toBe(409);

  const second = batch.body.questions[1].question;
  const research = await call("POST", `/v1/questions/${second.id}/answers`, { kind: "research" });
  expect(research.body.gap.status).toBe("under_investigation");
  const [proposal] = research.body.proposals;
  expect(proposal.kind).toBe("research_run");
  const url = `/v1/intake-proposals/${proposal.id}/accept`;
  expect((await call("POST", url)).status).toBe(403);
  const accepted = await call("POST", url, undefined, { ...ctx, role: "approver" });
  expect(accepted.body.status).toBe("accepted");
  expect(runs).toHaveLength(1);

  const next = await call("POST", `/v1/intakes/${intake.id}/question-batches`);
  expect(next.body.batch).toBe(2);
});

test("intake mock: roles, decisions and unknown ids", async () => {
  const { call, ctx } = setup("viewer");
  expect((await call("POST", "/v1/intakes", { title: "x", brief: "A brief that is long enough to count." })).status).toBe(403);
  const asCommenter = { ...ctx, role: "commenter" as const };
  const created = await call("POST", "/v1/intakes", { title: "x", brief: "A brief that is long enough to count." }, asCommenter);
  const critical = created.body.gaps.find((g: { importance: string }) => g.importance === "critical");
  const decide = (role: IntakeContext["role"]) =>
    call("POST", `/v1/gaps/${critical.id}/decisions`, { decision: "accept_risk", rationale: "Measured later" }, { ...ctx, role });
  expect((await decide("approver")).status).toBe(403);
  const decided = await decide("owner");
  expect(decided.status).toBe(201);
  expect(decided.body.gap.status).toBe("accepted_risk");
  expect((await call("GET", "/v1/intakes/00000000-0000-4000-8000-000000000000/summary")).status).toBe(404);
});

test("intake mock: the author's rules (S6, B4)", async () => {
  const { call, ctx } = setup();
  const created = await call("POST", "/v1/intakes", { title: "x", brief: "A brief that is long enough to count." });
  const id = created.body.intake.id;
  expect(created.body.is_author).toBe(true);
  expect(created.body.shared_counts).toEqual([]);
  const other = { ...ctx, userId: "b2000000-0000-4000-8000-000000000002" };
  const theirs = await call("GET", `/v1/intakes/${id}/summary`, undefined, other);
  expect(theirs.body.is_author).toBe(false);
  expect(theirs.body.new_evidence.count).toBeNull();
  expect((await call("GET", `/v1/intakes/${id}/findings`, undefined, other)).body).toEqual([]);
  // Only the author repins, re-analyses or shares; the author or an approver asks a batch.
  for (const leaf of ["repin", "analyze"]) {
    expect((await call("POST", `/v1/intakes/${id}/${leaf}`, undefined, { ...other, role: "owner" })).status).toBe(403);
    expect((await call("POST", `/v1/intakes/${id}/${leaf}`)).status).toBe(200);
  }
  const share = { changes: [{ finding_id: "f1000000-0000-4000-8000-000000000001", sharing: "full" }] };
  expect((await call("POST", `/v1/intakes/${id}/findings/sharing`, share, { ...other, role: "owner" })).status).toBe(403);
  expect((await call("POST", `/v1/intakes/${id}/question-batches`, undefined, other)).status).toBe(403);
  expect((await call("POST", `/v1/intakes/${id}/question-batches`, undefined, { ...other, role: "approver" })).status).toBe(200);
  // Lowering a critical gap or validating it unanswered takes an owner.
  const critical = created.body.gaps.find((g: { importance: string }) => g.importance === "critical");
  const lower = { importance: "low", lock_version: critical.lock_version };
  expect((await call("PATCH", `/v1/gaps/${critical.id}`, lower, { ...ctx, role: "approver" })).status).toBe(403);
  const validate = { decision: "validate", rationale: "Checked" };
  expect((await call("POST", `/v1/gaps/${critical.id}/decisions`, validate, { ...ctx, role: "approver" })).status).toBe(403);
  expect((await call("POST", `/v1/gaps/${critical.id}/decisions`, validate, { ...ctx, role: "owner" })).status).toBe(201);
});
