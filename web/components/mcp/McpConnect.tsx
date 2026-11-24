'use client';

import { useEffect, useState, type ReactNode } from 'react';

import { tokenState, when } from '@/components/ApiTokensSettings';
import { Button, Chip, Icon, InfoTip, Panel, SegmentedControl } from '@/components/ds';
import { ROLE_LABEL } from '@/components/MembersSettings';
import type { McpClient } from '@/lib/api/client';
import { formatDate, formatDateTime } from '@/lib/format';
import { useMe } from '@/lib/me';
import type { useQuery } from '@/lib/use-query';

export type ClientsQuery = ReturnType<typeof useQuery<McpClient[]>>;
type Tab = 'code' | 'app' | 'other';

const TABS: { value: Tab; label: string }[] = [
  { value: 'code', label: 'Claude Code' },
  { value: 'app', label: 'Claude app' },
  { value: 'other', label: 'Other client' },
];

/** While waiting for a new client, the list is read this often, for at most WATCH_FOR. */
export const WATCH_EVERY_MS = 3_000;
export const WATCH_FOR_MS = 5 * 60_000;

/** Relative "last used" under a day; null when older (the date then). */
export function ago(iso: string) {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (min < 2) return 'Just now';
  if (min < 60) return `${min} min ago`;
  if (min < 60 * 24) return `${Math.round(min / 60)} h ago`;
  return null;
}

export const usedCell = (iso: string) => {
  const a = ago(iso);
  return a ? (
    // On the phone the row reads "Used just now": lower case after its label.
    <span
      className="whitespace-nowrap text-text2 max-[600px]:lowercase"
      title={formatDateTime(iso)}
    >
      {a}
    </span>
  ) : (
    when(iso)
  );
};

/** One copyable value: a command or the address. */
function CopyChip({ text, testId }: { text: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="flex min-w-0 items-center gap-2" data-testid={testId}>
      <code className="min-w-0 flex-1 rounded-lg border border-line bg-surface2 px-2.5 py-1.5 font-mono text-sm break-normal text-text">
        {/* Wrap only at spaces and after / or . so the command reads exactly. */}
        {text.split(' ').map((word, i) => (
          <span key={i}>
            {i > 0 && ' '}
            <span className={word.includes('/') ? undefined : 'whitespace-nowrap'}>
              {word.split(/(?<=[/.])(?!\/)/).map((part, j) => (
                <span key={j}>
                  {j > 0 && <wbr />}
                  {part}
                </span>
              ))}
            </span>
          </span>
        ))}
      </code>
      <Button
        icon={copied ? 'check' : undefined}
        variant={copied ? 'solid' : 'secondary'}
        onClick={() => {
          void navigator.clipboard
            ?.writeText(text)
            .catch(() => undefined)
            .then(() => setCopied(true));
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </span>
  );
}

/** What the person's tools will be able to do: read from what their role may call. */
function RoleAccess() {
  const { can, capsReady, role } = useMe();
  const [kind, label, tip] = can('create_bucket_goal')
    ? ([
        'pass',
        'Changes apply at once',
        'What a tool changes is final at once, as if you made it. Each change sends the values you last saw; if someone changed them since, it is refused.',
      ] as const)
    : can('create_comment')
      ? ([
          'warn',
          'Changes become proposals',
          'What a tool changes waits as a proposal for an approver.',
        ] as const)
      : ([
          'na',
          'Read only',
          `Your role is ${role ? ROLE_LABEL[role] : 'not known'}: a connected tool reads goals, the roadmap and documents, and changes nothing.`,
        ] as const);
  // Until the capabilities load, no status (never a wrong one).
  if (!capsReady) return null;
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

/** The handful of tools most people need, by their MCP tool name (one per API action). */
export const MOST_USED: readonly [string, string][] = [
  ['get_simple_roadmap', 'Read the roadmap'],
  ['create_simple_change', 'Change a roadmap item'],
  ['create_bucket_goal', 'Add a goal'],
  ['edit_goal', 'Edit a goal'],
  ['create_goal_milestone', 'Add a milestone'],
  ['patch_goal_milestone', 'Edit a milestone'],
  ['add_feature_comment', 'Comment on a feature'],
];

function MostUsed() {
  return (
    <InfoTip
      label="the tools you will use most"
      align="start"
      trigger={<Chip kind="line">Most used tools</Chip>}
    >
      <span className="flex flex-col gap-1" data-testid="mcp-most-used">
        {MOST_USED.map(([name, what]) => (
          <span key={name}>
            <code className="font-mono">{name}</code>: {what}
          </span>
        ))}
      </span>
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

/** The steps for one client. */
function ClientSteps({ tab, url }: { tab: Tab; url: string }) {
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
          <CopyChip text={`claude mcp add --transport http oracle ${url}`} testId="mcp-command" />
        </Step>
        <Step
          n={2}
          title={
            <>
              In Claude Code, run <code className="font-mono">/mcp</code> and choose{' '}
              <code className="font-mono">oracle</code>
            </>
          }
        >
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
          <CopyChip text={url} />
        </Step>
        <Step n={3} title="Click Connect, then Approve" />
      </ol>
    );
  return (
    <ol className="flex flex-col gap-4" data-testid="mcp-steps-other">
      <Step n={1} title="Add a server with this address">
        <CopyChip text={url} />
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

/**
 * Live check: while the panel is open, the list is read every few seconds until a client
 * that was not there when it opened appears, or five minutes pass (then: timed out).
 */
function useWatch(query: ClientsQuery) {
  const [known, setKnown] = useState<Set<string> | null>(null);
  const [late, setLate] = useState(false);
  const loaded = !!query.data;
  // The clients there when the panel opened (set once, during render).
  if (known === null && query.data) setKnown(new Set(query.data.map((c) => c.id)));
  const fresh = known
    ? query.data
        ?.filter((c) => !known.has(c.id) && tokenState(c) === 'active')
        .sort((a, b) => b.authorized_at.localeCompare(a.authorized_at))[0]
    : undefined;
  const { reload } = query;
  const waiting = loaded && !fresh && !late;
  useEffect(() => {
    if (!waiting) return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started >= WATCH_FOR_MS) setLate(true);
      else void reload();
    }, WATCH_EVERY_MS);
    // A background tab's timers are slowed: read again as soon as the page is back.
    const back = () => document.visibilityState === 'visible' && void reload();
    document.addEventListener('visibilitychange', back);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', back);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one watch per waiting spell
  }, [waiting]);
  return { fresh, late };
}

/** Did it work: the new (or newest) client, or what to do when the sign-in timed out. */
function CheckStrip({ query }: { query: ClientsQuery }) {
  const { fresh, late } = useWatch(query);
  const live = query.data?.filter((c) => tokenState(c) === 'active') ?? [];
  const newest =
    fresh ?? [...live].sort((a, b) => b.authorized_at.localeCompare(a.authorized_at))[0];
  if (late && !newest)
    return (
      <div
        className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-warn-bg p-3"
        data-testid="mcp-check"
      >
        <Icon name="clock" size={16} />
        <span className="font-medium">Sign-in timed out</span>
        <span className="text-sm">Run /mcp again and Approve straight away</span>
        <span className="ml-auto w-fit">
          <CopyChip text="/mcp" />
        </span>
      </div>
    );
  if (newest)
    return (
      <div
        className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-pass-bg p-3"
        data-testid="mcp-check"
      >
        <Icon name="check" size={16} />
        <span className="min-w-0 font-medium">{newest.client_name}</span>
        <Chip kind="pass">Connected</Chip>
        <span className="text-sm text-text">
          Used {ago(newest.last_used_at)?.toLowerCase() ?? `on ${formatDate(newest.last_used_at)}`}
        </span>
      </div>
    );
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-line p-3 text-text2"
      data-testid="mcp-check"
    >
      <Icon name="clock" size={16} />
      <span>Waiting for your first client</span>
      <InfoTip label="checking it worked" align="start">
        After you Approve, the client shows here and under Connected clients, with when it was last
        used.
      </InfoTip>
    </div>
  );
}

/** The connect guide: the address, what your tools can do, the live check, a tab per client. */
export function ConnectGuide({ url, query }: { url?: string; query: ClientsQuery }) {
  const [tab, setTab] = useState<Tab>('code');
  return (
    <Panel
      id="connect"
      className="scroll-mt-16"
      title="Connect an AI tool"
      testId="mcp-guide"
      tools={
        <InfoTip label="connecting an AI tool" align="end">
          Use Oracle from Claude or another MCP client, signed in as you.
        </InfoTip>
      }
    >
      <div className="grid gap-5 p-4 min-[900px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="inline-flex items-center gap-1 text-sm font-semibold text-text2">
              Oracle&apos;s MCP address
              <InfoTip label="the MCP address" align="start">
                Every Oracle action is a tool here, limited to what your role allows.
              </InfoTip>
            </span>
            {url && <CopyChip text={url} testId="mcp-address" />}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-text2">Your tools can</span>
            <RoleAccess />
            <MostUsed />
          </div>
          <CheckStrip query={query} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <SegmentedControl label="Your tool" items={TABS} value={tab} onChange={setTab} fill />
          {url && <ClientSteps tab={tab} url={url} />}
        </div>
      </div>
    </Panel>
  );
}
