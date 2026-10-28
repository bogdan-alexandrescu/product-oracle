/**
 * B6 Goals interview's routes, and G3's generic change actions on its versions, typed here:
 * the calls go through the same client (mock or real), by path.
 */
import { api, unwrap, type EntityOut, type Schemas } from "./client";

/** goal_measure's payload (G1 registry, extended with B5's fields). */
export type GoalMeasure = {
  entity_id: string;
  metric?: string | null;
  unit?: string | null;
  comparison?: string | null;
  target?: number | null;
  start?: number | null;
  horizon?: string | null;
  due?: string | null;
  owner_id?: string | null;
  weight?: number | null;
};

/** DiscussionChangeOut, with what B6 adds (result_ref, pushback, override_reason). */
export type DiscussionChange = Omit<Schemas["DiscussionChangeOut"], "payload" | "edited_payload"> & {
  payload: GoalMeasure & Record<string, unknown>;
  edited_payload: (GoalMeasure & Record<string, unknown>) | null;
  result_ref?: { proposal_id: string } | null;
  pushback?: { reason: string } | null;
  override_reason?: string | null;
};

export type VagueGoal = { entity: EntityOut; missing: string[]; discussion_id: string | null };
export type Started = { discussion_id: string; created: boolean };

type Init = { params?: { path?: Record<string, string>; query?: Record<string, unknown> }; body?: unknown };
type Call = (path: string, init?: Init) => Promise<{ data?: unknown; error?: unknown; response: Response }>;
const loose = api as unknown as { GET: Call; POST: Call };

/** POST /v1/baseline/entities/{goal_id}/interview: the open interview on the goal, or a new one. */
export function startInterview(goalId: string, priv = false): Promise<Started> {
  return unwrap(
    loose.POST("/v1/baseline/entities/{entity_id}/interview", { params: { path: { entity_id: goalId } }, body: { private: priv } }),
  ) as Promise<Started>;
}

/** POST /v1/baseline/goals/interview: one discussion per goal named (the stepper names one at a time). */
export async function startInterviews(ids: string[]): Promise<(Started & { entity_id: string })[]> {
  const out = (await unwrap(loose.POST("/v1/baseline/goals/interview", { body: { entity_ids: ids } }))) as {
    discussions: (Started & { entity_id: string })[];
  };
  return out.discussions;
}

/** GET /v1/baseline/goals/vague: the confirmed and proposed goals not measurable yet. */
export function vagueGoals(): Promise<VagueGoal[]> {
  return unwrap(loose.GET("/v1/baseline/goals/vague")) as Promise<VagueGoal[]>;
}

/** GET /v1/discussions/{id}/changes. */
export function discussionChanges(discussionId: string): Promise<DiscussionChange[]> {
  return unwrap(loose.GET("/v1/discussions/{discussion_id}/changes", { params: { path: { discussion_id: discussionId } } })) as Promise<
    DiscussionChange[]
  >;
}

/** What Propose answered: the change, B5's refusals (422), or Oracle's pushback (409). */
export type ProposeResult =
  | { kind: "ok"; change: DiscussionChange }
  | { kind: "invalid"; errors: Schemas["GoalProblem"][] }
  | { kind: "pushback"; reason: string }
  | { kind: "error"; message: string };

/**
 * G3's generic Propose (POST /v1/discussion-changes/{change_id}/propose; B6's own route is
 * gone): `payload` is the person's Edit (null: as offered), saved only when it is used.
 * Oracle's pushback comes once; proposing again keeps the target.
 */
export async function proposeMeasure(change: DiscussionChange, payload: GoalMeasure | null): Promise<ProposeResult> {
  const { data, error, response } = await loose.POST("/v1/discussion-changes/{change_id}/propose", {
    params: { path: { change_id: change.id } },
    body: { lock_version: change.lock_version, ...(payload ? { payload } : {}) },
  });
  if (response.ok) return { kind: "ok", change: (data as { change: DiscussionChange }).change };
  const body = (error ?? {}) as { detail?: unknown; errors?: unknown; pushback?: unknown };
  if (response.status === 422 && Array.isArray(body.errors)) return { kind: "invalid", errors: body.errors as Schemas["GoalProblem"][] };
  if (response.status === 409 && body.pushback) return { kind: "pushback", reason: String(body.detail ?? "") };
  return { kind: "error", message: typeof body.detail === "string" ? body.detail : "Something went wrong. Try again." };
}

/** G3's generic Dismiss (POST /v1/discussion-changes/{change_id}/dismiss; approvers). */
export async function dismissMeasure(change: DiscussionChange): Promise<DiscussionChange> {
  const out = (await unwrap(
    loose.POST("/v1/discussion-changes/{change_id}/dismiss", { params: { path: { change_id: change.id } }, body: { lock_version: change.lock_version } }),
  )) as { change: DiscussionChange };
  return out.change;
}
