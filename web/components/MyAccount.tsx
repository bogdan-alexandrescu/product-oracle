"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { ActedCell, SETTLING, useActed } from "@/components/account/acted";
import { ConfirmDialog } from "@/components/account/ConfirmDialog";
import { scopeLabel } from "@/components/account/scopes";
import { SlackPingsPanel } from "@/components/account/SlackPingsPanel";
import { Expiry, expiryText, Scopes, TokenStatus, tokenState, when } from "@/components/ApiTokensSettings";
import { ROLE_LABEL } from "@/components/MembersSettings";
import { Field, INPUT } from "@/app/settings/_components/fields";
import {
  Button,
  Chip,
  type Column,
  DataTable,
  InfoTip,
  Inspector,
  InspectorRow,
  InspectorSection,
  Notice,
  Page,
  PageHeader,
  Panel,
  SegmentedControl,
  Split,
} from "@/components/ds";
import { api, ApiError, unwrap, type ApiToken, type McpClient, type MyAccount as Account } from "@/lib/api/client";
import { formatDate, formatDateTime } from "@/lib/format";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

/** "Password" or "Google". */
const methodLabel = (m: Account["sign_in_methods"][number]) => (m === "google" ? "Google" : "Password");
type Scope = "oracle:read" | "oracle:write";
/** A new personal token's lifetime: the API takes 30, 90 or 365 days, or null (never). */
type Lifetime = "30" | "90" | "365" | "never";
const LIFETIMES: { value: Lifetime; label: string }[] = [
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
  { value: "never", label: "Never" },
];
const lifetimeDays = (l: Lifetime) => (l === "never" ? null : (Number(l) as 30 | 90 | 365));
/** What a password change and Sign out everywhere also revoke (AC1). */
const REVOKES_TOO = "your personal API tokens, every MCP client you authorized and the current tokens of runs you started that are still going (those runs keep running; their next segment gets a new token)";

/**
 * A panel head's count that agrees with its table: "1 active · 2 total" when some rows
 * are expired or revoked, just the number when every row is active (qa-settings-30).
 */
function ActiveOfTotal({ rows }: { rows?: Pick<ApiToken, "revoked_at" | "expires_at">[] }) {
  if (!rows) return null;
  const active = rows.filter((r) => tokenState(r) === "active").length;
  if (active === rows.length) return <>{active}</>;
  return (
    <span className="text-[15px] font-semibold whitespace-nowrap">
      {active} active · {rows.length} total
    </span>
  );
}

/** My account: every signed-in member's own sign-in, password, personal tokens, MCP clients, Slack pings. */
export function MyAccount() {
  const router = useRouter();
  const { clear } = useMe();
  const accountQ = useQuery("my-account", () => unwrap(api.GET("/v1/me/account")));
  const tokensQ = useQuery("my-tokens", () => unwrap(api.GET("/v1/me/tokens")));
  const clientsQ = useQuery("my-oauth-clients", () => unwrap(api.GET("/v1/me/oauth-clients")));
  const [signingOut, setSigningOut] = useState(false);
  const [signOutOpen, setSignOutOpen] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  const account = accountQ.data;
  const liveClients = clientsQ.data?.filter((c) => tokenState(c) === "active").length;
  const liveTokens = tokensQ.data?.filter((t) => tokenState(t) === "active").length;
  const refreshCredentials = () => Promise.all([tokensQ.reload(), clientsQ.reload()]);

  async function signOutEverywhere() {
    setSigningOut(true);
    setSignOutError(null);
    try {
      await unwrap(api.POST("/v1/me/sign-out-everywhere"));
      clear();
      router.push("/login");
    } catch (e) {
      setSignOutError(errorMessage(e));
      setSigningOut(false);
    }
  }

  const inspector = (
    <Inspector
      eyebrow="My account"
      title={account?.email ?? "…"}
      label="My account"
      chips={
        account ? (
          <>
            <Chip hero>{ROLE_LABEL[account.role]}</Chip>
            {account.sign_in_methods.map((m) => (
              <Chip key={m} hero>
                {methodLabel(m)}
              </Chip>
            ))}
          </>
        ) : undefined
      }
      stats={[
        { label: "Personal tokens", value: liveTokens ?? "—", testId: "stat-tokens" },
        { label: "MCP clients", value: liveClients ?? "—", testId: "stat-clients" },
      ]}
    >
      {account && <AccountDetails account={account} onSaved={(a) => accountQ.setData(() => a)} />}
    </Inspector>
  );

  return (
    <Page>
      <PageHeader
        title="My account"
        info={
          <InfoTip label="your account" align="start" side="bottom">
            How you sign in, your password, and the credentials that act as you: personal API tokens and the MCP clients
            you authorized. Changing your password or signing out everywhere revokes them all.
          </InfoTip>
        }
        action={
          <Button variant="danger" icon="signout" onClick={() => setSignOutOpen(true)} data-testid="sign-out-everywhere">
            Sign out everywhere
          </Button>
        }
      />
      <Split inspector={inspector}>
        {accountQ.error && <Notice tone="error">{accountQ.error}</Notice>}
        {account && <PasswordPanel account={account} onChanged={refreshCredentials} />}
        <TokensPanel query={tokensQ} />
        <ClientsPanel query={clientsQ} />
        <SlackPingsPanel />
      </Split>
      <ConfirmDialog
        open={signOutOpen}
        title="Sign out of every device?"
        subject={account?.email}
        testId="sign-out-dialog"
        confirmLabel="Sign out everywhere"
        pendingLabel="Signing out…"
        pending={signingOut}
        error={signOutError}
        onClose={() => setSignOutOpen(false)}
        onConfirm={signOutEverywhere}
        consequences={[
          { icon: "signout", text: "Every browser signed in as you is signed out, this one too." },
          {
            icon: "lock",
            text:
              liveTokens === 1
                ? "Your personal API token is revoked."
                : `Your ${liveTokens ?? 0} personal API tokens are revoked.`,
          },
          {
            icon: "lock",
            text:
              liveClients === 1
                ? "Your MCP client loses its access and refresh tokens."
                : `Your ${liveClients ?? 0} MCP clients lose their access and refresh tokens.`,
          },
          {
            icon: "runs",
            text: "Runs you started that are still going lose their current tokens; they keep running, and their next segment gets a new token.",
          },
          ...(account?.sign_in_methods.includes("google")
            ? [{ icon: "user" as const, text: "Google sign-in can sign a browser in again on its next visit." }]
            : []),
        ]}
      />
    </Page>
  );
}

/** What a read-only credential is told (AC1, the API's refusal): it changes nothing. */
const READ_ONLY = "This credential can only read (oracle:read): it cannot add, change or delete anything.";

/**
 * A5: your name, shown to teammates instead of your email (PATCH /v1/me/account). Through a
 * read-only credential the field is disabled, with the reason.
 */
function NameForm({ account, onSaved }: { account: Account; onSaved: (a: Account) => void }) {
  const locked = !!account.read_only;
  const [name, setName] = useState(account.name ?? "");
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      onSaved(await unwrap(api.PATCH("/v1/me/account", { body: { name: name.trim() || null } })));
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }
  return (
    <form onSubmit={submit} aria-label="Your name" className="mb-2 flex flex-wrap items-end gap-2">
      <Field label="Name" className="min-w-0 flex-1">
        <input
          value={name}
          maxLength={80}
          disabled={locked}
          aria-describedby={locked ? "name-read-only" : undefined}
          onChange={(e) => {
            setName(e.target.value);
            setSaved(false);
          }}
          className={INPUT}
        />
      </Field>
      <Button type="submit" disabled={locked || pending || name.trim() === (account.name ?? "")}>
        {pending ? "Saving…" : saved ? "Saved" : "Save"}
      </Button>
      <span className="basis-full text-[13px] text-text2">Shown to your teammates instead of your email.</span>
      {locked && (
        <span id="name-read-only" data-testid="name-read-only" role="note" className="basis-full text-[13px] font-medium text-warn">
          {READ_ONLY}
        </span>
      )}
      {error && (
        <span role="alert" className="basis-full text-[13px] font-medium text-crit">
          {error}
        </span>
      )}
    </form>
  );
}

function AccountDetails({ account, onSaved }: { account: Account; onSaved: (a: Account) => void }) {
  return (
    <InspectorSection label="Details">
      <NameForm account={account} onSaved={onSaved} />
      <InspectorRow value={ROLE_LABEL[account.role]}>Role</InspectorRow>
      <InspectorRow value={account.sign_in_methods.map(methodLabel).join(" and ") || "None"}>Signs in with</InspectorRow>
      <InspectorRow value={account.last_sign_in_at ? formatDateTime(account.last_sign_in_at) : "Not known"}>Last sign-in</InspectorRow>
      <InspectorRow value={formatDate(account.created_at)}>Member since</InspectorRow>
    </InspectorSection>
  );
}

function PasswordPanel({ account, onChanged }: { account: Account; onChanged: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const min = account.password_min_length ?? 12;

  if (!account.sign_in_methods.includes("password")) {
    return (
      <Panel title="Password" testId="password-panel">
        <div className="p-4">
          <Notice>You sign in with Google: there is no Oracle password to change.</Notice>
        </div>
      </Panel>
    );
  }

  const mismatch = again.length > 0 && again !== next;
  const short = next.length > 0 && next.length < min;
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (short || mismatch || !current) return;
    setPending(true);
    setError(null);
    setDone(false);
    try {
      await unwrap(api.POST("/v1/me/password", { body: { current_password: current, new_password: next } }));
      setDone(true);
      setCurrent("");
      setNext("");
      setAgain("");
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 429 ? `Too many attempts. ${err.message}` : errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Panel title="Password" testId="password-panel">
      {/* qa-settings-38: each field's problem under it, so the three line up at the top. */}
      <form onSubmit={submit} aria-label="Change password" className="grid grid-cols-3 items-start gap-3 p-4 max-[900px]:grid-cols-1">
        <Field label="Current password">
          <input type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} className={INPUT} />
        </Field>
        {/* The message sits outside the label, so the field keeps its name. */}
        <div className="flex min-w-0 flex-col gap-1.5">
          <Field label={`New password · ${min}+ characters`}>
            <input
              type="password"
              autoComplete="new-password"
              required
              minLength={min}
              value={next}
              aria-invalid={short || undefined}
              aria-describedby={short ? "password-short" : undefined}
              onChange={(e) => setNext(e.target.value)}
              className={INPUT}
            />
          </Field>
          {short && (
            <span id="password-short" data-testid="password-short" className="text-sm text-warn">
              At least {min} characters
            </span>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <Field label="New password again">
            <input
              type="password"
              autoComplete="new-password"
              required
              value={again}
              aria-invalid={mismatch || undefined}
              aria-describedby={mismatch ? "password-mismatch" : undefined}
              onChange={(e) => setAgain(e.target.value)}
              className={INPUT}
            />
          </Field>
          {mismatch && (
            <span id="password-mismatch" data-testid="password-mismatch" className="text-sm text-warn">
              The two new passwords differ
            </span>
          )}
        </div>
        <div className="col-span-full flex flex-wrap items-center gap-3">
          <Button type="submit" variant="solid" disabled={pending || !current || !next || short || mismatch || again !== next}>
            {pending ? "Changing…" : "Change password"}
          </Button>
        </div>
        <p className="col-span-full text-sm text-text2" data-testid="password-revokes">
          Changing it signs out every other session and revokes {REVOKES_TOO}.
        </p>
        {error && (
          <div className="col-span-full">
            <Notice tone="error">{error}</Notice>
          </div>
        )}
        {done && (
          <div className="col-span-full">
            <Notice tone="pass">
              Password changed. Every other session was signed out; your personal API tokens, MCP clients and the tokens of
              your runs still going were revoked.
            </Notice>
          </div>
        )}
      </form>
    </Panel>
  );
}

function TokensPanel({ query }: { query: ReturnType<typeof useQuery<ApiToken[]>> }) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Scope[]>(["oracle:read"]);
  const [lifetime, setLifetime] = useState<Lifetime>("90");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ name: string; secret: string; expiresAt?: string | null } | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState<ApiToken | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const acts = useActed();

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || scopes.length === 0) return;
    setPending(true);
    setError(null);
    try {
      const out = await unwrap(api.POST("/v1/me/tokens", { body: { name: name.trim(), scopes, expires_in_days: lifetimeDays(lifetime) } }));
      query.setData((prev) => [...(prev ?? []), out.token]);
      setCreated({ name: out.token.name, secret: out.secret, expiresAt: out.token.expires_at });
      setCopied(false);
      setName("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  async function revoke(t: ApiToken) {
    setRevoking(true);
    setConfirmError(null);
    try {
      await unwrap(api.DELETE("/v1/me/tokens/{token_id}", { params: { path: { token_id: t.id } } }));
      const at = new Date().toISOString();
      query.setData((prev) => prev?.map((x) => (x.id === t.id ? { ...x, revoked_at: x.revoked_at ?? at } : x)));
      setConfirming(null);
      acts.mark({ key: t.id, outcome: "Revoked" });
    } catch (e) {
      setConfirmError(errorMessage(e));
    } finally {
      setRevoking(false);
    }
  }

  const toggle = (s: Scope) => setScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s].sort() as Scope[]));
  const rows = query.data ? [...query.data].reverse() : undefined;
  const columns: Column<ApiToken>[] = [
    {
      key: "name",
      header: "Name",
      cell: (t) => (
        <span className="truncate font-medium" title={`${t.name} · created ${formatDate(t.created_at)}`}>
          {t.name}
        </span>
      ),
    },
    { key: "scopes", header: "Scopes", width: "128px", hideOnPhone: true, wrap: true, cell: (t) => <Scopes scopes={t.scopes} /> },
    { key: "used", header: "Last used", width: "124px", phoneLabel: "Used ", cell: (t) => when(t.last_used_at) },
    // Created is in the name's title: the expiry matters more on one line.
    { key: "expires", header: "Expiry", width: "164px", cell: (t) => <Expiry t={t} /> },
    { key: "status", header: "Status", width: "128px", cell: (t) => <TokenStatus t={t} /> },
    {
      key: "action",
      header: <span className="sr-only">Actions</span>,
      width: "96px",
      align: "right",
      phone: "action",
      wrap: true,
      cell: (t) =>
        acts.acted?.key === t.id ? (
          <ActedCell acted={acts.acted} onUndo={acts.undo} />
        ) : tokenState(t) === "active" ? (
          <Button
            aria-label={`Revoke ${t.name}`}
            onClick={() => {
              setConfirmError(null);
              setConfirming(t);
            }}
          >
            Revoke
          </Button>
        ) : null,
    },
  ];

  return (
    <Panel
      title="Personal API tokens"
      count={<ActiveOfTotal rows={query.data} />}
      testId="tokens-panel"
      tools={
        <InfoTip label="personal tokens" align="end">
          A personal token acts as you from scripts and agents. Read only acts as a viewer; with write it has your role.
          The secret is shown once, when you create it. It expires after the time you choose; an expired token is refused.
        </InfoTip>
      }
    >
      <form onSubmit={create} aria-label="Create a token" className="flex flex-wrap items-end gap-3 border-b border-line p-4">
        <Field label="Name" className="w-64 max-[600px]:w-full">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="e.g. laptop cli" className={INPUT} />
        </Field>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-[13px] leading-4 font-semibold tracking-[0.02em] text-text2">Scopes</legend>
          <div className="flex h-9 items-center gap-4">
            {(["oracle:read", "oracle:write"] as const).map((s) => (
              <label key={s} className="inline-flex items-center gap-2 text-[15px]">
                <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggle(s)} className="size-4 accent-[var(--accent)]" />
                <span>{scopeLabel(s)}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="flex min-w-0 flex-col">
          <legend className="mb-1.5 text-[13px] leading-4 font-semibold tracking-[0.02em] text-text2">Expires after</legend>
          <SegmentedControl label="Expires after" items={LIFETIMES} value={lifetime} onChange={setLifetime} />
        </fieldset>
        <Button type="submit" variant="solid" icon="plus" disabled={pending || !name.trim() || scopes.length === 0}>
          {pending ? "Creating…" : "Create token"}
        </Button>
        {error && (
          <div className="basis-full">
            <Notice tone="error">{error}</Notice>
          </div>
        )}
      </form>
      {created && (
        <div role="region" aria-label="New token" data-testid="new-token" className="flex flex-col gap-2 border-b border-line bg-accent-soft p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-accent-ink">{created.name}</span>
            <Chip kind="warn">Shown once</Chip>
            <span className="text-sm text-text2" data-testid="new-token-expiry">
              {expiryText(created.expiresAt)}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <code data-testid="new-token-secret" className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-2.5 py-1.5 font-mono text-[13px] break-all text-text">
              {created.secret}
            </code>
            <Button
              icon="check"
              onClick={async () => {
                await navigator.clipboard?.writeText(created.secret).catch(() => undefined);
                setCopied(true);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button variant="ghost" onClick={() => setCreated(null)}>
              Done
            </Button>
          </div>
        </div>
      )}
      {query.error ? (
        <div className="p-4">
          <Notice tone="error">{query.error}</Notice>
        </div>
      ) : (
        <div className={SETTLING}>
          <DataTable
            label="Personal API tokens"
            columns={columns}
            rows={rows}
            loading={!rows}
            rowKey={(t) => t.id}
            rowProps={(t) => ({ "data-testid": "my-token-row", ...acts.rowAttrs(t.id) })}
            empty="No personal tokens"
          />
        </div>
      )}
      <ConfirmDialog
        open={!!confirming}
        title="Revoke this token?"
        subject={confirming?.name}
        testId="revoke-token-dialog"
        confirmLabel="Revoke"
        pendingLabel="Revoking…"
        pending={revoking}
        error={confirmError}
        onClose={() => setConfirming(null)}
        onConfirm={() => confirming && revoke(confirming)}
        consequences={[
          { icon: "lock", text: "Every script or agent using it is refused from now on." },
          { icon: "check", text: "Approvals given through it stop counting; yours given in person stand." },
          { icon: "doc", text: "It stays listed as revoked; it can't be turned back on." },
        ]}
      />
    </Panel>
  );
}

function ClientsPanel({ query }: { query: ReturnType<typeof useQuery<McpClient[]>> }) {
  const [confirming, setConfirming] = useState<McpClient | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const acts = useActed();

  async function revoke(c: McpClient) {
    setRevoking(true);
    setConfirmError(null);
    try {
      await unwrap(api.DELETE("/v1/me/oauth-clients/{grant_id}", { params: { path: { grant_id: c.id } } }));
      const at = new Date().toISOString();
      query.setData((prev) => prev?.map((x) => (x.id === c.id ? { ...x, revoked_at: x.revoked_at ?? at } : x)));
      setConfirming(null);
      acts.mark({ key: c.id, outcome: "Revoked" });
    } catch (e) {
      setConfirmError(errorMessage(e));
    } finally {
      setRevoking(false);
    }
  }

  const rows = query.data ? [...query.data].reverse() : undefined;
  const columns: Column<McpClient>[] = [
    {
      key: "name",
      header: "Client",
      cell: (c) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium" title={c.client_name}>
            {c.client_name}
          </span>
        </span>
      ),
    },
    { key: "scopes", header: "Scopes", width: "128px", hideOnPhone: true, wrap: true, cell: (c) => <Scopes scopes={c.scopes} /> },
    { key: "authorized", header: "Authorized", width: "124px", hideOnPhone: true, cell: (c) => when(c.authorized_at) },
    { key: "used", header: "Last used", width: "124px", phoneLabel: "Used ", cell: (c) => when(c.last_used_at) },
    { key: "status", header: "Status", width: "140px", cell: (c) => <TokenStatus t={c} /> },
    {
      key: "action",
      header: <span className="sr-only">Actions</span>,
      width: "96px",
      align: "right",
      phone: "action",
      wrap: true,
      cell: (c) =>
        acts.acted?.key === c.id ? (
          <ActedCell acted={acts.acted} onUndo={acts.undo} />
        ) : tokenState(c) === "active" ? (
          <Button
            aria-label={`Revoke ${c.client_name}`}
            onClick={() => {
              setConfirmError(null);
              setConfirming(c);
            }}
          >
            Revoke
          </Button>
        ) : null,
    },
  ];

  return (
    <Panel
      title="MCP clients"
      count={<ActiveOfTotal rows={query.data} />}
      testId="clients-panel"
      tools={
        <InfoTip label="MCP clients" align="end">
          Agents and apps you authorized to use Oracle&apos;s MCP server as you (OAuth). Revoking one ends its access and
          refresh tokens.
        </InfoTip>
      }
    >
      {query.error ? (
        <div className="p-4">
          <Notice tone="error">{query.error}</Notice>
        </div>
      ) : (
        <div className={SETTLING}>
          <DataTable
            label="MCP clients"
            columns={columns}
            rows={rows}
            loading={!rows}
            rowKey={(c) => c.id}
            rowProps={(c) => ({ "data-testid": "my-client-row", ...acts.rowAttrs(c.id) })}
            empty="No MCP clients"
          />
        </div>
      )}
      <ConfirmDialog
        open={!!confirming}
        title="Revoke this MCP client?"
        subject={confirming?.client_name}
        testId="revoke-client-dialog"
        confirmLabel="Revoke"
        pendingLabel="Revoking…"
        pending={revoking}
        error={confirmError}
        onClose={() => setConfirming(null)}
        onConfirm={() => confirming && revoke(confirming)}
        consequences={[
          { icon: "lock", text: "Its access and refresh tokens stop working at once." },
          { icon: "check", text: "Approvals made through it stop counting." },
          { icon: "link", text: "To use it again, authorize it again from the client." },
        ]}
      />
    </Panel>
  );
}
