"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useId, useState, type FormEvent } from "react";

import { Button, Chip, InfoTip, Notice, PageHeader, Panel, type ChipKind } from "@/components/ds";
import { api, ApiError, unwrap, type Schemas } from "@/lib/api/client";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

import { Field, INPUT } from "../_components/fields";

type Connection = Schemas["ConnectionOut"];
type Provider = Schemas["ProviderOut"];
type Data = { providers: Provider[]; connections: Connection[] };

const STATUS_KIND: Record<Connection["status"], ChipKind> = { active: "pass", expired: "warn", revoked: "na", error: "crit" };
const STATUS_LABEL = { active: "Connected", expired: "Expired", revoked: "Revoked", error: "Error" } as const;
/** An active row's chip says how it was connected, in words (qa-onboarding-22). */
const connectedBy = (mode: Connection["auth_mode"]) =>
  mode === "oauth" ? "Connected by signing in" : "Connected with a token";
/** The chip on a card: what a provider pulls in, in a word or two. */
const KIND_SHORT: Record<string, string> = {
  github: "Repos",
  slack: "Channels",
  notion: "Pages",
  fireflies: "Transcripts",
  google_docs: "Docs",
};
/** The (i) behind the chips: what exactly it pulls in. */
const KIND_LABEL: Record<string, string> = {
  github: "repos, issues, pull requests, releases",
  slack: "channels you pick (never direct messages)",
  notion: "pages you share",
  fireflies: "meeting transcripts",
  google_docs: "Google Docs",
};

async function loadAll(): Promise<Data> {
  const [providers, connections] = await Promise.all([
    unwrap(api.GET("/v1/connections/providers")),
    unwrap(api.GET("/v1/connections")),
  ]);
  return { providers, connections };
}

/** Settings > Connections: the signed-in user's own accounts, one panel per provider. */
export function ConnectionsSettings() {
  const params = useSearchParams();
  const q = useQuery("connections", loadAll);
  const connected = params.get("connected");
  const callbackError = params.get("error");

  const providers = q.data?.providers ?? [];
  const nameOf = (key: string | null) => providers.find((p) => p.key === key)?.name ?? key;
  const active = q.data?.connections.filter((c) => c.status === "active").length ?? 0;
  const broken = q.data?.connections.filter((c) => c.status === "expired" || c.status === "error").length ?? 0;

  return (
    <>
      <PageHeader
        title="Connections"
        info={
          <InfoTip label="connections" align="start" side="bottom">
            Your own accounts. Only you see these connections and what they pull in; nobody else in the company can
            use them. Oracle&apos;s own Claude calls run on the company&apos;s{" "}
            <Link href="/settings/claude-accounts" className="underline">
              Claude accounts
            </Link>
            .
          </InfoTip>
        }
        status={
          <>
            {q.data && (
              <Chip kind="line">
                <span className="tnum">{active}</span> connected
              </Chip>
            )}
            {broken > 0 && (
              <Chip kind="warn" dot>
                {broken} to fix
              </Chip>
            )}
          </>
        }
      />

      <div className="flex min-w-0 flex-col gap-4 max-[600px]:gap-3">
        {connected && !callbackError && <Notice tone="pass">{nameOf(connected)} is connected.</Notice>}
        {callbackError && (
          <Notice tone="error">
            {params.get("provider") ? `${nameOf(params.get("provider"))}: ` : ""}
            {callbackError}
          </Notice>
        )}
        {q.error && <Notice tone="error">{q.error}</Notice>}

        {q.loading && !q.data && (
          <div aria-busy className="grid gap-4 md:grid-cols-2">
            {[0, 1].map((i) => (
              <div key={i} className="h-40 animate-pulse rounded-panel border border-line bg-surface" />
            ))}
          </div>
        )}

        {q.data && (
          <div className="grid items-start gap-4 md:grid-cols-2 max-[600px]:gap-3">
            {providers.map((p) => (
              <ProviderCard
                key={p.key}
                provider={p}
                connections={q.data!.connections.filter((c) => c.provider === p.key)}
                reload={q.reload}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function ProviderCard({
  provider,
  connections,
  reload,
}: {
  provider: Provider;
  connections: Connection[];
  reload: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [pasting, setPasting] = useState(false);

  async function signIn() {
    setPending(true);
    setError(null);
    try {
      const { url } = await unwrap(
        api.GET("/v1/connections/{provider}/authorize", { params: { path: { provider: provider.key } } }),
      );
      window.location.assign(url);
    } catch (e) {
      setError(errorMessage(e));
      setPending(false);
    }
  }

  return (
    <Panel
      testId={`connection-card-${provider.key}`}
      title={provider.name}
      count={connections.length || undefined}
      tools={
        <>
          {provider.source_kinds.map((k) => (
            <Chip key={k} kind="acc">
              {KIND_SHORT[k] ?? k}
            </Chip>
          ))}
          <InfoTip label={`what ${provider.name} pulls in`}>
            Pulls in {provider.source_kinds.map((k) => KIND_LABEL[k] ?? k).join(", ")}.
          </InfoTip>
        </>
      }
    >
      {provider.key === "slack" && <CompanySlack />}
      {connections.length === 0 ? (
        <p className="px-4 py-3 text-[15px] text-text2">Not connected</p>
      ) : (
        <ul aria-label={`${provider.name} accounts`} className="flex flex-col">
          {connections.map((c) => (
            <ConnectionRow key={c.id} connection={c} reload={reload} />
          ))}
        </ul>
      )}
      {pasting && <TokenForm provider={provider} reload={reload} close={() => setPasting(false)} />}
      <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2.5">
        {provider.oauth_configured && (
          <Button variant="solid" icon="link" onClick={signIn} disabled={pending}>
            Connect with {provider.name}
          </Button>
        )}
        {!pasting && (
          // With an account already here, its row's Reconnect is the one way to renew it;
          // this adds another account (qa-onboarding-22).
          <Button onClick={() => setPasting(true)}>
            {connections.length ? "Add another account" : "Paste a token"}
          </Button>
        )}
      </div>
      {error && (
        <div className="px-4 pb-3">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
    </Panel>
  );
}

/**
 * Oracle's own Slack app beside the person's Slack account (qa-settings-21): read from the
 * same status the Notifications page reads, so the two pages never disagree. The app is the
 * company's (it posts reports and mirrors discussions); the rows below are this person's own
 * Slack, which pulls channels they pick into Oracle.
 */
function CompanySlack() {
  const status = useQuery("slack-status", () => unwrap(api.GET("/v1/company-integrations/slack/status")));
  const owner = useMe().can("list_company_integrations");
  if (!status.data) return null;
  const s = status.data;
  return (
    <div data-testid="company-slack" className="flex flex-col gap-1 border-b border-line px-4 py-3 text-sm max-[600px]:px-3">
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">Oracle&apos;s Slack app</span>
        <Chip kind={s.connected ? (s.needs_reconnect ? "warn" : "pass") : "na"} dot>
          {s.connected ? (s.needs_reconnect ? "Installed, needs a reconnect" : "Installed for notifications") : "Not installed"}
        </Chip>
      </p>
      <p className="text-text2">
        {s.connected ? (s.label ? <>Installed for the company in {s.label}: it </> : "Installed for the company, it ") : "Once installed for the company, it "}
        posts the weekly report and mirrors discussions.{" "}
        {owner ? (
          <>
            It is set up on{" "}
            <Link href="/settings/notifications" className="font-medium text-accent underline underline-offset-2">
              Notifications
            </Link>
            .
          </>
        ) : (
          "An owner sets it up on Notifications."
        )}{" "}
        Your own Slack account, below, pulls channels you pick into Oracle.
      </p>
    </div>
  );
}

function ConnectionRow({ connection: c, reload }: { connection: Connection; reload: () => Promise<void> }) {
  const { can } = useMe();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [changing, setChanging] = useState(false);

  async function reconnect() {
    setPending(true);
    setError(null);
    try {
      const res = await unwrap(
        api.POST("/v1/connections/{connection_id}/reconnect", { params: { path: { connection_id: c.id } } }),
      );
      if (res.authorize_url) {
        window.location.assign(res.authorize_url);
        return;
      }
      await reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  async function disconnect() {
    setPending(true);
    setError(null);
    try {
      await unwrap(api.DELETE("/v1/connections/{connection_id}", { params: { path: { connection_id: c.id } } }));
      await reload();
    } catch (e) {
      setError(errorMessage(e));
      setPending(false);
    }
  }

  const name = c.account_label ?? c.account_id;
  return (
    <li data-testid={`connection-${c.id}`} className="border-t border-line px-4 py-2 first:border-t-0 max-[600px]:px-3">
      <div className="flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="min-w-0 flex-1 basis-32 truncate font-medium" title={name}>
          {name}
        </span>
        <Chip kind={STATUS_KIND[c.status]} dot>
          {c.status === "active" ? connectedBy(c.auth_mode) : STATUS_LABEL[c.status]}
        </Chip>
        {c.scopes.length > 0 && (
          <InfoTip label={`${name} scopes`}>Scopes: {c.scopes.join(", ")}</InfoTip>
        )}
        {c.reconnect_reason && (
          <InfoTip label={`why reconnect ${name}`}>
            This Google sign-in cannot read folders. Reconnect once, then choose files and folders on Sources.
            Oracle can read your Drive; it pulls in only the files and folders you choose there.
          </InfoTip>
        )}
        <span className="flex flex-none items-center gap-1">
          {c.endpoint_url && can("set_connection_endpoint") && !changing && (
            <Button variant="ghost" onClick={() => setChanging(true)}>
              Change endpoint
            </Button>
          )}
          <Button onClick={reconnect} disabled={pending} variant={c.reconnect_reason ? "solid" : undefined}>
            {c.reconnect_reason ?? "Reconnect"}
          </Button>
          {confirming ? (
            <>
              <Button variant="danger" onClick={disconnect} disabled={pending}>
                Confirm disconnect
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button variant="ghost" onClick={() => setConfirming(true)}>
              Disconnect
            </Button>
          )}
        </span>
      </div>
      {c.endpoint_url && (
        <p className="mt-0.5 truncate text-sm text-text2" title={c.endpoint_url}>
          Endpoint: <span className="font-mono">{c.endpoint_url}</span>
        </p>
      )}
      {changing && <EndpointForm connection={c} reload={reload} close={() => setChanging(false)} />}
      {c.last_error && (
        <p className="mt-1 truncate text-sm text-crit" title={c.last_error}>
          {c.last_error}
        </p>
      )}
      {error && (
        <div className="mt-1.5">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
    </li>
  );
}

function TokenForm({
  provider,
  reload,
  close,
}: {
  provider: Provider;
  reload: () => Promise<void>;
  close: () => void;
}) {
  const id = useId();
  const { can } = useMe();
  // Only an Oracle owner sets another GraphQL endpoint (Fireflies only).
  const takesEndpoint = provider.key === "fireflies" && can("set_connection_endpoint");
  const [token, setToken] = useState("");
  const [label, setLabel] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    setTokenError(null);
    try {
      await unwrap(
        api.POST("/v1/connections/{provider}/token", {
          params: { path: { provider: provider.key } },
          body: { token, label: label.trim() || null, ...(takesEndpoint && endpoint.trim() ? { endpoint_url: endpoint.trim() } : {}) },
        }),
      );
      setToken("");
      setLabel("");
      close();
      await reload();
    } catch (e) {
      // The provider turned the token down (400): say so in words under the field (qa-settings-9).
      const rejected = e instanceof ApiError && e.status === 400;
      setTokenError(rejected ? `${provider.name} did not accept this token. Check that you copied all of it, then paste it again.` : null);
      setError(rejected ? null : errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-3 border-t border-line bg-surface2 px-4 py-3 max-[600px]:px-3"
      aria-label={`${provider.name} token`}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {/* The token's help sits under the field, not in an (i) tip: the tip, opened under the
            pointer or the first Tab, covered the card (qa-onboarding-23). Its error sits here too. */}
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor={`${id}-token`} className="text-[13px] leading-4 font-semibold tracking-[0.02em] text-text2">
            Token
          </label>
          <input
            id={`${id}-token`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            required
            // Opening the form puts the cursor in the token field.
            autoFocus
            aria-invalid={tokenError ? true : undefined}
            aria-describedby={[provider.token_help ? `${id}-help` : "", tokenError ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined}
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              setTokenError(null);
            }}
            className={`${INPUT} font-mono`}
          />
          {provider.token_help && (
            <p id={`${id}-help`} className="text-sm text-text2">
              {provider.token_help}
            </p>
          )}
          {tokenError && (
            <p id={`${id}-error`} role="alert" className="text-sm font-medium text-crit" data-testid="token-error">
              {tokenError}
            </p>
          )}
        </div>
        <Field label="Label (optional)">
          <input value={label} onChange={(e) => setLabel(e.target.value)} className={INPUT} maxLength={200} />
        </Field>
        {takesEndpoint && (
          <Field label="GraphQL endpoint (optional)" htmlFor={`${id}-endpoint`}>
            <input
              id={`${id}-endpoint`}
              type="url"
              inputMode="url"
              spellCheck={false}
              placeholder={FIREFLIES_DEFAULT_ENDPOINT}
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              className={`${INPUT} font-mono`}
              maxLength={2048}
            />
          </Field>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="solid" disabled={pending || !token.trim()}>
          {pending ? "Checking…" : "Connect"}
        </Button>
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
        {!token.trim() && <span className="text-sm text-text2">Paste a token to connect</span>}
      </div>
      {error && <Notice tone="error">{error}</Notice>}
    </form>
  );
}

const FIREFLIES_DEFAULT_ENDPOINT = "https://api.fireflies.ai/graphql";

/** Owners only: another GraphQL endpoint for a Fireflies connection, with the key again. */
function EndpointForm({ connection: c, reload, close }: { connection: Connection; reload: () => Promise<void>; close: () => void }) {
  const id = useId();
  const [endpoint, setEndpoint] = useState(c.endpoint_url === FIREFLIES_DEFAULT_ENDPOINT ? "" : (c.endpoint_url ?? ""));
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      await unwrap(
        api.PUT("/v1/connections/{connection_id}/endpoint", {
          params: { path: { connection_id: c.id } },
          body: { endpoint_url: endpoint.trim() || null, token },
        }),
      );
      close();
      await reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-2 flex flex-col gap-3 rounded bg-surface2 p-3" aria-label={`${c.account_label ?? c.account_id} endpoint`}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="GraphQL endpoint" htmlFor={`${id}-endpoint`}>
          <input
            id={`${id}-endpoint`}
            type="url"
            inputMode="url"
            spellCheck={false}
            placeholder={FIREFLIES_DEFAULT_ENDPOINT}
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            className={`${INPUT} font-mono`}
            maxLength={2048}
          />
        </Field>
        <Field label="API key, again" htmlFor={`${id}-token`}>
          <input
            id={`${id}-token`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            required
            value={token}
            onChange={(e) => setToken(e.target.value)}
            className={`${INPUT} font-mono`}
          />
        </Field>
      </div>
      <p className="text-sm text-text2">Empty reads Fireflies&apos; own API. The key is checked at the new endpoint and never sent elsewhere.</p>
      <div className="flex items-center gap-2">
        <Button type="submit" variant="solid" disabled={pending || !token.trim()}>
          {pending ? "Checking…" : "Save endpoint"}
        </Button>
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
    </form>
  );
}
