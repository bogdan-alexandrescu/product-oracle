"use client";

import { useEffect, useId, useRef, useState } from "react";

import { Button, Chip, Icon, InfoTip, LinkButton, Notice } from "@/components/ds";
import { api, unwrap } from "@/lib/api/client";
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

/** The config to save for `files`: `docs`, `folders` (when any) and their `names`. */
export function driveConfig(config: Record<string, unknown>, files: DriveFile[]) {
  const folders = files.filter((f) => f.kind === "folder").map((f) => f.id);
  const next: Record<string, unknown> = {
    ...config,
    docs: files.filter((f) => f.kind === "doc").map((f) => f.id),
    folders,
    names: Object.fromEntries(files.filter((f) => f.name !== f.id).map((f) => [f.id, f.name])),
  };
  if (folders.length === 0) delete next.folders;
  return next;
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
    const pastedIds = [...new Set(pasted.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
    onChange(merge(files, pastedIds.map((id) => ({ id, name: id, kind: "doc" as const }))));
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
            Removing one deletes what came from it on the next sync.
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
                  No access
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
