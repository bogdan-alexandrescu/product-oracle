"use client";

/**
 * Settings > Claude accounts: the Claude subscriptions Oracle's built-in jobs run on.
 *
 * Ported from SwarmCloud's swarm-ui `src/Accounts.tsx`. The scan line is `cs status`'s:
 * the label, the five-hour figure and the state with when the binding window CLEARS.
 * Everything else lives in the chosen account's pane: the 5h / 7d / Clears / Last given
 * out tiles, the facts, Holding now | History, and an owner's controls (state with a
 * confirm and a reason, refresh, sign in again, remove by typing the label).
 *
 * Honesty marks, unchanged from SwarmCloud: an unmeasured window prints an em dash and
 * draws no bar; a measured 0% prints 0%; a figure that is real but old carries `~`; a
 * window past its reset says `reset`. Every change reloads the listing rather than
 * patching a local copy. No credential is ever rendered, not even its length.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { Badge, Button, ErrorNote, INPUT, Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
import { hasRole, useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

import {
  FIVE_HOUR,
  SEVEN_DAY,
  agoPastDay,
  anyProjected,
  bindingWindow,
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

export function ClaudeAccounts() {
  const q = useQuery("claude-accounts", () => unwrap(api.GET("/v1/claude-accounts")));
  const { role } = useMe();
  const owner = hasRole(role, "owner");
  const [chosen, setChosen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // Keyed by what they are for ("add", or an account id for signing in again), held
  // here so a reload after a write does not lose a sign-in under way.
  const [signins, setSignins] = useState<Record<string, SignIn>>({});
  const signin = (key: string) => signins[key] ?? { kind: "idle" };
  const setSignin = (key: string, s: SignIn) => setSignins((all) => ({ ...all, [key]: s }));

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <h1 className="mb-2 text-2xl font-semibold tracking-tight text-neutral-900">Claude accounts</h1>
      <p className="mb-4 max-w-3xl text-sm text-neutral-600">
        The Claude subscriptions Oracle&apos;s built-in jobs (review comments, reporting, refinement) run on. Each
        call takes the account with the most headroom and moves to another when one runs out. Agent workflows run
        in SwarmCloud on SwarmCloud&apos;s own accounts.
      </p>
      {q.loading && !q.data && <Loading />}
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {q.data && (
        <>
          <p className="mb-3 text-sm text-neutral-700" data-testid="accounts-summary">
            <SummaryLine page={q.data} />
          </p>
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
            signin={signin}
            setSignin={setSignin}
            reload={q.reload}
          />
          <Fallback page={q.data} owner={owner} reload={q.reload} />
        </>
      )}
    </div>
  );
}

function SummaryLine({ page }: { page: Page }) {
  const n = page.accounts.length;
  const available = page.accounts.filter((a) => a.state === "AVAILABLE").length;
  const broken = page.accounts.filter(needsAHuman).length;
  const missing = page.unreadable_document_count;
  const sweep = page.refresh_sweep;
  return (
    <>
      {n} account{n === 1 ? "" : "s"} &middot; {available} available
      {missing > 0 && (
        <>
          {" "}
          &middot;{" "}
          <strong>
            {missing} row{missing === 1 ? "" : "s"} unreadable, so this list is short
          </strong>
        </>
      )}
      {broken > 0 && (
        <>
          {" "}
          &middot; <strong>{broken} need{broken === 1 ? "s" : ""} a sign-in</strong>
        </>
      )}{" "}
      &middot;{" "}
      <span data-testid="refresh-sweep">
        {!sweep.readable
          ? "refresh sweep unknown"
          : sweep.last_completed_at
            ? `refresh sweep ${sweep.last_outcome === "ok" ? "ran" : "failed"} ${timeAgo(sweep.last_completed_at)}`
            : "refresh sweep has not completed yet"}
      </span>
    </>
  );
}

/** The accounts a timer will never fix, before anything else. */
function Broken({ accounts, owner, onOpen }: { accounts: Account[]; owner: boolean; onOpen: (id: string) => void }) {
  const broken = accounts.filter(needsAHuman);
  if (broken.length === 0) return null;
  return (
    <div role="status" className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      <b>{broken.map((a) => a.label).join(", ")}</b> need{broken.length === 1 ? "s" : ""} someone to sign in again.{" "}
      {broken.length === 1 ? "It gives" : "They give"} out nothing until then.{" "}
      {owner
        ? broken.map((a, i) => (
            <span key={a.account_id}>
              {i > 0 && <span aria-hidden="true"> &middot; </span>}
              <button type="button" className="underline" onClick={() => onOpen(a.account_id)}>
                {broken.length === 1 ? "Sign in again" : `Sign in again to ${a.label}`}
              </button>
            </span>
          ))
        : "An owner signs in again."}
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

  return (
    <div className="mb-8 grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <section aria-label="Subscription accounts" className="rounded-lg border border-neutral-200 bg-white">
        <div className="flex items-center justify-between border-b border-neutral-200 px-3 py-2">
          <h2 className="text-sm font-semibold text-neutral-900">
            Subscription accounts <span className="font-normal text-neutral-500">{accounts.length}</span>
          </h2>
          {owner && (
            <Button size="sm" onClick={() => setAdding(!adding)} disabled={signin("add").kind === "started"} aria-expanded={adding}>
              + Add account
            </Button>
          )}
        </div>
        {accounts.length === 0 ? (
          <div className="px-3 py-4 text-sm text-neutral-600" role="status">
            <h3 className="font-medium text-neutral-900">No accounts registered</h3>
            <p className="mt-1">
              Built-in jobs use the fallback credential below, if one is set.{" "}
              {owner ? "Add the first account beside this list." : "An owner adds accounts."}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-neutral-100" data-testid="account-list">
            {accounts.map((a) => (
              <AcctItem
                key={a.account_id}
                account={a}
                now={now}
                chosen={shown?.account_id === a.account_id}
                onChoose={() => choose(a.account_id)}
              />
            ))}
          </ul>
        )}
        {accounts.length > 0 && (
          <p className="border-t border-neutral-100 px-3 py-2 text-xs text-neutral-500" data-testid="accounts-foot">
            {accounts.length} row{accounts.length === 1 ? "" : "s"}
            {page.unreadable_document_count > 0 && <> of {accounts.length + page.unreadable_document_count}</>}
            {readingAges(accounts, now) && <> &middot; {readingAges(accounts, now)}</>} &middot;{" "}
            {anyProjected(accounts, now) ? "~ is an old reading, not current" : "no projected figures"} &middot; — is not
            measured
          </p>
        )}
      </section>
      <div className="min-w-0 space-y-4">
        {adding && addForm}
        {shown && !(adding && signin("add").kind === "idle") && (
          <Detail
            key={shown.account_id}
            account={shown}
            now={now}
            owner={owner}
            signin={signin(shown.account_id)}
            setSignin={(s) => setSignin(shown.account_id, s)}
            reload={reload}
          />
        )}
      </div>
    </div>
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

const STATE_TONE: Record<string, "neutral" | "green" | "amber" | "red" | "blue"> = {
  AVAILABLE: "green",
  PAUSED: "blue",
  DRAINING: "neutral",
  REAUTH_REQUIRED: "amber",
};

/** The state word, lower case with spaces; the platform's spelling is the title. */
function AcctState({ state }: { state: string }) {
  return (
    <Badge tone={STATE_TONE[state] ?? "neutral"} title={state}>
      {state === "REAUTH_REQUIRED" && <span aria-hidden="true">⚠</span>}
      {state.toLowerCase().replace(/_/g, " ")}
    </Badge>
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
function WindowFig({ reading, window, win }: { reading: AccountReading; window: string; win?: string }) {
  const title = readingTitle(reading, window);
  const named = win ? <span className="ml-1 text-xs font-normal text-neutral-500">{win}</span> : null;
  if (reading.kind === "never" || reading.kind === "absent") {
    return (
      <span className="tabular-nums text-neutral-400" title={title} data-testid="fig-unmeasured">
        —{named}
      </span>
    );
  }
  if (reading.kind === "reset") {
    return (
      <span className="tabular-nums text-neutral-500" title={title}>
        reset{named} <small className="text-xs">was {Math.round(reading.pct)}%</small>
      </span>
    );
  }
  const projected = isProjected(reading);
  return (
    <span className={`tabular-nums ${projected ? "text-neutral-500" : "text-neutral-900"}`} title={title}>
      {projected && <span data-testid="tilde">~</span>}
      {Math.round(reading.pct)}%{named}
    </span>
  );
}

function ClearsLine({ account, now }: { account: Account; now: number }) {
  const c = clearsOf(account, now);
  return (
    <span title={c.title} data-testid="clears">
      clears {c.tilde && "~"}
      {c.text}
      {c.win && <> &middot; {c.win}</>}
    </span>
  );
}

function AcctItem({ account, now, chosen, onChoose }: { account: Account; now: number; chosen: boolean; onChoose: () => void }) {
  return (
    <li className={chosen ? "bg-neutral-50" : ""} data-testid={`account-row-${account.label}`}>
      <button
        type="button"
        onClick={onChoose}
        aria-current={chosen ? "true" : undefined}
        className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-neutral-50"
      >
        <span className="flex items-baseline justify-between gap-2">
          <b className="truncate text-sm text-neutral-900">{account.label}</b>
          <WindowFig reading={readingOf(account, FIVE_HOUR)} window="five-hour" win="5h" />
        </span>
        <small className="flex flex-wrap items-center gap-1 text-xs text-neutral-500">
          <AcctState state={account.state} /> &middot; <ClearsLine account={account} now={now} />
        </small>
      </button>
      <span className="flex flex-wrap gap-x-2 px-3 pb-2 text-[11px] text-neutral-400">
        <span className="font-mono">{account.account_id.slice(0, 8)}</span>
        <span>{account.last_assigned_at ? `given out ${agoPastDay(account.last_assigned_at, now)}` : "never given out"}</span>
        {account.unreadable_now && (
          <span className="text-rose-700" title="A call could not read this account's credential; the pool skips it for thirty minutes.">
            skipped
          </span>
        )}
        <StateNote account={account} />
      </span>
    </li>
  );
}

/** The second line under a state, when there is a real one to write. */
function StateNote({ account }: { account: Account }) {
  if (account.reason) return <span>{account.reason}</span>;
  const binding = bindingWindow(account);
  if (binding && binding.window.reset) return <span>window reset, awaiting a new reading</span>;
  if (account.observed_at === null) return <span>never observed</span>;
  if (account.stale) return <span>reading is {timeAgo(account.observed_at)}</span>;
  return null;
}

function Tile({ label, children, note, title }: { label: string; children: ReactNode; note?: ReactNode; title?: string }) {
  return (
    <div className="rounded-md border border-neutral-200 px-3 py-2" title={title} data-testid={`tile-${label}`}>
      <small className="block text-xs text-neutral-500">{label}</small>
      <b className="text-lg text-neutral-900">{children}</b>
      {note && <i className="block text-xs not-italic text-neutral-500">{note}</i>}
    </div>
  );
}

function WindowTile({ reading, window, label }: { reading: AccountReading; window: string; label: string }) {
  const title = readingTitle(reading, window);
  if (reading.kind === "never" || reading.kind === "absent") {
    return (
      <Tile label={label} title={title} note="not measured">
        <span className="text-neutral-400">—</span>
      </Tile>
    );
  }
  if (reading.kind === "reset") {
    return (
      <Tile label={label} title={title} note={`was ${Math.round(reading.pct)}% before it refilled`}>
        reset
      </Tile>
    );
  }
  const projected = isProjected(reading);
  const full = reading.kind === "live" && reading.pct >= 100;
  return (
    <Tile label={label} title={title}>
      {projected && "~"}
      {Math.round(reading.pct)}%
      <span className="mt-1 block h-1.5 w-full rounded bg-neutral-100" aria-hidden="true">
        <span
          className={`block h-1.5 rounded ${full ? "bg-rose-500" : projected ? "bg-neutral-300" : "bg-neutral-700"}`}
          style={{ width: `${Math.max(1, Math.min(100, reading.pct))}%` }}
        />
      </span>
    </Tile>
  );
}

function Detail({
  account,
  now,
  owner,
  signin,
  setSignin,
  reload,
}: {
  account: Account;
  now: number;
  owner: boolean;
  signin: SignIn;
  setSignin: (s: SignIn) => void;
  reload: () => Promise<void>;
}) {
  const c = clearsOf(account, now);
  return (
    <section aria-label={`Account ${account.label}`} className="rounded-lg border border-neutral-200 bg-white p-4" data-testid="account-detail">
      <header>
        <div className="flex items-center gap-2">
          <AcctState state={account.state} />
          <Badge>{account.provider} &middot; Claude subscription</Badge>
        </div>
        <h3 className="mt-1 text-lg font-semibold text-neutral-900">{account.label}</h3>
        <p className="font-mono text-xs text-neutral-500">{account.account_id}</p>
        {account.reason && <p className="mt-1 text-sm text-neutral-700">{account.reason}</p>}
      </header>
      <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
        <WindowTile reading={readingOf(account, FIVE_HOUR)} window="five-hour" label="5h used" />
        <WindowTile reading={readingOf(account, SEVEN_DAY)} window="seven-day" label="7d used" />
        <Tile label="Clears" title={c.title} note={c.win ? `${c.win} window` : undefined}>
          <span className={c.unmeasured ? "text-neutral-400" : ""}>
            {c.tilde && "~"}
            {c.text}
          </span>
        </Tile>
        <Tile
          label="Last given out"
          note={account.last_assigned_at ? timeAgo(account.last_assigned_at, now) : "no job has ever been handed it"}
        >
          {account.last_assigned_at ? formatDateTime(account.last_assigned_at) : "never"}
        </Tile>
      </div>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-neutral-500">jobs on it</dt>
        <dd>{account.assigned}</dd>
        <dt className="text-neutral-500">last read</dt>
        <dd>
          {account.observed_at === null
            ? "not measured"
            : `${timeAgo(account.observed_at, now)}${account.stale ? " (old: figures are projected)" : ""}`}
        </dd>
        <dt className="text-neutral-500">token expires</dt>
        <dd>{account.token_expires_at ? `in ${clearsIn(account.token_expires_at, now)}` : "—"}</dd>
        <dt className="text-neutral-500">last refresh</dt>
        <dd>
          {account.last_refresh_at
            ? `${timeAgo(account.last_refresh_at, now)}: ${account.last_refresh_reason ?? "—"}`
            : "no sweep has visited it yet"}
        </dd>
      </dl>
      <Holding account={account} now={now} />
      {owner ? (
        <div className="mt-4 space-y-4 border-t border-neutral-200 pt-4">
          {needsAHuman(account) && (
            <SignInAgain account={account} signin={signin} setSignin={setSignin} reload={reload} prominent />
          )}
          <StateControls account={account} reload={reload} />
          <RefreshControl account={account} reload={reload} />
          {!needsAHuman(account) && <SignInAgain account={account} signin={signin} setSignin={setSignin} reload={reload} />}
          <Remove account={account} reload={reload} />
        </div>
      ) : (
        <p className="mt-4 border-t border-neutral-200 pt-3 text-xs text-neutral-500">Only an owner changes accounts.</p>
      )}
    </section>
  );
}

/** Holding now | History, both closed by default and loaded only when opened. */
function Holding({ account, now }: { account: Account; now: number }) {
  const [tab, setTab] = useState<"now" | "history" | null>(null);
  return (
    <div className="mt-4">
      <div role="tablist" className="flex gap-1 border-b border-neutral-200">
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
            className={`-mb-px border-b-2 px-2 py-1 text-sm ${tab === key ? "border-neutral-900 text-neutral-900" : "border-transparent text-neutral-500"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "now" && <HoldingNow account={account} now={now} />}
      {tab === "history" && <HoldingHistory account={account} now={now} />}
    </div>
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

function HoldingNow({ account, now }: { account: Account; now: number }) {
  const path = { params: { path: { account_id: account.account_id } } };
  const q = useQuery(`holders:${account.account_id}`, () =>
    unwrap(api.GET("/v1/claude-accounts/{account_id}/holders", path)),
  );
  if (q.loading) return <Loading label="Loading holders…" />;
  if (q.error) return <ErrorNote>{q.error}</ErrorNote>;
  const b = q.data!;
  if (b.total === 0) return <p className="mt-2 text-sm text-neutral-500">Nobody holds it.</p>;
  return (
    <table className="mt-2 w-full text-sm" data-testid="holding-now">
      <thead className="text-left text-xs text-neutral-500">
        <tr>
          <th className="py-1 font-medium">Job</th>
          <th className="py-1 font-medium">Since</th>
          <th className="py-1 font-medium">Note</th>
        </tr>
      </thead>
      <tbody>
        {b.holders.map((h, i) => (
          <tr key={i} className="border-t border-neutral-100">
            <td className="py-1">{h.task_id ? (JOB_LABEL[h.task_id] ?? h.task_id) : <span className="text-neutral-400">not recorded</span>}</td>
            <td className="py-1">{h.since ? `${formatDateTime(h.since)} (${heldFor(now - Date.parse(h.since))})` : "—"}</td>
            <td className="py-1 text-xs text-neutral-500">
              {h.move === "drain" ? "moving off (draining)" : h.swapped_from ? `moved here: ${h.swapped_from_reason}` : ""}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
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
  if (q.loading) return <Loading label="Loading history…" />;
  if (q.error) return <ErrorNote>{q.error}</ErrorNote>;
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
        <p className="text-xs text-neutral-500">
          Five-hour window now: {five.kind === "stale" && "~"}
          {Math.round(five.pct)}%
        </p>
      )}
      {spans.length === 0 ? (
        <p className="text-sm text-neutral-500">No holds recorded in this window.</p>
      ) : (
        <table className="mt-1 w-full text-sm">
          <thead className="text-left text-xs text-neutral-500">
            <tr>
              <th className="py-1 font-medium">Job</th>
              <th className="py-1 font-medium">Started</th>
              <th className="py-1 text-right font-medium">Held</th>
              <th className="py-1 font-medium">Ended</th>
              <th className="py-1 font-medium">When</th>
            </tr>
          </thead>
          <tbody>
            {spans.map((s, i) => {
              const a = Date.parse(s.since ?? "");
              const b = s.until ? Date.parse(s.until) : now;
              const left = Number.isFinite(a) ? ((a - lo) / scale) * 100 : 0;
              const width = Number.isFinite(a) ? ((b - a) / scale) * 100 : 0;
              return (
                <tr key={i} className="border-t border-neutral-100">
                  <td className="py-1">{s.task_id ? (JOB_LABEL[s.task_id] ?? s.task_id) : "not recorded"}</td>
                  <td className="py-1">{s.since ? formatDateTime(s.since) : "start not recorded"}</td>
                  <td className="py-1 text-right tabular-nums">{s.since ? heldFor(b - a) : "—"}</td>
                  <td className="py-1">
                    {s.end ?? <span className="text-neutral-400">holding</span>}
                    {s.swapped_to && <span className="text-xs text-neutral-500"> ({s.swapped_to_reason})</span>}
                  </td>
                  <td className="w-1/4 py-1">
                    <span className="relative block h-1.5 rounded bg-neutral-100" aria-hidden="true">
                      <i
                        className="absolute block h-1.5 rounded bg-neutral-600"
                        style={{ left: `${Math.max(0, Math.min(100, left))}%`, width: `${Math.max(1, Math.min(100, width))}%` }}
                      />
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {h.next_cursor && (
        <Button size="sm" className="mt-2" onClick={() => setCursor(h.next_cursor ?? null)}>
          Older
        </Button>
      )}
    </div>
  );
}

const TARGETS: { to: StateName; why: string }[] = [
  { to: "AVAILABLE", why: "assignable to new jobs" },
  { to: "PAUSED", why: "no new jobs; the ones on it keep running" },
  { to: "DRAINING", why: "no new jobs, and the ones on it are moved off" },
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
    <div>
      <h4 className="text-sm font-medium text-neutral-900">State</h4>
      <div className="mt-1 flex flex-wrap gap-2">
        {TARGETS.map((t) => (
          <Button key={t.to} size="sm" title={t.why} disabled={account.state === t.to} onClick={() => setAsking(t.to)}>
            move to {t.to.toLowerCase()}
          </Button>
        ))}
      </div>
      {asked && (
        <div role="dialog" aria-label={`Move ${account.label} to ${asked.to.toLowerCase()}?`} className="mt-2 rounded-md border border-neutral-300 bg-neutral-50 p-3 text-sm">
          <p className="font-medium text-neutral-900">
            Move {account.label} to {asked.to.toLowerCase()}?
          </p>
          <p className="text-neutral-600">After: {asked.why}.</p>
          {asked.to !== "AVAILABLE" && account.assigned > 0 && (
            <p className="mt-1 text-amber-800">
              {asked.to === "DRAINING"
                ? `${jobs} on it now will be moved off at their next turn.`
                : `${jobs} on it now keep running; no new ones start on it.`}
            </p>
          )}
          <label className="mt-2 flex flex-col gap-1 text-xs text-neutral-700">
            {needsReason ? "Reason (required)" : "Reason"}
            <input
              className={INPUT}
              value={reason}
              disabled={busy}
              placeholder="why, e.g. held back for Monday's report"
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="primary" disabled={busy || (needsReason && !reason.trim())} onClick={() => void move(asked.to)}>
              {busy ? "saving…" : `move to ${asked.to.toLowerCase()}`}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAsking(null)}>
              Leave it {account.state.toLowerCase().replace(/_/g, " ")}
            </Button>
          </div>
          {error && (
            <div className="mt-2">
              <ErrorNote>{error} The state was not changed.</ErrorNote>
            </div>
          )}
        </div>
      )}
    </div>
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
    <div>
      <h4 className="text-sm font-medium text-neutral-900">Refresh</h4>
      <Button size="sm" className="mt-1" disabled={busy} onClick={() => void run()}>
        {busy ? "refreshing…" : "Refresh now"}
      </Button>
      {verdict && (
        <p role="status" className={`mt-1 text-sm ${verdict.ok ? "text-emerald-800" : "text-rose-800"}`}>
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
    <div className="rounded-md border border-rose-200 p-3">
      <h4 className="text-sm font-medium text-rose-900">Remove</h4>
      <p className="text-xs text-neutral-600">
        jobs on it: {account.assigned}
        {account.assigned > 0 && " (in use: move it to draining first to move them off)"} &middot; its credential is
        deleted with it
      </p>
      <div className="mt-2 flex items-center gap-2">
        <input
          className={`${INPUT} max-w-56 font-mono`}
          value={typed}
          disabled={busy}
          placeholder={account.label}
          aria-label={`Type ${account.label} to confirm removal`}
          onChange={(e) => setTyped(e.target.value)}
        />
        <Button size="sm" variant="primary" disabled={!armed || busy} onClick={() => void run()}>
          {busy ? "removing…" : `remove ${account.label}`}
        </Button>
        <span className="text-xs text-neutral-500">type the label to arm this</span>
      </div>
      {error && (
        <div className="mt-2">
          <ErrorNote>{error} The account was not removed.</ErrorNote>
        </div>
      )}
    </div>
  );
}

/** The browser sign-in: open Claude's page, sign in, paste the code it shows. */
function SignInSteps({
  label,
  signin,
  setSignin,
  reload,
  fixedLabel,
  start,
}: {
  label: string;
  signin: SignIn;
  setSignin: (s: SignIn) => void;
  reload: () => Promise<void>;
  fixedLabel?: boolean;
  start: string;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function begin() {
    setBusy(true);
    setError(null);
    try {
      const s = await unwrap(api.POST("/v1/claude-accounts/authorize", { body: { label } }));
      setSignin({ kind: "started", label, state: s.state, url: s.authorize_url, expiresIn: s.expires_in_seconds });
      window.open(s.authorize_url, "_blank", "noopener");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

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
      <div role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900" data-testid="signin-done">
        Signed in: <b>{signin.account.label}</b> is {signin.account.state.toLowerCase().replace(/_/g, " ")}.{" "}
        <button type="button" className="underline" onClick={() => setSignin({ kind: "idle" })}>
          Done
        </button>
      </div>
    );
  }
  if (signin.kind === "idle") {
    return (
      <div>
        <Button size="sm" variant="primary" disabled={busy || !label} onClick={() => void begin()}>
          {busy ? "starting…" : start}
        </Button>
        {!fixedLabel && !label && <span className="ml-2 text-xs text-neutral-500">give it a label first</span>}
        {error && (
          <div className="mt-2">
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}
      </div>
    );
  }
  return (
    <form onSubmit={finish} className="space-y-2 text-sm" aria-label="Finish the Claude sign-in">
      <ol className="list-decimal space-y-1 pl-5 text-neutral-700">
        <li>
          <a href={signin.url} target="_blank" rel="noopener noreferrer" className="underline" data-testid="signin-link">
            Open the Claude sign-in page
          </a>{" "}
          and sign in to the account to add as <b>{signin.label}</b>.
        </li>
        <li>Claude shows a code when you are done. Copy all of it (it may end in #…).</li>
        <li>Paste it here within {Math.round(signin.expiresIn / 60)} minutes.</li>
      </ol>
      <label className="flex flex-col gap-1 text-xs text-neutral-700">
        Code from the Claude page
        <input
          className={`${INPUT} font-mono`}
          value={code}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setCode(e.target.value)}
        />
      </label>
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="primary" disabled={busy || code.trim().length < 4}>
          {busy ? "finishing…" : "Finish sign-in"}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setSignin({ kind: "idle" })}>
          Start over
        </Button>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
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
  return (
    <div className={prominent ? "rounded-md border border-amber-200 bg-amber-50 p-3" : ""}>
      <h4 className="text-sm font-medium text-neutral-900">Sign in again</h4>
      <p className="mb-2 text-xs text-neutral-600">
        {prominent
          ? "Its refresh token is gone and the sweep has stopped trying. Signing in again puts it back the way it was."
          : "Replaces its credential with a fresh sign-in; its state, holds and readings stay."}
      </p>
      <SignInSteps label={account.label} fixedLabel signin={signin} setSignin={setSignin} reload={reload} start="Sign in again with Claude" />
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
    <section aria-label="Add a Claude account" className="rounded-lg border border-neutral-200 bg-white p-4" data-testid="add-account">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-neutral-900">Add a Claude account</h3>
        {signin.kind !== "started" && (
          <Button size="sm" variant="ghost" onClick={close}>
            Cancel
          </Button>
        )}
      </div>
      <p className="mt-1 text-xs text-neutral-500">
        A Claude subscription (Pro or Max). Oracle keeps it signed in by refreshing its token; nobody has to sign in
        again unless the subscription is signed out.
      </p>
      {signin.kind === "done" ? (
        <div className="mt-3">
          <SignInSteps label={label} signin={signin} setSignin={setSignin} reload={reload} start="" />
        </div>
      ) : (
        <>
          <label className="mt-3 flex flex-col gap-1 text-xs text-neutral-700">
            Label (lowercase letters, digits and dashes)
            <input
              className={`${INPUT} max-w-xs font-mono`}
              value={label}
              disabled={signin.kind === "started"}
              placeholder="personal"
              onChange={(e) => setLabel(e.target.value.toLowerCase())}
            />
          </label>
          {taken && (
            <p className="mt-1 text-xs text-amber-800">
              An account has this label: adding again replaces its credential and keeps its state.
            </p>
          )}
          <div role="tablist" className="mt-3 flex gap-1 text-sm">
            {(
              [
                ["signin", "Sign in with Claude"],
                ["paste", "Paste Claude Code's saved login"],
              ] as const
            ).map(([key, text]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={mode === key}
                disabled={signin.kind === "started"}
                onClick={() => setMode(key)}
                className={`rounded px-2 py-1 ${mode === key ? "bg-neutral-100 font-medium text-neutral-900" : "text-neutral-500"}`}
              >
                {text}
              </button>
            ))}
          </div>
          <div className="mt-2">
            {mode === "signin" ? (
              <SignInSteps label={label.trim()} signin={signin} setSignin={setSignin} reload={reload} start="Sign in with Claude" />
            ) : (
              <form onSubmit={paste} className="space-y-2" aria-label="Paste Claude Code login JSON">
                <p className="text-xs text-neutral-500">
                  The JSON Claude Code keeps for its login (on macOS the keychain item &quot;Claude Code-credentials&quot;),
                  pasted whole. It must include a refresh token.
                </p>
                <label className="flex flex-col gap-1 text-xs text-neutral-700">
                  Saved login
                  <textarea
                    className={`${INPUT} h-24 font-mono text-xs`}
                    value={credential}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(e) => setCredential(e.target.value)}
                  />
                </label>
                <Button type="submit" size="sm" variant="primary" disabled={busy || !label.trim() || !credential.trim()}>
                  {busy ? "adding…" : "Add account"}
                </Button>
                {error && <ErrorNote>{error}</ErrorNote>}
              </form>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/** The credential built-in jobs use while no account is registered. */
function Fallback({ page, owner, reload }: { page: Page; owner: boolean; reload: () => Promise<void> }) {
  const [token, setToken] = useState("");
  const [open, setOpen] = useState(false);
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
    <section aria-label="Fallback credential" className="max-w-3xl rounded-lg border border-neutral-200 bg-white p-4" data-testid="fallback">
      <h2 className="text-base font-semibold text-neutral-900">Fallback credential</h2>
      <p className="mt-1 text-sm text-neutral-600">
        Used only while no account is registered: a <code className="font-mono text-xs">claude setup-token</code> value
        or an Anthropic API key. Accounts that are spent or paused are waited for, never replaced by this.
      </p>
      <p className="mt-2 text-sm" data-testid="fallback-status">
        {spare ? (
          <>
            <b>{spare.label}</b> <span className="text-neutral-500">(set {timeAgo(spare.updated_at)})</span>
          </>
        ) : (
          <span className="text-neutral-500">None set.</span>
        )}
      </p>
      {owner && (
        <div className="mt-2">
          {open ? (
            <form onSubmit={save} className="space-y-2" aria-label="Set the fallback credential">
              <label className="flex flex-col gap-1 text-xs text-neutral-700">
                Setup-token or API key
                <input
                  type="password"
                  className={`${INPUT} max-w-md font-mono`}
                  value={token}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setToken(e.target.value)}
                />
              </label>
              <div className="flex gap-2">
                <Button type="submit" size="sm" variant="primary" disabled={busy || token.trim().length < 8}>
                  Save
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex gap-2">
              <Button size="sm" onClick={() => setOpen(true)}>
                {spare ? "Replace" : "Set a fallback"}
              </Button>
              {spare && (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void clear()}>
                  Remove
                </Button>
              )}
            </div>
          )}
          {error && (
            <div className="mt-2">
              <ErrorNote>{error}</ErrorNote>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
