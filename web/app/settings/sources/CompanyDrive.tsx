"use client";

import { type FormEvent, useId, useState } from "react";

import { Button, Chip, confirmInPage, Icon, InfoTip, LinkButton, Notice, Panel } from "@/components/ds";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage, useAuthRedirect, useQuery } from "@/lib/use-query";

import { Field, INPUT, SELECT_FIELD } from "../_components/fields";
import { ReconnectToChoose } from "./DriveFiles";

/** A shared drive as the company list keeps it. */
export interface SharedDrive {
  id: string;
  name: string;
}

const DOMAINS_KEY = "company_email_domains";
const DRIVES_KEY = "company_shared_drives";

/** What a company email domain looks like: lowercase labels and a TLD, no "@". */
const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/** A typed domain, lowercased and without a leading "@" (or a pasted address's "user@"). */
export function normaliseDomain(text: string): string {
  const t = text.trim().toLowerCase();
  return t.includes("@") ? t.slice(t.lastIndexOf("@") + 1) : t;
}

function domains(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((d): d is string => typeof d === "string") : [];
}

function drives(value: unknown): SharedDrive[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((d) =>
    d && typeof d === "object" && typeof d.id === "string" ? [{ id: d.id, name: typeof d.name === "string" ? d.name : d.id }] : [],
  );
}

const readSetting = (key: string) => unwrap(api.GET("/v1/settings/{key}", { params: { path: { key } } })).then((s) => s.value);
const writeSetting = (key: string, value: unknown) =>
  unwrap(api.PUT("/v1/settings/{key}", { params: { path: { key } }, body: { value } })).then((s) => s.value);

const sharedDrives = (connection_id: string) =>
  unwrap(api.GET("/v1/connections/{connection_id}/google/shared-drives", { params: { path: { connection_id } } })).then((r) =>
    drives(r.drives),
  );

function useAction() {
  const onAuth = useAuthRedirect();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function act<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      if (!onAuth(e)) setError(errorMessage(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { act, error, setError, busy };
}

const REMOVE = "grid size-8 flex-none place-items-center rounded-lg text-text2 hover:bg-surface2 hover:text-text disabled:opacity-70";

function Heading({ id, title, tip, children }: { id: string; title: string; tip: string; children: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="flex items-center gap-1.5">
        <h3 id={id} className="text-[15px] font-semibold">
          {title}
        </h3>
        <InfoTip label={title.toLowerCase()} align="start">
          {tip}
        </InfoTip>
      </span>
      <p className="text-sm text-text2">{children}</p>
    </div>
  );
}

/** Company email domains: docs in a picked folder owned outside them are skipped. */
function CompanyDomains() {
  const headingId = useId();
  const inputId = useId();
  const q = useQuery(`setting|${DOMAINS_KEY}`, () => readSetting(DOMAINS_KEY).then(domains));
  const [text, setText] = useState("");
  const { act, error, setError, busy } = useAction();
  const list = q.data ?? [];

  async function save(next: string[]) {
    const saved = await act(() => writeSetting(DOMAINS_KEY, next));
    if (saved === undefined) return false;
    q.setData(() => domains(saved));
    return true;
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    const domain = normaliseDomain(text);
    if (!DOMAIN.test(domain)) return setError(`Not a domain: ${text.trim()}. Enter it like example.com.`);
    if (list.includes(domain)) return setError(`${domain} is already on the list.`);
    if (await save([...list, domain])) setText("");
  }

  async function remove(domain: string) {
    if (
      list.length === 1 &&
      !(await confirmInPage({
        destructive: true,
        action: "Remove",
        message: `Remove ${domain}? With no company domain, every doc in a picked folder is skipped, and the ones already pulled in are hidden now.`,
      }))
    ) {
      return;
    }
    await save(list.filter((d) => d !== domain));
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2.5 px-4 py-3 max-[600px]:px-3" data-testid="company-domains">
      <Heading
        id={headingId}
        title="Company email domains"
        tip="Set here by an owner. Oracle never guesses them from members' email addresses."
      >
        Docs in a picked folder owned outside these domains are skipped. With none set, every doc in a picked folder is
        skipped (&ldquo;company domain not set&rdquo;). Removing a domain hides the docs it let in from every
        member&rsquo;s sources at once.
      </Heading>
      {q.error && <Notice tone="error">{q.error}</Notice>}
      {!q.data && !q.error && <span aria-busy className="block h-3 w-1/2 animate-pulse rounded bg-surface2" />}
      {q.data && list.length === 0 && (
        <div>
          <Chip kind="warn" dot>
            Company domain not set
          </Chip>
        </div>
      )}
      {list.length > 0 && (
        <ul aria-label="Company email domains" className="flex flex-wrap gap-1.5">
          {list.map((d) => (
            <li key={d} aria-label={d}>
              <Chip kind="line" className="pr-0.5 font-mono">
                {d}
                <button
                  type="button"
                  aria-label={`Remove ${d}`}
                  disabled={busy}
                  onClick={() => void remove(d)}
                  className="grid size-6 place-items-center rounded-full text-text2 hover:bg-surface2 hover:text-text disabled:opacity-70"
                >
                  <Icon name="x" size={16} />
                </button>
              </Chip>
            </li>
          ))}
        </ul>
      )}
      {q.data && (
        <form onSubmit={add} aria-label="Add a company domain" className="flex items-end gap-1.5">
          <Field label="Add a domain" htmlFor={inputId} className="max-w-72 flex-1">
            <input
              id={inputId}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                if (error) setError(null);
              }}
              placeholder="example.com"
              autoComplete="off"
              spellCheck={false}
              inputMode="url"
              aria-invalid={!!error}
              className={`${INPUT} font-mono`}
            />
          </Field>
          <Button type="submit" variant="solid" icon="plus" className="h-9" disabled={busy || !text.trim()}>
            Add
          </Button>
        </form>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </section>
  );
}

/** The shared drives one of the owner's Google connections can see, to add to the list. */
function ChooseSharedDrives({ saved, busy, onAdd }: { saved: SharedDrive[]; busy: boolean; onAdd: (d: SharedDrive) => void }) {
  const accountId = useId();
  const connections = useQuery("connections", () => unwrap(api.GET("/v1/connections")));
  const google = (connections.data ?? []).filter((c) => c.provider === "google" && c.status === "active");
  const [chosen, setChosen] = useState("");
  const connectionId = chosen || google[0]?.id || "";
  const connection = google.find((c) => c.id === connectionId);
  const reconnect = !!connection?.reconnect_reason;
  const list = useQuery(`shared-drives|${reconnect ? "" : connectionId}`, () =>
    connectionId && !reconnect ? sharedDrives(connectionId) : Promise.resolve([]),
  );
  const onList = new Set(saved.map((d) => d.id));

  if (connections.error) return <Notice tone="error">{connections.error}</Notice>;
  if (!connections.data) return <span aria-busy className="block h-3 w-1/2 animate-pulse rounded bg-surface2" />;
  if (google.length === 0) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Chip kind="warn">No Google account</Chip>
        <LinkButton href="/settings/connections" icon="link">
          Connect Google
        </LinkButton>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2.5 rounded-button border border-line bg-surface2 p-3" data-testid="shared-drive-choices">
      <Field label="Google account" htmlFor={accountId} className="max-w-72">
        <select id={accountId} value={connectionId} onChange={(e) => setChosen(e.target.value)} className={SELECT_FIELD}>
          {google.map((c) => (
            <option key={c.id} value={c.id}>
              {c.account_label ?? c.id}
            </option>
          ))}
        </select>
      </Field>
      {reconnect ? (
        <ReconnectToChoose />
      ) : list.error ? (
        <Notice tone="error">{list.error}</Notice>
      ) : list.loading || !list.data ? (
        <span aria-busy className="block h-3 w-1/2 animate-pulse rounded bg-surface" />
      ) : list.data.length === 0 ? (
        <p className="text-sm text-text2">This account sees no shared drives.</p>
      ) : (
        <ul
          aria-label={`Shared drives of ${connection?.account_label ?? "this account"}`}
          className="flex flex-col rounded-button border border-line bg-surface"
        >
          {list.data.map((d) => (
            <li key={d.id} aria-label={d.name} className="flex min-h-11 items-center gap-2.5 border-t border-line px-3 py-1.5 first:border-t-0">
              <Icon name="folder" size={16} className="flex-none text-text2" />
              <span className="min-w-0 flex-1 truncate text-[15px] font-medium" title={d.name}>
                {d.name}
              </span>
              {onList.has(d.id) ? (
                <Chip kind="pass">Added</Chip>
              ) : (
                <Button icon="plus" aria-label={`Add ${d.name}`} disabled={busy} onClick={() => onAdd(d)}>
                  Add
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Company shared drives: docs in a picked folder in any other shared drive are skipped. */
function CompanySharedDrives() {
  const headingId = useId();
  const q = useQuery(`setting|${DRIVES_KEY}`, () => readSetting(DRIVES_KEY).then(drives));
  const [choosing, setChoosing] = useState(false);
  const { act, error, busy } = useAction();
  const list = q.data ?? [];

  async function save(next: SharedDrive[]) {
    const saved = await act(() => writeSetting(DRIVES_KEY, next));
    if (saved !== undefined) q.setData(() => drives(saved));
  }

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-2.5 border-t border-line px-4 py-3 max-[600px]:px-3"
      data-testid="company-shared-drives"
    >
      <Heading
        id={headingId}
        title="Company shared drives"
        tip="Add the shared drives that belong to the company. Docs in My Drive folders are judged by their owner's domain instead."
      >
        A doc in a shared drive counts as the company&rsquo;s only when its drive is on this list. Docs in picked folders
        in other shared drives are skipped. Removing a drive hides its docs from every member&rsquo;s sources at once.
      </Heading>
      {q.error && <Notice tone="error">{q.error}</Notice>}
      {!q.data && !q.error && <span aria-busy className="block h-3 w-1/2 animate-pulse rounded bg-surface2" />}
      {q.data && list.length === 0 && <p className="text-sm text-text2">None yet.</p>}
      {list.length > 0 && (
        <ul aria-label="Company shared drives" className="flex flex-col rounded-button border border-line">
          {list.map((d) => (
            <li key={d.id} aria-label={d.name} className="flex min-h-11 items-center gap-2.5 border-t border-line px-3 py-1.5 first:border-t-0">
              <span className="grid size-7 flex-none place-items-center rounded-lg bg-accent-soft text-accent-ink">
                <Icon name="folder" size={16} />
              </span>
              <span className="min-w-0 flex-1 truncate text-[15px] font-medium" title={`${d.name} (${d.id})`}>
                {d.name}
              </span>
              <button
                type="button"
                aria-label={`Remove ${d.name}`}
                disabled={busy}
                onClick={() => void save(list.filter((x) => x.id !== d.id))}
                className={REMOVE}
              >
                <Icon name="x" size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {q.data && (
        <div>
          <Button icon={choosing ? undefined : "plus"} aria-expanded={choosing} onClick={() => setChoosing((v) => !v)}>
            {choosing ? "Done adding" : "Add shared drives"}
          </Button>
        </div>
      )}
      {choosing && q.data && <ChooseSharedDrives saved={list} busy={busy} onAdd={(d) => void save([...list, d])} />}
      {error && <Notice tone="error">{error}</Notice>}
    </section>
  );
}

/**
 * Settings › Sources › Google Drive (owners only, S5): which docs in a picked Drive folder
 * count as the company's. Company-wide, unlike the sources above it.
 */
export function CompanyDriveSettings() {
  return (
    <Panel
      title="Google Drive"
      testId="company-drive"
      tools={
        <>
          <Chip kind="acc">Company · owners</Chip>
          <InfoTip label="company Drive settings" align="end" side="bottom">
            These apply to every member&rsquo;s Google Docs sources: they decide which docs in a picked folder count as
            the company&rsquo;s and are pulled in.
          </InfoTip>
        </>
      }
    >
      <CompanyDomains />
      <CompanySharedDrives />
    </Panel>
  );
}
