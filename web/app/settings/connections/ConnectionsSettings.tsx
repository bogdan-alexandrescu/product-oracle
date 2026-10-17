"use client";

import { useSearchParams } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";

import { Badge, Button, ErrorNote, Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { hasRole, useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

type Connection = Schemas["ConnectionOut"];
type Provider = Schemas["ProviderOut"];
type ClaudePlan = Schemas["ClaudePlanOut"];

type Data = { providers: Provider[]; connections: Connection[]; plan: ClaudePlan };

const STATUS_TONE = { active: "green", expired: "amber", revoked: "neutral", error: "red" } as const;
const STATUS_LABEL = { active: "Connected", expired: "Expired", revoked: "Revoked", error: "Error" } as const;
const KIND_LABEL: Record<string, string> = {
  github: "repos, issues, pull requests, releases",
  slack: "channels you pick (never direct messages)",
  notion: "pages you share",
  fireflies: "meeting transcripts",
  google_docs: "Google Docs",
};

async function loadAll(): Promise<Data> {
  const [providers, connections, plan] = await Promise.all([
    unwrap(api.GET("/v1/connections/providers")),
    unwrap(api.GET("/v1/connections")),
    unwrap(api.GET("/v1/claude-plan")),
  ]);
  return { providers, connections, plan };
}

/** Settings > Connections: the signed-in user's own accounts, one card per provider. */
export function ConnectionsSettings() {
  const params = useSearchParams();
  const { role } = useMe();
  const q = useQuery("connections", loadAll);
  const connected = params.get("connected");
  const callbackError = params.get("error");

  const providers = q.data?.providers ?? [];
  const claude = providers.find((p) => p.key === "claude");
  const others = providers.filter((p) => p.key !== "claude");
  const nameOf = (key: string | null) => providers.find((p) => p.key === key)?.name ?? key;

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <h1 className="mb-2 text-2xl font-semibold tracking-tight text-neutral-900">Connections</h1>
      <p className="mb-6 text-sm text-neutral-600">
        Your own accounts. Only you see these connections and what they pull in; nobody else in the company can
        use them.
      </p>

      {connected && !callbackError && (
        <p role="status" className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {nameOf(connected)} is connected.
        </p>
      )}
      {callbackError && (
        <div className="mb-4">
          <ErrorNote>
            {params.get("provider") ? `${nameOf(params.get("provider"))}: ` : ""}
            {callbackError}
          </ErrorNote>
        </div>
      )}

      {q.loading && !q.data && <Loading />}
      {q.error && <ErrorNote>{q.error}</ErrorNote>}

      {q.data && claude && (
        <div className="flex flex-col gap-4">
          <ClaudeCard
            provider={claude}
            connections={q.data.connections.filter((c) => c.provider === "claude")}
            plan={q.data.plan}
            isOwner={hasRole(role, "owner")}
            reload={q.reload}
          />
          <div className="grid gap-4 md:grid-cols-2">
            {others.map((p) => (
              <ProviderCard
                key={p.key}
                provider={p}
                connections={q.data!.connections.filter((c) => c.provider === p.key)}
                reload={q.reload}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Card({ provider, children }: { provider: Provider; children: ReactNode }) {
  return (
    <section
      data-testid={`connection-card-${provider.key}`}
      aria-labelledby={`card-${provider.key}`}
      className="rounded-lg border border-neutral-200 bg-white p-4"
    >
      <h2 id={`card-${provider.key}`} className="text-base font-semibold text-neutral-900">
        {provider.name}
      </h2>
      {children}
    </section>
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
    <Card provider={provider}>
      <p className="mt-0.5 text-xs text-neutral-500">
        Pulls in {provider.source_kinds.map((k) => KIND_LABEL[k] ?? k).join(", ")}.
      </p>
      <ConnectionList connections={connections} reload={reload} />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {provider.oauth_configured && (
          <Button variant="primary" size="sm" onClick={signIn} disabled={pending}>
            Connect with {provider.name}
          </Button>
        )}
      </div>
      <TokenForm provider={provider} reload={reload} openByDefault={false} />
      {error && (
        <div className="mt-2">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
    </Card>
  );
}

function ClaudeCard({
  provider,
  connections,
  plan,
  isOwner,
  reload,
}: {
  provider: Provider;
  connections: Connection[];
  plan: ClaudePlan;
  isOwner: boolean;
  reload: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  // The default being saved, shown at once (undefined: none pending).
  const [pendingDefault, setPendingDefault] = useState<string | null | undefined>(undefined);
  const isDefault = (c: Connection) =>
    pendingDefault !== undefined ? pendingDefault === c.id : (c.is_company_default ?? false);

  async function setDefault(c: Connection, on: boolean) {
    setError(null);
    setPendingDefault(on ? c.id : null);
    try {
      await unwrap(
        api.PUT("/v1/settings/{key}", {
          params: { path: { key: "default_claude_connection_id" } },
          body: { value: on ? c.id : null },
        }),
      );
      await reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPendingDefault(undefined);
    }
  }

  const using =
    plan.source === "own"
      ? `Oracle's model calls run on your own plan: ${plan.account_label}.`
      : plan.source === "company"
        ? "Oracle's model calls run on the company's default plan. Connect your own to use it instead."
        : "No Claude plan: Oracle cannot make model calls for you until you connect one, or an owner sets a company default.";

  return (
    <Card provider={provider}>
      <p data-testid="claude-plan-status" className="mt-1 text-sm text-neutral-700">
        {using}
      </p>
      <div className="mt-3 rounded-md bg-neutral-50 p-3 text-sm text-neutral-700">
        <p>Connect your Claude plan (Pro or Max) so it pays for Oracle&apos;s own Claude calls:</p>
        <ol className="mt-1 list-decimal space-y-0.5 pl-5">
          <li>
            On your machine, with Claude Code installed, run{" "}
            <code className="rounded bg-white px-1 font-mono text-xs ring-1 ring-neutral-200">claude setup-token</code>.
          </li>
          <li>Sign in when the browser opens; it prints a long-lived token.</li>
          <li>Paste that token below. Oracle runs your calls through Claude Code with it.</li>
        </ol>
        <p className="mt-1 text-xs text-neutral-500">An Anthropic API key works too.</p>
      </div>
      <ConnectionList
        connections={connections}
        reload={reload}
        extra={(c) =>
          isOwner && c.status === "active" ? (
            <label className="mt-1 flex items-center gap-2 text-xs text-neutral-700">
              <input
                type="checkbox"
                checked={isDefault(c)}
                disabled={pendingDefault !== undefined}
                onChange={(e) => void setDefault(c, e.target.checked)}
              />
              Use as the default plan for users without their own
            </label>
          ) : isDefault(c) ? (
            <p className="mt-1 text-xs text-neutral-500">The company&apos;s default plan.</p>
          ) : null
        }
      />
      <TokenForm provider={provider} reload={reload} openByDefault={connections.length === 0} />
      {error && (
        <div className="mt-2">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
    </Card>
  );
}

function ConnectionList({
  connections,
  reload,
  extra,
}: {
  connections: Connection[];
  reload: () => Promise<void>;
  extra?: (c: Connection) => ReactNode;
}) {
  if (connections.length === 0) return <p className="mt-3 text-sm text-neutral-500">Not connected.</p>;
  return (
    <ul className="mt-3 flex flex-col gap-2">
      {connections.map((c) => (
        <ConnectionRow key={c.id} connection={c} reload={reload} extra={extra?.(c)} />
      ))}
    </ul>
  );
}

function ConnectionRow({
  connection: c,
  reload,
  extra,
}: {
  connection: Connection;
  reload: () => Promise<void>;
  extra?: ReactNode;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);

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

  return (
    <li data-testid={`connection-${c.id}`} className="rounded-md border border-neutral-200 px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-neutral-900">{c.account_label ?? c.account_id}</span>
            <Badge tone={STATUS_TONE[c.status]}>{STATUS_LABEL[c.status]}</Badge>
            <span className="text-xs text-neutral-500">{c.auth_mode === "oauth" ? "signed in" : "token"}</span>
          </div>
          {c.scopes.length > 0 && <p className="mt-0.5 text-xs text-neutral-500">Scopes: {c.scopes.join(", ")}</p>}
          {c.last_error && <p className="mt-0.5 text-xs text-rose-700">{c.last_error}</p>}
        </div>
        <div className="flex items-center gap-1.5">
          <Button size="sm" onClick={reconnect} disabled={pending}>
            Reconnect
          </Button>
          {confirming ? (
            <>
              <Button size="sm" variant="primary" onClick={disconnect} disabled={pending}>
                Confirm disconnect
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
              Disconnect
            </Button>
          )}
        </div>
      </div>
      {extra}
      {error && <p className="mt-1 text-xs text-rose-700">{error}</p>}
    </li>
  );
}

/** The Claude plan is the one provider that serves no source kinds. */
function pasteLabel(p: Provider): string {
  return p.source_kinds.length === 0 ? "Token from claude setup-token" : "Token";
}

function TokenForm({
  provider,
  reload,
  openByDefault,
}: {
  provider: Provider;
  reload: () => Promise<void>;
  openByDefault: boolean;
}) {
  const [open, setOpen] = useState(openByDefault);
  const [token, setToken] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      await unwrap(
        api.POST("/v1/connections/{provider}/token", {
          params: { path: { provider: provider.key } },
          body: { token, label: label.trim() || null },
        }),
      );
      setToken("");
      setLabel("");
      setOpen(false);
      await reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  if (!open) {
    return (
      <Button size="sm" variant="ghost" className="mt-2" onClick={() => setOpen(true)}>
        Paste a token
      </Button>
    );
  }
  const field = "rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm text-neutral-900";
  return (
    <form onSubmit={onSubmit} className="mt-3 flex flex-col gap-2" aria-label={`${provider.name} token`}>
      <p className="text-xs text-neutral-500">{provider.token_help}</p>
      <label className="flex flex-col gap-1 text-xs text-neutral-700">
        {pasteLabel(provider)}
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          required
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className={`${field} font-mono`}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-neutral-700">
        Label (optional)
        <input value={label} onChange={(e) => setLabel(e.target.value)} className={field} maxLength={200} />
      </label>
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" variant="primary" disabled={pending || !token.trim()}>
          {pending ? "Checking…" : "Connect"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
    </form>
  );
}
