"use client";

import { useEffect, useId, useRef, useState } from "react";

import { Button, Chip, Icon, InfoTip, LinkButton, Notice } from "@/components/ds";
import { api, unwrap } from "@/lib/api/client";
import { chooseFromDrive, preloadDrivePicker, type PickerConfig } from "@/lib/google-picker";
import { errorMessage } from "@/lib/use-query";

import { TEXTAREA } from "../_components/fields";

/** One picked Drive file, as the source config keeps it: `docs` ids plus `names`. */
export interface DriveFile {
  id: string;
  name: string;
}

export const RECONNECT_TO_CHOOSE_FILES = "Reconnect to choose files";

/** The picked files in a Google Docs source config. */
export function driveFiles(config: Record<string, unknown>): DriveFile[] {
  const ids = Array.isArray(config.docs) ? config.docs.map(String) : [];
  const names = (config.names && typeof config.names === "object" ? config.names : {}) as Record<string, unknown>;
  return ids.map((id) => ({ id, name: typeof names[id] === "string" ? (names[id] as string) : id }));
}

/** The config to save for `files`. Legacy folders are dropped once files can be picked. */
export function driveConfig(config: Record<string, unknown>, files: DriveFile[], keepFolders: boolean) {
  const next: Record<string, unknown> = {
    ...config,
    docs: files.map((f) => f.id),
    names: Object.fromEntries(files.filter((f) => f.name !== f.id).map((f) => [f.id, f.name])),
  };
  if (!keepFolders) delete next.folders;
  return next;
}

function merge(list: DriveFile[], more: DriveFile[]): DriveFile[] {
  const seen = new Set(list.map((f) => f.id));
  return [...list, ...more.filter((f) => !seen.has(f.id) && seen.add(f.id))];
}

/** "Reconnect to choose files": the Google grant predates the Drive picker (no drive.file). */
export function ReconnectToChoose({ className = "" }: { className?: string }) {
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`} data-testid="reconnect-to-choose">
      <Chip kind="warn" dot>
        {RECONNECT_TO_CHOOSE_FILES}
      </Chip>
      <InfoTip label="reconnecting Google" align="start">
        Oracle now reads only the Google Docs you choose from Drive. Reconnect Google once, then choose the files.
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
 * The picked-files list of a Google Docs source: "Choose files from Drive" opens Google's
 * Drive picker; each picked file shows with its icon, name and type, and can be removed.
 * "Paste ids" is the fallback for ids copied from Drive links.
 */
export function DriveFiles({
  files,
  onChange,
  accountHint,
  reconnect,
  unavailable = {},
  autoOpen = false,
}: {
  files: DriveFile[];
  onChange: (files: DriveFile[]) => void;
  /** The Google account to pick from (the connection's email). */
  accountHint: string;
  /** The connection lacks drive.file: show the reconnect state instead of the picker. */
  reconnect: boolean;
  /** Picked files the last sync could not read: id -> reason. */
  unavailable?: Record<string, string>;
  /** Open the picker at once (editing a source). */
  autoOpen?: boolean;
}) {
  const pasteId = useId();
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const opened = useRef(false);
  const latest = useRef(files);
  useEffect(() => {
    latest.current = files;
  }, [files]);

  useEffect(() => {
    if (reconnect) return;
    // Load Google's scripts ahead of the click, so its sign-in popup opens on the click.
    pickerConfig().then(preloadDrivePicker, () => undefined);
  }, [reconnect]);

  async function choose() {
    setBusy(true);
    setError(null);
    try {
      const picked = await chooseFromDrive(await pickerConfig(), accountHint);
      if (picked?.length) onChange(merge(latest.current, picked));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (autoOpen && !reconnect && !opened.current) {
      opened.current = true;
      void choose();
    }
    // Runs once, when the editor opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpen, reconnect]);

  function addPasted() {
    const ids = [...new Set(pasted.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
    onChange(merge(files, ids.map((id) => ({ id, name: id }))));
    setPasted("");
    setPasting(false);
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {reconnect ? (
        <ReconnectToChoose />
      ) : (
        <div className="flex flex-wrap items-center gap-1">
          <Button variant="solid" icon="doc" onClick={choose} disabled={busy}>
            {busy ? "Opening Drive…" : "Choose files from Drive"}
          </Button>
          <InfoTip label="choosing files" align="start">
            Oracle reads only the Google Docs you choose here. Open folders to find files; folders themselves cannot be
            chosen.
          </InfoTip>
        </div>
      )}
      {files.length > 0 && (
        <ul aria-label="Picked files" className="flex flex-col rounded-button border border-line bg-surface">
          {files.map((f) => (
            <li
              key={f.id}
              aria-label={f.name}
              className="flex min-h-12 items-center gap-2.5 border-t border-line px-3 py-1.5 first:border-t-0"
            >
              <span className="grid size-7 flex-none place-items-center rounded-lg bg-accent-soft text-accent-ink">
                <Icon name="doc" size={16} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[15px] font-medium" title={f.name === f.id ? f.id : `${f.name} (${f.id})`}>
                  {f.name}
                </span>
                <span className="text-[13px] leading-4 text-text2">{f.name === f.id ? "Drive id" : "Google Doc"}</span>
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
