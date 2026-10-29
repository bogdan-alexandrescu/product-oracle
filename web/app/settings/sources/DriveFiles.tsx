"use client";

import { useEffect, useId, useRef, useState } from "react";

import { Button, Chip, Icon, InfoTip, LinkButton, Notice } from "@/components/ds";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { chooseFromDrive, drivePickerReady, preloadDrivePicker, type PickerConfig } from "@/lib/google-picker";
import { errorMessage } from "@/lib/use-query";

import { TEXTAREA } from "../_components/fields";

/** One picked Drive item, as the source config keeps it: `docs` or `folders` ids plus `names`. */
export interface DriveFile {
  id: string;
  name: string;
  kind: "doc" | "folder";
}

export const RECONNECT_TO_CHOOSE_FILES = "Reconnect to choose files";
/** What Oracle can read through a Google connection, said plainly (S5, 'Drive folders'). */
export const DRIVE_ACCESS = "Oracle can read your Drive; it pulls in only the files and folders you choose here.";

function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

/** The picked folders and files in a Google Docs source config, folders first. */
export function driveFiles(config: Record<string, unknown>): DriveFile[] {
  const names = (config.names && typeof config.names === "object" ? config.names : {}) as Record<string, unknown>;
  const name = (id: string) => (typeof names[id] === "string" ? (names[id] as string) : id);
  return [
    ...ids(config.folders).map((id) => ({ id, name: name(id), kind: "folder" as const })),
    ...ids(config.docs).map((id) => ({ id, name: name(id), kind: "doc" as const })),
  ];
}

/** The longest display name the API keeps for a picked item (config `names`). */
export const MAX_NAME = 500;

/** The config to save for `files`: `docs`, `folders` (when any) and their `names`. */
export function driveConfig(config: Record<string, unknown>, files: DriveFile[]) {
  const folders = files.filter((f) => f.kind === "folder").map((f) => f.id);
  const next: Record<string, unknown> = {
    ...config,
    docs: files.filter((f) => f.kind === "doc").map((f) => f.id),
    folders,
    names: Object.fromEntries(files.filter((f) => f.name !== f.id).map((f) => [f.id, f.name.slice(0, MAX_NAME)])),
  };
  if (folders.length === 0) delete next.folders;
  return next;
}

/** What a Drive file id looks like; the API refuses anything else (and "root"). */
export const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/;

/** A pasted id, or the id in a pasted Drive link (/d/<id>, /folders/<id>, ?id=<id>). */
export function pastedFile(text: string): DriveFile | null {
  const folder = text.match(/\/folders\/([A-Za-z0-9_-]+)/);
  const doc = text.match(/\/d\/([A-Za-z0-9_-]+)/) ?? text.match(/[?&]id=([A-Za-z0-9_-]+)/);
  const id = folder?.[1] ?? doc?.[1] ?? text;
  if (!DRIVE_ID.test(id) || id.toLowerCase() === "root") return null;
  return { id, name: id, kind: folder ? "folder" : "doc" };
}

function merge(list: DriveFile[], more: DriveFile[]): DriveFile[] {
  const seen = new Set(list.map((f) => f.id));
  return [...list, ...more.filter((f) => !seen.has(f.id) && seen.add(f.id))];
}

/** "Reconnect to choose files": the Google grant lacks drive.readonly, so folders cannot be read. */
export function ReconnectToChoose({ className = "" }: { className?: string }) {
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`} data-testid="reconnect-to-choose">
      <Chip kind="warn" dot>
        {RECONNECT_TO_CHOOSE_FILES}
      </Chip>
      <InfoTip label="reconnecting Google" align="start">
        This Google sign-in cannot read folders. Reconnect Google once, then choose files and folders. {DRIVE_ACCESS}
      </InfoTip>
      <LinkButton href="/settings/connections" icon="link">
        Reconnect
      </LinkButton>
    </div>
  );
}

let configPromise: Promise<PickerConfig> | null = null;

function pickerConfig(): Promise<PickerConfig> {
  configPromise ??= unwrap(api.GET("/v1/connections/google/picker-config")).catch((e) => {
    configPromise = null;
    throw e;
  });
  return configPromise;
}

/**
 * The picked folders and files of a Google Docs source: "Choose from Drive" opens Google's
 * Drive picker (Google Docs and folders); each picked item shows with its icon, name and
 * type, and can be removed. "Paste ids" is the fallback for doc ids copied from Drive links.
 *
 * Google's scripts and the picker config load when this shows; the button waits for them,
 * so the click itself opens Google's sign-in popup (popup blockers allow only that).
 */
export function DriveFiles({
  files,
  onChange,
  accountHint,
  reconnect,
  unavailable = {},
}: {
  files: DriveFile[];
  onChange: (files: DriveFile[]) => void;
  /** The Google account to pick from (the connection's email). */
  accountHint: string;
  /** The connection lacks drive.readonly: show the reconnect state instead of the picker. */
  reconnect: boolean;
  /** Picked files the last sync could not read: id -> reason. */
  unavailable?: Record<string, string>;
}) {
  const pasteId = useId();
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [config, setConfig] = useState<PickerConfig | null>(null);
  const latest = useRef(files);
  useEffect(() => {
    latest.current = files;
  }, [files]);

  useEffect(() => {
    if (reconnect) return;
    let live = true;
    pickerConfig()
      .then(async (c) => {
        await preloadDrivePicker();
        if (live) setConfig(c);
      })
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [reconnect]);

  function choose() {
    if (!config || !drivePickerReady()) return;
    setError(null);
    setBusy(true);
    // No await before this: it opens Google's sign-in popup on the click.
    chooseFromDrive(config, accountHint)
      .then((picked) => {
        if (picked?.length) onChange(merge(latest.current, picked));
      })
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  }

  function addPasted() {
    const parts = [...new Set(pasted.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
    const found = parts.map(pastedFile);
    const bad = parts.filter((_, i) => !found[i]);
    onChange(merge(files, found.filter((f): f is DriveFile => f !== null)));
    if (bad.length) {
      setPasted(bad.join("\n"));
      setError(`Not a Drive file or folder id: ${bad.join(", ")}`);
      return;
    }
    setError(null);
    setPasted("");
    setPasting(false);
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {reconnect ? (
        <ReconnectToChoose />
      ) : (
        <div className="flex flex-wrap items-center gap-1">
          <Button variant="solid" icon="doc" onClick={choose} disabled={busy || !config}>
            {busy ? "Opening Drive…" : config ? "Choose from Drive" : "Loading Drive…"}
          </Button>
          <InfoTip label="choosing from Drive" align="start">
            {DRIVE_ACCESS} Choose Google Docs, or a folder to bring in every doc in it, including docs added to it later.
            Removing one hides what came from it when you save.
          </InfoTip>
        </div>
      )}
      {files.length > 0 && (
        <ul aria-label="Picked files and folders" className="flex flex-col rounded-button border border-line bg-surface">
          {files.map((f) => (
            <li
              key={f.id}
              aria-label={f.name}
              className="flex min-h-12 items-center gap-2.5 border-t border-line px-3 py-1.5 first:border-t-0"
            >
              <span className="grid size-7 flex-none place-items-center rounded-lg bg-accent-soft text-accent-ink">
                <Icon name={f.kind === "folder" ? "folder" : "doc"} size={16} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[15px] font-medium" title={f.name === f.id ? f.id : `${f.name} (${f.id})`}>
                  {f.name}
                </span>
                <span className="text-[13px] leading-4 text-text2">
                  {f.kind === "folder"
                    ? "Folder · every doc in it"
                    : f.name === f.id
                      ? "Drive id"
                      : "Google Doc"}
                </span>
              </span>
              {unavailable[f.id] && (
                <Chip kind="warn" title={unavailable[f.id]}>
                  {noAccessLabel(unavailable[f.id])}
                </Chip>
              )}
              <button
                type="button"
                aria-label={`Remove ${f.name}`}
                onClick={() => onChange(files.filter((x) => x.id !== f.id))}
                className="grid size-8 flex-none place-items-center rounded-lg text-text2 hover:bg-surface2 hover:text-text"
              >
                <Icon name="x" size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {pasting ? (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={pasteId} className="text-[13px] leading-4 font-semibold tracking-[0.02em] text-text2">
            Drive file ids
          </label>
          <span className="text-[13px] leading-4 text-text2">Ids or links copied from Drive, one per line.</span>
          <textarea
            id={pasteId}
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            rows={2}
            placeholder="1AbC…"
            className={`${TEXTAREA} font-mono`}
          />
          <div className="flex items-center gap-1">
            <Button onClick={addPasted} disabled={!pasted.trim()}>
              Add ids
            </Button>
            <Button variant="ghost" onClick={() => setPasting(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button variant="ghost" className="-ml-2.5" onClick={() => setPasting(true)}>
            Paste ids
          </Button>
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}

type SourceNote = Schemas["UnavailableItem"];

/** The chip for an item the last sync could not read. */
function noAccessLabel(reason: string): string {
  if (reason.startsWith("Lost access")) return "Lost access";
  if (reason.startsWith("In the trash")) return "In the trash";
  if (reason.startsWith("Not a")) return reason;
  if (reason.startsWith("Not picked")) return "Not picked";
  return "No access";
}

/** Why docs in a picked folder were skipped, for the chip's title. */
function skippedTitle(reason: string): string {
  if (/shared drive/i.test(reason)) {
    return "Docs in a picked folder in a shared drive that is not on the company list (Settings › Sources › Google Drive) are not pulled in";
  }
  if (/domain not set/i.test(reason)) {
    return "No company email domain is set (Settings › Sources › Google Drive), so docs in picked folders are not pulled in";
  }
  return "Docs in a picked folder whose owner is outside the company are not pulled in";
}

/** Up to `shown` names, then "+N more"; every name is in the title. */
function NameList({ names, shown = 4 }: { names: string[]; shown?: number }) {
  const rest = names.length - shown;
  return (
    <span className="min-w-0 truncate text-text max-[600px]:whitespace-normal" title={names.join(", ")}>
      {names.slice(0, shown).join(", ")}
      {rest > 0 && <span className="text-text2">{` +${rest} more`}</span>}
    </span>
  );
}

/**
 * What the last sync of a Google Docs source reported, on its card: picked docs and folders
 * it cannot read ("Lost access to <folder>": a folder's docs are hidden until Oracle can
 * read it again, owner 2026-10-20), docs in a picked folder it
 * left out (owned outside the company, in a shared drive outside the company, or no company
 * domain set; count and names per reason), docs it pulled in
 * with that warning, and a folder listing that stopped at the source's cap.
 */
export function DriveNotes({
  notes,
  picked,
  sourceName,
}: {
  notes: SourceNote[];
  picked: DriveFile[];
  sourceName: string;
}) {
  const byId = new Map(picked.map((f) => [f.id, f]));
  const nameOf = (n: SourceNote) => byId.get(n.external_id)?.name ?? n.name ?? n.external_id;
  const unreadable = notes.filter((n) => (n.status ?? "unavailable") === "unavailable");
  const limited = notes.filter((n) => n.status === "limited");
  const groups = (status: "skipped" | "flagged") => {
    const out = new Map<string, string[]>();
    for (const n of notes.filter((x) => x.status === status)) out.set(n.reason, [...(out.get(n.reason) ?? []), nameOf(n)]);
    return [...out.entries()];
  };
  const skipped = groups("skipped");
  const flagged = groups("flagged");
  if (!notes.length) return null;
  return (
    <ul aria-label={`Sync notes for ${sourceName}`} className="mt-2 flex flex-col gap-1.5" data-testid="drive-notes">
      {unreadable.map((n) => {
        const folder = byId.get(n.external_id)?.kind === "folder";
        const label = noAccessLabel(n.reason);
        const lost = label === "Lost access";
        return (
          <li
            key={n.external_id}
            aria-label={lost ? `Lost access to ${nameOf(n)}` : `${label}: ${nameOf(n)}`}
            className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm"
          >
            <Chip kind="warn" title={n.reason}>
              {label}
            </Chip>
            {lost && <span className="text-text2">to</span>}
            <span className="flex min-w-0 items-center gap-1.5">
              <Icon name={folder ? "folder" : "doc"} size={16} className="flex-none text-text2" />
              <span className="min-w-0 truncate font-medium" title={`${nameOf(n)}: ${n.reason}`}>
                {nameOf(n)}
              </span>
            </span>
            {folder && <span className="text-text2">— its docs are hidden until Oracle can read it again</span>}
          </li>
        );
      })}
      {skipped.map(([reason, names]) => (
        <li key={reason} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
          {/* A short "Skipped" chip that never wraps, then why in plain text (qa-settings-45). */}
          <Chip kind="line" title={skippedTitle(reason)}>
            Skipped
          </Chip>
          <span className="min-w-0 text-text2">{reason.replace(/^Skipped:\s*/, "")}</span>
          <span className="tnum flex-none font-medium">{names.length === 1 ? "1 doc" : `${names.length} docs`}</span>
          <NameList names={names} />
        </li>
      ))}
      {flagged.map(([reason, names]) => (
        <li key={reason} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
          <Chip kind="warn" title="Pulled in, but owned outside the company">
            {reason}
          </Chip>
          <span className="tnum flex-none font-medium">{names.length === 1 ? "1 doc" : `${names.length} docs`}</span>
          <NameList names={names} />
        </li>
      ))}
      {limited.map((n) => (
        <li key={`limit-${n.external_id}`} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
          <Chip kind="warn">Capped</Chip>
          <span className="min-w-0 text-text2">
            <span className="font-medium text-text">{nameOf(n)}</span>: {n.reason}
          </span>
        </li>
      ))}
    </ul>
  );
}
