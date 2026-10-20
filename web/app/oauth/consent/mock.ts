/**
 * Mock mode for the consent screen: answers the two /oauth/authorize/* calls and hands
 * everything else (GET /v1/me, sign-in) to the app's mock API, so "signed in" means the
 * same thing here as on every other screen.
 */
import { mockFetch } from "@/lib/api/mock/server";

export const MOCK_CONSENT = {
  client_id: "pocl_mock-example-agent",
  client_name: "Example Agent",
  redirect_uri: "http://127.0.0.1:33418/callback",
  state: "mock-state",
};

/** Request handles the mock treats specially. Anything else is a valid request. */
export const MOCK_HANDLES = { readOnly: "mock-read-only", expired: "mock-expired" };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export async function consentMockFetch(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/oauth/authorize/")) return mockFetch(req);

  const me = await mockFetch(new Request(new URL("/v1/me", url)));
  if (!me.ok) return json(401, { detail: "Not authenticated" });
  const user = (await me.json()) as { email: string; role: "viewer" | "commenter" | "approver" | "owner" };

  const decision =
    req.method === "POST" ? ((await req.json()) as { request: string; approve: boolean }) : null;
  const handle = decision ? decision.request : url.searchParams.get("request");
  if (!handle || handle === MOCK_HANDLES.expired) {
    return json(400, { detail: "This request has expired. Start again from your MCP client." });
  }
  const readOnly = handle === MOCK_HANDLES.readOnly;

  if (url.pathname === "/oauth/authorize/request") {
    return json(200, {
      client_id: MOCK_CONSENT.client_id,
      client_name: MOCK_CONSENT.client_name,
      redirect_uri: MOCK_CONSENT.redirect_uri,
      redirect_host: new URL(MOCK_CONSENT.redirect_uri).host,
      scopes: [
        { name: "oracle:read", description: "Read the baseline, sources you can see, documents and runs, and list the titles of every Notion page shared with Product Oracle, including pages in no source." },
        ...(readOnly
          ? []
          : [{ name: "oracle:write", description: "Make changes with your role: propose, comment, approve, edit." }]),
      ],
      user_email: user.email,
      user_role: user.role,
      effective_role: readOnly ? "viewer" : user.role,
    });
  }
  if (url.pathname === "/oauth/authorize/decision" && decision) {
    const back = new URL(MOCK_CONSENT.redirect_uri);
    if (decision.approve) back.searchParams.set("code", "poc_mock-code");
    else back.searchParams.set("error", "access_denied");
    back.searchParams.set("state", MOCK_CONSENT.state);
    return json(200, { redirect_to: back.toString() });
  }
  return json(404, { detail: "Route not found" });
}
