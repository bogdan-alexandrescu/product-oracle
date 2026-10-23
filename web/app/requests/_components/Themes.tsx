"use client";

import { useState, type FormEvent } from "react";

import { Button, Chip, Empty } from "@/components/ds";
import { ErrorNote, INPUT } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useMe } from "@/lib/me";
import { errorMessage } from "@/lib/use-query";

type Theme = Schemas["RequestThemeOut"];

/**
 * The Themes tab (#348): every theme, archived ones last, with how many requests it holds.
 * Approvers and owners create, rename, archive and restore them; others only read.
 * Every change hands the saved theme to `onChange`.
 */
export function Themes({ themes, onChange }: { themes: Theme[]; onChange: (theme: Theme) => void }) {
  const { can } = useMe();
  // #370: the theme routes' own role decides who creates, renames and archives.
  const canCreate = can("create_request_theme");
  const approver = can("update_request_theme");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(call: () => Promise<Theme>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      onChange(await call());
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  }
  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => unwrap(api.POST("/v1/request-themes", { body: { title: title.trim(), goal_ids: [] } })))) setTitle("");
  };
  const sorted = [...themes].sort((a, b) => Number(a.archived) - Number(b.archived));

  return (
    <div className="flex flex-col">
      {canCreate && (
        <form className="flex flex-wrap items-end gap-2 border-b border-line px-4 py-3" onSubmit={create}>
          <label className="flex min-w-0 flex-1 basis-56 flex-col gap-1 text-sm font-semibold text-text2">
            New theme
            <input className={INPUT} value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <Button variant="solid" type="submit" disabled={busy || !title.trim()}>
            Create theme
          </Button>
        </form>
      )}
      {error && (
        <div className="px-4 pt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      {sorted.length === 0 ? (
        <Empty>No themes yet</Empty>
      ) : (
        <ul className="divide-y divide-line">
          {sorted.map((t) => (
            <ThemeRow key={t.id} theme={t} canChange={approver} busy={busy} run={run} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ThemeRow({
  theme,
  canChange,
  busy,
  run,
}: {
  theme: Theme;
  canChange: boolean;
  busy: boolean;
  run: (call: () => Promise<Theme>) => Promise<boolean>;
}) {
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(theme.title);
  const patch = (body: Omit<Schemas["RequestThemePatch"], "lock_version">) =>
    run(() =>
      unwrap(api.PATCH("/v1/request-themes/{theme_id}", { params: { path: { theme_id: theme.id } }, body: { lock_version: theme.lock_version, ...body } })),
    );
  const rename = async (e: FormEvent) => {
    e.preventDefault();
    if (await patch({ title: title.trim() })) setRenaming(false);
  };
  return (
    <li data-testid="theme-row" className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3">
      {renaming ? (
        <form className="flex min-w-0 flex-1 basis-64 flex-wrap items-end gap-2" onSubmit={rename}>
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm font-semibold text-text2">
            Theme title
            <input className={INPUT} value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <Button variant="ghost" onClick={() => setRenaming(false)}>
            Cancel
          </Button>
          <Button variant="solid" type="submit" disabled={busy || !title.trim()}>
            Save
          </Button>
        </form>
      ) : (
        <span className={`min-w-0 flex-1 basis-64 truncate text-[15px] font-semibold ${theme.archived ? "text-text2" : ""}`}>{theme.title}</span>
      )}
      <span className="flex flex-wrap items-center gap-2 text-sm text-text2">
        {theme.archived && <Chip kind="na">Archived</Chip>}
        {theme.origin === "oracle" && <Chip kind="line">From Oracle</Chip>}
        <span className="tnum">
          {theme.request_count} {theme.request_count === 1 ? "request" : "requests"}
        </span>
        {canChange && !renaming && (
          <>
            {!theme.archived && (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setTitle(theme.title);
                  setRenaming(true);
                }}
              >
                Rename
              </Button>
            )}
            <Button variant="ghost" disabled={busy} onClick={() => patch({ archived: !theme.archived })}>
              {theme.archived ? "Restore" : "Archive"}
            </Button>
          </>
        )}
      </span>
    </li>
  );
}
