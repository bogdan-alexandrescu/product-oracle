"use client";

import { useId, useMemo, useState, type FormEvent } from "react";

import { ConfidenceBadge, DEFAULT_LOW, sourceKindLabel } from "@/app/baseline/_components/common";
import { Button, ErrorNote, INPUT } from "@/components/ui";
import { api, ApiError, type EntityOut, type LinkPreviewOut } from "@/lib/api/client";
import { formatDate } from "@/lib/format";
import { useAuthRedirect } from "@/lib/use-query";

type Target = { entity_id: string } | { edge_id: string };

const FACTOR_LABEL: Record<string, string> = {
  source: "Source",
  freshness: "Freshness",
  mentions: "Mentions",
  goal_impact: "Goal impact",
};

/** The API's own words for a refused link ("This link is not public: …"), else the status. */
function linkError(error: unknown, status: number): string {
  if (error && typeof error === "object" && "detail" in error && typeof error.detail === "string") {
    return error.detail;
  }
  if (status === 403) return "You need the commenter role to add evidence.";
  return `Could not fetch the link (${status}).`;
}

/**
 * "Add evidence link": a commenter (or anyone above) pastes a public link (a public
 * Notion page, a Google Doc shared with anyone with the link, a public web page), sees
 * the page's title, excerpt and confidence, then saves it as evidence. Oracle fetches
 * the page without any account, so the saved evidence is visible to everyone.
 *
 * Give `target` to cite on a known entity or edge (the Baseline drawer), or `entities`
 * to let the person pick a baseline item (a document section).
 */
export function AddEvidenceLink({
  target,
  entities,
  suggested,
  context,
  low = DEFAULT_LOW,
  quiet = false,
  onSaved,
}: {
  target?: Target;
  entities?: EntityOut[];
  /** Entity preselected in the picker (e.g. one named in the section heading). */
  suggested?: string | null;
  /** Shown in the button's accessible name, e.g. the section heading. */
  context?: string;
  low?: number;
  /** A quieter button, for places that repeat it (every document section). */
  quiet?: boolean;
  onSaved?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const [picked, setPicked] = useState<string>(suggested ?? "");
  const [preview, setPreview] = useState<LinkPreviewOut | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const onAuth = useAuthRedirect();
  const ids = { url: useId(), note: useId(), target: useId() };

  const choices = useMemo(
    () =>
      [...(entities ?? [])]
        .filter((e) => e.status !== "rejected")
        .sort((a, b) => a.type.localeCompare(b.type) || a.title.localeCompare(b.title)),
    [entities],
  );
  const chosen: Target | null = target ?? (picked ? { entity_id: picked } : null);

  function reset() {
    setUrl("");
    setNote("");
    setPreview(null);
    setError(null);
  }

  async function call<T>(run: () => Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T | null> {
    setBusy(true);
    setError(null);
    try {
      const { data, error: err, response } = await run();
      if (response.ok) return data as T;
      if (response.status === 401) {
        onAuth(new ApiError(401, "Your session has expired. Sign in again."));
        return null;
      }
      setError(linkError(err, response.status));
      return null;
    } catch {
      setError("Cannot reach the API.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function fetchPreview(e?: FormEvent) {
    e?.preventDefault();
    setSaved(null);
    if (!chosen) {
      setError("Pick the baseline item this link supports.");
      return;
    }
    if (!url.trim()) {
      setError("Paste a link first.");
      return;
    }
    setPreview(null);
    const out = await call(() => api.POST("/v1/baseline/evidence/link/preview", { body: { ...chosen, url: url.trim() } }));
    if (out) setPreview(out);
  }

  async function save() {
    if (!chosen || !preview) return;
    const out = await call(() =>
      api.POST("/v1/baseline/evidence/link", { body: { ...chosen, url: preview.url, note: note.trim() || null } }),
    );
    if (out) {
      setSaved(`Saved “${out.ref ?? out.url}” as evidence. Everyone can see it.`);
      reset();
      setOpen(false);
      onSaved?.();
    }
  }

  if (!open) {
    return (
      <div className="flex flex-col items-start gap-1.5">
        {saved && (
          <p role="status" className="text-xs text-emerald-800">
            {saved}
          </p>
        )}
        <Button
          size="sm"
          variant={quiet ? "ghost" : "secondary"}
          onClick={() => {
            setSaved(null);
            setOpen(true);
          }}
          aria-label={context ? `Add evidence link to ${context}` : "Add evidence link"}
        >
          Add evidence link
        </Button>
      </div>
    );
  }

  const breakdown = (preview?.confidence_factors as { breakdown?: Record<string, { value?: number; weight?: number }> })
    ?.breakdown;

  return (
    <form
      onSubmit={fetchPreview}
      aria-label="Add evidence link"
      className="space-y-2.5 rounded-md border border-neutral-200 bg-neutral-50/60 p-3 text-sm"
      data-testid="add-evidence-link"
    >
      {!target && (
        <div>
          <label htmlFor={ids.target} className="block text-xs font-medium text-neutral-600">
            Baseline item it supports
          </label>
          <select
            id={ids.target}
            className={`${INPUT} mt-1`}
            value={picked}
            onChange={(e) => {
              setPicked(e.target.value);
              setPreview(null);
            }}
          >
            <option value="">Choose a goal, feature, requirement…</option>
            {choices.map((e) => (
              <option key={e.id} value={e.id}>
                {e.type}: {e.title}
              </option>
            ))}
          </select>
        </div>
      )}
      <div>
        <label htmlFor={ids.url} className="block text-xs font-medium text-neutral-600">
          Public link
        </label>
        <input
          id={ids.url}
          type="url"
          inputMode="url"
          autoFocus
          placeholder="https://… (public Notion page, Google Doc, web page)"
          className={`${INPUT} mt-1`}
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setPreview(null);
          }}
        />
        <p className="mt-1 text-xs text-neutral-500">
          No account needed: the page must be public (a Google Doc shared with anyone with the link). Everyone in the
          company will see it.
        </p>
      </div>
      <div>
        <label htmlFor={ids.note} className="block text-xs font-medium text-neutral-600">
          Note (optional)
        </label>
        <textarea
          id={ids.note}
          rows={2}
          maxLength={2000}
          className={`${INPUT} mt-1`}
          placeholder="Why this supports the item"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}

      {preview && (
        <div className="rounded-md border border-neutral-200 bg-white p-3" data-testid="link-preview" aria-label="Link preview">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-xs text-neutral-500">
                {sourceKindLabel(preview.kind)} · fetched {formatDate(preview.fetched_at)}
                {preview.last_modified ? ` · updated ${formatDate(preview.last_modified)}` : ""}
              </p>
              <p className="font-medium text-neutral-900" data-testid="link-preview-title">
                {preview.title ?? preview.url}
              </p>
            </div>
            <ConfidenceBadge value={preview.confidence} low={low} />
          </div>
          <p className="mt-2 border-l-2 border-neutral-200 pl-2 text-neutral-600 italic" data-testid="link-preview-excerpt">
            “{preview.excerpt}”
          </p>
          {breakdown && (
            <p className="mt-2 text-xs text-neutral-500" data-testid="link-preview-factors">
              {Object.entries(breakdown)
                .map(([k, f]) => `${FACTOR_LABEL[k] ?? k} ${typeof f.value === "number" ? f.value.toFixed(2) : "—"}`)
                .join(" · ")}
            </p>
          )}
          {preview.already_cited && (
            <p className="mt-2 text-xs text-amber-800">This item already cites this link; refresh it from its evidence instead.</p>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {preview && !preview.already_cited ? (
          <Button variant="primary" size="sm" onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save evidence"}
          </Button>
        ) : (
          <Button type="submit" variant="primary" size="sm" disabled={busy}>
            {busy ? "Fetching…" : "Preview"}
          </Button>
        )}
        <Button
          size="sm"
          onClick={() => {
            reset();
            setOpen(false);
          }}
          disabled={busy}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
