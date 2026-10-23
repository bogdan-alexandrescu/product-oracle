"use client";

/**
 * Settings > Claude accounts: the Claude subscriptions Oracle's built-in jobs run on.
 *
 * Ported from SwarmCloud's swarm-ui `src/Accounts.tsx`. The scan line is `cs status`'s:
 * the label, the five-hour figure and the state with when the binding window CLEARS.
 * Everything else lives in the chosen account's inspector: the 5h / 7d / Clears / Last
 * given out stats, the facts, Holding now | History, and an owner's controls (state with
 * a confirm and a reason, refresh, sign in again, remove by typing the label).
 *
 * Honesty marks, unchanged from SwarmCloud: an unmeasured window prints an em dash and
 * draws no bar; a measured 0% prints 0%; a figure that is real but old carries `~`; a
 * window past its reset says `reset`. Every change reloads the listing rather than
 * patching a local copy. No credential is ever rendered, not even its length.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import {
  Button,
  Chip,
  DataTable,
  Empty,
  InfoTip,
  Inspector,
  InspectorSection,
  Label,
  Notice,
  PageHeader,
  ViewOnly,
  Panel,
  Split,
  type ChipKind,
  type Column,
  type InspectorStat,
} from "@/components/ds";
import { ClaudeOffNotice, limitWord } from "@/components/ClaudeOffNotice";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatDateTime, inWords } from "@/lib/format";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

import { Field, INPUT, TEXTAREA } from "../_components/fields";

import {
  FIVE_HOUR,
  SEVEN_DAY,
  agoPastDay,
  anyProjected,
  clearsIn,
  clearsOf,
  defaultAccount,
  isProjected,
  needsAHuman,
  readingAges,
  readingOf,
  timeAgo,
  type Account,
  type AccountReading,
} from "./_readings";

type Page = Schemas["AccountsPage"];
type StateName = Account["state"];

/** A sign-in between its authorize URL and its pasted code. Survives a reload. */
type SignIn =
  | { kind: "idle" }
  | { kind: "started"; label: string; state: string; url: string; expiresIn: number }
  | { kind: "done"; account: Account };

/** Separator that keeps the summary's text "4 accounts · 3 available" between chips. */
const Dot = () => <span className="sr-only"> · </span>;

export function ClaudeAccounts() {
  const q = useQuery("claude-accounts", () => unwrap(api.GET("/v1/claude-accounts")));
  const { can, capsReady } = useMe();
  const owner = can("add_claude_account");
  const [chosen, setChosen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [fallbackOpen, setFallbackOpen] = useState(false);
  // Keyed by what they are for ("add", or an account id for signing in again), held
  // here so a reload after a write does not lose a sign-in under way.
  const [signins, setSignins] = useState<Record<string, SignIn>>({});
  const signin = (key: string) => signins[key] ?? { kind: "idle" };
  const setSignin = (key: string, s: SignIn) => setSignins((all) => ({ ...all, [key]: s }));

  return (
    <>
      <PageHeader
        title="Claude accounts"
        status={
          <>
            <InfoTip label="Claude accounts" align="start" side="bottom">
              The Claude subscriptions Oracle&apos;s built-in jobs (review comments, reporting, refinement) run on.
              Each call takes the account with the most headroom and moves to another when one runs out. Agent
              workflows run in SwarmCloud on SwarmCloud&apos;s own accounts.
            </InfoTip>
            {q.data && <SummaryChips page={q.data} />}
            {capsReady && !owner && <ViewOnly />}
          </>
        }
        action={
          owner && q.data ? (
            <Button
              variant="primary"
              icon="plus"
              aria-label="+ Add account"
              aria-expanded={adding}
              disabled={signin("add").kind === "started"}
              onClick={() => setAdding(!adding)}
            >
              Add account
            </Button>
          ) : null
        }
      />
      {q.error && <Notice tone="error">{q.error}</Notice>}
      {q.loading && !q.data && (
        <Panel title="Accounts">
          <DataTable<Account>
            label="Subscription accounts"
            columns={[{ key: "label", header: "Account", cell: (a) => a.label }]}
            rows={undefined}
            rowKey={(a) => a.account_id}
            loading
          />
        </Panel>
      )}
      {q.data && (
        <div className="flex flex-col gap-4 max-[600px]:gap-3">
          {owner && <ClaudeOffNotice page={q.data} onAdd={() => setAdding(true)} onFallback={() => setFallbackOpen(true)} />}
          <Broken accounts={q.data.accounts} owner={owner} onOpen={(id) => setChosen(id)} />
          <Pool
            page={q.data}
            owner={owner}
            chosen={chosen}
            choose={(id) => {
              setChosen(id);
              if (signin("add").kind === "idle") setAdding(false);
            }}
            adding={adding || (owner && q.data.accounts.length === 0)}
            setAdding={setAdding}
            fallbackOpen={fallbackOpen}
            setFallbackOpen={setFallbackOpen}
            signin={signin}
            setSignin={setSignin}
            reload={q.reload}
          />
        </div>
      )}
    </>
  );
}

/** The summary as chips; the hidden dots keep it one readable sentence for tests and readers. */
function SummaryChips({ page }: { page: Page }) {
  const n = page.accounts.length;
  // What the pool would give a call to, not the state alone: a spent account is AVAILABLE.
  const available = page.accounts.filter((a) => a.takes_calls).length;
  const broken = page.accounts.filter(needsAHuman).length;
  const missing = page.unreadable_document_count;
  const sweep = page.refresh_sweep;
  const sweepOk = sweep.readable && !!sweep.last_completed_at && sweep.last_outcome === "ok";
  return (
    <span data-testid="accounts-summary" className="flex flex-wrap items-center gap-2">
      <Chip kind="line">
        {n} account{n === 1 ? "" : "s"}
      </Chip>
      <Dot />
      <Chip kind="pass">{available} available</Chip>
      {missing > 0 && (
        <>
          <Dot />
          <Chip kind="crit" title="This list is short.">
            {missing} row{missing === 1 ? "" : "s"} unreadable
          </Chip>
        </>
      )}
      {broken > 0 && (
        <>
          <Dot />
          <Chip kind="warn">
            {broken} need{broken === 1 ? "s" : ""} a sign-in
          </Chip>
        </>
      )}
      <Dot />
      <Chip kind={sweepOk ? "na" : "warn"} data-testid="refresh-sweep">
        {!sweep.readable
          ? "refresh sweep unknown"
          : sweep.last_completed_at
            ? `refresh sweep ${sweep.last_outcome === "ok" ? "ran" : "failed"} ${timeAgo(sweep.last_completed_at)}`
            : "refresh sweep has not completed yet"}
      </Chip>
    </span>
  );
}

/** The accounts a timer will never fix, before anything else. */
function Broken({ accounts, owner, onOpen }: { accounts: Account[]; owner: boolean; onOpen: (id: string) => void }) {
  const broken = accounts.filter(needsAHuman);
  if (broken.length === 0) return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-button bg-warn-bg px-3 py-2 text-sm font-medium text-warn"
    >
      <span>
        <b>{broken.map((a) => a.label).join(", ")}</b> need{broken.length === 1 ? "s" : ""} someone to sign in again
      </span>
      <InfoTip label="sign-ins" align="start" side="bottom">
        {broken.length === 1 ? "It gives" : "They give"} out nothing until then.{" "}
        {owner ? "" : "An owner signs in again."}
      </InfoTip>
      {owner &&
        broken.map((a) => (
          <button
            key={a.account_id}
            type="button"
            className="font-semibold underline underline-offset-2"
            onClick={() => onOpen(a.account_id)}
          >
            {broken.length === 1 ? "Sign in again" : `Sign in again to ${a.label}`}
          </button>
        ))}
    </div>
  );
}

function Pool({
  page,
  owner,
  chosen,
  choose,
  adding,
  setAdding,
  fallbackOpen,
  setFallbackOpen,
  signin,
  setSignin,
  reload,
}: {
  page: Page;
  owner: boolean;
  chosen: string | null;
  choose: (id: string | null) => void;
  adding: boolean;
  setAdding: (on: boolean) => void;
  fallbackOpen: boolean;
  setFallbackOpen: (on: boolean) => void;
  signin: (key: string) => SignIn;
  setSignin: (key: string, s: SignIn) => void;
  reload: () => Promise<void>;
}) {
  // One clock for the whole render, so two figures cannot disagree by a second.
  const now = useNow(15_000);
  const accounts = [...page.accounts].sort((a, b) => a.label.localeCompare(b.label));
  const shown = accounts.find((a) => a.account_id === chosen) ?? defaultAccount(accounts);
  const addForm = owner ? (
    <AddAccount
      accounts={accounts}
      signin={signin("add")}
      setSignin={(s) => setSignin("add", s)}
      close={() => setAdding(false)}
      reload={reload}
    />
  ) : null;
  const showDetail = !!shown && !(adding && signin("add").kind === "idle");

  const columns: Column<Account>[] = [
    {
      key: "label",
      header: "Account",
      cell: (a) => (
        <span className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            tabIndex={-1}
            aria-current={shown?.account_id === a.account_id ? "true" : undefined}
            className="min-w-0 truncate text-left font-semibold"
          >
            {a.label}
          </button>
          {a.unreadable_now && (
            <Chip kind="crit" title="A call could not read this account's credential; the pool skips it for thirty minutes.">
              skipped
            </Chip>
          )}
        </span>
      ),
    },
    {
      key: "5h",
      header: "5h",
      phoneLabel: "5h",
      width: "76px",
      align: "right",
      cell: (a) => <WindowFig reading={readingOf(a, FIVE_HOUR)} window="five-hour" />,
    },
    { key: "state", header: "State", width: "196px", wrap: true, cell: (a) => <AcctState account={a} zone={page.time_zone} stacked /> },
    {
      key: "clears",
      header: "Clears",
      width: "176px",
      wrap: true,
      hideOnPhone: true,
      className: "text-text2",
      cell: (a) => <ClearsLine account={a} now={now} />,
    },
    {
      key: "given",
      header: "Given out",
      width: "168px",
      wrap: true,
      hideOnPhone: true,
      className: "text-text2",
      cell: (a) => (
        <span className="tnum" title={a.last_assigned_at ? formatDateTime(a.last_assigned_at) : undefined}>
          {a.last_assigned_at ? `given out ${agoPastDay(a.last_assigned_at, now)}` : "never given out"}
        </span>
      ),
    },
  ];

  const ages = readingAges(accounts, now);
  const inspector =
    (adding && addForm) || showDetail ? (
      <div className="flex min-w-0 flex-col gap-4 max-[600px]:gap-3">
        {adding && addForm}
        {showDetail && shown && (
          <Detail
            key={shown.account_id}
            account={shown}
            now={now}
            zone={page.time_zone}
            owner={owner}
            signin={signin(shown.account_id)}
            setSignin={(s) => setSignin(shown.account_id, s)}
            reload={reload}
          />
        )}
      </div>
    ) : undefined;

  return (
    <Split inspector={inspector}>
      <Panel title="Accounts" count={accounts.length} className="overflow-hidden">
        {accounts.length === 0 ? (
          <div role="status">
            <Empty>No accounts registered</Empty>
          </div>
        ) : (
          <DataTable
            label="Subscription accounts"
            testId="account-list"
            columns={columns}
            rows={accounts}
            rowKey={(a) => a.account_id}
            selected={shown?.account_id ?? null}
            onSelect={(id) => choose(id)}
            rowProps={(a) => ({ "data-testid": `account-row-${a.label}` })}
          />
        )}
        {accounts.length > 0 && (
          <p
            className="tnum flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line px-4 py-2 text-[13px] leading-4 text-text2"
            data-testid="accounts-foot"
          >
            <span>
              {accounts.length} row{accounts.length === 1 ? "" : "s"}
              {page.unreadable_document_count > 0 && <> of {accounts.length + page.unreadable_document_count}</>}
              {ages && <> · {ages}</>}
            </span>
            <InfoTip label="the figures" align="start">
              {anyProjected(accounts, now) ? "~ is an old reading, not current" : "no projected figures"} · — is not
              measured
            </InfoTip>
          </p>
        )}
      </Panel>
      <Fallback page={page} owner={owner} open={fallbackOpen} setOpen={setFallbackOpen} reload={reload} />
    </Split>
  );
}

/** The clock the screen's ages and countdowns read, ticking so they do not freeze. */
function useNow(tickMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), tickMs);
    return () => window.clearInterval(id);
  }, [tickMs]);
  return now;
}

const STATE_KIND: Record<string, ChipKind> = {
  AVAILABLE: "pass",
  PAUSED: "acc",
  DRAINING: "na",
  REAUTH_REQUIRED: "warn",
};

const STATE_LABEL: Record<string, string> = {
  AVAILABLE: "Available",
  PAUSED: "Paused",
  DRAINING: "Draining",
  REAUTH_REQUIRED: "Needs sign-in",
};

/** A state as a plain label; an unknown one in sentence case. */
export function stateLabel(state: string): string {
  return STATE_LABEL[state] ?? sentence(state.toLowerCase().replace(/_/g, " "));
}

/** The platform's reason codes, in words. */
const REASON_LABEL: Record<string, string> = {
  reauth_required: "sign-in needed",
  unreadable: "credential unreadable",
  refresh_failed: "refresh failed",
  refreshed: "refreshed",
  still_valid: "still valid",
  published: "published",
  held_deferred: "deferred while in use",
};

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A reason ("refresh failed: reauth_required") with its codes in words: "Refresh failed: sign-in needed". */
export function reasonLabel(reason: string): string {
  if (REASON_LABEL[reason]) return sentence(REASON_LABEL[reason]);
  // A reason someone typed reads as they typed it.
  if (!/[a-z]+(?:_[a-z]+)+/.test(reason)) return reason;
  const words = reason.replace(/[a-z]+(?:_[a-z]+)+/g, (code) =>
    code === NO_REFRESH ? "nothing to refresh" : (REASON_LABEL[code] ?? code.replace(/_/g, " ")),
  );
  return sentence(words);
}

/**
 * The state as a chip; the platform's spelling is the title. An AVAILABLE account the
 * pool will not choose because a window is spent reads "Spent until", as the gateway
 * treats it, never Available.
 */
function AcctState({ account, zone, stacked }: { account: Account; zone: string; stacked?: boolean }) {
  const { state } = account;
  if (account.spent_until) {
    const title = `Over its ${account.spent_by ? limitWord(account.spent_by) : "limit"}: Oracle gives it no calls until then.`;
    const when = inWords(account.spent_until, zone);
    // In a row the time goes under the chip, so the column stays narrow.
    return stacked ? (
      <span className="flex flex-col items-start gap-0.5" title={title}>
        <Chip kind="warn" dot>
          Spent until
        </Chip>
        <span className="tnum text-[13px] leading-4 text-text2">{when}</span>
      </span>
    ) : (
      <Chip kind="warn" dot title={title}>
        Spent until {when}
      </Chip>
    );
  }
  return (
    <Chip kind={STATE_KIND[state] ?? "na"} dot title={state}>
      {stateLabel(state)}
    </Chip>
  );
}

function readingTitle(r: AccountReading, window: string): string {
  switch (r.kind) {
    case "never":
      return "No reading has ever arrived. Unknown is not zero.";
    case "absent":
      return `The last reading carried no ${window} window. Unmeasured is not zero.`;
    case "reset":
      return `Passed its reset ${timeAgo(r.resetsAt)}; the figure is what the window before it had used.`;
    case "stale":
      return `Last read ${timeAgo(r.observedAt)}, past the age a reading is trusted for. Marked ~.`;
    case "live":
      return `Read ${timeAgo(r.observedAt)}, within the age a reading is trusted for.`;
  }
}

/** A window's figure: an em dash when unmeasured, `~` when projected, `reset` once refilled. */
function WindowFig({ reading, window }: { reading: AccountReading; window: string }) {
  const title = readingTitle(reading, window);
  if (reading.kind === "never" || reading.kind === "absent") {
    return (
      <span className="tnum text-text2" title={title} data-testid="fig-unmeasured">
        —
      </span>
    );
  }
  if (reading.kind === "reset") {
    return (
      <span className="tnum text-text2" title={`${title} Was ${Math.round(reading.pct)}%.`}>
        reset
      </span>
    );
  }
  const projected = isProjected(reading);
  return (
    <span className={`tnum font-semibold ${projected ? "text-text2" : "text-text"}`} title={title}>
      {projected && <span data-testid="tilde">~</span>}
      {Math.round(reading.pct)}%
    </span>
  );
}

function ClearsLine({ account, now }: { account: Account; now: number }) {
  const c = clearsOf(account, now);
  return (
    <span className="tnum" title={c.title} data-testid="clears">
      clears {c.tilde && "~"}
      {c.text}
      {c.win && <> &middot; {c.win}</>}
    </span>
  );
}

/** A thin bar under a window figure; none when unmeasured. */
function Bar({ pct, tone }: { pct: number; tone: "full" | "old" | "live" }) {
  return (
    <span className="mt-1.5 block h-1.5 w-full max-w-24 overflow-hidden rounded bg-surface2" aria-hidden="true">
      <span
        className={`block h-full rounded ${tone === "full" ? "bg-crit" : tone === "old" ? "bg-line-strong" : "bg-accent"}`}
        style={{ width: `${Math.max(1, Math.min(100, pct))}%` }}
      />
    </span>
  );
}

/** A stat's figure: a display numeral sized for four across, and a 13 px note. */
function StatFig({ children, note, dim, title }: { children: ReactNode; note?: ReactNode; dim?: boolean; title?: string }) {
  return (
    <span className="block min-w-0" title={title}>
      <span
        className={`tnum block truncate font-display text-[22px] leading-7 font-bold tracking-heading ${dim ? "text-text2" : ""}`}
      >
        {children}
      </span>
      {note && <span className="block text-[13px] leading-4 text-text2">{note}</span>}
    </span>
  );
}

/** A window's stat: the figure, and an InfoTip for the label's line when it is not measured. */
function windowStat(reading: AccountReading, window: string): Pick<InspectorStat, "figure" | "extra"> {
  const title = readingTitle(reading, window);
  if (reading.kind === "never" || reading.kind === "absent") {
    return {
      figure: <StatFig dim>—</StatFig>,
      extra: (
        <InfoTip label={`the ${window} window`} align="start">
          Not measured. {title}
        </InfoTip>
      ),
    };
  }
  if (reading.kind === "reset") {
    return {
      figure: (
        <StatFig title={title} note={`was ${Math.round(reading.pct)}% before it refilled`}>
          reset
        </StatFig>
      ),
    };
  }
  const projected = isProjected(reading);
  const full = reading.kind === "live" && reading.pct >= 100;
  return {
    figure: (
      <StatFig title={title} dim={projected}>
        {projected && "~"}
        {Math.round(reading.pct)}%
        <Bar pct={reading.pct} tone={full ? "full" : projected ? "old" : "live"} />
      </StatFig>
    ),
  };
}

/** One fact: a 13 px label left, the value right (truncated, full text in its title). */
function Fact({ label, children, mono, testId }: { label: string; children: ReactNode; mono?: boolean; testId?: string }) {
  return (
    <div className="flex min-h-8 items-center gap-3" data-testid={testId}>
      <Label className="flex-none">{label}</Label>
      <span
        className={`tnum min-w-0 flex-1 truncate text-right font-semibold ${mono ? "font-mono text-sm" : ""}`}
        title={typeof children === "string" ? children : undefined}
      >
        {children}
      </span>
    </div>
  );
}

function Detail({
  account,
  now,
  zone,
  owner,
  signin,
  setSignin,
  reload,
}: {
  account: Account;
  now: number;
  zone: string;
  owner: boolean;
  signin: SignIn;
  setSignin: (s: SignIn) => void;
  reload: () => Promise<void>;
}) {
  const c = clearsOf(account, now);
  return (
    <Inspector
      testId="account-detail"
      label={`Account ${account.label}`}
      eyebrow="Account · selected"
      title={account.label}
      chips={
        <>
          <AcctState account={account} zone={zone} />
          <Chip hero>{account.provider} · Claude subscription</Chip>
        </>
      }
      statColumns={2}
      stats={[
        { label: "5h used", testId: "tile-5h used", ...windowStat(readingOf(account, FIVE_HOUR), "five-hour") },
        { label: "7d used", testId: "tile-7d used", ...windowStat(readingOf(account, SEVEN_DAY), "seven-day") },
        {
          label: "Clears",
          testId: "tile-Clears",
          figure: (
            <StatFig title={c.title} note={c.win ? `${c.win} window` : undefined} dim={c.unmeasured}>
              {c.tilde && "~"}
              {c.text}
            </StatFig>
          ),
        },
        {
          label: "Given out",
          testId: "tile-Last given out",
          figure: account.last_assigned_at ? (
            <StatFig title={formatDateTime(account.last_assigned_at)} note={formatDateTime(account.last_assigned_at)}>
              {agoPastDay(account.last_assigned_at, now).replace(" ago", "")}
            </StatFig>
          ) : (
            <StatFig title="No job has ever been handed it." dim>
              never
            </StatFig>
          ),
        },
      ]}
    >
      <InspectorSection label="Facts">
        <Fact label="Claude account" testId="fact-claude-account">
          {claudeAccountOf(account) ?? (
            <span className="font-normal text-text2" title="Claude reports it at sign-in; a pasted saved login carries none.">
              Not reported
            </span>
          )}
        </Fact>
        {account.spent_by && <Fact label="Spent">Over its {limitWord(account.spent_by)}</Fact>}
        {account.reason && <Fact label="Reason">{reasonLabel(account.reason)}</Fact>}
        <Fact label="Jobs on it">{account.assigned}</Fact>
        <Fact label="Last read">
          {account.observed_at === null
            ? "not measured"
            : `${timeAgo(account.observed_at, now)}${account.stale ? " (old: figures are projected)" : ""}`}
        </Fact>
        <Fact label="Token expires">
          {!account.token_expires_at
            ? "—"
            : new Date(account.token_expires_at).getTime() <= now
              ? "Expired"
              : `in ${clearsIn(account.token_expires_at, now)}`}
        </Fact>
        <Fact label="Last refresh">
          {account.last_refresh_at
            ? `${account.last_refresh_reason ? `${reasonLabel(account.last_refresh_reason)} · ` : ""}${timeAgo(account.last_refresh_at, now)}`
            : "No sweep yet"}
        </Fact>
        <Fact label="Id" mono>
          {account.account_id}
        </Fact>
      </InspectorSection>
      <Holding account={account} now={now} />
      {owner ? (
        <>
          {needsAHuman(account) && (
            <SignInAgain account={account} signin={signin} setSignin={setSignin} reload={reload} prominent />
          )}
          <StateControls account={account} reload={reload} />
          <InspectorSection label="Credential">
            <div className="flex flex-col gap-3">
              <RefreshControl account={account} reload={reload} />
              {!needsAHuman(account) && (
                <SignInAgain account={account} signin={signin} setSignin={setSignin} reload={reload} />
              )}
            </div>
          </InspectorSection>
          <Remove account={account} reload={reload} />
        </>
      ) : null}
    </Inspector>
  );
}

const TAB = "h-8 rounded-lg px-3 text-sm font-medium whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-70";
const tabTone = (on: boolean) => (on ? "bg-accent text-on-accent" : "text-text2 hover:bg-surface2 hover:text-text");

/** Holding now | History, both closed by default and loaded only when opened. */
function Holding({ account, now }: { account: Account; now: number }) {
  const [tab, setTab] = useState<"now" | "history" | null>(null);
  return (
    <InspectorSection label="Jobs">
      <div role="tablist" aria-label="Jobs on this account" className="flex flex-wrap gap-1">
        {(
          [
            ["now", `Holding now (${account.assigned})`],
            ["history", "History"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(tab === key ? null : key)}
            className={`${TAB} ${tabTone(tab === key)}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "now" && <HoldingNow account={account} now={now} />}
      {tab === "history" && <HoldingHistory account={account} now={now} />}
    </InspectorSection>
  );
}

function heldFor(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

const JOB_LABEL: Record<string, string> = {
  review_comments: "review comments",
  reporting: "reporting",
  refinement: "refinement",
};

const Quiet = ({ children }: { children: ReactNode }) => <p className="mt-2 text-sm text-text2">{children}</p>;

function HoldingNow({ account, now }: { account: Account; now: number }) {
  const path = { params: { path: { account_id: account.account_id } } };
  const q = useQuery(`holders:${account.account_id}`, () =>
    unwrap(api.GET("/v1/claude-accounts/{account_id}/holders", path)),
  );
  if (q.loading) return <Quiet>Loading holders…</Quiet>;
  if (q.error)
    return (
      <div className="mt-2">
        <Notice tone="error">{q.error}</Notice>
      </div>
    );
  const b = q.data!;
  if (b.total === 0) return <Quiet>Nobody holds it.</Quiet>;
  return (
    <ul className="mt-2" data-testid="holding-now">
      {b.holders.map((h, i) => {
        const note =
          h.move === "drain" ? "moving off (draining)" : h.swapped_from ? `moved here: ${h.swapped_from_reason}` : "";
        return (
          <li key={i} className="flex min-h-9 items-center gap-2.5 border-t border-line first:border-t-0">
            <span className="min-w-0 flex-1 truncate" title={note || undefined}>
              {h.task_id ? (JOB_LABEL[h.task_id] ?? h.task_id) : <span className="text-text2">not recorded</span>}
            </span>
            {h.move === "drain" && <Chip kind="na">moving off</Chip>}
            <span className="tnum flex-none text-sm text-text2" title={h.since ? formatDateTime(h.since) : undefined}>
              {h.since ? heldFor(now - Date.parse(h.since)) : "—"}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function HoldingHistory({ account, now }: { account: Account; now: number }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const q = useQuery(`history:${account.account_id}:${cursor ?? ""}`, () =>
    unwrap(
      api.GET("/v1/claude-accounts/{account_id}/history", {
        params: { path: { account_id: account.account_id }, query: cursor ? { cursor } : {} },
      }),
    ),
  );
  if (q.loading) return <Quiet>Loading history…</Quiet>;
  if (q.error)
    return (
      <div className="mt-2">
        <Notice tone="error">{q.error}</Notice>
      </div>
    );
  const h = q.data!;
  const five = readingOf(account, FIVE_HOUR);
  const spans = h.spans;
  const from = Date.parse(h.from);
  const to = Date.parse(h.to) || now;
  const starts = spans.map((s) => Date.parse(s.since ?? "")).filter((t) => Number.isFinite(t));
  const lo = starts.length === 0 ? from : Math.max(from, Math.min(...starts));
  const scale = Math.max(1, to - lo);
  return (
    <div className="mt-2" data-testid="holding-history">
      {/* One reading per window is kept, not a series: today's figure, labelled as current. */}
      {(five.kind === "live" || five.kind === "stale") && (
        <Label className="tnum">
          Five-hour window now: {five.kind === "stale" && "~"}
          {Math.round(five.pct)}%
        </Label>
      )}
      {spans.length === 0 ? (
        <Quiet>No holds recorded in this window.</Quiet>
      ) : (
        <ul className="mt-1">
          {spans.map((s, i) => {
            const a = Date.parse(s.since ?? "");
            const b = s.until ? Date.parse(s.until) : now;
            const left = Number.isFinite(a) ? ((a - lo) / scale) * 100 : 0;
            const width = Number.isFinite(a) ? ((b - a) / scale) * 100 : 0;
            return (
              <li key={i} className="border-t border-line py-1.5 first:border-t-0">
                <span className="flex min-h-7 items-center gap-2.5">
                  <span
                    className="min-w-0 flex-1 truncate"
                    title={s.since ? `Started ${formatDateTime(s.since)}` : "start not recorded"}
                  >
                    {s.task_id ? (JOB_LABEL[s.task_id] ?? s.task_id) : "not recorded"}
                  </span>
                  <span className="tnum flex-none text-sm text-text2">{s.since ? heldFor(b - a) : "—"}</span>
                  {s.end ? (
                    <Chip kind="line" title={s.swapped_to ? (s.swapped_to_reason ?? undefined) : undefined}>
                      {s.end}
                    </Chip>
                  ) : (
                    <Chip kind="now">holding</Chip>
                  )}
                </span>
                <span className="relative mt-1 block h-1.5 rounded bg-surface2" aria-hidden="true">
                  <i
                    className="absolute block h-1.5 rounded bg-accent"
                    style={{ left: `${Math.max(0, Math.min(100, left))}%`, width: `${Math.max(1, Math.min(100, width))}%` }}
                  />
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {h.next_cursor && (
        <Button className="mt-2" onClick={() => setCursor(h.next_cursor ?? null)}>
          Older
        </Button>
      )}
    </div>
  );
}

const TARGETS: { to: StateName; verb: string; why: string }[] = [
  { to: "AVAILABLE", verb: "Make available", why: "assignable to new jobs" },
  { to: "PAUSED", verb: "Pause", why: "no new jobs; the ones on it keep running" },
  { to: "DRAINING", verb: "Drain", why: "no new jobs, and the ones on it are moved off" },
];

/** Taking an account out of rotation is the move that has to say why. */
export function stateNeedsReason(to: StateName): boolean {
  return to === "PAUSED" || to === "DRAINING";
}

/** PAUSED, DRAINING and back, each behind a confirm that names the account. */
function StateControls({ account, reload }: { account: Account; reload: () => Promise<void> }) {
  const [asking, setAsking] = useState<StateName | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const asked = TARGETS.find((t) => t.to === asking) ?? null;
  const needsReason = asking !== null && stateNeedsReason(asking);
  const jobs = `${account.assigned} job${account.assigned === 1 ? "" : "s"}`;

  async function move(to: StateName) {
    if (stateNeedsReason(to) && !reason.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await unwrap(
        api.PUT("/v1/claude-accounts/{account_id}/state", {
          params: { path: { account_id: account.account_id } },
          body: { state: to, reason: reason.trim() },
        }),
      );
      setAsking(null);
      setReason("");
      await reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <InspectorSection label="State">
      <div className="flex flex-wrap gap-2">
        {TARGETS.map((t) => (
          <Button key={t.to} title={t.why} disabled={account.state === t.to} onClick={() => setAsking(t.to)}>
            {t.verb}
          </Button>
        ))}
      </div>
      {asked && (
        <div
          role="dialog"
          aria-label={`${asked.verb} ${account.label}?`}
          className="mt-3 flex flex-col gap-2.5 rounded-button border border-line-strong bg-surface2 p-3"
        >
          <p className="flex items-center gap-2 font-semibold">
            <span className="min-w-0 flex-1">
              {asked.verb} {account.label}?
            </span>
            <InfoTip label="this state">After: {asked.why}.</InfoTip>
          </p>
          {asked.to !== "AVAILABLE" && account.assigned > 0 && (
            <p className="text-sm font-medium text-warn">
              {asked.to === "DRAINING"
                ? `${jobs} on it now will be moved off at their next turn.`
                : `${jobs} on it now keep running; no new ones start on it.`}
            </p>
          )}
          <Field label={needsReason ? "Reason (required)" : "Reason"}>
            <input
              className={INPUT}
              value={reason}
              disabled={busy}
              placeholder="why"
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button variant="solid" disabled={busy || (needsReason && !reason.trim())} onClick={() => void move(asked.to)}>
              {busy ? "Saving…" : asked.verb}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setAsking(null)}>
              Cancel
            </Button>
          </div>
          {error && <Notice tone="error">{error} The state was not changed.</Notice>}
        </div>
      )}
    </InspectorSection>
  );
}

// The reason's name, built from parts.
const NO_REFRESH = ["no", "refresh", "credential"].join("_");

const REFRESH_WORDS: Record<string, string> = {
  refreshed: "Refreshed: the credential was exchanged for a new one.",
  still_valid: "Still valid: the token has hours left, so nothing was exchanged.",
  published: "Still valid, and its access token is now the one calls use.",
  held_deferred: "A job is running on it, so the exchange waits until the token nears expiry.",
  reauth_required: "The refresh token is gone. Sign in again.",
  unreadable: "The stored credential cannot be read. Sign in again.",
  refresh_failed: "The exchange failed; the sweep tries again in five minutes.",
  [NO_REFRESH]: "Nothing is stored to exchange. Sign in again.",
};

function RefreshControl({ account, reload }: { account: Account; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [verdict, setVerdict] = useState<{ ok: boolean; text: string } | null>(null);
  async function run() {
    setBusy(true);
    setVerdict(null);
    try {
      const r = await unwrap(
        api.POST("/v1/claude-accounts/{account_id}/refresh", { params: { path: { account_id: account.account_id } } }),
      );
      const words = REFRESH_WORDS[r.refresh.reason] ?? `The refresh answered ${r.refresh.reason}.`;
      setVerdict({ ok: !["reauth_required", "unreadable", "refresh_failed"].includes(r.refresh.reason), text: words });
      await reload();
    } catch (e) {
      setVerdict({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col items-start gap-2">
      <Button icon="clock" disabled={busy} onClick={() => void run()}>
        {busy ? "refreshing…" : "Refresh now"}
      </Button>
      {verdict && (
        <p
          role="status"
          className={`rounded-button px-3 py-2 text-sm font-medium ${verdict.ok ? "bg-pass-bg text-pass" : "bg-crit-bg text-crit"}`}
        >
          {verdict.text}
        </p>
      )}
    </div>
  );
}

/** Remove: the button arms only once the label is typed. */
function Remove({ account, reload }: { account: Account; reload: () => Promise<void> }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const armed = typed === account.label;
  async function run() {
    if (!armed) return;
    setBusy(true);
    setError(null);
    try {
      await unwrap(api.DELETE("/v1/claude-accounts/{account_id}", { params: { path: { account_id: account.account_id } } }));
      setTyped("");
      await reload();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <InspectorSection
      label="Remove"
      tools={
        <InfoTip label="deleting">
          Jobs on it: {account.assigned}
          {account.assigned > 0 && " (in use: move it to draining first to move them off)"}. Its credential is deleted
          with it. Type the label to arm the button.
        </InfoTip>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <input
          className={`${INPUT} max-w-48 flex-1 font-mono`}
          value={typed}
          disabled={busy}
          placeholder={account.label}
          aria-label={`Type ${account.label} to confirm removal`}
          onChange={(e) => setTyped(e.target.value)}
        />
        <Button variant="danger" disabled={!armed || busy} onClick={() => void run()}>
          {busy ? "Removing…" : "Remove"}
        </Button>
      </div>
      {error && (
        <div className="mt-2">
          <Notice tone="error">{error} The account was not removed.</Notice>
        </div>
      )}
    </InspectorSection>
  );
}

/** Which Claude account it is, as Claude reported it at sign-in; null when not reported. */
function claudeAccountOf(a: Pick<Account, "claude_email" | "claude_organization">): string | null {
  return [a.claude_email, a.claude_organization].filter(Boolean).join(" · ") || null;
}

/** Claude's page signs in whoever that browser is signed in as. */
const WHICH_ACCOUNT =
  "Claude adds the account signed in on that page. To add a different one, open the link in a browser signed in to it";

/** The browser sign-in: open Claude's page (or copy its link), sign in, paste the code it shows. */
function SignInSteps({
  label,
  signin,
  setSignin,
  reload,
  fixedLabel,
  start,
  primary,
}: {
  label: string;
  signin: SignIn;
  setSignin: (s: SignIn) => void;
  reload: () => Promise<void>;
  fixedLabel?: boolean;
  start: string;
  /** The panel's one action: the filled primary button. */
  primary?: boolean;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function copy(url: string) {
    setCopied(false);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setError("Could not copy the link. Open shows it.");
    }
  }

  /** Starts the sign-in, then opens Claude's page here, or copies its link for another browser. */
  async function begin(then: "open" | "copy") {
    setBusy(true);
    setError(null);
    try {
      const s = await unwrap(api.POST("/v1/claude-accounts/authorize", { body: { label } }));
      setSignin({ kind: "started", label, state: s.state, url: s.authorize_url, expiresIn: s.expires_in_seconds });
      if (then === "open") window.open(s.authorize_url, "_blank", "noopener");
      else await copy(s.authorize_url);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const which = <p className="text-sm text-text2">{WHICH_ACCOUNT}</p>;
  const copiedNote = copied && (
    <span role="status" className="text-sm font-medium text-pass">
      Link copied
    </span>
  );

  async function finish(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (signin.kind !== "started") return;
    setBusy(true);
    setError(null);
    try {
      const r = await unwrap(api.POST("/v1/claude-accounts/exchange", { body: { state: signin.state, code: code.trim() } }));
      setCode("");
      setSignin({ kind: "done", account: r.account });
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (signin.kind === "done") {
    return (
      <div
        role="status"
        className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-button bg-pass-bg px-3 py-2 text-sm font-medium text-pass"
        data-testid="signin-done"
      >
        <span>
          Signed in: <b>{signin.account.label}</b> is {signin.account.state.toLowerCase().replace(/_/g, " ")}.
        </span>
        {claudeAccountOf(signin.account) && (
          <span>
            Claude account: <b>{claudeAccountOf(signin.account)}</b>
          </span>
        )}
        <button type="button" className="font-semibold underline underline-offset-2" onClick={() => setSignin({ kind: "idle" })}>
          Done
        </button>
      </div>
    );
  }
  if (signin.kind === "idle") {
    return (
      <div className="flex flex-col items-start gap-2">
        <span className="flex flex-wrap items-center gap-2">
          <Button
            variant={primary ? "primary" : "solid"}
            icon="signout"
            disabled={busy || !label}
            title={!fixedLabel && !label ? "Give it a label first" : undefined}
            onClick={() => void begin("open")}
          >
            {busy ? "starting…" : start}
          </Button>
          <Button
            disabled={busy || !label}
            title={!fixedLabel && !label ? "Give it a label first" : undefined}
            onClick={() => void begin("copy")}
          >
            Copy link
          </Button>
        </span>
        {which}
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    );
  }
  const codeId = `code-${signin.state}`;
  return (
    <form onSubmit={finish} className="flex flex-col gap-2.5" aria-label="Finish the Claude sign-in">
      <span className="flex flex-wrap items-center gap-2">
        <a
          href={signin.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-8 items-center rounded-lg border border-line-strong px-3 text-sm font-semibold hover:bg-surface2"
          data-testid="signin-link"
        >
          Open
        </a>
        <Button onClick={() => void copy(signin.url)}>Copy link</Button>
        <Chip kind="na" className="tnum" title="Paste the code within this time">
          {Math.round(signin.expiresIn / 60)} min
        </Chip>
        <InfoTip label="the steps" align="start">
          Sign in on Claude&apos;s page to the account to add as <b>{signin.label}</b>. Claude shows a code when you are
          done. Copy all of it (it may end in #…) and paste it here within {Math.round(signin.expiresIn / 60)} minutes.
        </InfoTip>
        {copiedNote}
      </span>
      {which}
      <Field label="Code from the Claude page" htmlFor={codeId}>
        <input
          id={codeId}
          className={`${INPUT} font-mono`}
          value={code}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setCode(e.target.value)}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="solid" disabled={busy || code.trim().length < 4}>
          {busy ? "finishing…" : "Finish sign-in"}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => setSignin({ kind: "idle" })}>
          Start over
        </Button>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
    </form>
  );
}

function SignInAgain({
  account,
  signin,
  setSignin,
  reload,
  prominent,
}: {
  account: Account;
  signin: SignIn;
  setSignin: (s: SignIn) => void;
  reload: () => Promise<void>;
  prominent?: boolean;
}) {
  const tip = (
    <InfoTip label="signing in again">
      {prominent
        ? "Its refresh token is gone and the sweep has stopped trying. Signing in again puts it back the way it was."
        : "Replaces its credential with a fresh sign-in; its state, holds and readings stay."}
    </InfoTip>
  );
  const steps = (
    <SignInSteps label={account.label} fixedLabel signin={signin} setSignin={setSignin} reload={reload} start="Sign in again with Claude" />
  );
  if (prominent) {
    return (
      <InspectorSection
        label="Sign-in"
        tools={tip}
      >
        {steps}
      </InspectorSection>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <span className="flex items-center gap-2">
        <Label>Sign in again</Label>
        {tip}
      </span>
      {steps}
    </div>
  );
}

function AddAccount({
  accounts,
  signin,
  setSignin,
  close,
  reload,
}: {
  accounts: Account[];
  signin: SignIn;
  setSignin: (s: SignIn) => void;
  close: () => void;
  reload: () => Promise<void>;
}) {
  const [label, setLabel] = useState(signin.kind === "started" ? signin.label : "");
  const [mode, setMode] = useState<"signin" | "paste">("signin");
  const [credential, setCredential] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taken = accounts.some((a) => a.label === label.trim());

  async function paste(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await unwrap(api.POST("/v1/claude-accounts", { body: { label: label.trim(), credential } }));
      setCredential("");
      setSignin({ kind: "done", account: r.account });
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Inspector
      testId="add-account"
      label="Add a Claude account"
      eyebrow="Account · new"
      title="Add a Claude account"
      action={
        signin.kind !== "started" ? (
          <Button variant="hero" onClick={close}>
            Cancel
          </Button>
        ) : undefined
      }
      chips={
        <>
          <Chip hero>Pro or Max</Chip>
          <InfoTip label="adding" hero align="start" side="bottom">
            A Claude subscription (Pro or Max). Oracle keeps it signed in by refreshing its token; nobody has to sign in
            again unless the subscription is signed out.
          </InfoTip>
        </>
      }
    >
      {signin.kind === "done" ? (
        <InspectorSection>
          <SignInSteps label={label} signin={signin} setSignin={setSignin} reload={reload} start="" />
        </InspectorSection>
      ) : (
        <>
          <InspectorSection>
            <Field
              label="Label"
              htmlFor="add-account-label"
              tip={
                <InfoTip label="naming" align="start">
                  Lowercase letters, digits and dashes.
                </InfoTip>
              }
            >
              <input
                id="add-account-label"
                className={`${INPUT} font-mono`}
                value={label}
                disabled={signin.kind === "started"}
                placeholder="personal"
                onChange={(e) => setLabel(e.target.value.toLowerCase())}
              />
            </Field>
            {taken && (
              <div className="mt-2">
                <Chip kind="warn" title="Adding again replaces its credential and keeps its state.">
                  Label in use
                </Chip>
              </div>
            )}
          </InspectorSection>
          <InspectorSection label="Method">
            <div role="radiogroup" aria-label="How to add it" className="flex flex-col gap-1.5">
              {(
                [
                  ["signin", "Sign in with Claude"],
                  ["paste", "Paste Claude Code's saved login"],
                ] as const
              ).map(([key, text]) => (
                <label
                  key={key}
                  className="flex cursor-pointer items-center gap-2 text-sm text-text has-[:disabled]:cursor-not-allowed has-[:disabled]:text-text2"
                >
                  <input
                    type="radio"
                    name="add-account-method"
                    className="size-4 accent-[var(--accent)]"
                    checked={mode === key}
                    disabled={signin.kind === "started"}
                    onChange={() => setMode(key)}
                  />
                  {text}
                </label>
              ))}
            </div>
            <div className="mt-3">
              {mode === "signin" ? (
                <SignInSteps
                  label={label.trim()}
                  signin={signin}
                  setSignin={setSignin}
                  reload={reload}
                  start="Open Claude's sign-in page"
                  primary
                />
              ) : (
                <form onSubmit={paste} className="flex flex-col gap-2.5" aria-label="Paste Claude Code login JSON">
                  <Field
                    label="Saved login"
                    htmlFor="add-account-json"
                    tip={
                      <InfoTip label="the JSON" align="start">
                        The JSON Claude Code keeps for its login (on macOS the keychain item &quot;Claude
                        Code-credentials&quot;), pasted whole. It must include a refresh token.
                      </InfoTip>
                    }
                  >
                    <textarea
                      id="add-account-json"
                      className={`${TEXTAREA} h-24 font-mono text-sm`}
                      value={credential}
                      spellCheck={false}
                      autoComplete="off"
                      onChange={(e) => setCredential(e.target.value)}
                    />
                  </Field>
                  <div>
                    <Button type="submit" variant="solid" disabled={busy || !label.trim() || !credential.trim()}>
                      {busy ? "adding…" : "Add account"}
                    </Button>
                  </div>
                  {error && <Notice tone="error">{error}</Notice>}
                </form>
              )}
            </div>
          </InspectorSection>
        </>
      )}
    </Inspector>
  );
}

/** The credential built-in jobs use while no account is registered. */
function Fallback({
  page,
  owner,
  open,
  setOpen,
  reload,
}: {
  page: Page;
  owner: boolean;
  open: boolean;
  setOpen: (on: boolean) => void;
  reload: () => Promise<void>;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const spare = page.fallback;

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await unwrap(api.PUT("/v1/claude-accounts/fallback", { body: { token: token.trim() } }));
      setToken("");
      setOpen(false);
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    setError(null);
    try {
      await unwrap(api.DELETE("/v1/claude-accounts/fallback"));
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Fallback credential"
      tools={
        // The tip sits outside the `fallback` block, so a reader's block holds no buttons.
        <InfoTip label="the fallback">
          Used while no account is registered or every account is spent: a <code className="font-mono">claude setup-token</code>{" "}
          value or an Anthropic API key. Accounts that are paused or draining are waited for, never replaced by this.
        </InfoTip>
      }
    >
      <div data-testid="fallback" aria-label="Fallback credential" role="group" className="flex flex-col gap-3 px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="min-w-0 flex-1" data-testid="fallback-status">
            {spare ? (
              <>
                <b className="font-semibold">{spare.label}</b>{" "}
                <span className="tnum text-sm text-text2">(set {timeAgo(spare.updated_at)})</span>
              </>
            ) : (
              <span className="text-text2">None set.</span>
            )}
          </p>
          {owner && !open && (
            <div className="flex gap-2">
              <Button onClick={() => setOpen(true)}>{spare ? "Replace" : "Set a fallback"}</Button>
              {spare && (
                <Button variant="ghost" disabled={busy} onClick={() => void clear()}>
                  Remove
                </Button>
              )}
            </div>
          )}
        </div>
        {owner && open && (
          <form onSubmit={save} className="flex flex-col gap-2.5" aria-label="Set the fallback credential">
            <Field label="Setup-token or API key" className="max-w-md">
              <input
                type="password"
                className={`${INPUT} font-mono`}
                value={token}
                autoComplete="off"
                spellCheck={false}
                autoFocus
                onChange={(e) => setToken(e.target.value)}
              />
            </Field>
            <div className="flex gap-2">
              <Button type="submit" variant="solid" disabled={busy || token.trim().length < 8}>
                Save
              </Button>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
        {owner && error && <Notice tone="error">{error}</Notice>}
      </div>
    </Panel>
  );
}
