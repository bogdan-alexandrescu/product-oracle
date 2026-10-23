/**
 * C3 customer interviews: the API's shapes and two small transports, until the routes are in
 * the generated schema (`make openapi`). Members' calls go through the same cookie session as
 * the typed client; the customer page's calls (`/v1/public/interviews/...`) carry no member
 * credential, only the interview's own cookie (credentials "include"). In mock mode both go
 * to the in-browser mock, as the typed client does.
 */
import { ApiError, MOCK_MODE } from "./client";
import { mockFetch } from "./mock/server";

export type InterviewStatus = "draft" | "invited" | "in_progress" | "finished" | "expired" | "revoked";
export type JobState = { id: string; status: "queued" | "running" | "succeeded" | "failed" | "cancelled"; error: string | null };
export type GuideItem = { id: string; prompt: string; purpose: string | null };
export type InterviewMessage = {
  id: string;
  role: "oracle" | "interviewee";
  kind: "intro" | "question" | "ack" | "follow_up" | "answer" | "skip" | "closing";
  body: string;
  guide_item: string | null;
  /** Team interviews: the intake question it is about. */
  question_id?: string | null;
  created_at: string;
};
export type InterviewSnapshot = {
  quick_facts?: string[];
  quotes?: { text: string; question_id: string | null }[];
  needs?: { title: string; quote: string; question_id: string | null }[];
  insights?: string[];
};
export type InterviewSubject = { intake_id: string } | { theme_id: string } | { topic: string };

export type InterviewOut = {
  id: string;
  kind: "customer" | "team";
  status: InterviewStatus;
  title: string;
  intake_id: string | null;
  theme_id: string | null;
  topic: string | null;
  intro: string | null;
  guide: GuideItem[];
  guide_job: JobState | null;
  interviewee_name: string | null;
  interviewee_company: string | null;
  link_expires_at: string | null;
  link_opened_at: string | null;
  created_by: string;
  created_by_name: string | null;
  created_at: string;
  finished_at: string | null;
  lock_version: number;
  messages: InterviewMessage[];
  snapshot: InterviewSnapshot;
  snapshot_job: JobState | null;
  request_ids: string[];
  can_manage: boolean;
};

export type InterviewSummary = Pick<
  InterviewOut,
  "id" | "kind" | "status" | "title" | "interviewee_name" | "interviewee_company" | "created_by" | "created_by_name" | "created_at" | "finished_at"
> & { request_count: number };

export type InterviewCreate = {
  kind: "customer";
  interviewee_name: string;
  interviewee_company?: string | null;
  subject: InterviewSubject;
};
export type InterviewPatch = {
  lock_version: number;
  intro?: string;
  guide?: { id?: string; prompt: string; purpose?: string | null }[];
  interviewee_name?: string;
  interviewee_company?: string | null;
};
export type InterviewLink = { url: string; expires_at: string };

export type PublicMessage = { role: "oracle" | "customer"; body: string; at: string };
export type PublicProgress = { asked: number; total: number };
export type PublicInterview = {
  company: string;
  interviewee_name: string;
  intro: string;
  status: "invited" | "in_progress" | "finished";
  messages: PublicMessage[];
  progress: PublicProgress;
};
export type PublicTurn = { messages: PublicMessage[]; progress: PublicProgress; done: boolean };

export const INTERVIEW_STATUS_LABEL: Record<InterviewStatus, string> = {
  draft: "Draft",
  invited: "Invited",
  in_progress: "In progress",
  finished: "Finished",
  expired: "Expired",
  revoked: "Withdrawn",
};

/** The status chip's tone (ds Chip kinds). */
export const INTERVIEW_STATUS_KIND: Record<InterviewStatus, "na" | "now" | "warn" | "pass"> = {
  draft: "na",
  invited: "now",
  in_progress: "warn",
  finished: "pass",
  expired: "na",
  revoked: "na",
};

/** Limits the API enforces (oracle.interviews.schemas). */
export const LIMITS = { name: 120, company: 120, topic: 300, intro: 300, prompt: 300, questions: 8, message: 2000 } as const;

const send = (req: Request) => (MOCK_MODE ? mockFetch(req) : fetch(req));

function request(method: string, path: string, body?: unknown, credentials?: RequestCredentials): Request {
  return new Request(new URL(path, window.location.origin), {
    method,
    credentials,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => "");
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** A member's call to /v1/interviews...: the data, or an ApiError (401 sends useQuery to sign-in). */
export async function interviewsCall<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await send(request(method, path, body));
  const data = await readJson(res);
  if (res.ok) return data as T;
  const detail = data && typeof data === "object" && "detail" in data ? (data as { detail: unknown }).detail : null;
  const message =
    res.status === 401
      ? "Your session has expired. Sign in again."
      : typeof detail === "string"
        ? detail
        : `Request failed (${res.status}).`;
  throw new ApiError(res.status, message);
}

/** What a public call answered: its status and body, never thrown (the page shows refusals). */
export type PublicResult<T> = { status: number; data: T | null; reason: string | null; detail: string | null };

/** The customer page's call to /v1/public/interviews/{token}...; a network failure reads as status 0. */
export async function publicCall<T>(method: "GET" | "POST", token: string, action = "", body?: unknown): Promise<PublicResult<T>> {
  const path = `/v1/public/interviews/${encodeURIComponent(token)}${action ? `/${action}` : ""}`;
  try {
    const res = await send(request(method, path, body, "include"));
    const data = (await readJson(res)) as Record<string, unknown> | null;
    const reason = data && typeof data.reason === "string" ? data.reason : null;
    const detail = data && typeof data.detail === "string" ? data.detail : null;
    return { status: res.status, data: res.ok ? (data as T) : null, reason, detail };
  } catch {
    return { status: 0, data: null, reason: null, detail: null };
  }
}
