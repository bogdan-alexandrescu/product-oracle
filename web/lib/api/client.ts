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
export type SectionOut = Schemas["SectionOut"];
export type CitationOut = Schemas["CitationOut"];
export type CommentOut = Schemas["CommentOut"];
export type FeedbackItem = Schemas["FeedbackItemOut"];
export type Verdict = Schemas["SectionReviewIn"]["verdict"];
export type FeedbackStatus = FeedbackItem["status"];
export type DiffOut = Schemas["DiffOut"];
export type SectionDiff = Schemas["SectionDiff"];

/** A failed API call, carrying the HTTP status so pages can react (401 → login). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Result<T> = { data?: T; error?: unknown; response: Response };

/** Returns the data of an openapi-fetch result or throws an ApiError. */
export async function unwrap<T>(call: Promise<Result<T>>): Promise<T> {
  const { data, error, response } = await call;
  if (response.ok) return data as T;
  const detail =
    error && typeof error === "object" && "detail" in error && typeof error.detail === "string"
      ? error.detail
      : response.statusText;
  throw new ApiError(response.status, describeStatus(response.status, detail));
}

function describeStatus(status: number, detail: string): string {
  if (status === 401) return "Your session has expired. Sign in again.";
  if (status === 404) return detail || "Not found.";
  if (status === 501) return "This part of the API is not implemented yet.";
  return detail ? `${detail} (${status})` : `Request failed (${status}).`;
}
