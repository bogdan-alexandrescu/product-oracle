"use client";

import createClient from "openapi-fetch";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { AuthCard } from "@/app/login/_components/AuthCard";
import { Button, Chip, InfoTip, Label, Notice } from "@/components/ds";
import { scopeLabel } from "@/components/account/scopes";
import { Loading } from "@/components/ui";
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

/** Loopback hosts: the MCP client runs on this computer (RFC 8252 redirects). */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Where the browser returns, in words (qa-settings-41, qa4-settings-40): a loopback address is
 * the client "on this computer", by its name, its host and port only in the title; any other
 * host as it is.
 */
function returnPlace(host: string, client: string): { text: string; title?: string } {
  const name = host.replace(/:\d+$/, "").toLowerCase();
  return LOOPBACK.has(name) ? { text: `${client || "the app"} on this computer`, title: host } : { text: host };
}

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

  const back = returnPlace(detail?.redirect_host ?? "", detail?.client_name ?? "");
  // qa4-settings-40: the title names the client asking, not the protocol.
  return (
    <AuthCard title={detail ? `Let ${detail.client_name} use Product Oracle?` : "Connect an app"}>
      {error && (
        <>
          <Notice tone="error">{error}</Notice>
          {/* qa-settings-40: no request to decide on: a way on, not a dead end. */}
          {!detail && (
            <Link href="/" className="mt-4 inline-block text-[15px] font-semibold text-accent-ink hover:underline">
              Go to Oracle
            </Link>
          )}
        </>
      )}
      {!error && !detail && <Loading />}
      {detail && (
        <div className="flex flex-col gap-5" data-testid="consent">
          <p className="text-[15px]">
            <strong className="font-semibold">{detail.client_name}</strong> wants to use Product Oracle as you.
          </p>

          <section aria-labelledby="consent-scopes">
            <h2 id="consent-scopes" className="mb-2">
              <Label>It asks to</Label>
            </h2>
            <ul className="overflow-hidden rounded-button border border-line">
              {detail.scopes.map((s) => (
                <li key={s.name} className="border-t border-line px-3 py-2.5 first:border-t-0">
                  <Chip kind="acc" data-scope={s.name}>
                    {scopeLabel(s.name)}
                  </Chip>
                  <p className="mt-1 text-sm text-text">{s.description}</p>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="consent-user" className="flex flex-col gap-2">
            <h2 id="consent-user">
              <Label>Signed in as</Label>
            </h2>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span data-testid="consent-user" className="min-w-0 font-semibold break-all">
                {detail.user_email}
              </span>
              <Chip kind="acc">{ROLE_LABEL[detail.user_role]}</Chip>
            </div>
            {detail.effective_role !== detail.user_role && (
              <p className="rounded-button bg-warn-bg px-3 py-2 text-sm font-medium text-warn" data-testid="consent-effective-role">
                It will act with {ROLE_LABEL[detail.effective_role].toLowerCase()} rights only (read access).
              </p>
            )}
          </section>

          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Label>Returns to</Label>
            <span data-testid="consent-return" title={back.title} className="min-w-0 text-sm break-all">
              {back.text}
            </span>
            <InfoTip label="Consent" align="end">
              The name is the one the client gave itself. After you decide, your browser returns to {back.text}.
              Approve only if you just started this from an app you trust. Access lasts until it is revoked or
              unused for 30 days.
            </InfoTip>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Button variant="primary" disabled={pending !== null} onClick={() => decide(true)}>
              {pending === "approve" ? "Approving…" : "Approve"}
            </Button>
            <Button className="h-10! rounded-button! text-[15px]!" disabled={pending !== null} onClick={() => decide(false)}>
              {pending === "deny" ? "Denying…" : "Deny"}
            </Button>
          </div>
        </div>
      )}
    </AuthCard>
  );
}
