"use client";

import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";

import { KIND_LABEL } from "@/app/sources/_components/confidence";
import {
  Button,
  Chip,
  Empty,
  Icon,
  InfoTip,
  Inspector,
  InspectorSection,
  Label,
  LinkButton,
  Notice,
  PageHeader,
  Panel,
  Split,
  type ChipKind,
} from "@/components/ds";
import { api, type Schemas, unwrap } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
import { errorMessage, useAuthRedirect, useQuery } from "@/lib/use-query";

import { Field, INPUT, SELECT_FIELD, TEXTAREA } from "../_components/fields";
import { NotionPicker, notionRoots } from "./NotionPicker";

type Source = Schemas["SourceOut"];
type Kind = Source["kind"];
type KindOption = Schemas["SourceKindOut"];

// The config key holding each kind's allowlist (as its connector reads it), and what one
// entry looks like. Notion's roots are ticked in the page picker, not typed.
const ALLOWLIST: Record<Exclude<Kind, "upload">, { key: string; label: string; example: string }> = {
  github: { key: "repos", label: "Repositories", example: "example-org/example-app" },
  slack: { key: "channels", label: "Channel ids", example: "C0123PRODUCT" },
  notion: { key: "roots", label: "Pages", example: "" },
  google_docs: { key: "folders", label: "Folder ids", example: "1AbC…" },
  fireflies: { key: "meetings", label: "Meeting title filters", example: "Weekly product review" },
};

const STATUS_KIND: Record<Source["status"], ChipKind> = { active: "pass", paused: "na", error: "crit" };
const STATUS_LABEL: Record<Source["status"], string> = { active: "Active", paused: "Paused", error: "Error" };

/**
 * A row's rarely used actions (Edit allowlist, Delete) behind one "More" button, so the
 * row's actions stay on one line on a phone.
 */
function RowMenu({ label, items }: { label: string; items: { label: string; onSelect: () => void; danger?: boolean }[] }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <span ref={box} className="relative">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
        className="grid size-8 place-items-center rounded-lg text-text2 hover:bg-surface2 hover:text-text"
      >
        <Icon name="more" size={20} />
      </button>
      {open && (
        <span
          id={id}
          role="menu"
          aria-label={label}
          className="absolute top-full right-0 z-20 mt-1 flex min-w-40 flex-col rounded-button border border-line bg-surface p-1 shadow-panel"
        >
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
              className={`flex h-9 items-center rounded-lg px-3 text-left text-[15px] font-medium whitespace-nowrap hover:bg-surface2 ${
                it.danger ? "text-crit" : "text-text"
              }`}
            >
              {it.label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

function entries(config: Record<string, unknown>, key: string): string[] {
  if (key === "roots") return notionRoots(config);
  const value = config[key];
  return Array.isArray(value) ? value.map(String) : [];
}

function parseLines(text: string): string[] {
  return [...new Set(text.split(/[\n,]/).map((l) => l.trim()).filter(Boolean))];
}

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

/** A one-line warning (warn tokens): a connector that is not there yet. */
function Warn({ children }: { children: ReactNode }) {
  return <p className="rounded-button bg-warn-bg px-3 py-2 text-sm font-medium text-warn">{children}</p>;
}

function AllowlistEditor({ source, onSaved }: { source: Source; onSaved: (s: Source) => void }) {
  const id = useId();
  const spec = ALLOWLIST[source.kind as Exclude<Kind, "upload">];
  const [text, setText] = useState(entries(source.config, spec.key).join("\n"));
  const [roots, setRoots] = useState(() => notionRoots(source.config));
  const { act, error, busy } = useAction();
  const notion = source.kind === "notion";

  async function save(e: FormEvent) {
    e.preventDefault();
    const config: Record<string, unknown> = { ...source.config, [spec.key]: notion ? roots : parseLines(text) };
    const saved = await act(() =>
      unwrap(api.PATCH("/v1/sources/{source_id}", { params: { path: { source_id: source.id } }, body: { config } })),
    );
    if (saved) onSaved(saved);
  }

  if (notion && !source.connection_id) return <ReconnectNotion picked={roots.length} />;

  return (
    <form onSubmit={save} className="mt-2.5 flex flex-col gap-2.5 rounded-button border border-line bg-surface2 p-3">
      {notion && source.connection_id ? (
        <ChoosePages connectionId={source.connection_id} value={roots} onChange={setRoots} />
      ) : (
        <Field
          label={`${spec.label} (one per line)`}
          htmlFor={id}
          tip={
            <InfoTip label="saving the allowlist" align="start">
              Saving a new allowlist syncs this source again from the start.
            </InfoTip>
          }
        >
          <textarea
            id={id}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            placeholder={spec.example}
            className={`${TEXTAREA} font-mono`}
          />
        </Field>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      <div>
        <Button type="submit" variant="solid" disabled={busy || (notion && roots.length === 0)}>
          Save allowlist
        </Button>
      </div>
    </form>
  );
}

/** A Notion source whose connection is gone: its pages can only be picked through a connection. */
function ReconnectNotion({ picked }: { picked: number }) {
  return (
    <div
      className="mt-2.5 flex flex-col gap-2.5 rounded-button border border-line bg-surface2 p-3"
      data-testid="notion-reconnect"
    >
      <Warn>Reconnect Notion to change pages.</Warn>
      <p className="text-sm text-text2">
        This source&rsquo;s Notion connection was removed. It keeps its {picked} picked{" "}
        {picked === 1 ? "page" : "pages"}; changing them needs a Notion connection.
      </p>
      <div>
        <LinkButton href="/settings/connections" icon="link">
          Go to Connections
        </LinkButton>
      </div>
    </div>
  );
}

function SourceRow({ source, onChange, onDelete }: { source: Source; onChange: (s: Source) => void; onDelete: () => void }) {
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { act, error, busy } = useAction();
  const path = { params: { path: { source_id: source.id } } };
  const allowlist = source.kind === "upload" ? null : ALLOWLIST[source.kind];

  async function syncNow() {
    setNotice(null);
    const r = await act(() => unwrap(api.POST("/v1/sources/{source_id}/sync", path)));
    if (!r) return;
    onChange(r.source);
    if (r.outcome === "completed") {
      setNotice(`Synced: ${r.upserted} item(s) seen, ${r.versions_written} new version(s), ${r.deleted} deleted.`);
    } else if (r.outcome === "rate_limited") {
      setNotice("Rate limited: the next sync resumes where this one stopped.");
    }
  }

  async function togglePause() {
    const next = source.status === "paused" ? "/v1/sources/{source_id}/resume" : "/v1/sources/{source_id}/pause";
    const s = await act(() => unwrap(api.POST(next, path)));
    if (s) onChange(s);
  }

  async function remove() {
    if (!window.confirm(`Delete “${source.name}” and everything it pulled in?`)) return;
    const ok = await act(() => unwrap(api.DELETE("/v1/sources/{source_id}", path)).then(() => true));
    if (ok) onDelete();
  }

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setNotice(null);
    const form = new FormData();
    for (const f of Array.from(files)) form.append("files", f);
    const r = await act(() =>
      unwrap(
        api.POST("/v1/sources/{source_id}/uploads", {
          ...path,
          // openapi-fetch sends FormData as is; the schema types the field as strings.
          body: form as unknown as Schemas["Body_upload_files"],
          bodySerializer: (b) => b as unknown as FormData,
        }),
      ),
    );
    if (fileRef.current) fileRef.current.value = "";
    if (!r) return;
    const added = r.items.length - r.unchanged.length;
    setNotice(`Uploaded ${added} file(s)${r.unchanged.length ? `, ${r.unchanged.length} unchanged` : ""}.`);
    const fresh = await act(() => unwrap(api.GET("/v1/sources/{source_id}", path)));
    if (fresh) onChange(fresh);
  }

  const items = allowlist ? entries(source.config, allowlist.key) : [];
  const synced = source.last_synced_at
    ? `last ${source.kind === "upload" ? "upload" : "sync"} ${formatDateTime(source.last_synced_at)}`
    : "never synced";

  return (
    <li
      className="border-t border-line px-4 py-2.5 first:border-t-0 max-[600px]:px-3"
      data-testid="source-card"
      aria-label={source.name}
    >
      <div className="flex min-h-9 flex-wrap items-center gap-x-2.5 gap-y-2">
        <span className="flex min-w-0 flex-1 basis-56 items-center gap-2">
          <span className="min-w-0 truncate font-semibold" title={source.name}>
            {source.name}
          </span>
          <Chip kind="acc">{KIND_LABEL[source.kind]}</Chip>
          <Chip kind={STATUS_KIND[source.status]} dot>
            {STATUS_LABEL[source.status]}
          </Chip>
          {!source.connector_available && (
            <Chip kind="warn" title={`The ${KIND_LABEL[source.kind]} connector is not available yet.`}>
              No connector
            </Chip>
          )}
        </span>
        <span className="flex flex-none items-center gap-1">
          {source.kind === "upload" ? (
            <>
              <input
                ref={fileRef}
                type="file"
                multiple
                accept=".md,.markdown,.txt,.pdf"
                className="sr-only"
                aria-label={`Upload files to ${source.name}`}
                onChange={(e) => upload(e.target.files)}
              />
              <Button variant="solid" disabled={busy || source.status === "paused"} onClick={() => fileRef.current?.click()}>
                Upload files
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="solid"
                disabled={busy || source.status === "paused" || !source.connector_available}
                onClick={syncNow}
              >
                Sync now
              </Button>
            </>
          )}
          <Button disabled={busy} onClick={togglePause}>
            {source.status === "paused" ? "Resume" : "Pause"}
          </Button>
          <RowMenu
            label={`More actions for ${source.name}`}
            items={[
              ...(allowlist
                ? [{ label: editing ? "Close allowlist" : "Edit allowlist", onSelect: () => setEditing((v) => !v) }]
                : []),
              { label: "Delete", onSelect: () => void remove(), danger: true },
            ]}
          />
        </span>
      </div>
      <div className="tnum mt-0.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-sm text-text2">
        <span>{source.item_count} item(s)</span>
        <span>{synced}</span>
        {allowlist && (
          <span className="flex min-w-0 max-w-full items-center gap-1.5">
            <Label className="flex-none">{allowlist.label}</Label>
            <span className="min-w-0 truncate font-mono text-text" title={items.join(", ")}>
              {source.kind === "notion" ? `${items.length} picked` : items.length ? items.join(", ") : "none yet"}
            </span>
          </span>
        )}
      </div>
      {(source.last_error || notice || error) && (
        <div className="mt-2 flex flex-col gap-2">
          {source.last_error && (
            <p className="rounded-button bg-crit-bg px-3 py-2 text-sm font-medium text-crit" data-testid="last-error">
              {source.last_error}
            </p>
          )}
          {notice && <Notice tone="pass">{notice}</Notice>}
          {error && <Notice tone="error">{error}</Notice>}
        </div>
      )}
      {editing && allowlist && (
        <AllowlistEditor
          source={source}
          onSaved={(s) => {
            onChange(s);
            setEditing(false);
            setNotice("Allowlist saved.");
          }}
        />
      )}
    </li>
  );
}

/** The Notion page picker under its label: a source's roots, ticked rather than typed. */
function ChoosePages(props: { connectionId: string; value: string[]; onChange: (roots: string[]) => void }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5" role="group" aria-label="Choose pages">
      <span className="flex items-center gap-1.5">
        <Label>Choose pages</Label>
        <InfoTip label="choosing pages" align="start">
          Tick the pages and databases to pull in; their sub-pages and databases come with them. Saving new picks syncs
          the source again from the start.
        </InfoTip>
      </span>
      <NotionPicker {...props} />
    </div>
  );
}

function AddSource({ kinds, onAdded }: { kinds: KindOption[]; onAdded: (s: Source) => void }) {
  const [kind, setKind] = useState<Kind>("upload");
  const [name, setName] = useState("");
  const [connection, setConnection] = useState("");
  const [allow, setAllow] = useState("");
  const [roots, setRoots] = useState<string[]>([]);
  const { act, error, busy } = useAction();
  const option = kinds.find((k) => k.kind === kind);
  const usable = (option?.connections ?? []).filter((c) => c.status === "active");
  const spec = kind === "upload" ? null : ALLOWLIST[kind];
  const connectionId = connection || usable[0]?.id || "";

  async function submit(e: FormEvent) {
    e.preventDefault();
    const body: Schemas["SourceCreate"] = {
      kind,
      name: name.trim(),
      connection_id: spec ? connectionId : null,
      config: kind === "notion" ? { roots } : spec ? { [spec.key]: parseLines(allow) } : {},
    };
    const s = await act(() => unwrap(api.POST("/v1/sources", { body })));
    if (s) {
      onAdded(s);
      setName("");
      setAllow("");
      setRoots([]);
    }
  }

  const blocked =
    !option?.connector_available || (spec !== null && usable.length === 0) || (kind === "notion" && roots.length === 0);

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" aria-label="Add a source">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-3">
        <Field label="Kind">
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as Kind);
              setConnection("");
              setRoots([]);
            }}
            className={SELECT_FIELD}
          >
            {kinds.map((k) => (
              <option key={k.kind} value={k.kind}>
                {KIND_LABEL[k.kind]}
                {k.connector_available ? "" : " (not available yet)"}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder={kind === "upload" ? "Research notes" : `My ${KIND_LABEL[kind]}`}
            className={INPUT}
          />
        </Field>
      </div>
      {spec && usable.length > 0 && (
        <Field label="Connection">
          <select
            value={connectionId}
            onChange={(e) => {
              setConnection(e.target.value);
              setRoots([]);
            }}
            className={SELECT_FIELD}
          >
            {usable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.account_label ?? c.id}
              </option>
            ))}
          </select>
        </Field>
      )}
      {!option?.connector_available && <Warn>The {KIND_LABEL[kind]} connector is not available yet.</Warn>}
      {option?.connector_available && spec && usable.length === 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Chip kind="warn">No {KIND_LABEL[kind]} account</Chip>
          <LinkButton href="/settings/connections" icon="link">
            Connect your account
          </LinkButton>
        </div>
      )}
      {kind === "notion" && usable.length > 0 && (
        <ChoosePages key={connectionId} connectionId={connectionId} value={roots} onChange={setRoots} />
      )}
      {spec && kind !== "notion" && usable.length > 0 && (
        <Field label={`${spec.label} to pull in (one per line)`}>
          <textarea
            value={allow}
            onChange={(e) => setAllow(e.target.value)}
            rows={3}
            placeholder={spec.example}
            className={`${TEXTAREA} font-mono`}
          />
        </Field>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      <div>
        <Button type="submit" variant="solid" icon="plus" disabled={busy || blocked || !name.trim()}>
          Add source
        </Button>
      </div>
    </form>
  );
}

export default function SourceSettingsPage() {
  const sources = useQuery("sources", () => unwrap(api.GET("/v1/sources")));
  const kinds = useQuery("source-kinds", () => unwrap(api.GET("/v1/sources/kinds")));
  const list = sources.data ?? [];
  const errors = list.filter((s) => s.status === "error").length;
  const items = list.reduce((n, s) => n + s.item_count, 0);

  const replace = (s: Source) => sources.setData((prev) => (prev ?? []).map((x) => (x.id === s.id ? s : x)));

  const inspector = (
    <Inspector
      eyebrow="Source · new"
      title="Add a source"
      label="New source"
      chips={
        <>
          <Chip hero>Only you</Chip>
          <InfoTip label="private sources" hero align="start" side="bottom">
            Your sources are yours alone: what they pull in through your connections is visible only to you, and reaches
            others only as evidence you add to the baseline. Direct messages are never pulled in.
          </InfoTip>
        </>
      }
      stats={[
        { label: "Sources", value: sources.data ? list.length : "—" },
        { label: "Items", value: sources.data ? items : "—" },
        { label: "Errors", value: sources.data ? errors : "—", tone: errors > 0 ? "crit" : undefined },
      ]}
    >
      <InspectorSection>
        {kinds.error && <Notice tone="error">{kinds.error}</Notice>}
        {!kinds.data && !kinds.error && <span className="block h-3 w-2/3 animate-pulse rounded bg-surface2" />}
        {kinds.data && <AddSource kinds={kinds.data} onAdded={(s) => sources.setData((prev) => [...(prev ?? []), s])} />}
      </InspectorSection>
    </Inspector>
  );

  return (
    <>
      <PageHeader
        title="Sources"
        status={
          <>
            <InfoTip label="sources" align="start" side="bottom">
              What your connections pull in. Only you see it; it reaches others only as evidence you add to the baseline.
            </InfoTip>
            {errors > 0 && (
              <Chip kind="crit" dot>
                {errors} in error
              </Chip>
            )}
          </>
        }
        action={
          <LinkButton variant="primary" icon="search" href="/sources">
            Search sources
          </LinkButton>
        }
      />
      <Split inspector={inspector}>
        {sources.error && <Notice tone="error">{sources.error}</Notice>}
        <Panel title="My sources" count={sources.data ? list.length : undefined}>
          {sources.loading && !sources.data && (
            <div aria-busy className="flex flex-col">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex h-14 items-center border-t border-line px-4 first:border-t-0">
                  <span className="block h-3 w-2/3 animate-pulse rounded bg-surface2" />
                </div>
              ))}
            </div>
          )}
          {sources.data && list.length === 0 && <Empty>No sources yet</Empty>}
          {list.length > 0 && (
            <ul aria-label="My sources" className="flex flex-col">
              {list.map((s) => (
                <SourceRow
                  key={s.id}
                  source={s}
                  onChange={replace}
                  onDelete={() => sources.setData((prev) => (prev ?? []).filter((x) => x.id !== s.id))}
                />
              ))}
            </ul>
          )}
        </Panel>
      </Split>
    </>
  );
}
