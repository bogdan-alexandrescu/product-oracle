"use client";

import createClient from "openapi-fetch";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { Badge, Button, ErrorNote, Loading } from "@/components/ui";
import { ApiError, MOCK_MODE, unwrap, type Schemas } from "@/lib/api/client";
import type { paths } from "@/lib/api/schema";

import { consentMockFetch } from "./mock";

type ConsentRequest = Schemas["ConsentRequestOut"];

// Same origin as the app: /oauth/authorize/* is routed to the API (see the deploy notes).
const oauthApi = createClient<paths>({ baseUrl: "", ...(MOCK_MODE ? { fetch: consentMockFetch } : {}) });

const ROLE_LABEL: Record<ConsentRequest["user_role"], string> = {
  viewer: "Viewer",
  commenter: "Commenter",
  approver: "Approver",
  owner: "Owner",
};

/**
 * The OAuth consent screen: an MCP client asks to act for the signed-in user. Reached
 * from GET /oauth/authorize with a signed request handle; Approve or Deny sends the
 * browser back to the client's redirect URI.
 */
export function ConsentScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const handle = useSearchParams().get("request") ?? "";
  const [detail, setDetail] = useState<ConsentRequest | null>(null);
  const [failure, setError] = useState<string | null>(null);
  const error = handle
    ? failure
    : "This page needs a request from an MCP client. Start again from your MCP client.";
  const [pending, setPending] = useState<"approve" | "deny" | null>(null);

  useEffect(() => {
    if (!handle) return;
    let live = true;
    unwrap(oauthApi.GET("/oauth/authorize/request", { params: { query: { request: handle } } }))
      .then((d) => live && setDetail(d))
      .catch((e: unknown) => {
        if (!live) return;
        if (e instanceof ApiError && e.status === 401) {
          const back = `${pathname}?request=${encodeURIComponent(handle)}`;
          router.replace(`/login?next=${encodeURIComponent(back)}`);
          return;
        }
        setError(e instanceof Error ? e.message : "Cannot load this request.");
      });
    return () => {
      live = false;
    };
  }, [handle, pathname, router]);

  async function decide(approve: boolean) {
    setPending(approve ? "approve" : "deny");
    setError(null);
    try {
      const { redirect_to } = await unwrap(
        oauthApi.POST("/oauth/authorize/decision", { body: { request: handle, approve } }),
      );
      window.location.assign(redirect_to);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Cannot record your decision.");
      setPending(null);
    }
  }

  return (
    <div className="mx-auto mt-16 max-w-md px-6">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Connect an MCP client</h1>
      {error && <ErrorNote>{error}</ErrorNote>}
      {!error && !detail && <Loading />}
      {detail && (
        <div className="mt-4 space-y-5" data-testid="consent">
          <p className="text-sm text-neutral-700">
            <strong className="font-semibold text-neutral-900">{detail.client_name}</strong> wants to use Product
            Oracle as you.
          </p>

          <section aria-labelledby="consent-scopes">
            <h2 id="consent-scopes" className="mb-2 text-xs font-semibold tracking-wide text-neutral-500 uppercase">
              It asks to
            </h2>
            <ul className="space-y-2">
              {detail.scopes.map((s) => (
                <li key={s.name} className="rounded-md border border-neutral-200 px-3 py-2 text-sm">
                  <span className="font-mono text-xs text-neutral-500">{s.name}</span>
                  <p className="text-neutral-800">{s.description}</p>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="consent-user" className="text-sm text-neutral-700">
            <h2 id="consent-user" className="mb-1 text-xs font-semibold tracking-wide text-neutral-500 uppercase">
              Signed in as
            </h2>
            <p>
              <span data-testid="consent-user">{detail.user_email}</span>{" "}
              <Badge>{ROLE_LABEL[detail.user_role]}</Badge>
            </p>
            {detail.effective_role !== detail.user_role && (
              <p className="mt-1 text-neutral-500" data-testid="consent-effective-role">
                It will act with {ROLE_LABEL[detail.effective_role].toLowerCase()} rights only (read access).
              </p>
            )}
          </section>

          <p className="text-xs text-neutral-500">
            The name is the one the client gave itself. After you decide, your browser returns to{" "}
            <span className="font-mono">{detail.redirect_host}</span>. Approve only if you just started this from an
            MCP client you trust. Access lasts until it is revoked or unused for 30 days.
          </p>

          <div className="flex gap-3">
            <Button variant="primary" className="flex-1 py-2" disabled={pending !== null} onClick={() => decide(true)}>
              {pending === "approve" ? "Approving…" : "Approve"}
            </Button>
            <Button className="flex-1 py-2" disabled={pending !== null} onClick={() => decide(false)}>
              {pending === "deny" ? "Denying…" : "Deny"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
