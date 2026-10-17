"use client";

import Link from "next/link";
import { type FormEvent, useRef, useState } from "react";

import { KIND_LABEL } from "@/app/sources/_components/confidence";
import { Badge, Button, ErrorNote, Loading } from "@/components/ui";
import { api, type Schemas, unwrap } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
import { errorMessage, useAuthRedirect, useQuery } from "@/lib/use-query";

type Source = Schemas["SourceOut"];
type Kind = Source["kind"];
type KindOption = Schemas["SourceKindOut"];

// The config key holding each kind's allowlist, and what one entry looks like.
const ALLOWLIST: Record<Exclude<Kind, "upload">, { key: string; label: string; example: string }> = {
  github: { key: "repos", label: "Repositories", example: "example-org/example-app" },
  slack: { key: "channels", label: "Channel ids", example: "C0123PRODUCT" },
  notion: { key: "pages", label: "Root page ids", example: "0123abcd…" },
  google_docs: { key: "folders", label: "Folder ids", example: "1AbC…" },
  fireflies: { key: "meetings", label: "Meeting title filters", example: "Weekly product review" },
};

const STATUS_TONE = { active: "green", paused: "neutral", error: "red" } as const;

function entries(config: Record<string, unknown>, key: string): string[] {
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

function AllowlistEditor({ source, onSaved }: { source: Source; onSaved: (s: Source) => void }) {
  const spec = ALLOWLIST[source.kind as Exclude<Kind, "upload">];
  const [text, setText] = useState(entries(source.config, spec.key).join("\n"));
  const { act, error, busy } = useAction();

  async function save(e: FormEvent) {
    e.preventDefault();
    const config = { ...source.config, [spec.key]: parseLines(text) };
    const saved = await act(() =>
      unwrap(api.PATCH("/v1/sources/{source_id}", { params: { path: { source_id: source.id } }, body: { config } })),
    );
    if (saved) onSaved(saved);
  }

  return (
    <form onSubmit={save} className="mt-3 space-y-2">
      <label className="block text-xs text-neutral-600">
        {spec.label} (one per line)
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          placeholder={spec.example}
          className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-1.5 font-mono text-sm"
        />
      </label>
      <p className="text-xs text-neutral-500">Saving a new allowlist syncs this source again from the start.</p>
      {error && <ErrorNote>{error}</ErrorNote>}
      <Button type="submit" size="sm" variant="primary" disabled={busy}>
        Save allowlist
      </Button>
    </form>
  );
}

function SourceCard({ source, onChange, onDelete }: { source: Source; onChange: (s: Source) => void; onDelete: () => void }) {
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

  return (
    <li className="rounded-lg border border-neutral-200 bg-white px-4 py-3" data-testid="source-card" aria-label={source.name}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-neutral-900">{source.name}</span>
            <Badge>{KIND_LABEL[source.kind]}</Badge>
            <Badge tone={STATUS_TONE[source.status]}>{source.status}</Badge>
          </div>
          <div className="mt-0.5 text-xs text-neutral-500">
            {source.item_count} item(s) ·{" "}
            {source.last_synced_at ? `last ${source.kind === "upload" ? "upload" : "sync"} ${formatDateTime(source.last_synced_at)}` : "never synced"}
            {allowlist && (
              <>
                {" "}
                · {allowlist.label.toLowerCase()}: {items.length ? items.join(", ") : "none yet"}
              </>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
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
              <Button size="sm" variant="primary" disabled={busy || source.status === "paused"} onClick={() => fileRef.current?.click()}>
                Upload files
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="primary" disabled={busy || source.status === "paused" || !source.connector_available} onClick={syncNow}>
                Sync now
              </Button>
              <Button size="sm" disabled={busy} onClick={() => setEditing((v) => !v)}>
                {editing ? "Close allowlist" : "Edit allowlist"}
              </Button>
            </>
          )}
          <Button size="sm" disabled={busy} onClick={togglePause}>
            {source.status === "paused" ? "Resume" : "Pause"}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={remove}>
            Delete
          </Button>
        </div>
      </div>
      {!source.connector_available && (
        <p className="mt-2 text-xs text-amber-800">The {KIND_LABEL[source.kind]} connector is not available yet.</p>
      )}
      {source.last_error && (
        <p className="mt-2 rounded-md bg-rose-50 px-2 py-1 text-xs text-rose-800" data-testid="last-error">
          {source.last_error}
        </p>
      )}
      {notice && (
        <p className="mt-2 text-xs text-emerald-800" role="status">
          {notice}
        </p>
      )}
      {error && (
        <div className="mt-2">
          <ErrorNote>{error}</ErrorNote>
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

function AddSource({ kinds, onAdded }: { kinds: KindOption[]; onAdded: (s: Source) => void }) {
  const [kind, setKind] = useState<Kind>("upload");
  const [name, setName] = useState("");
  const [connection, setConnection] = useState("");
  const [allow, setAllow] = useState("");
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
      config: spec ? { [spec.key]: parseLines(allow) } : {},
    };
    const s = await act(() => unwrap(api.POST("/v1/sources", { body })));
    if (s) {
      onAdded(s);
      setName("");
      setAllow("");
    }
  }

  const blocked = !option?.connector_available || (spec !== null && usable.length === 0);

  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border border-neutral-200 bg-white px-4 py-4" aria-label="Add a source">
      <h2 className="text-sm font-semibold text-neutral-900">Add a source</h2>
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col text-xs text-neutral-600">
          Kind
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as Kind);
              setConnection("");
            }}
            className="mt-1 rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
          >
            {kinds.map((k) => (
              <option key={k.kind} value={k.kind}>
                {KIND_LABEL[k.kind]}
                {k.connector_available ? "" : " (not available yet)"}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-48 flex-1 flex-col text-xs text-neutral-600">
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder={kind === "upload" ? "Research notes" : `My ${KIND_LABEL[kind]}`}
            className="mt-1 rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
          />
        </label>
        {spec && usable.length > 0 && (
          <label className="flex flex-col text-xs text-neutral-600">
            Connection
            <select
              value={connectionId}
              onChange={(e) => setConnection(e.target.value)}
              className="mt-1 rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
            >
              {usable.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.account_label ?? c.id}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {!option?.connector_available && (
        <p className="text-xs text-amber-800">The {KIND_LABEL[kind]} connector is not available yet.</p>
      )}
      {option?.connector_available && spec && usable.length === 0 && (
        <p className="text-xs text-neutral-600">
          You have no {KIND_LABEL[kind]} connection yet.{" "}
          <Link href="/settings/connections" className="underline">
            Connect your account
          </Link>{" "}
          first.
        </p>
      )}
      {spec && usable.length > 0 && (
        <label className="block text-xs text-neutral-600">
          {spec.label} to pull in (one per line)
          <textarea
            value={allow}
            onChange={(e) => setAllow(e.target.value)}
            rows={3}
            placeholder={spec.example}
            className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-1.5 font-mono text-sm"
          />
        </label>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
      <Button type="submit" variant="primary" disabled={busy || blocked || !name.trim()}>
        Add source
      </Button>
    </form>
  );
}

export default function SourceSettingsPage() {
  const sources = useQuery("sources", () => unwrap(api.GET("/v1/sources")));
  const kinds = useQuery("source-kinds", () => unwrap(api.GET("/v1/sources/kinds")));
  const list = sources.data ?? [];

  const replace = (s: Source) => sources.setData((prev) => (prev ?? []).map((x) => (x.id === s.id ? s : x)));

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <h1 className="mb-2 text-2xl font-semibold tracking-tight text-neutral-900">Sources</h1>
      <p className="mb-6 text-sm text-neutral-600">
        Your sources are yours alone: what they pull in through your connections is visible only to you, and reaches
        others only as evidence you add to the baseline. Direct messages are never pulled in.{" "}
        <Link href="/sources" className="underline">
          Search your sources
        </Link>
        .
      </p>
      {sources.error && <ErrorNote>{sources.error}</ErrorNote>}
      {sources.loading && <Loading />}
      {sources.data && list.length === 0 && <p className="mb-6 text-neutral-600">You have no sources yet. Add one below.</p>}
      {list.length > 0 && (
        <ul className="mb-6 space-y-3" aria-label="My sources">
          {list.map((s) => (
            <SourceCard
              key={s.id}
              source={s}
              onChange={replace}
              onDelete={() => sources.setData((prev) => (prev ?? []).filter((x) => x.id !== s.id))}
            />
          ))}
        </ul>
      )}
      {kinds.error && <ErrorNote>{kinds.error}</ErrorNote>}
      {kinds.data && <AddSource kinds={kinds.data} onAdded={(s) => sources.setData((prev) => [...(prev ?? []), s])} />}
    </div>
  );
}
