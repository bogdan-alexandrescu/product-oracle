import createClient from "openapi-fetch";

import type { components, paths } from "./schema";

// Same-origin: next.config.ts proxies /v1/* to the API, so the session cookie
// set by POST /v1/auth/login is sent on every call.
export const api = createClient<paths>({ baseUrl: "" });

export type Schemas = components["schemas"];
export type Me = Schemas["Me"];
export type DocumentSummary = Schemas["DocumentSummary"];
