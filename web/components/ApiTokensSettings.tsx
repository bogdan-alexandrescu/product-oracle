"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ActedCell, SETTLING, useActed } from "@/components/account/acted";
import { ConfirmDialog, type Consequence } from "@/components/account/ConfirmDialog";
import { Field, SELECT_FIELD } from "@/app/settings/_components/fields";
import {
  Button,
  Chip,
  type ChipKind,
  type Column,
  DataTable,
  InfoTip,
  Notice,
  PageHeader,
  Panel,
  SegmentedControl,
  Split,
} from "@/components/ds";
import { api, unwrap, type ApiToken, type TokenKind } from "@/lib/api/client";
import { formatDate, formatDateTime } from "@/lib/format";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

export const KIND_LABEL: Record<TokenKind, string> = {
  personal: "Personal",
  service: "Service",
  run: "Run",
  mcp_client: "MCP client",
};
const KIND_TIP: Record<TokenKind, string> = {
  personal: "A member's API token (po_…): acts as them, capped by its scopes; expires after 30, 90 or 365 days, or never.",
  service: "An API token for no one (po_…): acts with its own role.",
  run: "A run's short-lived token for its agents (ort_…): read and draft scopes, ends with the run.",
  mcp_client: "An MCP client a member authorized (OAuth, poa_…): acts as them, capped by its scopes.",
};
const KINDS: TokenKind[] = ["personal", "service", "run", "mcp_client"];

const shortFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
/** "Oct 18": a chip's date; the full one is in its title. */
export const shortDate = (iso: string) => shortFmt.format(new Date(iso));

export type TokenState = "active" | "revoked" | "expired";
export function tokenState(t: Pick<ApiToken, "revoked_at" | "expires_at">): TokenState {
  if (t.revoked_at) return "revoked";
  if (t.expires_at && Date.parse(t.expires_at) <= Date.now()) return "expired";
  return "active";
}

export function TokenStatus({ t }: { t: Pick<ApiToken, "revoked_at" | "expires_at"> }) {
  const state = tokenState(t);
  const kind: ChipKind = state === "active" ? "pass" : "na";
  const title = state === "revoked" ? formatDateTime(t.revoked_at!) : state === "expired" ? formatDateTime(t.expires_at!) : undefined;
  if (state === "expired") {
    // Neutral like Revoked, told apart by a hollow dot: it lapsed, nobody revoked it.
    return (
      <Chip kind={kind} title={`Expired ${title}`} data-state={state}>
        <span aria-hidden className="size-2 flex-none rounded-full border-[1.5px] border-current" />
        Expired
      </Chip>
    );
  }
  return (
    <Chip kind={kind} dot title={title} data-state={state}>
      {state === "active" ? "Active" : `Revoked ${shortDate(t.revoked_at!)}`}
    </Chip>
  );
}

/** "Expires Jan 18, 2027", "Expired Oct 1, 2026" or "Never expires". */
export function expiryText(expiresAt?: string | null): string {
  if (!expiresAt) return "Never expires";
  return `${Date.parse(expiresAt) <= Date.now() ? "Expired" : "Expires"} ${formatDate(expiresAt)}`;
}

/** A credential's expiry in a table cell; a revoked one's expiry no longer matters. */
export function Expiry({ t }: { t: Pick<ApiToken, "revoked_at" | "expires_at"> }) {
  return (
    <span className={`tnum ${t.revoked_at ? "text-text2" : "text-text"}`} title={t.expires_at ? formatDateTime(t.expires_at) : undefined} data-testid="token-expiry">
      {expiryText(t.expires_at)}
    </span>
  );
}

/** Scopes on one line (mono, truncated, every one in the title); a service token's role. */
export function Scopes({ scopes, role }: { scopes?: string[] | null; role?: string }) {
  if (!scopes?.length) return <span className="text-text2">acts as {role}</span>;
  const text = scopes.join(", ");
  return (
    <span className="block truncate font-mono text-[13px] text-text" title={text}>
      {text}
    </span>
  );
}

export const when = (iso?: string | null, never = "Never") =>
  iso ? (
    <span className="tnum text-text2" title={formatDateTime(iso)}>
      {formatDate(iso)}
    </span>
  ) : (
    <span className="text-text2">{never}</span>
  );

/** What revoking a credential of each kind does, for the confirm dialog. */
function revokeConsequences(t: ApiToken): Consequence[] {
  const common: Consequence = { icon: "doc", text: "It stays listed as revoked; it can't be turned back on." };
  if (t.kind === "run") {
    return [
      { icon: "lock", text: "The run's agents can no longer call Oracle with it." },
      { icon: "runs", text: "The run itself goes on; its next segment gets a new token." },
      common,
    ];
  }
  if (t.kind === "mcp_client") {
    return [
      { icon: "lock", text: `${t.name} loses its access and refresh tokens at once.` },
      { icon: "check", text: "Approvals made through it stop counting; its member's own approvals stand." },
      common,
    ];
  }
  return [
    { icon: "lock", text: "Every call made with it fails from now on." },
    { icon: "check", text: "Approvals given through it stop counting; spend approvals and checkpoint decisions stand." },
    common,
  ];
}

/** Settings > API tokens (owners): every credential of the company, filter by member and kind, revoke. */
export function ApiTokensSettings({ initialMember }: { initialMember: string | null }) {
  const { can } = useMe();
  // #370: the page reads every token (GET /v1/api-tokens); Settings never opens it for anyone else.
  if (!can("list_api_tokens")) return <PageHeader title="API tokens" />;
  return <OwnerTokens initialMember={initialMember} />;
}

function OwnerTokens({ initialMember }: { initialMember: string | null }) {
  const router = useRouter();
  const [kind, setKind] = useState<TokenKind | "all">("all");
  const [member, setMember] = useState<string>(initialMember ?? "");
  const membersQ = useQuery("members", () => unwrap(api.GET("/v1/members")));
  const tokensQ = useQuery(`api-tokens:${kind}:${member}`, () =>
    unwrap(
      api.GET("/v1/api-tokens", {
        params: { query: { kind: kind === "all" ? undefined : kind, user_id: member || undefined } },
      }),
    ),
  );
  const [confirming, setConfirming] = useState<ApiToken | null>(null);
  const [pending, setPending] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const acts = useActed();

  async function revoke(t: ApiToken) {
    setPending(true);
    setConfirmError(null);
    try {
      await unwrap(api.DELETE("/v1/api-tokens/{token_id}", { params: { path: { token_id: t.id } } }));
      const at = new Date().toISOString();
      tokensQ.setData((prev) => prev?.map((x) => (x.id === t.id ? { ...x, revoked_at: x.revoked_at ?? at } : x)));
      setConfirming(null);
      acts.mark({ key: t.id, outcome: "Revoked" });
    } catch (e) {
      setConfirmError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  const rows = tokensQ.data;
  const shown = rows ? [...rows].reverse() : undefined; // newest first
  const chooseMember = (id: string) => {
    setMember(id);
    router.replace(id ? `/settings/api-tokens?member=${id}` : "/settings/api-tokens", { scroll: false });
  };

  const columns: Column<ApiToken>[] = [
    {
      key: "name",
      header: "Name",
      cell: (t) => (
        <span className="min-w-0 truncate font-medium" title={`${t.name} · created ${formatDate(t.created_at)}`}>
          {t.name}
        </span>
      ),
    },
    {
      key: "kind",
      header: "Kind",
      width: "124px",
      cell: (t) => <Chip kind="acc">{KIND_LABEL[t.kind ?? "service"]}</Chip>,
    },
    {
      key: "owner",
      header: "Acts for",
      width: "18%",
      phoneLabel: "For ",
      cell: (t) => <span className={t.owner_email ? "" : "text-text2"}>{t.owner_email ?? "No one (company)"}</span>,
    },
    { key: "scopes", header: "Scopes", width: "15%", hideOnPhone: true, cell: (t) => <Scopes scopes={t.scopes} role={t.role} /> },
    { key: "used", header: "Last used", width: "110px", phoneLabel: "Used ", cell: (t) => when(t.last_used_at) },
    // Created is in the name's title: the expiry matters more on one line.
    { key: "expires", header: "Expiry", width: "164px", cell: (t) => <Expiry t={t} /> },
    { key: "status", header: "Status", width: "150px", cell: (t) => <TokenStatus t={t} /> },
    {
      key: "action",
      header: <span className="sr-only">Actions</span>,
      width: "110px",
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

  const active = rows?.filter((t) => tokenState(t) === "active").length;
  const revoked = rows?.filter((t) => t.revoked_at).length;
  const expired = rows?.filter((t) => tokenState(t) === "expired").length;
  return (
    <>
      <PageHeader
        title="API tokens"
        status={
          <>
            {active != null && (
              <Chip kind="pass" data-testid="active-count">
                {active} active
              </Chip>
            )}
            {!!revoked && <Chip kind="na">{revoked} revoked</Chip>}
            {!!expired && (
              <Chip kind="na" data-testid="expired-count">
                {expired} expired
              </Chip>
            )}
            <InfoTip label="API tokens" align="start" side="bottom">
              Every credential that can call this company&apos;s Oracle; secrets are never shown after they are created.
              Removing a member revokes all of theirs.
              <span className="mt-2 block">
                {KINDS.map((k) => (
                  <span key={k} className="block">
                    <b>{KIND_LABEL[k]}</b>: {KIND_TIP[k]}
                  </span>
                ))}
              </span>
            </InfoTip>
          </>
        }
      />
      <Split>
        <Panel
          title="Tokens"
          count={rows?.length}
          tools={
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Member" htmlFor="token-member">
                <select id="token-member" value={member} onChange={(e) => chooseMember(e.target.value)} className={`${SELECT_FIELD} w-56`}>
                  <option value="">Everyone</option>
                  {membersQ.data?.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.email}
                      {m.status === "disabled" ? " (removed)" : ""}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          }
        >
          <div className="border-b border-line px-4 py-2.5">
            <SegmentedControl
              label="Kind"
              size="sm"
              value={kind}
              onChange={setKind}
              items={[{ value: "all", label: "All" }, ...KINDS.map((k) => ({ value: k, label: KIND_LABEL[k], testId: `kind-${k}` }))]}
            />
          </div>
          {tokensQ.error ? (
            <div className="p-4">
              <Notice tone="error">{tokensQ.error}</Notice>
            </div>
          ) : (
            <div className={SETTLING}>
              <DataTable
                label="API tokens"
                columns={columns}
                rows={shown}
                loading={tokensQ.loading && !rows}
                rowKey={(t) => t.id}
                rowProps={(t) => ({ "data-testid": "token-row", "data-kind": t.kind ?? undefined, ...acts.rowAttrs(t.id) })}
                empty="No tokens"
              />
            </div>
          )}
        </Panel>
      </Split>
      <ConfirmDialog
        open={!!confirming}
        title={confirming?.kind === "mcp_client" ? "Revoke this MCP client?" : "Revoke this token?"}
        subject={confirming ? `${confirming.name} · ${confirming.owner_email ?? "no one"}` : undefined}
        testId="revoke-dialog"
        confirmLabel="Revoke"
        pendingLabel="Revoking…"
        pending={pending}
        error={confirmError}
        onClose={() => setConfirming(null)}
        onConfirm={() => confirming && revoke(confirming)}
        consequences={confirming ? revokeConsequences(confirming) : []}
      />
    </>
  );
}
