/**
 * G3 Outcome extraction: the changes a discussion turns into (ChangeOut), the kinds its
 * subject offers, and the routes that act on them. Typed here, by hand, until the generated
 * schema carries them; every call goes through the same transport as `api` (the mock layer
 * in mock mode) and fails with the same ApiError.
 */
import { MOCK_MODE, unwrap, type Schemas } from "./client";
import { mockFetch } from "./mock/server";

export type ChangeVerb = "Stage" | "Propose" | "Resolve" | "Use as answer" | "Record" | "Apply" | "Ask";
export type ChangeStatus = "proposed" | "suggested" | "staged" | "done" | "dismissed" | "superseded";
export type PersonRef = { user_id: string; name: string };

export interface ChangeAction {
  verb: ChangeVerb;
  allowed: boolean;
  why_not: string | null;
}

export interface ChangeOut {
  id: string;
  discussion_id: string;
  kind: string;
  /** A plain sentence: "Move usage-caps to Next". */
  label: string;
  target: Record<string, unknown>;
  payload: Record<string, unknown>;
  edited_payload: Record<string, unknown> | null;
  /** One sentence with [c:n] markers. */
  rationale: string | null;
  proposed_by_kind: "oracle" | "person";
  proposed_by: PersonRef | null;
  suggested_by: PersonRef | null;
  status: ChangeStatus;
  /** The kind's main action for the caller; null for viewers. */
  action: ChangeAction | null;
  can: { suggest: boolean; edit: boolean; withdraw: boolean; dismiss: boolean };
  /** C1b: Stage asks "Why stage it anyway?" first. */
  pushback: { reason: string; sources?: number[] } | null;
  /** A private discussion: Stage asks for the reason everyone will see. */
  needs_reason: boolean;
  basis: { intake_id: string; finding_id: string }[];
  result_ref: Record<string, unknown> | null;
  decision_note: string | null;
  lock_version: number;
  created_at: string;
}

export type ChangeKindOut = { kind: string; verb: ChangeVerb; schema: Record<string, unknown> };
export type ChangeResult = { change: ChangeOut; result: Record<string, unknown> | null };

export const OPEN_STATUSES: ChangeStatus[] = ["proposed", "suggested"];
export const isOpen = (c: ChangeOut) => OPEN_STATUSES.includes(c.status);

/** Each kind as a person reads it in the "Propose a change" picker. */
export const KIND_LABEL: Record<string, string> = {
  item_horizon: "Move an item to Now, Next or Later",
  item_outcome: "Change an item's outcome",
  section_edit: "Edit a section",
  goal_measure: "Set how a goal is measured",
  entity_edit: "Edit a goal or decision",
  conflict_pick: "Settle a conflict",
  answer: "Answer a question",
  basis_record: "Record a date basis",
  priority_move: "Move a priority",
  priority_pin: "Pin a priority",
  ask_person: "Ask someone",
  scope_feature: "Include, exclude or defer a feature",
  scope_requirement: "Add, change or cut a requirement",
  decision: "Propose a decision",
};
export const kindLabel = (kind: string) => KIND_LABEL[kind] ?? kind.replace(/_/g, " ");

/** The route segment each verb posts to. */
export const VERB_ROUTE: Record<ChangeVerb, string> = {
  Stage: "stage",
  Propose: "propose",
  Resolve: "resolve",
  "Use as answer": "answer",
  Record: "verify",
  Apply: "apply",
  Ask: "ask",
};

/** One request on the API's transport; the body is JSON. */
async function send(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<{ response: Response; parsed: unknown }> {
  const init: RequestInit = {
    method,
    headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
  const req = new Request(new URL(path, window.location.origin), init);
  const response = MOCK_MODE ? await mockFetch(req) : await fetch(req);
  const text = await response.text();
  let parsed: unknown = undefined;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  return { response, parsed };
}

/** One call on the API's transport; fails with the same ApiError as `api`. */
async function call<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
  const { response, parsed } = await send(method, path, body);
  return unwrap<T>(Promise.resolve(response.ok ? { data: parsed as T, response } : { error: parsed, response }));
}

export const listChanges = (discussionId: string) => call<ChangeOut[]>("GET", `/v1/discussions/${discussionId}/changes`);

export const listChangeKinds = (discussionId: string) => call<ChangeKindOut[]>("GET", `/v1/discussions/${discussionId}/change-kinds`);

export const createChange = (
  discussionId: string,
  body: { kind: string; target: Record<string, unknown>; payload: Record<string, unknown>; rationale: string | null },
) => call<ChangeResult>("POST", `/v1/discussions/${discussionId}/changes`, body);

export const editChange = (c: ChangeOut, payload: Record<string, unknown>, rationale?: string | null) =>
  call<ChangeResult>("PATCH", `/v1/discussion-changes/${c.id}`, {
    payload,
    ...(rationale !== undefined ? { rationale } : {}),
    lock_version: c.lock_version,
  });

/** suggest, withdraw, dismiss, or the kind's verb route (stage, propose, resolve, answer, …). */
export const actOnChange = (c: ChangeOut, route: string, extra: Record<string, unknown> = {}) =>
  call<ChangeResult>("POST", `/v1/discussion-changes/${c.id}/${route}`, { ...extra, lock_version: c.lock_version });

/** One of Oracle's objections to an Apply (C9's rules, the reason check). */
export type PushbackItem = { code: string; message: string; evidence?: unknown[] };

/** Apply's 409 when Oracle pushes back: nothing is stored and the change stays open. */
export class ApplyPushback extends Error {
  constructor(
    readonly pushback: PushbackItem[],
    readonly previewRank: number | null,
    readonly heldBelow: string | null,
    detail: string,
  ) {
    super(detail);
  }
}

/**
 * Apply a priority move or pin. Without `confirm`, Oracle may push back (409, an
 * ApplyPushback with its reasons); sending again with `confirm: true` and a reason keeps it.
 */
export async function applyChange(c: ChangeOut, opts: { reason?: string; confirm?: boolean } = {}): Promise<ChangeResult> {
  const body = { ...(opts.reason ? { reason: opts.reason } : {}), ...(opts.confirm ? { confirm: true } : {}), lock_version: c.lock_version };
  const { response, parsed } = await send("POST", `/v1/discussion-changes/${c.id}/apply`, body);
  const out = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  if (response.status === 409 && out && Array.isArray(out.pushback) && out.pushback.length) {
    const items = (out.pushback as unknown[])
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
      .map((x) => ({ code: String(x.code ?? ""), message: String(x.message ?? ""), ...(Array.isArray(x.evidence) ? { evidence: x.evidence } : {}) }));
    throw new ApplyPushback(
      items,
      typeof out.preview_rank === "number" ? out.preview_rank : null,
      typeof out.held_below === "string" ? out.held_below : null,
      typeof out.detail === "string" ? out.detail : "Oracle pushed back on this",
    );
  }
  return unwrap<ChangeResult>(Promise.resolve(response.ok ? { data: parsed as ChangeResult, response } : { error: parsed, response }));
}

/** Ask Oracle for a summary draft; `replace` when the starter replaces a confirmed one. */
export const askSummary = (discussionId: string, replace = false) =>
  call<Schemas["DiscussionOut"]>("POST", `/v1/discussions/${discussionId}/summary`, replace ? { replace: true } : {});

/** The rationale without its [c:n] markers: the prefill of a private discussion's shared reason. */
export const stripMarkers = (text: string | null | undefined) =>
  (text ?? "")
    .replace(/\s*\[c:\d{1,4}\]/g, "")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
