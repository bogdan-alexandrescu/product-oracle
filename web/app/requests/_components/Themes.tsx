"use client";

import { useState, type FormEvent } from "react";

import { Button, Chip, Empty } from "@/components/ds";
import { ErrorNote, INPUT } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useMe } from "@/lib/me";
import { errorMessage } from "@/lib/use-query";

type Theme = Schemas["RequestThemeOut"];

/**
 * The Themes tab (#348): every theme, archived ones last, with how many requests it holds.
 * Approvers and owners create, rename, archive and restore them; others only read.
 * Each theme shows its problem (H10): Oracle's suggestion to Confirm, Edit or Dismiss, or the
 * confirmed problem with its definition of success, which replies and agents cite.
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
            <li key={t.id} data-testid="theme-row" className="flex flex-col gap-2 px-4 py-3">
              <ThemeRow theme={t} canChange={approver} busy={busy} run={run} />
              {(t.problem_state !== "none" || t.problem) && <ProblemBlock theme={t} canChange={can("confirm_request_theme_problem")} onChange={onChange} />}
            </li>
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
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
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
          {plural(theme.request_count, "request")}
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
    </div>
  );
}

const PROBLEM_FIELDS = [
  { key: "problem", label: "The problem", hint: "Who has it, what they are trying to do, what stops them", max: 1000 },
  { key: "success", label: "How we would know it is solved", hint: null, max: 500 },
  { key: "constraints", label: "Limits set by others", hint: "Legal, finance, sales", max: 500 },
] as const;

/**
 * A theme's problem (H10): Oracle's suggestion, marked, with Confirm, Edit and Dismiss, or
 * the confirmed problem with Edit, for approvers and owners; others read it. Shared by the
 * Themes tab and the request inspector.
 */
export function ProblemBlock({ theme, canChange, onChange }: { theme: Theme; canChange: boolean; onChange: (theme: Theme) => void }) {
  const suggested = theme.problem_state === "suggested" && theme.problem_suggestion ? theme.problem_suggestion : null;
  const shown = suggested ?? { problem: theme.problem, success: theme.success, constraints: theme.constraints };
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ problem: "", success: "", constraints: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = { params: { path: { theme_id: theme.id } } };
  async function run(call: () => Promise<Theme>) {
    setBusy(true);
    setError(null);
    try {
      onChange(await call());
      setEditing(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  const save = (e: FormEvent) => {
    e.preventDefault();
    run(() =>
      unwrap(
        api.PATCH("/v1/request-themes/{theme_id}", {
          ...path,
          body: { lock_version: theme.lock_version, problem: draft.problem.trim() || null, success: draft.success.trim() || null, constraints: draft.constraints.trim() || null },
        }),
      ),
    );
  };
  if (editing) {
    return (
      <form data-testid="theme-problem" className="flex flex-col gap-2" onSubmit={save}>
        {PROBLEM_FIELDS.map((f) => (
          <label key={f.key} className="flex flex-col gap-1 text-sm font-semibold text-text2">
            {f.label}
            {f.hint && <span className="font-normal">{f.hint}</span>}
            <textarea className={INPUT} rows={f.key === "problem" ? 3 : 2} maxLength={f.max} value={draft[f.key]} onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))} />
          </label>
        ))}
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <Button variant="solid" type="submit" disabled={busy || !draft.problem.trim()}>
            Save problem
          </Button>
        </div>
      </form>
    );
  }
  return (
    <div data-testid="theme-problem" className="flex min-w-0 flex-col gap-1.5 text-[15px]">
      {suggested && <p className="text-sm font-semibold text-text2">Oracle suggests this problem</p>}
      <dl className="flex min-w-0 flex-col gap-1.5">
        {PROBLEM_FIELDS.filter((f) => shown[f.key]).map((f) => (
          <div key={f.key} className="min-w-0">
            <dt className="text-sm font-semibold text-text2">{f.label}</dt>
            <dd className="break-words whitespace-pre-wrap">{shown[f.key]}</dd>
          </div>
        ))}
      </dl>
      {error && <ErrorNote>{error}</ErrorNote>}
      {canChange && (
        <div className="flex flex-wrap gap-2">
          {suggested && (
            <Button
              variant="solid"
              disabled={busy}
              onClick={() => run(() => unwrap(api.POST("/v1/request-themes/{theme_id}/problem/confirm", { ...path, body: { lock_version: theme.lock_version } })))}
            >
              Confirm
            </Button>
          )}
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setDraft({ problem: shown.problem ?? "", success: shown.success ?? "", constraints: shown.constraints ?? "" });
              setEditing(true);
            }}
          >
            Edit
          </Button>
          {suggested && (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => run(() => unwrap(api.POST("/v1/request-themes/{theme_id}/problem/dismiss", { ...path, body: { lock_version: theme.lock_version } })))}
            >
              Dismiss
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
