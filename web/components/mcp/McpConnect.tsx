'use client';
// MOCK-HOOK: the whole file is the mk-mcp-connect mock-up (Connect with MCP, decisions MC1..MC3).
// URL switches: ?mc1=a|b|c (where), ?mc2=a|b|c (the guide), ?mc3=a|b|c (clients and access),
// &tab=code|app|other, &copied=1, &phase=wait|done|late, &step=1|2|3, &revoke=1, &as=<role>, &clients=none|fresh|five.

import { useEffect, useState, type ReactNode } from 'react'; // MOCK-HOOK

import { ConfirmDialog } from '@/components/account/ConfirmDialog'; // MOCK-HOOK
import { Scopes, tokenState, when } from '@/components/ApiTokensSettings'; // MOCK-HOOK
import {
  Button,
  Chip,
  type Column,
  DataTable,
  Dialog,
  Icon,
  InfoTip,
  Notice,
  Panel,
  SegmentedControl,
} from '@/components/ds'; // MOCK-HOOK
import { api, unwrap, type McpClient } from '@/lib/api/client'; // MOCK-HOOK
import { MOCK_COMPANY, MOCK_MCP_URL, MOCK_WHERE } from '@/lib/api/mock/mcp-connect'; // MOCK-HOOK
import { formatDate, formatDateTime } from '@/lib/format'; // MOCK-HOOK
import { Link, useSearchParams } from '@/lib/nav'; // MOCK-HOOK
import { useMe } from '@/lib/me'; // MOCK-HOOK
import { errorMessage, useQuery } from '@/lib/use-query'; // MOCK-HOOK

/** MOCK-HOOK: the variant switches. */
export function useMcpMock() {
  const p = useSearchParams(); // MOCK-HOOK
  const get = (k: string, d: string) => p.get(k) ?? d; // MOCK-HOOK
  return {
    mc1: get('mc1', 'a'), // MOCK-HOOK
    mc2: get('mc2', 'a'), // MOCK-HOOK
    mc3: get('mc3', 'a'), // MOCK-HOOK
    tab: get('tab', 'code') as Tab, // MOCK-HOOK
    copied: p.get('copied') === '1', // MOCK-HOOK
    phase: get('phase', 'rest'), // MOCK-HOOK
    step: Number(get('step', '1')), // MOCK-HOOK
    revoke: p.get('revoke') === '1', // MOCK-HOOK
    open: p.get('open') === '1', // MOCK-HOOK
    on: p.has('mc1') || p.has('mc2') || p.has('mc3'), // MOCK-HOOK
  };
}

type Tab = 'code' | 'app' | 'other'; // MOCK-HOOK
const TABS: { value: Tab; label: string }[] = [
  { value: 'code', label: 'Claude Code' }, // MOCK-HOOK
  { value: 'app', label: 'Claude app' }, // MOCK-HOOK
  { value: 'other', label: 'Other client' }, // MOCK-HOOK
];

/** MOCK-HOOK: relative "last used", a moment ago when under two minutes. */
function ago(iso: string) {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000); // MOCK-HOOK
  if (min < 2) return 'A moment ago'; // MOCK-HOOK
  if (min < 60) return `${min} min ago`; // MOCK-HOOK
  if (min < 60 * 24) return `${Math.round(min / 60)} h ago`; // MOCK-HOOK
  return null; // MOCK-HOOK: older: the date
}
const usedCell = (iso: string) => {
  const a = ago(iso); // MOCK-HOOK
  return a ? <span className="whitespace-nowrap text-text2" title={formatDateTime(iso)}>{a}</span> : when(iso); // MOCK-HOOK
};

/** MOCK-HOOK: one copyable value: a command or the address. */
function CopyChip({ text, copied: start = false, testId }: { text: string; copied?: boolean; testId?: string }) {
  const [copied, setCopied] = useState(start); // MOCK-HOOK
  return (
    <span className="flex min-w-0 items-center gap-2" data-testid={testId}>
      <code className="min-w-0 flex-1 rounded-lg border border-line bg-surface2 px-2.5 py-1.5 font-mono text-sm break-all text-text">
        {text}
      </code>
      <Button
        icon={copied ? 'check' : undefined}
        variant={copied ? 'solid' : 'secondary'}
        onClick={async () => {
          await navigator.clipboard?.writeText(text).catch(() => undefined); // MOCK-HOOK
          setCopied(true); // MOCK-HOOK
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </span>
  );
}

/** MOCK-HOOK: what the person's tools will be able to do, read from their role. */
export function RoleAccess() {
  const { me } = useMe(); // MOCK-HOOK
  const role = me?.role ?? 'viewer'; // MOCK-HOOK
  const [kind, label, tip] =
    role === 'viewer'
      ? (['na', 'Read only', 'Your role is Viewer: a connected tool reads goals, the roadmap and documents, and changes nothing.'] as const)
      : role === 'commenter'
        ? (['warn', 'Changes become proposals', 'Your role is Commenter: what a tool changes waits as a proposal for an approver.'] as const)
        : (['pass', 'Changes apply at once', `Your role is ${role === 'owner' ? 'Owner' : 'Approver'}: what a tool changes is final at once, as if you made it. Each change sends the values you last saw; if someone changed them since, it is refused.`] as const); // MOCK-HOOK
  return (
    <span className="inline-flex items-center gap-1" data-testid="mcp-role-access">
      <Chip kind={kind} dot>
        {label}
      </Chip>
      <InfoTip label="what your tools can do" align="start">
        {tip} Approve with Read only and a tool only reads.
      </InfoTip>
    </span>
  );
}

/** MOCK-HOOK: the handful of tools most people use (of about 800, one per API operation). */
function MostUsed() {
  return (
    <InfoTip label="the tools you will use most" align="start" trigger={<Chip kind="line">Most used tools</Chip>}>
      About 800 tools load, one per action in Oracle. The ones most people use: read the roadmap,
      change an item, add or edit a goal, add or edit a milestone, comment.
    </InfoTip>
  );
}

function Step({ n, title, children }: { n: number; title: ReactNode; children?: ReactNode }) {
  return (
    <li className="flex min-w-0 gap-3">
      <span className="tnum flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm font-semibold text-accent-ink">
        {n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 pt-0.5">
        <span className="text-base font-medium">{title}</span>
        {children}
      </div>
    </li>
  );
}

/** MOCK-HOOK: the steps for one client. */
function ClientSteps({ tab, copied }: { tab: Tab; copied: boolean }) {
  const cmd = `claude mcp add --transport http oracle ${MOCK_MCP_URL}`; // MOCK-HOOK
  if (tab === 'code')
    return (
      <ol className="flex flex-col gap-4" data-testid="mcp-steps-code">
        <Step
          n={1}
          title={
            <span className="inline-flex items-center gap-1">
              In a terminal, run
              <InfoTip label="every project" align="start">
                Add --scope user at the end to have Oracle in every project.
              </InfoTip>
            </span>
          }
        >
          <CopyChip text={cmd} copied={copied} testId="mcp-command" />
        </Step>
        <Step n={2} title="In Claude Code, run /mcp and choose oracle">
          <span className="w-fit">
            <CopyChip text="/mcp" />
          </span>
        </Step>
        <Step n={3} title="In the browser that opens, click Approve" />
      </ol>
    );
  if (tab === 'app')
    return (
      <ol className="flex flex-col gap-4" data-testid="mcp-steps-app">
        <Step n={1} title="In Claude, open Settings > Connectors and add a custom connector" />
        <Step n={2} title="Paste the address">
          <CopyChip text={MOCK_MCP_URL} />
        </Step>
        <Step n={3} title="Click Connect, then Approve" />
      </ol>
    );
  return (
    <ol className="flex flex-col gap-4" data-testid="mcp-steps-other">
      <Step n={1} title="Add a server with this address">
        <CopyChip text={MOCK_MCP_URL} />
      </Step>
      <Step
        n={2}
        title={
          <span className="inline-flex items-center gap-1">
            Sign in with OAuth, then Approve
            <InfoTip label="sign-in" align="start">
              The client registers itself; no key to paste.
            </InfoTip>
          </span>
        }
      />
    </ol>
  );
}

/** MOCK-HOOK: did it work: the newest connected client, or what to do when the sign-in timed out. */
function CheckStrip({ phase, clients }: { phase: string; clients?: McpClient[] }) {
  const live = clients?.filter((c) => tokenState(c) === 'active') ?? []; // MOCK-HOOK
  const newest = [...live].sort((a, b) => b.authorized_at.localeCompare(a.authorized_at))[0]; // MOCK-HOOK
  if (phase === 'late')
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-warn-bg p-3" data-testid="mcp-check">
        <Icon name="clock" size={16} />
        <span className="font-medium">Sign-in timed out</span>
        <InfoTip label="a timed-out sign-in" align="start">
          The sign-in waits a few minutes. Run /mcp again, choose oracle, and Approve straight away.
        </InfoTip>
        <span className="ml-auto w-fit">
          <CopyChip text="/mcp" />
        </span>
      </div>
    );
  if (newest && phase !== 'wait')
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-pass-bg p-3" data-testid="mcp-check">
        <Icon name="check" size={16} />
        <span className="min-w-0 truncate font-medium">{newest.client_name}</span>
        <Chip kind="pass">Connected</Chip>
        <span className="text-sm text-text2">Used {(ago(newest.last_used_at) ?? 'on ' + formatDate(newest.last_used_at)).toLowerCase()}</span>
      </div>
    );
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-line p-3 text-text2" data-testid="mcp-check">
      <Icon name="clock" size={16} />
      <span>Waiting for your first client</span>
      <InfoTip label="checking it worked" align="start">
        After you Approve, the client shows here and under Connected clients, with when it was last used.
      </InfoTip>
    </div>
  );
}

/** MOCK-HOOK: MC2, the connect guide, in three variants. */
export function ConnectGuide({ bare = false }: { bare?: boolean }) {
  const m = useMcpMock(); // MOCK-HOOK
  const [tab, setTab] = useState<Tab>(m.tab); // MOCK-HOOK
  const [step, setStep] = useState(m.step); // MOCK-HOOK
  const clientsQ = useQuery('my-oauth-clients', () => unwrap(api.GET('/v1/me/oauth-clients'))); // MOCK-HOOK
  useEffect(() => setTab(m.tab), [m.tab]); // MOCK-HOOK

  const address = (
    <div className="flex flex-col gap-1.5">
      <span className="inline-flex items-center gap-1 text-sm font-semibold text-text2">
        Oracle&apos;s MCP address
        <InfoTip label="the MCP address" align="start">
          Every Oracle action is a tool here, limited to what your role allows.
        </InfoTip>
      </span>
      <CopyChip text={MOCK_MCP_URL} testId="mcp-address" />
    </div>
  );
  const access = (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm font-semibold text-text2">Your tools can</span>
      <RoleAccess />
      <MostUsed />
    </div>
  );

  let body: ReactNode; // MOCK-HOOK
  if (m.mc2 === 'b') {
    // MOCK-HOOK: b, one step at a time, waiting for the connection.
    const STEPS = ['Pick your tool', 'Add Oracle', 'Approve and check']; // MOCK-HOOK
    body = (
      <div className="flex flex-col gap-4 p-4">
        <ol className="flex flex-wrap gap-2" aria-label="Steps">
          {STEPS.map((s, i) => (
            <li key={s}>
              <Chip kind={i + 1 === step ? 'acc' : i + 1 < step ? 'pass' : 'line'} dot={i + 1 < step}>
                {i + 1}. {s}
              </Chip>
            </li>
          ))}
        </ol>
        {step === 1 && (
          <div className="flex flex-col gap-3">
            <SegmentedControl label="Your tool" items={TABS} value={tab} onChange={setTab} fill />
            {access}
          </div>
        )}
        {step === 2 && <ClientSteps tab={tab} copied={m.copied} />}
        {step === 3 && <CheckStrip phase={m.phase} clients={clientsQ.data} />}
        <div className="flex gap-2">
          {step > 1 && (
            <Button variant="ghost" onClick={() => setStep(step - 1)}>
              Back
            </Button>
          )}
          {step < 3 && (
            <Button variant="solid" onClick={() => setStep(step + 1)}>
              Next
            </Button>
          )}
        </div>
      </div>
    );
  } else if (m.mc2 === 'c') {
    // MOCK-HOOK: c, everything on one card, Claude Code only, the rest behind a tip.
    body = (
      <div className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-text2">Claude Code</span>
          <InfoTip label="other clients" align="start">
            Claude app: Settings &gt; Connectors, add a custom connector with the address. Other
            clients: add the address; sign-in is OAuth.
          </InfoTip>
          <span className="ml-auto">
            <RoleAccess />
          </span>
        </div>
        <CopyChip text={`claude mcp add --transport http oracle ${MOCK_MCP_URL}`} copied={m.copied} testId="mcp-command" />
        <span className="text-sm text-text2">Then /mcp, choose oracle, Approve.</span>
      </div>
    );
  } else {
    // MOCK-HOOK: a, the address, a tab per client, numbered steps, and the live check.
    body = (
      <div className="grid gap-5 p-4 min-[900px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          {address}
          {access}
          <CheckStrip phase={m.phase} clients={clientsQ.data} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <SegmentedControl label="Your tool" items={TABS} value={tab} onChange={setTab} fill />
          <ClientSteps tab={tab} copied={m.copied} />
        </div>
      </div>
    );
  }
  if (bare) return <div data-testid="mcp-guide">{body}</div>;
  return (
    <Panel
      title="Connect an AI tool"
      testId="mcp-guide"
      tools={
        <InfoTip label="connecting an AI tool" align="end">
          Use Oracle from Claude or another MCP client, signed in as you.
        </InfoTip>
      }
    >
      <div id="connect">{body}</div>
    </Panel>
  );
}

/** MOCK-HOOK: MC3, the person's connected clients, in three variants. */
export function ConnectedClients({ tokens }: { tokens?: number }) {
  const m = useMcpMock(); // MOCK-HOOK
  const q = useQuery('my-oauth-clients', () => unwrap(api.GET('/v1/me/oauth-clients'))); // MOCK-HOOK
  const [confirming, setConfirming] = useState<McpClient | null>(null); // MOCK-HOOK
  const [pending, setPending] = useState<McpClient | null>(null); // MOCK-HOOK: b, undo window
  const [inline, setInline] = useState<string | null>(null); // MOCK-HOOK: c, inline confirm
  const [error, setError] = useState<string | null>(null); // MOCK-HOOK
  const tq = useQuery('my-tokens', () => unwrap(api.GET('/v1/me/tokens'))); // MOCK-HOOK: b lists tokens in the same list
  const asRows: McpClient[] = (m.mc3 === 'b' ? (tq.data ?? []) : []).map((t) => ({
    id: t.id, // MOCK-HOOK
    client_id: 'token', // MOCK-HOOK
    client_name: t.name, // MOCK-HOOK
    scopes: t.scopes ?? [], // MOCK-HOOK
    authorized_at: t.created_at, // MOCK-HOOK
    last_used_at: t.last_used_at ?? t.created_at, // MOCK-HOOK
    expires_at: t.expires_at ?? t.created_at, // MOCK-HOOK
    revoked_at: tokenState(t) === 'active' ? null : (t.revoked_at ?? t.created_at), // MOCK-HOOK
  }));
  const rows = q.data && [...q.data, ...asRows].filter((c) => tokenState(c) === 'active' || c.id === pending?.id); // MOCK-HOOK
  useEffect(() => {
    if (m.revoke && q.data?.[0] && m.mc3 === 'a') setConfirming(q.data[q.data.length - 1]); // MOCK-HOOK
    if (m.revoke && q.data?.[0] && m.mc3 === 'c') setInline(q.data[q.data.length - 1].id); // MOCK-HOOK
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.revoke, !!q.data]);

  async function revoke(c: McpClient) {
    try {
      await unwrap(api.DELETE('/v1/me/oauth-clients/{grant_id}', { params: { path: { grant_id: c.id } } })); // MOCK-HOOK
      q.setData((prev) => prev?.map((x) => (x.id === c.id ? { ...x, revoked_at: new Date().toISOString() } : x))); // MOCK-HOOK
      setConfirming(null);
      setInline(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const tokensLink = (
    <Link href="/account#tokens-panel" className="rounded-full hover:underline" data-testid="mcp-tokens-link">
      <Chip kind="line">
        <span className="tnum">{tokens ?? 0}</span> personal {tokens === 1 ? 'token' : 'tokens'}
      </Chip>
    </Link>
  );
  const where = (c: McpClient) => (c.client_id === 'token' ? 'A script' : (MOCK_WHERE[c.client_id] ?? 'Another app')); // MOCK-HOOK

  if (m.mc3 === 'c') {
    // MOCK-HOOK: c, a card per client, Revoke asks inline in the card.
    return (
      <Panel title="Connected clients" count={rows?.length} testId="mcp-clients" tools={tokensLink}>
        {rows && rows.length === 0 && <p className="p-4 text-text2">None yet</p>}
        <ul className="grid gap-3 p-4 min-[900px]:grid-cols-2 min-[1400px]:grid-cols-3">
          {rows?.map((c) => (
            <li key={c.id} className="flex min-w-0 flex-col gap-2 rounded-xl border border-line p-3" data-testid="mcp-client-card">
              <span className="truncate font-medium" title={c.client_name}>{c.client_name}</span>
              <span className="flex flex-wrap items-center gap-2 text-sm text-text2">
                {where(c)} · <Scopes scopes={c.scopes} />
              </span>
              <span className="flex flex-wrap items-center gap-x-3 text-sm text-text2">
                <span>Connected {when(c.authorized_at)}</span>
                <span className="inline-flex gap-1">Used {usedCell(c.last_used_at)}</span>
              </span>
              {inline === c.id ? (
                <span className="flex flex-wrap items-center gap-2 rounded-lg bg-crit-bg p-2">
                  <span className="text-sm font-medium">It stops working at once</span>
                  <Button variant="danger" onClick={() => revoke(c)}>Revoke</Button>
                  <Button variant="ghost" onClick={() => setInline(null)}>Keep</Button>
                </span>
              ) : (
                <Button className="w-fit" aria-label={`Revoke ${c.client_name}`} onClick={() => setInline(c.id)}>
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Panel>
    );
  }

  const columns: Column<McpClient>[] = [
    {
      key: 'name',
      header: 'Client',
      cell: (c) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium" title={c.client_name}>{c.client_name}</span>
          {m.mc3 === 'b' && <span className="text-sm text-text2">{c.client_id === 'token' ? 'Personal token' : 'MCP client'}</span>}
        </span>
      ),
    },
    { key: 'where', header: 'Where it runs', width: '140px', hideOnPhone: true, cell: (c) => <span className="text-text2">{where(c)}</span> },
    { key: 'scopes', header: 'Access', width: '116px', hideOnPhone: true, wrap: true, cell: (c) => <Scopes scopes={c.scopes} /> },
    { key: 'at', header: 'Connected', width: '104px', hideOnPhone: true, cell: (c) => when(c.authorized_at) },
    { key: 'used', header: 'Last used', width: '124px', phoneLabel: 'Used ', cell: (c) => usedCell(c.last_used_at) },
    {
      key: 'action',
      header: <span className="sr-only">Actions</span>,
      width: '120px',
      align: 'right',
      phone: 'action',
      wrap: true,
      cell: (c) =>
        pending?.id === c.id ? (
          <span className="inline-flex items-center gap-2" data-testid="mcp-undo">
            <Chip kind="crit">Revoked</Chip>
            <Button variant="ghost" onClick={() => setPending(null)}>Undo</Button>
          </span>
        ) : (
          <Button
            aria-label={`Revoke ${c.client_name}`}
            onClick={() => (m.mc3 === 'b' ? setPending(c) : setConfirming(c))} // MOCK-HOOK: b revokes after the undo window
          >
            Revoke
          </Button>
        ),
    },
  ];
  useEffect(() => {
    if (m.revoke && m.mc3 === 'b' && q.data?.length) setPending(q.data[q.data.length - 1]); // MOCK-HOOK
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.revoke, !!q.data]);

  return (
    <Panel
      title={m.mc3 === 'b' ? 'What acts as you' : 'Connected clients'} // MOCK-HOOK
      count={rows?.length}
      testId="mcp-clients"
      tools={
        <span className="flex items-center gap-2">
          {m.mc3 === 'a' && tokensLink}
          <InfoTip label="connected clients" align="end">
            AI tools you approved. Revoke ends a tool&apos;s access at once; to use it again, connect it again.
          </InfoTip>
        </span>
      }
    >
      {error && <Notice tone="error">{error}</Notice>}
      <DataTable
        label="Connected clients"
        columns={columns}
        rows={rows}
        loading={!rows}
        rowKey={(c) => c.id}
        rowProps={() => ({ 'data-testid': 'mcp-client-row' })}
        empty="None yet"
      />
      <ConfirmDialog
        open={!!confirming}
        title="Revoke this client?"
        subject={confirming?.client_name}
        testId="mcp-revoke-dialog"
        confirmLabel="Revoke"
        pendingLabel="Revoking…"
        pending={false}
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

/** MOCK-HOOK: MC3, the owner's company view: who has connected a client. */
export function CompanyMcp() {
  const m = useMcpMock(); // MOCK-HOOK
  const { me } = useMe(); // MOCK-HOOK
  if (me?.role !== 'owner') return null; // MOCK-HOOK: owners only (the real check is can('list_api_tokens'))
  const connected = MOCK_COMPANY.filter((r) => r.clients > 0); // MOCK-HOOK
  const stat = (
    <Chip kind="line">
      <span className="tnum">{`${connected.length} of ${MOCK_COMPANY.length} people connected`}</span>
    </Chip>
  );
  if (m.mc3 === 'b')
    return (
      <Panel title="MCP across the company" testId="mcp-company" tools={stat}>
        <div className="flex flex-wrap gap-2 p-4">
          {MOCK_COMPANY.map((r) => (
            <Chip key={r.email} kind={r.clients ? 'pass' : 'na'} dot title={r.email}>
              {r.name} · {r.clients}
            </Chip>
          ))}
        </div>
      </Panel>
    );
  const cols: Column<(typeof MOCK_COMPANY)[number]>[] = [
    {
      key: 'who',
      header: 'Person',
      cell: (r) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{r.name}</span>
          <span className="truncate text-sm text-text2">{r.email}</span>
        </span>
      ),
    },
    { key: 'role', header: 'Role', width: '120px', hideOnPhone: true, cell: (r) => <span className="text-text2">{r.role}</span> },
    { key: 'n', header: 'Clients', width: '96px', align: 'right', cell: (r) => <span className="tnum">{r.clients}</span> },
    { key: 'used', header: 'Last used', width: '124px', phoneLabel: 'Used ', cell: (r) => (r.used ? usedCell(r.used) : <span className="text-text2">Never</span>) },
  ];
  const rows = m.mc3 === 'c' ? [...MOCK_COMPANY].sort((a, b) => (b.used ?? '').localeCompare(a.used ?? '')) : MOCK_COMPANY; // MOCK-HOOK
  return (
    <Panel title="MCP across the company" testId="mcp-company" tools={stat}>
      <DataTable label="MCP across the company" columns={cols} rows={rows} rowKey={(r) => r.email} />
    </Panel>
  );
}

/** MOCK-HOOK: MC1 b, the guide in a dialog opened from the account menu, on any page. */
export function ConnectDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Connect an AI tool" onClose={onClose} size="lg" testId="mcp-dialog" scrollBody>
      <div className="-m-4 flex flex-col">
        <ConnectGuide bare />
        <div className="border-t border-line p-4">
          <ConnectedClients />
        </div>
        <div className="px-4 pb-4">
          <CompanyMcp />
        </div>
      </div>
    </Dialog>
  );
}
