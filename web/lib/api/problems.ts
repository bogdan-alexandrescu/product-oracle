import { ApiError, unwrap, type Schemas } from "./client";

export type Problem = Schemas["Problem"];

/** A save the API rejected (422) with every problem found, e.g. a template or theme. */
export class ProblemsError extends ApiError {
  constructor(
    message: string,
    readonly problems: Problem[],
  ) {
    super(422, message);
  }
}

type Result<T> = { data?: T; error?: unknown; response: Response };

/** Like unwrap(), but a 422 carrying `problems` throws a ProblemsError with them. */
export async function unwrapProblems<T>(call: Promise<Result<T>>): Promise<T> {
  const result = await call;
  const { error, response } = result;
  if (
    response.status === 422 &&
    error &&
    typeof error === "object" &&
    "problems" in error &&
    Array.isArray(error.problems)
  ) {
    const detail = "detail" in error && typeof error.detail === "string" ? error.detail : "Rejected.";
    throw new ProblemsError(detail, error.problems as Problem[]);
  }
  return unwrap(Promise.resolve(result));
}

/** "Line 12: …" or just the message. */
export function problemText(p: Problem): string {
  return p.line != null ? `Line ${p.line}: ${p.message}` : p.message;
}
