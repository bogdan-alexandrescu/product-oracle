"use client";

import { useRouter } from "next/navigation";
import { type ComponentType, type FormEvent, type ReactNode, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";

import { KIND_LABEL } from "@/app/sources/_components/confidence";
import {
  Button,
  Chip,
  confirmInPage,
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
import { api, ApiError, type Schemas, unwrap } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
import { useMe } from "@/lib/me";
import { errorMessage, useAuthRedirect, useQuery } from "@/lib/use-query";

import { Field, INPUT, SELECT_FIELD } from "../_components/fields";
import { labelsOf, type PickerProps } from "./_browse-list";
import { CodeMaps } from "./_code-maps";
import { GithubPicker, githubReads } from "./_github-picker";
import { SlackPicker } from "./_slack-picker";
import { CodeMapRefreshSetting } from "./_code-map-refresh";
import { CompanyDriveSettings } from "./CompanyDrive";
import { driveConfig, driveFiles, DriveFiles, DriveNotes, ReconnectToChoose, type DriveFile } from "./DriveFiles";
import {
  type FirefliesConfig,
  FirefliesPicker,
  firefliesConfigToSave,
  firefliesReady,
  firefliesSummary,
  firefliesRange,
  readFirefliesConfig,
} from "./FirefliesPicker";
import { NotionPicker, notionRoots } from "./NotionPicker";

type Source = Schemas["SourceOut"];
type Kind = Source["kind"];
type KindOption = Schemas["SourceKindOut"];
type Choice = Schemas["ConnectionChoice"];

// The config key holding each kind's picks (as its connector reads it), the row's label
// for them and the word for them in the menu, button and notice. Every kind is picked in
// a picker (S5); Fireflies sources in a browse panel of their own (FirefliesPicker).
type ListKind = Exclude<Kind, "upload" | "fireflies">;
const ALLOWLIST: Record<ListKind, { key: string; label: string; noun: string }> = {
  github: { key: "repos", label: "Repositories", noun: "repositories" },
  slack: { key: "channels", label: "Channels", noun: "channels" },
  notion: { key: "roots", label: "Pages", noun: "pages" },
  // Picked in Google's Drive picker (DriveFiles): "docs" and "folders".
  google_docs: { key: "docs", label: "Files", noun: "files" },
};

const SAVE_TIP =
  "Saving fewer channels (or repositories, or pages), or a shorter date range, removes what they no longer cover at once. The next sync reads only what remains, and anything new.";

// Kinds chosen in a picker (browse, search, tick) rather than typed ids (S5).
const PICKER: Partial<Record<Kind, ComponentType<PickerProps>>> = {
  slack: SlackPicker,
  github: GithubPicker,
  notion: NotionSourcePicker,
};

const STATUS_KIND: Record<Source["status"], ChipKind> = {
  active: "pass",
  paused: "na",
  error: "crit",
  needs_attention: "warn",
};
const STATUS_LABEL: Record<Source["status"], string> = {
  active: "Active",
  paused: "Paused",
  error: "Error",
  needs_attention: "Needs attention",
};

/** Fireflies' own API: a source reading it says nothing of where it reads. */
const FIREFLIES_API = "https://api.fireflies.ai/graphql";

/** "1 item", "2 items": a count and its noun, in words (qa-settings-26). */
function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

const NEW_FIREFLIES: FirefliesConfig = { mode: "all", series: [], meetings: [], labels: {} };

type RowNotice = { tone: "pass" | "warn"; text: string };

/**
 * A row's rarely used actions (Edit channels, Delete) behind one "More" button, so the
 * row's actions stay on one line on a phone.
 */
function RowMenu({ label, items }: { label: string; items: { label: string; onSelect: () => void; danger?: boolean }[] }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLSpanElement>(null);
  const id = useId();
  const menuItems = () => [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  useEffect(() => {
    if (!open) return;
    // Opening moves focus to the first item (qa-settings-12); Escape returns it to the button.
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setOpen(false);
      trigger.current?.focus();
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
        ref={trigger}
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
          ref={menu}
          id={id}
          role="menu"
          aria-label={label}
          onKeyDown={(e) => {
            // Arrow keys move between the items; Tab leaves the menu and closes it.
            if (e.key === "Tab") return setOpen(false);
            if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
            e.preventDefault();
            const els = menuItems();
            const i = els.indexOf(document.activeElement as HTMLElement);
            const next =
              e.key === "Home" ? 0 : e.key === "End" ? els.length - 1 : (i + (e.key === "ArrowDown" ? 1 : -1) + els.length) % els.length;
            els[next]?.focus();
          }}
          className="absolute top-full right-0 z-20 mt-1 flex min-w-40 flex-col rounded-button border border-line bg-surface p-1 shadow-panel"
        >
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              tabIndex={-1}
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

/** Picks shown on a row: at most this many names, then "and N more". */
const PICKS_SHOWN = 5;

/**
 * A row's picks in words (qa-work-46): "#product, #design, #eng and 40 more"; picks saved
 * before names were kept are counted as unknown ("120 unknown channels", qa-settings-23),
 * never listed by id: the ids only in the title.
 */
function picksSummary(names: string[], unnamedIds: string[], unknown: [string, string]): { text: string; title: string } {
  const unnamed = unnamedIds.length;
  const unknownText = unnamed === 0 ? "" : unnamed === 1 ? unknown[0] : `${unnamed} ${unknown[1]}`;
  const title = [names.join(", "), unnamed ? `No name saved for ${unnamedIds.join(", ")}` : ""].filter(Boolean).join(". ");
  const extra = names.length - Math.min(names.length, PICKS_SHOWN);
  const shown = names.slice(0, PICKS_SHOWN).join(", ");
  if (!extra) return { text: [shown, unknownText].filter(Boolean).join(", "), title };
  return { text: `${shown} and ${extra + unnamed} more`, title };
}

/** What a pick without a saved name reads as: "Unknown channel", "3 unknown channels". */
const UNKNOWN: Partial<Record<Kind | "folder", [string, string]>> = {
  slack: ["Unknown channel", "unknown channels"],
  google_docs: ["Unknown file", "unknown files"],
  folder: ["Unknown folder", "unknown folders"],
};

/**
 * Picks in words: their saved names, those without one counted as unknown (never their raw
 * ids, qa-settings-23), and a title naming everything, the unnamed ones by id.
 */
function pickWords(picks: { id: string; name?: string }[], unknown?: [string, string]): { text: string; title: string } {
  const named = picks.flatMap((p) => (p.name ? [p.name] : unknown ? [] : [p.id]));
  const unnamed = unknown ? picks.filter((p) => !p.name).map((p) => p.id) : [];
  const rest = unnamed.length === 0 ? [] : unnamed.length === 1 ? [unknown![0]] : [`${unnamed.length} ${unknown![1]}`];
  return {
    text: [...named, ...rest].join(", "),
    title: [named.join(", "), unnamed.length ? `No name saved for ${unnamed.join(", ")}` : ""].filter(Boolean).join(". "),
  };
}

function entries(config: Record<string, unknown>, key: string): string[] {
  if (key === "roots") return notionRoots(config);
  const value = config[key];
  return Array.isArray(value) ? value.map(String) : [];
}

function useAction() {
  const onAuth = useAuthRedirect();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The save loaded an older version of the source (409 source_changed).
  const [stale, setStale] = useState(false);
  async function act<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    setStale(false);
    try {
      return await fn();
    } catch (e) {
      if (!onAuth(e)) {
        setError(errorMessage(e));
        setStale(e instanceof ApiError && e.code === "source_changed");
      }
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { act, error, setError, busy, stale };
}

/** A save's error. A stale one (the source changed since the form opened) offers Reload,
 * which refetches the source and reopens the form on its current picks. */
function SaveError({
  error,
  stale,
  busy,
  onReload,
}: {
  error: string;
  stale: boolean;
  busy: boolean;
  onReload: () => void;
}) {
  if (!stale) return <Notice tone="error">{error}</Notice>;
  return (
    <Notice
      tone="error"
      action={
        <Button onClick={onReload} disabled={busy}>
          Reload
        </Button>
      }
    >
      {error} Nothing was saved. Reloading discards the picks you changed here.
    </Notice>
  );
}

/** Refetches a source (the Reload of a stale save). */
function fetchSource(id: string) {
  return unwrap(api.GET("/v1/sources/{source_id}", { params: { path: { source_id: id } } }));
}

/** A one-line warning (warn tokens): a connector that is not there yet. */
function Warn({ children }: { children: ReactNode }) {
  return <p className="rounded-button bg-warn-bg px-3 py-2 text-sm font-medium text-warn">{children}</p>;
}

function AllowlistEditor({
  source,
  onSaved,
  onReload,
}: {
  source: Source;
  onSaved: (s: Source) => void;
  onReload: (s: Source) => void;
}) {
  const spec = ALLOWLIST[source.kind as ListKind];
  const Picker = PICKER[source.kind];
  const [picked, setPicked] = useState(source.config);
  const { act, error, busy, stale } = useAction();
  const notion = source.kind === "notion";
  // Like Add source, a Slack source with no channel left says why Save waits.
  const noChannels = source.kind === "slack" && entries(picked, "channels").length === 0;

  async function save(e: FormEvent) {
    e.preventDefault();
    // base_version: the version this form loaded; a source saved since refuses the save.
    const saved = await act(() =>
      unwrap(
        api.PATCH("/v1/sources/{source_id}", {
          params: { path: { source_id: source.id } },
          body: { config: picked, base_version: source.config_version },
        }),
      ),
    );
    if (saved) onSaved(saved);
  }
  async function reload() {
    const fresh = await act(() => fetchSource(source.id));
    if (fresh) onReload(fresh);
  }

  if (notion && !source.connection_id) return <ReconnectNotion picked={notionRoots(source.config).length} />;

  return (
    <form onSubmit={save} className="mt-2.5 flex flex-col gap-2.5 rounded-button border border-line bg-surface2 p-3">
      {Picker && <Picker connectionId={source.connection_id} config={picked} onChange={setPicked} />}
      {error && <SaveError error={error} stale={stale} busy={busy} onReload={reload} />}
      <div className="flex items-center gap-1.5">
        <Button type="submit" variant="solid" disabled={busy || (notion && notionRoots(picked).length === 0) || noChannels}>
          Save {spec.noun}
        </Button>
        {!notion && (
          <InfoTip label={`saving the ${spec.noun}`} align="start">
            {SAVE_TIP}
          </InfoTip>
        )}
        {noChannels && (
          <span className="text-sm text-text2" data-testid="save-channels-reason">
            Pick a channel to save
          </span>
        )}
      </div>
    </form>
  );
}

function FirefliesEditor({
  source,
  onSaved,
  onReload,
}: {
  source: Source;
  onSaved: (s: Source) => void;
  onReload: (s: Source) => void;
}) {
  const initial = readFirefliesConfig(source.config);
  const [value, setValue] = useState<FirefliesConfig>(initial.value);
  const { act, error, busy, stale } = useAction();

  async function save(e: FormEvent) {
    e.preventDefault();
    const config = firefliesConfigToSave(value);
    const saved = await act(() =>
      unwrap(
        api.PATCH("/v1/sources/{source_id}", {
          params: { path: { source_id: source.id } },
          body: { config, base_version: source.config_version },
        }),
      ),
    );
    if (saved) onSaved(saved);
  }
  async function reload() {
    const fresh = await act(() => fetchSource(source.id));
    if (fresh) onReload(fresh);
  }

  return (
    <form
      onSubmit={save}
      aria-label={`Meetings of ${source.name}`}
      className="mt-2.5 flex flex-col gap-3 rounded-button border border-line bg-surface2/40 p-3 max-[600px]:p-2.5"
    >
      {source.connection_id ? (
        <FirefliesPicker connectionId={source.connection_id} value={value} onChange={setValue} titleRule={initial.titleRule} />
      ) : (
        <Warn>This source has no connection: reconnect Fireflies first.</Warn>
      )}
      {error && <SaveError error={error} stale={stale} busy={busy} onReload={reload} />}
      <div className="flex items-center gap-2.5">
        <Button type="submit" variant="solid" disabled={busy || !firefliesReady(value) || !source.connection_id}>
          Save meetings
        </Button>
        <InfoTip label="saving meetings" align="start">
          Saving a narrower date range, or dropping a meeting or series, removes the meetings outside your picks at once. What is already stored and still included is kept.
        </InfoTip>
      </div>
    </form>
  );
}

/** Edit a Google Docs source's picked files and folders: the Drive picker adds to the list. */
function DriveFilesEditor({
  source,
  connection,
  onSaved,
  onReload,
}: {
  source: Source;
  connection: Choice | undefined;
  onSaved: (s: Source) => void;
  onReload: (s: Source) => void;
}) {
  const [files, setFiles] = useState<DriveFile[]>(driveFiles(source.config));
  const { act, error, busy, stale } = useAction();
  const reconnect = !!connection?.reconnect_reason;
  const unavailable = Object.fromEntries(
    (source.unavailable_items ?? []).filter((u) => (u.status ?? "unavailable") === "unavailable").map((u) => [u.external_id, u.reason]),
  );

  async function save(e: FormEvent) {
    e.preventDefault();
    const config = driveConfig(source.config, files);
    const saved = await act(() =>
      unwrap(api.PATCH("/v1/sources/{source_id}", { params: { path: { source_id: source.id } }, body: { config, base_version: source.config_version } })),
    );
    if (saved) onSaved(saved);
  }
  async function reload() {
    const fresh = await act(() => fetchSource(source.id));
    if (fresh) onReload(fresh);
  }

  return (
    <form
      onSubmit={save}
      aria-label={`Files of ${source.name}`}
      className="mt-2.5 flex flex-col gap-2.5 rounded-button border border-line bg-surface2 p-3"
    >
      <DriveFiles
        files={files}
        onChange={setFiles}
        accountHint={connection?.account_label ?? ""}
        reconnect={reconnect}
        unavailable={unavailable}
      />
      {error && <SaveError error={error} stale={stale} busy={busy} onReload={reload} />}
      <div className="flex items-center gap-1.5">
        <Button type="submit" variant="solid" disabled={busy || files.length === 0}>
          Save files
        </Button>
        <InfoTip label="saving the files" align="start">
          Saving syncs this source again. Docs from a file or folder you removed are deleted on that sync.
        </InfoTip>
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

function SourceRow({
  source,
  connection,
  onChange,
  onDelete,
  targeted = false,
}: {
  source: Source;
  connection?: Choice;
  onChange: (s: Source) => void;
  onDelete: () => void;
  /** The page's #source-<id> (the Inbox's Edit): scrolled to, its editor open if it needs attention. */
  targeted?: boolean;
}) {
  const router = useRouter();
  // Rows mount once the list has loaded, after the hash is read: open from the start.
  const [editing, setEditing] = useState(targeted && source.status === "needs_attention");
  const rowRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (targeted) rowRef.current?.scrollIntoView({ block: "center" });
  }, [targeted]);
  const [notice, setNotice] = useState<RowNotice | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { act, error, busy } = useAction();
  const path = { params: { path: { source_id: source.id } } };
  const fireflies = source.kind === "fireflies" ? readFirefliesConfig(source.config) : null;
  const allowlist = source.kind === "upload" || source.kind === "fireflies" ? null : ALLOWLIST[source.kind];
  const drive = source.kind === "google_docs";
  const picked = drive ? driveFiles(source.config) : [];
  // A Drive pick without a saved name carries its id as its name (driveFiles).
  const folders = pickWords(
    picked.filter((f) => f.kind === "folder").map((f) => ({ id: f.id, name: f.name !== f.id ? f.name : undefined })),
    UNKNOWN.folder,
  );
  const unavailable = source.unavailable_items ?? [];

  async function syncNow() {
    setNotice(null);
    const r = await act(() => unwrap(api.POST("/v1/sources/{source_id}/sync", path)));
    if (!r) return;
    onChange(r.source);
    if (r.outcome === "completed") {
      setNotice({
        tone: "pass",
        text:
          r.upserted === 0 && r.deleted === 0
            ? "Synced: nothing new."
            : `Synced: ${count(r.upserted, "item")} seen, ${count(r.versions_written, "new version")}, ${r.deleted} deleted.`,
      });
    } else if (r.outcome === "rate_limited") {
      setNotice({ tone: "pass", text: "Rate limited: the next sync resumes where this one stopped." });
    } else if (r.outcome === "superseded") {
      setNotice({ tone: "warn", text: "Not synced: this source was edited while it synced. Sync again to use the new selection." });
    }
    // error and needs_attention: the returned source carries the status and last_error shown below.
  }

  async function togglePause() {
    const next = source.status === "paused" ? "/v1/sources/{source_id}/resume" : "/v1/sources/{source_id}/pause";
    const s = await act(() => unwrap(api.POST(next, path)));
    if (s) onChange(s);
  }

  async function remove() {
    if (!(await confirmInPage({ destructive: true, action: "Delete", message: `Delete “${source.name}” and everything it pulled in?` }))) return;
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
    setNotice({ tone: "pass", text: `Uploaded ${count(added, "file")}${r.unchanged.length ? `, ${r.unchanged.length} unchanged` : ""}.` });
    const fresh = await act(() => unwrap(api.GET("/v1/sources/{source_id}", path)));
    if (fresh) onChange(fresh);
  }

  // Picks by name where the source saved one (labels); a Slack channel or Drive file saved
  // before names were kept reads as unknown, its id only in the title (qa-settings-23).
  // GitHub repositories are named by their ids.
  const names = labelsOf(source.config);
  const pickIds = drive || !allowlist ? [] : entries(source.config, allowlist.key);
  // qa-work-46: Slack and Notion picks are opaque ids; one with no saved name is counted, not shown by id.
  const opaqueIds = source.kind === "slack" || source.kind === "notion";
  // A Drive pick without a saved name carries its id as its name (driveFiles).
  const docs = picked.filter((f) => f.kind === "doc");
  const items = drive
    ? docs.filter((f) => f.name !== f.id).map((f) => f.name)
    : opaqueIds
      ? pickIds.filter((id) => names[id]).map((id) => names[id])
      : pickIds.map((id) => names[id] ?? id);
  const unnamedIds = drive ? docs.filter((f) => f.name === f.id).map((f) => f.id) : opaqueIds ? pickIds.filter((id) => !names[id]) : [];
  const unnamed = unnamedIds.length;
  const unknown: [string, string] = UNKNOWN[source.kind] ?? (allowlist ? [`Unknown ${allowlist.noun.replace(/s$/, "")}`, `unknown ${allowlist.noun}`] : ["", ""]);
  const picks = allowlist ? picksSummary(items, unnamedIds, unknown) : { text: "", title: "" };
  // GitHub's include: what the source reads, when it reads only some kinds.
  const reads = source.kind === "github" ? githubReads(source.config) : null;
  const attention = source.status === "needs_attention";
  // An Uploads source with nothing in it yet points to its own Upload files (qa-onboarding-24).
  const emptyUpload = source.kind === "upload" && source.item_count === 0 && !source.last_synced_at;
  // A sync that stopped part way (a rate limit) kept what it stored: say so, never "never synced".
  const synced = source.partly_synced_at
    ? `partly synced ${formatDateTime(source.partly_synced_at)} · resumes on the next sync`
    : source.last_synced_at
      ? `last ${source.kind === "upload" ? "upload" : "sync"} ${formatDateTime(source.last_synced_at)}`
      : "never synced";

  return (
    <li
      ref={rowRef}
      className="border-t border-line px-4 py-2.5 first:border-t-0 max-[600px]:px-3"
      id={`source-${source.id}`}
      data-testid="source-card"
      aria-label={source.name}
    >
      <div className="flex min-h-9 flex-wrap items-center gap-x-2.5 gap-y-2">
        <span className="flex min-w-0 flex-1 basis-56 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 max-w-full truncate font-semibold" title={source.name}>
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
          {/* Where it reads, without the address: only when an owner set another endpoint (qa-settings-25). */}
          {source.kind === "fireflies" && connection?.endpoint_url && connection.endpoint_url !== FIREFLIES_API && (
            <span className="min-w-0 max-w-full truncate text-sm text-text2" title={connection.endpoint_url}>
              Reads an endpoint an owner set
            </span>
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
                ? [
                    {
                      label: drive
                        ? editing
                          ? "Close files and folders"
                          : "Edit files and folders"
                        : `${editing ? "Close" : "Edit"} ${allowlist.noun}`,
                      onSelect: () => setEditing((v) => !v),
                    },
                  ]
                : []),
              ...(fireflies
                ? [{ label: editing ? "Close meetings" : "Edit meetings", onSelect: () => setEditing((v) => !v) }]
                : []),
              // What Oracle read from it, left out and uses (A2).
              { label: "Coverage", onSelect: () => router.push(`/sources?source=${source.id}`) },
              { label: "Delete", onSelect: () => void remove(), danger: true },
            ]}
          />
        </span>
      </div>
      <div className="tnum mt-0.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-sm text-text2">
        {emptyUpload ? (
          <span data-testid="source-items">No items yet — upload files to add some</span>
        ) : (
          <>
            <span data-testid="source-items">{source.item_count ? count(source.item_count, "item") : "No items yet"}</span>
            <span data-testid="source-synced">{synced}</span>
          </>
        )}
        {fireflies && (
          <span className="flex min-w-0 max-w-full items-center gap-1.5" data-testid="fireflies-included">
            <Label className="flex-none">{fireflies.titleRule ? "Title rule" : "Meetings"}</Label>
            <span className="min-w-0 truncate text-text">
              {fireflies.titleRule
                ? [fireflies.titleRule.join(", "), firefliesRange(fireflies.value)].filter(Boolean).join(", ")
                : firefliesSummary(fireflies.value)}
            </span>
          </span>
        )}
        {allowlist && (items.length + unnamed > 0 || folders.text === "") && !(source.kind === "github" && items.length > 0) && (
          <span className="flex min-w-0 max-w-full items-center gap-1.5">
            <Label className="flex-none">{allowlist.label}</Label>
            <span className="min-w-0 truncate text-text" title={picks.title} data-testid="source-picks">
              {/* A Slack source reads nothing until it has a channel (qa-onboarding-4). */}
              {picks.text || (source.kind === "slack" ? "Pick channels to read" : "none yet")}
            </span>
          </span>
        )}
        {reads && (
          <span className="flex min-w-0 max-w-full items-center gap-1.5" data-testid="github-include">
            <Label className="flex-none">Reads</Label>
            <span className="min-w-0 truncate text-text" title={reads}>
              {reads}
            </span>
          </span>
        )}
        {folders.text && (
          <span className="flex min-w-0 max-w-full items-center gap-1.5">
            <Label className="flex-none">Folders</Label>
            <span className="min-w-0 truncate text-text" title={folders.title} data-testid="source-folders">
              {folders.text}
            </span>
          </span>
        )}
      </div>
      {source.kind === "github" && <CodeMaps source={source} />}
      {source.reconnect_reason && <ReconnectToChoose className="mt-2" />}
      {drive && <DriveNotes notes={unavailable} picked={picked} sourceName={source.name} />}
      {!drive && unavailable.length > 0 && (
        // What was left out and why, and what to do about it (qa-settings-25).
        <ul aria-label={`Sync notes for ${source.name}`} className="mt-2 flex flex-col gap-1">
          {unavailable.map((u) => {
            // qa-work-46: by the name the sync or the picker saved ("#partner-launch"), never its id.
            const name = u.name ?? picked.find((f) => f.id === u.external_id)?.name ?? names[u.external_id] ?? (source.kind === "slack" ? "Unknown channel" : "Unnamed item");
            const skipped = u.status === "skipped";
            const why = u.reason.replace(/^Skipped:\s*/, "");
            return (
              <li
                key={u.external_id}
                aria-label={`${skipped ? "Skipped" : "No access"}: ${name}`}
                className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm"
              >
                <Chip kind={skipped ? "line" : "warn"}>{skipped ? "Skipped" : "No access"}</Chip>
                <span className="min-w-0 truncate font-medium" title={name}>
                  {name}
                </span>
                <span className="min-w-0 text-text2">
                  {skipped
                    ? `— ${why}. Nothing to do: Oracle never reads it.`
                    : source.kind === "slack"
                      ? "— Oracle can’t read it with your account. Rejoin it in Slack, or remove it from this source."
                      : "— Oracle can’t read it with your account. Ask for access again, or remove it from this source."}
                </span>
                <InfoTip label={`why ${name} is ${skipped ? "skipped" : "not read"}`} align="start">
                  {skipped
                    ? source.kind === "slack"
                      ? "A channel shared in from another company is left out on purpose: only the company's own channels are read."
                      : u.reason
                    : `${u.reason}. What was already pulled in from it is kept.`}
                </InfoTip>
                {!skipped && allowlist && !editing && (
                  <Button onClick={() => setEditing(true)} aria-label={`Edit ${allowlist.noun} of ${source.name}`}>
                    Edit {allowlist.noun}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {(source.last_error || notice || error) && (
        <div className="mt-2 flex flex-col gap-2">
          {source.last_error && attention && (
            // Saved before a newer rule it breaks: not synced until edited back within the rules.
            <div
              className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-button bg-warn-bg px-3 py-2 text-sm font-medium text-warn"
              data-testid="needs-attention"
            >
              <span className="flex min-w-0 flex-1 basis-60 items-start gap-2">
                <Icon name="alert" size={16} className="mt-0.5 flex-none" />
                <span className="min-w-0 break-words" data-testid="last-error">
                  {source.last_error}
                </span>
              </span>
              {allowlist && !editing && (
                <Button onClick={() => setEditing(true)} aria-label={`Edit ${source.name}`}>
                  Edit
                </Button>
              )}
            </div>
          )}
          {source.last_error && !attention && (
            <p className="rounded-button bg-crit-bg px-3 py-2 text-sm font-medium text-crit" data-testid="last-error">
              {source.last_error}
            </p>
          )}
          {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
          {error && <Notice tone="error">{error}</Notice>}
        </div>
      )}
      {editing && drive && (
        <DriveFilesEditor
          key={source.config_version}
          source={source}
          connection={connection}
          onReload={onChange}
          onSaved={(s) => {
            onChange(s);
            setEditing(false);
            setNotice({ tone: "pass", text: "Files saved." });
          }}
        />
      )}
      {editing && fireflies && (
        <FirefliesEditor
          key={source.config_version}
          source={source}
          onReload={onChange}
          onSaved={(s) => {
            onChange(s);
            setEditing(false);
            setNotice({ tone: "pass", text: "Meetings saved." });
          }}
        />
      )}
      {editing && allowlist && !drive && (
        <AllowlistEditor
          key={source.config_version}
          source={source}
          onReload={onChange}
          onSaved={(s) => {
            onChange(s);
            setEditing(false);
            const noun = ALLOWLIST[source.kind as ListKind].noun;
            setNotice({ tone: "pass", text: `${noun[0].toUpperCase()}${noun.slice(1)} saved.` });
          }}
        />
      )}
    </li>
  );
}

/** Notion in the PICKER registry: its roots, ticked in the page picker once there is a
 * connection, and their titles (`labels`) for the source's row. */
function NotionSourcePicker({ connectionId, config, onChange }: PickerProps) {
  if (!connectionId) return null;
  return (
    <ChoosePages
      connectionId={connectionId}
      value={notionRoots(config)}
      onChange={(roots) => onChange({ ...config, roots })}
      labels={labelsOf(config)}
      onLabels={(labels) => onChange({ ...config, labels })}
    />
  );
}

/** The Notion page picker under its label: a source's roots, ticked rather than typed. */
function ChoosePages(props: Parameters<typeof NotionPicker>[0]) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5" role="group" aria-label="Choose pages">
      <span className="flex items-center gap-1.5">
        <Label>Choose pages</Label>
        <InfoTip label="choosing pages" align="start">
          Tick the pages and databases to pull in; their sub-pages and databases come with them. Pages no longer under
          your picks are removed as soon as you save.
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
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [picked, setPicked] = useState<Record<string, unknown>>({});
  const [meetings, setMeetings] = useState<FirefliesConfig>(NEW_FIREFLIES);
  const { act, error, busy } = useAction();
  const Picker = PICKER[kind];
  const option = kinds.find((k) => k.kind === kind);
  const usable = (option?.connections ?? []).filter((c) => c.status === "active");
  const needsConnection = kind !== "upload";
  const spec = kind === "upload" || kind === "fireflies" ? null : ALLOWLIST[kind];
  const connectionId = connection || usable[0]?.id || "";
  const chosen = usable.find((c) => c.id === connectionId);
  const drive = kind === "google_docs";
  const reconnect = drive && !!chosen?.reconnect_reason;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const body: Schemas["SourceCreate"] = {
      kind,
      name: name.trim(),
      connection_id: needsConnection ? connectionId : null,
      config:
        kind === "fireflies"
          ? firefliesConfigToSave(meetings)
          : drive
            ? driveConfig({}, files)
            : Picker
              ? picked
              : {},
    };
    const s = await act(() => unwrap(api.POST("/v1/sources", { body })));
    if (s) {
      onAdded(s);
      setName("");
      setFiles([]);
      setPicked({});
      setMeetings(NEW_FIREFLIES);
    }
  }

  // A Slack source reads at least one channel, as the API refuses one without (qa-onboarding-5).
  const noChannels = kind === "slack" && entries(picked, "channels").length === 0;
  // Why Add source is greyed out, next to it (qa-onboarding-17); other blocks say so above.
  const reason = !name.trim()
    ? "Name the source to add it"
    : drive && !reconnect && usable.length > 0 && files.length === 0
      ? "Choose files or folders to add it"
      : kind === "notion" && usable.length > 0 && notionRoots(picked).length === 0
        ? "Tick pages to add it"
        : kind === "fireflies" && usable.length > 0 && !firefliesReady(meetings)
          ? "Pick meetings to add it"
          : noChannels && usable.length > 0
            ? "Pick a channel to add it"
            : null;

  const blocked =
    !option?.connector_available ||
    (needsConnection && usable.length === 0) ||
    (drive && (reconnect || files.length === 0)) ||
    (kind === "fireflies" && !firefliesReady(meetings)) ||
    (kind === "notion" && notionRoots(picked).length === 0) ||
    noChannels;

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" aria-label="Add a source" id="add-source">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-3">
        <Field label="Kind">
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as Kind);
              setConnection("");
              setPicked({});
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
            id="add-source-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder={kind === "upload" ? "Research notes" : `My ${KIND_LABEL[kind]}`}
            className={INPUT}
          />
        </Field>
      </div>
      {needsConnection && usable.length > 0 && (
        <Field label="Connection">
          <select
            value={connectionId}
            onChange={(e) => {
              setConnection(e.target.value);
              // Picks belong to the account they were listed from; the date range stays.
              setPicked((p) => Object.fromEntries(Object.entries(p).filter(([k]) => k !== spec?.key && k !== "labels")));
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
      {option?.connector_available && needsConnection && usable.length === 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Chip kind="warn">No {KIND_LABEL[kind]} account</Chip>
          <LinkButton href="/settings/connections" icon="link">
            Connect your account
          </LinkButton>
        </div>
      )}
      {drive && usable.length > 0 && (
        <DriveFiles
          key={connectionId}
          files={files}
          onChange={setFiles}
          accountHint={chosen?.account_label ?? ""}
          reconnect={reconnect}
        />
      )}
      {kind === "fireflies" && option?.connector_available && usable.length > 0 && connectionId && (
        <FirefliesPicker key={connectionId} connectionId={connectionId} value={meetings} onChange={setMeetings} />
      )}
      {Picker && usable.length > 0 && <Picker key={`${kind}:${connectionId}`} connectionId={connectionId} config={picked} onChange={setPicked} />}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button type="submit" variant="solid" icon="plus" disabled={busy || blocked || !name.trim()}>
          Add source
        </Button>
        {reason && option?.connector_available && !(needsConnection && usable.length === 0) && (
          <span className="text-sm text-text2" data-testid="add-source-reason">
            {reason}
          </span>
        )}
      </div>
    </form>
  );
}

function subscribeHash(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

/** The source named by the URL's #source-<id> (the Inbox's Edit links there), or null. */
function useTargetedSource(): string | null {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash, () => "");
  const m = /^#source-(.+)$/.exec(hash);
  return m ? decodeURIComponent(m[1]) : null;
}

/** The header's Add a source, the page's one way in (qa-onboarding-18): to the form, cursor
 * in its name. On a phone the form sits below the list, so it is scrolled into view. */
function toAddSource() {
  document.getElementById("add-source")?.scrollIntoView({ block: "start", behavior: "smooth" });
  document.getElementById("add-source-name")?.focus({ preventScroll: true });
}

export default function SourceSettingsPage() {
  const sources = useQuery("sources", () => unwrap(api.GET("/v1/sources")));
  const kinds = useQuery("source-kinds", () => unwrap(api.GET("/v1/sources/kinds")));
  const { can } = useMe();
  const list = sources.data ?? [];
  const errors = list.filter((s) => s.status === "error").length;
  const attention = list.filter((s) => s.status === "needs_attention").length;
  const items = list.reduce((n, s) => n + s.item_count, 0);

  const target = useTargetedSource();
  // Opened from Set up's Pick sources with nothing yet (qa-settings-44): straight to the form,
  // which a phone would otherwise show only after the whole page.
  const fromSetup = useSyncExternalStore(
    subscribeHash,
    () => new URLSearchParams(window.location.search).get("from") === "setup" && !window.location.hash,
    () => false,
  );
  const empty = !!sources.data && list.length === 0;
  const ready = !!kinds.data;
  useEffect(() => {
    if (fromSetup && empty && ready) toAddSource();
  }, [fromSetup, empty, ready]);
  const replace = (s: Source) => sources.setData((prev) => (prev ?? []).map((x) => (x.id === s.id ? s : x)));

  const inspector = (
    <Inspector
      eyebrow="Your sources"
      title="New source"
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
        { label: list.length === 1 ? "Source" : "Sources", value: sources.data ? list.length : "—" },
        { label: items === 1 ? "Item" : "Items", value: sources.data ? items : "—" },
        { label: errors === 1 ? "Error" : "Errors", value: sources.data ? errors : "—", tone: errors > 0 ? "crit" : undefined, testId: "stat-errors" },
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
        info={
          <InfoTip label="sources" align="start" side="bottom">
            What your connections pull in. Only you see it; it reaches others only as evidence you add to the baseline.
          </InfoTip>
        }
        status={
          <>
            {errors > 0 && (
              <Chip kind="crit" dot>
                {errors} in error
              </Chip>
            )}
            {attention > 0 && (
              <Chip kind="warn" dot data-testid="sources-attention">
                {attention} need{attention === 1 ? "s" : ""} attention
              </Chip>
            )}
          </>
        }
        action={
          // Adding a source is this page's main act (qa-settings-27); searching is next to it.
          <span className="flex flex-wrap items-center gap-2">
            <LinkButton variant="ghost" icon="search" href="/sources">
              Search sources
            </LinkButton>
            <Button variant="primary" icon="plus" onClick={toAddSource}>
              Add a source
            </Button>
          </span>
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
          {sources.data && list.length === 0 && (
            <div className="flex flex-col items-center gap-3 px-4 py-8 text-center" data-testid="sources-empty">
              {/* Just words: the header's Add a source is the one way in (qa-onboarding-18). */}
              <p className="text-[15px] text-text2">No sources yet. Add one with Add a source to give Oracle something to read.</p>
            </div>
          )}
          {list.length > 0 && (
            <ul aria-label="My sources" className="flex flex-col">
              {list.map((s) => (
                <SourceRow
                  key={s.id}
                  source={s}
                  connection={kinds.data?.flatMap((k) => k.connections).find((c) => c.id === s.connection_id)}
                  onChange={replace}
                  targeted={s.id === target}
                  onDelete={() => sources.setData((prev) => (prev ?? []).filter((x) => x.id !== s.id))}
                />
              ))}
            </ul>
          )}
        </Panel>
        {can("put_setting") && <CompanyDriveSettings />}
        {can("put_setting") && <CodeMapRefreshSetting />}
      </Split>
    </>
  );
}
