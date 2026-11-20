/**
 * Mock replies typed against the API schema (#1587): `reply("/v1/goals/{goal_id}", "get", body)`
 * only compiles when `body` fits that route's success response in schema.d.ts, so a mock
 * field that drifts from the API fails `tsc`. The path names the route as openapi.json does;
 * e2e/mock-route-coverage.spec.ts reads these names to check every route a page reads is mocked.
 */
import type { paths } from "@/lib/api/schema";

export type MockMethod = "get" | "post" | "put" | "patch" | "delete";

/** A route of the schema and the methods it has. */
export type MockPath = keyof paths;
type Op<P extends MockPath, M extends MockMethod> = NonNullable<paths[P][M]>;
type Responses<P extends MockPath, M extends MockMethod> = Op<P, M> extends { responses: infer R } ? R : never;
type Success = 200 | 201 | 202 | 203 | 204 | 206;

/** The JSON body of a route's success response(s). */
export type MockBody<P extends MockPath, M extends MockMethod> = {
  [S in keyof Responses<P, M>]: S extends Success
    ? Responses<P, M>[S] extends { content: { "application/json": infer B } }
      ? B
      : undefined
    : never;
}[keyof Responses<P, M>];

/** A success reply of `path` + `method` whose body must match the schema. */
export function reply<P extends MockPath, M extends MockMethod>(path: P, method: M, body: MockBody<P, M>, status = 200): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { "content-type": "application/json" },
  });
}

/** Checks a body against a route's success response without building a Response (for routes that add headers). */
export function bodyOf<P extends MockPath, M extends MockMethod>(path: P, method: M, body: MockBody<P, M>): MockBody<P, M> {
  void path;
  void method;
  return body;
}
