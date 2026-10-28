import createClient from "openapi-fetch";

import { mockFetch } from "./mock/server";
import type { components, paths } from "./schema";

/**
 * Mock mode (NEXT_PUBLIC_API_MOCKS=1, inlined at build time) swaps the transport for
 * an in-browser fake of the API backed by fixtures; every call site stays the same.
 */
export const MOCK_MODE = process.env.NEXT_PUBLIC_API_MOCKS === "1";

// Same-origin: next.config.ts proxies /v1/* to the API, so the session cookie
// set by POST /v1/auth/login is sent on every call.
export const api = createClient<paths>({
  baseUrl: "",
  ...(MOCK_MODE ? { fetch: mockFetch } : {}),
});

export type Schemas = components["schemas"];
export type Me = Schemas["Me"];
export type DocumentSummary = Schemas["DocumentSummary"];
export type DocumentOut = Schemas["DocumentOut"];
export type VersionOut = Schemas["VersionOut"];
export type VersionSummary = Schemas["VersionSummary"];
export type VersionSource = Schemas["VersionSource"];
export type SectionOut = Schemas["SectionOut"];
export type CitationOut = Schemas["CitationOut"];
export type DateMarkOut = Schemas["DateMarkOut"];
export type CommentOut = Schemas["CommentOut"];
export type FeedbackItem = Schemas["FeedbackItemOut"];
export type Verdict = Schemas["SectionReviewIn"]["verdict"];
export type FeedbackStatus = FeedbackItem["status"];
export type DiffOut = Schemas["DiffOut"];
export type SectionDiff = Schemas["SectionDiff"];
export type Member = Schemas["MemberOut"];
// Account management: every credential by kind (Settings > API tokens) and My account.
export type ApiToken = Schemas["ApiTokenOut"];
export type TokenKind = NonNullable<ApiToken["kind"]>;
export type MyAccount = Schemas["MyAccountOut"];
export type McpClient = Schemas["McpClientOut"];

// Brief, full and present (O1f).
export type DeckOut = Schemas["DeckOut"];
export type SlideOut = Schemas["SlideOut"];
export type ExpandOut = Schemas["ExpandOut"];

// Built-in model jobs (/v1/.../llm-jobs, suggestions, reports).
export type LlmJob = Schemas["LlmJobOut"];
export type LlmJobKind = LlmJob["kind"];
export type JobSettings = Schemas["JobSettings"];
export type Suggestion = Schemas["SuggestionOut"];
export type VersionReports = Schemas["VersionReports"];
export type RefinementPreview = Schemas["RefinementPreview"];
export type Invite = Schemas["InviteOut"];

// Baseline graph (/v1/baseline/...).
export type EntityOut = Schemas["EntityOut"];
export type EntityDetail = Schemas["EntityDetail"];
export type EntityType = EntityOut["type"];
export type NodeStatus = EntityOut["status"];
export type EdgeOut = Schemas["EdgeOut"];
export type EdgeType = EdgeOut["type"];
export type GraphOut = Schemas["GraphOut"];
export type EvidenceOut = Schemas["EvidenceOut"];
export type LinkPreviewOut = Schemas["LinkPreviewOut"];
export type TraceReport = Schemas["TraceReport"];
export type TraceFeature = Schemas["TraceFeature"];
export type TraceGoal = Schemas["TraceGoal"];
export type ConflictOut = Schemas["ConflictOut"];
export type ProposalOut = Schemas["ProposalOut"];
export type EntityPatch = Schemas["EntityPatch"];
export type EntityWriteOut = Schemas["EntityWriteOut"];

/** A failed API call, carrying the HTTP status so pages can react (401 → login). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The API's machine-readable code, when the error body has one ("source_changed"). */
    readonly code?: string,
    /** Seconds to wait before trying again, from a 429's Retry-After. */
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

/** Retry-After in seconds (as seconds or an HTTP date); undefined when absent or unreadable. */
function retryAfter(response: Response): number | undefined {
  const value = response.headers.get("Retry-After");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, (at - Date.now()) / 1000);
}

type Result<T> = { data?: T; error?: unknown; response: Response };

/** Returns the data of an openapi-fetch result or throws an ApiError. */
export async function unwrap<T>(call: Promise<Result<T>>): Promise<T> {
  const { data, error, response } = await call;
  if (response.ok) return data as T;
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    const message = "message" in error && typeof error.message === "string" ? error.message : response.statusText;
    throw new ApiError(response.status, message, error.code, retryAfter(response));
  }
  // A structured refusal ({detail: {code, message}}, e.g. D8 "review_changed") keeps its code.
  const inner = error && typeof error === "object" && "detail" in error ? error.detail : null;
  if (inner && typeof inner === "object" && "code" in inner && typeof inner.code === "string") {
    const message = "message" in inner && typeof inner.message === "string" ? inner.message : response.statusText;
    throw new ApiError(response.status, message, inner.code);
  }
  // {detail: {message, …}} without a code (e.g. S8's 409 "has its meeting already") says its message.
  const said = inner && typeof inner === "object" && "message" in inner && typeof inner.message === "string" ? inner.message : null;
  const detail =
    error && typeof error === "object" && "detail" in error && typeof error.detail === "string"
      ? error.detail
      : (said ?? response.statusText);
  throw new ApiError(response.status, describeStatus(response.status, detail), undefined, retryAfter(response));
}

function describeStatus(status: number, detail: string): string {
  if (status === 401) return "Your session has expired. Sign in again.";
  if (status === 404) return detail || "Not found.";
  if (status === 501) return "This part of the API is not implemented yet.";
  return detail ? `${detail} (${status})` : `Request failed (${status}).`;
}
