/**
 * Mock replies typed against the API schema (#1587): `reply("/v1/goals/{goal_id}", "get", body)`
 * only compiles when `body` fits that route's success response in schema.d.ts, so a mock
 * field that drifts from the API fails `tsc`. The path names the route as openapi.json does;
 * guards/mock-route-coverage.test.ts reads these names to check every route a page reads is mocked.
 */
import type { paths } from '@/lib/api/schema';

export type MockMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** A route of the schema and the methods it has. */
export type MockPath = keyof paths;
type Op<P extends MockPath, M extends MockMethod> = NonNullable<paths[P][M]>;
type Responses<P extends MockPath, M extends MockMethod> =
  Op<P, M> extends { responses: infer R } ? R : never;
type Success = 200 | 201 | 202 | 203 | 204 | 206;

/** The JSON body of a route's success response(s). */
export type MockBody<P extends MockPath, M extends MockMethod> = {
  [S in keyof Responses<P, M>]: S extends Success
    ? Responses<P, M>[S] extends { content: { 'application/json': infer B } }
      ? B
      : undefined
    : never;
}[keyof Responses<P, M>];

/**
 * draw-time (#1870): a JSON answer that keeps its text. A plain Response turns its text into bytes and
 * back for each of its copies (lib/api/shared-reads makes two), about 45 ms of the page's own thread
 * for the 500-item roadmap's 1.1 MB, which a server's answer never takes.
 */
class JsonReply extends Response {
  #text: string;
  #used = false;
  constructor(text: string, init: ResponseInit) {
    super(null, init);
    this.#text = text;
  }
  #take(): string {
    if (this.#used) throw new TypeError('body stream already read');
    this.#used = true;
    return this.#text;
  }
  override get bodyUsed() {
    return this.#used;
  }
  override get body() {
    return new Response(this.#text).body;
  }
  override async text() {
    return this.#take();
  }
  override async json() {
    return JSON.parse(this.#take());
  }
  override async arrayBuffer() {
    return new Response(this.#take()).arrayBuffer();
  }
  override async blob() {
    return new Response(this.#take(), { headers: this.headers }).blob();
  }
  override clone(): Response {
    if (this.#used) throw new TypeError('body already used');
    return new JsonReply(this.#text, {
      status: this.status,
      statusText: this.statusText,
      headers: this.headers,
    });
  }
}

/** A success reply of `path` + `method` whose body must match the schema. */
export function reply<P extends MockPath, M extends MockMethod>(
  path: P,
  method: M,
  body: MockBody<P, M>,
  status = 200,
): Response {
  if (body === undefined) return new Response(null, { status });
  return new JsonReply(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Checks a body against a route's success response without building a Response (for routes that add headers). */
export function bodyOf<P extends MockPath, M extends MockMethod>(
  path: P,
  method: M,
  body: MockBody<P, M>,
): MockBody<P, M> {
  void path;
  void method;
  return body;
}

/** Names the route of a reply whose body is not JSON (html, pdf, markdown, yaml), for the route coverage check. */
export function rawReply<P extends MockPath, M extends MockMethod>(
  path: P,
  method: M & keyof paths[P],
  res: Response,
): Response {
  void path;
  void method;
  return res;
}
