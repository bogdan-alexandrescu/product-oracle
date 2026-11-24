'use client';

import { useState } from 'react';

import { ConfirmDialog } from '@/components/account/ConfirmDialog';
import { Scopes, tokenState, when } from '@/components/ApiTokensSettings';
import { Button, Chip, type Column, DataTable, InfoTip, Notice, Panel } from '@/components/ds';
import { ROLE_LABEL } from '@/components/MembersSettings';
import { api, unwrap, type McpClient, type Schemas } from '@/lib/api/client';
import { useMe } from '@/lib/me';
import { Link } from '@/lib/nav';
import { errorMessage, useQuery } from '@/lib/use-query';

import { type ClientsQuery, usedCell } from './McpConnect';

/** The person's connected clients: a table, Revoke asks once, a chip to their tokens. */
export function ConnectedClients({ query, tokens }: { query: ClientsQuery; tokens?: number }) {
  const [confirming, setConfirming] = useState<McpClient | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rows = query.data?.filter((c) => tokenState(c) === 'active');

  async function revoke(c: McpClient) {
    setRevoking(true);
    setError(null);
    try {
      await unwrap(
        api.DELETE('/v1/me/oauth-clients/{grant_id}', { params: { path: { grant_id: c.id } } }),
      );
      const at = new Date().toISOString();
      query.setData((prev) =>
        prev?.map((x) => (x.id === c.id ? { ...x, revoked_at: x.revoked_at ?? at } : x)),
      );
      setConfirming(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRevoking(false);
    }
  }

  const columns: Column<McpClient>[] = [
    {
      key: 'name',
      header: 'Client',
      wrap: true,
      cell: (c) => <span className="font-medium break-words">{c.client_name}</span>,
    },
    {
      key: 'where',
      header: 'Where it runs',
      width: '140px',
      hideOnPhone: true,
      wrap: true,
      cell: (c) => <span className="text-text2">{c.runs_on}</span>,
    },
    {
      key: 'scopes',
      header: 'Access',
      width: '124px',
      hideOnPhone: true,
      cell: (c) => (
        <span className="whitespace-nowrap">
          <Scopes scopes={c.scopes} />
        </span>
      ),
    },
    {
      key: 'at',
      header: 'Connected',
      width: '112px',
      hideOnPhone: true,
      cell: (c) => when(c.authorized_at),
    },
    {
      key: 'used',
      header: 'Last used',
      width: '124px',
      phoneLabel: 'Used ',
      cell: (c) => usedCell(c.last_used_at),
    },
    {
      key: 'action',
      header: <span className="sr-only">Actions</span>,
      width: '104px',
      align: 'right',
      phone: 'action',
      wrap: true,
      cell: (c) => (
        <Button
          aria-label={`Revoke ${c.client_name}`}
          onClick={() => {
            setError(null);
            setConfirming(c);
          }}
        >
          Revoke
        </Button>
      ),
    },
  ];

  return (
    <Panel
      title="Connected clients"
      count={rows?.length}
      testId="clients-panel"
      tools={
        <span className="flex items-center gap-2">
          {tokens !== undefined && (
            <Link
              href="/account#tokens-panel"
              className="rounded-full hover:underline"
              data-testid="mcp-tokens-link"
            >
              <Chip kind="line">
                <span className="tnum">{tokens}</span> personal API{' '}
                {tokens === 1 ? 'token' : 'tokens'}
              </Chip>
            </Link>
          )}
          <InfoTip label="connected clients" align="end">
            AI tools you approved. Revoke ends a tool&apos;s access at once; to use it again,
            connect it again.
          </InfoTip>
        </span>
      }
    >
      {query.error && <Notice tone="error">{query.error}</Notice>}
      <DataTable
        label="Connected clients"
        columns={columns}
        rows={rows}
        loading={!rows && !query.error}
        rowKey={(c) => c.id}
        rowProps={() => ({ 'data-testid': 'my-client-row' })}
        empty="None yet"
      />
      <ConfirmDialog
        open={!!confirming}
        title="Revoke this client?"
        subject={confirming?.client_name}
        testId="revoke-client-dialog"
        confirmLabel="Revoke"
        pendingLabel="Revoking…"
        pending={revoking}
        error={error}
        onClose={() => setConfirming(null)}
        onConfirm={() => confirming && revoke(confirming)}
        consequences={[
          { icon: 'lock', text: 'It stops working at once.' },
          { icon: 'link', text: 'To use it again, connect it again.' },
        ]}
      />
    </Panel>
  );
}

type Person = Schemas['McpPersonOut'];

/** The owner's company view: who has connected a client (Settings > Connections). */
export function CompanyMcp() {
  const { can } = useMe();
  const allowed = can('list_mcp_people');
  if (!allowed) return null;
  return <CompanyTable />;
}

function CompanyTable() {
  const q = useQuery('mcp-people', () => unwrap(api.GET('/v1/mcp-people')));
  const name = (p: Person) => p.name ?? p.email;
  const rows = q.data && [...q.data.people].sort((a, b) => name(a).localeCompare(name(b)));
  const cols: Column<Person>[] = [
    {
      key: 'who',
      header: 'Person',
      cell: (p) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{name(p)}</span>
          <span className="truncate text-sm text-text2">{p.email}</span>
        </span>
      ),
    },
    {
      key: 'role',
      header: 'Role',
      width: '120px',
      hideOnPhone: true,
      cell: (p) => <span className="text-text2">{ROLE_LABEL[p.role]}</span>,
    },
    {
      key: 'n',
      header: 'Clients',
      width: '96px',
      align: 'right',
      cell: (p) => <span className="tnum">{p.clients}</span>,
    },
    {
      key: 'used',
      header: 'Last used',
      width: '124px',
      phoneLabel: 'Used ',
      cell: (p) =>
        p.last_used_at ? usedCell(p.last_used_at) : <span className="text-text2">Never</span>,
    },
  ];
  return (
    <Panel
      title="MCP across the company"
      testId="mcp-company"
      tools={
        q.data && (
          <Chip kind="line">
            <span className="tnum" data-testid="mcp-company-count">
              {`${q.data.connected} of ${q.data.total} people connected`}
            </span>
          </Chip>
        )
      }
    >
      {q.error && <Notice tone="error">{q.error}</Notice>}
      <DataTable
        label="MCP across the company"
        columns={cols}
        rows={rows}
        loading={!rows && !q.error}
        rowKey={(p) => p.user_id}
        rowProps={() => ({ 'data-testid': 'mcp-company-row' })}
      />
    </Panel>
  );
}
