"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { RowMenu, RowMenuItem } from "@/app/company/updates/_components/RowMenu";
import { usd } from "@/app/runs/_lib";
import { Button, Icon, Notice, toast, useFocusTrap } from "@/components/ds";
import { INPUT } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { artifactsChanged } from "@/lib/artifacts";
import { useMe, type Operation } from "@/lib/me";
import { errorMessage } from "@/lib/use-query";
import { versionHref } from "@/lib/version-href";

/** What the menu needs of a document (a DocumentOut or a list row). */
export type ArtifactDoc = { slug: string; title: string; kind?: string | null; latest_version?: number | null };

type TrashItem = Schemas["TrashItem"];
type Estimate = Schemas["RegenerateEstimateOut"];

/** Kinds with a flow behind them (PRD, roadmap, spec or tech brief, update). */
const REGENERATES = new Set(["prd", "roadmap", "spec", "update"]);

const KIND_LABEL: Record<string, string> = {
  prd: "PRD",
  roadmap: "Roadmap",
  spec: "Spec",
  update: "Update",
  vision: "Vision",
  strategy: "Strategy",
  intake: "Brief",
};

export function itemKind(i: TrashItem): string {
  if (i.type === "run") return "Run";
  return KIND_LABEL[i.kind] ?? i.kind;
}

/** "Usage alerts PRD and 2 more": a Trash entry in a line. */
export function entryText(root: TrashItem, items: TrashItem[]): string {
  return items.length ? `${root.title} and ${items.length} more` : root.title;
}

/** Undo (= Restore) right after a delete, from the toast. */
async function undo(entry: Schemas["TrashEntryOut"]) {
  try {
    await unwrap(api.POST("/v1/trash/{entry_id}/restore", { params: { path: { entry_id: entry.id } } }));
    artifactsChanged();
    toast({ message: `Restored ${entryText(entry.root, entry.items)}` });
  } catch (e) {
    toast({ message: errorMessage(e) });
  }
}

/**
 * A document's ⋮ menu (#482): Open v<n> (the latest version, where its sections are edited) and Regenerate… for approvers (deciders approve) and owners,
 * Delete… for owners. Commenters and viewers can use none of these, so it is not drawn (#370).
 */
export function ArtifactMenu({ doc, onDeleted }: { doc: ArtifactDoc; onDeleted?: () => void }) {
  const { can } = useMe();
  const [open, setOpen] = useState<"delete" | "regenerate" | null>(null);
  const router = useRouter();
  // #370: each action shows when the API lets this role call it.
  const edit = can("edit_document_section") && doc.latest_version != null ? versionHref(doc.slug, doc.kind, doc.latest_version) : null;
  const regenerate = can("start_regeneration") && !!doc.kind && REGENERATES.has(doc.kind);
  const del = can("delete_document");
  if (!edit && !regenerate && !del) return null;
  const label = `Actions for ${doc.title}`;
  return (
    // A list row selects on click: the menu and its dialogs keep their clicks.
    <span className="contents" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.key !== "Escape" && e.stopPropagation()}>
      <RowMenu label={label}>
        {(close) => (
          <>
            {edit && (
              <RowMenuItem
                onClick={() => {
                  close();
                  router.push(edit);
                }}
              >
                {`Open v${doc.latest_version}`}
              </RowMenuItem>
            )}
            {regenerate && (
              <RowMenuItem
                onClick={() => {
                  close();
                  setOpen("regenerate");
                }}
              >
                Regenerate…
              </RowMenuItem>
            )}
            {del && (
              <RowMenuItem
                onClick={() => {
                  close();
                  setOpen("delete");
                }}
              >
                Delete…
              </RowMenuItem>
            )}
          </>
        )}
      </RowMenu>
      {open === "delete" &&
        createPortal(
          <DeleteDialog
            title={doc.title}
            dependents={() => unwrap(api.GET("/v1/documents/{doc}/dependents", { params: { path: { doc: doc.slug } } }))}
            remove={(query) => unwrap(api.DELETE("/v1/documents/{doc}", { params: { path: { doc: doc.slug }, query } }))}
            onClose={() => setOpen(null)}
            onDeleted={onDeleted}
          />,
          document.body,
        )}
      {open === "regenerate" && createPortal(<RegenerateDialog doc={doc} onClose={() => setOpen(null)} />, document.body)}
    </span>
  );
}

/** The app's modal frame: a scrim, a titled panel, focus kept inside, Escape closes. */
function Dialog({
  title,
  onClose,
  children,
  footer,
  testId,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
  testId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useFocusTrap(ref, true, onClose);
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-hero/50 px-4 py-10 max-[600px]:px-2 max-[600px]:py-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        tabIndex={-1}
        data-testid={testId}
        className="w-full max-w-lg min-w-0 rounded-inspector border border-line bg-surface text-text shadow-tip outline-none"
      >
        <div className="flex min-h-14 items-center gap-2 border-b border-line pr-2 pl-5 max-[600px]:pl-4">
          <h2 id={id} className="min-w-0 flex-1 font-display text-lg font-bold break-words tracking-heading">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid size-9 flex-none place-items-center rounded-lg text-text2 hover:bg-surface2 hover:text-text"
          >
            <Icon name="x" size={20} />
          </button>
        </div>
        <div className="space-y-3.5 px-5 py-4 text-[15px] leading-6 max-[600px]:px-4">{children}</div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3 max-[600px]:px-4">{footer}</div>
      </div>
    </div>
  );
}

const LABEL = "mb-1.5 block text-[13px] leading-4 font-semibold tracking-[0.02em] text-text2";

/**
 * Delete… (owners): what goes to Trash with it, a published artifact's second yes (its
 * external copy stays), then the toast with Undo. Used for documents, briefs and runs.
 */
export function DeleteDialog({
  title,
  dependents,
  remove,
  onClose,
  onDeleted,
}: {
  title: string;
  dependents: () => Promise<Schemas["DependentsOut"]>;
  remove: (query: { reason?: string | null; confirm_published?: boolean }) => Promise<Schemas["TrashEntryOut"]>;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const id = useId();
  const [deps, setDeps] = useState<Schemas["DependentsOut"] | null>(null);
  const [reason, setReason] = useState("");
  const [external, setExternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useRef(dependents);
  useEffect(() => {
    load.current()
      .then(setDeps)
      .catch((e) => setError(errorMessage(e)));
  }, []);
  const working = (deps?.working_runs.length ?? 0) > 0;
  const runs = deps?.items.filter((i) => i.type === "run") ?? [];
  const ready = !!deps && !working && (!deps.published || external);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const entry = await remove({ reason: reason.trim() || null, confirm_published: deps?.published || undefined });
      artifactsChanged();
      onClose();
      toast({ message: `Moved to Trash: ${entryText(entry.root, entry.items)}`, action: { label: "Undo", onClick: () => void undo(entry) } });
      onDeleted?.();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={`Delete ${title}`}
      onClose={onClose}
      testId="delete-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} data-autofocus>
            Back
          </Button>
          <Button variant="danger" disabled={!ready || busy} title={working ? "Cancel the run first" : undefined} onClick={submit}>
            Move to Trash
          </Button>
        </>
      }
    >
      <p>It waits in Settings › Trash for 30 days, where an owner can restore it; then it is gone.</p>
      {!deps && !error && <p className="text-text2">Finding what depends on it…</p>}
      {deps && (
        <div data-testid="delete-dependents">
          {deps.items.length === 0 ? (
            <p className="text-text2">Nothing else goes with it.</p>
          ) : (
            <>
              <p className="font-semibold">These go to Trash with it, and come back with it:</p>
              <ul className="mt-1.5 flex flex-col gap-1">
                {deps.items
                  .filter((i) => i.type !== "run")
                  .map((i) => (
                    <li key={i.id} className="flex min-w-0 items-baseline gap-2">
                      <span className="flex-none text-[13px] font-semibold text-text2">{itemKind(i)}</span>
                      <span className="min-w-0 break-words">{i.title}</span>
                    </li>
                  ))}
                {runs.length > 0 && (
                  // qa-docs-43: the runs in words, not by their flow's internal name (that is on hover).
                  <li data-testid="delete-runs" className="min-w-0 break-words" title={runs.map((r) => r.title).join("\n")}>
                    {runs.length === 1 && deps.items.length === 1
                      ? "The draft run that created it"
                      : runs.length === 1
                        ? "The draft run that created one of these"
                        : `The ${runs.length} draft runs that created these`}
                  </li>
                )}
              </ul>
            </>
          )}
        </div>
      )}
      {working && (
        // qa-onboarding-16: said as it is (a run waiting for a decision is not "working"), and
        // Move to Trash stays off until the run is cancelled.
        <Notice tone="warn" testId="delete-blocked">
          {deps?.root.type === "run" ? "This run has not finished" : "A run on this has not finished"} (it is running or waiting for
          someone). Cancel the run first, then delete.
        </Notice>
      )}
      {deps?.published && (
        <div data-testid="published-warning" className="rounded-button bg-warn-bg px-3 py-2 text-warn">
          <p>This is published. Deleting moves it to Trash here only: the external copy (Notion, Google Docs, Slack) stays where it is.</p>
          <label className="mt-2 flex items-start gap-2 font-medium text-text">
            <input type="checkbox" className="mt-1" checked={external} onChange={(e) => setExternal(e.target.checked)} />
            Delete it here; the external copy stays where it is
          </label>
        </div>
      )}
      <div>
        <label htmlFor={`${id}-reason`} className={LABEL}>
          Reason (optional)
        </label>
        <input id={`${id}-reason`} className={INPUT} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      </div>
      {error && <Notice tone="error">{error}</Notice>}
    </Dialog>
  );
}

/**
 * Regenerate… (approvers and owners): the inputs a new run will use and its estimate, an
 * optional note to the agents, then the run; its result is imported as the next version.
 */
function RegenerateDialog({ doc, onClose }: { doc: ArtifactDoc; onClose: () => void }) {
  const id = useId();
  const router = useRouter();
  const [note, setNote] = useState("");
  // The estimate, for the note it was made with: a changed note asks for a new one.
  const [draft, setDraft] = useState<{ note: string; out: Estimate } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const estimate = draft?.note === note ? draft.out : null;

  async function runEstimate() {
    setBusy(true);
    setError(null);
    try {
      const out = await unwrap(
        api.POST("/v1/documents/{doc}/regenerate/estimate", { params: { path: { doc: doc.slug } }, body: { note: note.trim() || null } }),
      );
      setDraft({ note, out });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    if (!estimate) return;
    setBusy(true);
    setError(null);
    try {
      const run = await unwrap(
        api.POST("/v1/documents/{doc}/regenerate", {
          params: { path: { doc: doc.slug } },
          body: { run_id: estimate.run_id, note: note.trim() || null },
        }),
      );
      artifactsChanged();
      onClose();
      router.push(`/runs/${run.id}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={`Regenerate ${doc.title}`}
      onClose={onClose}
      testId="regenerate-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Back
          </Button>
          <Button onClick={runEstimate} disabled={busy}>
            Estimate
          </Button>
          <Button variant="solid" disabled={!estimate || busy} onClick={start}>
            Start run
          </Button>
        </>
      }
    >
      <p>
        A new run writes it again; the result becomes the next version. Earlier versions stay in history and in
        Changes.
      </p>
      <div>
        <label htmlFor={`${id}-note`} className={LABEL}>
          Note to the agents (optional)
        </label>
        <textarea
          id={`${id}-note`}
          data-autofocus
          rows={3}
          maxLength={2000}
          className={INPUT}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      {estimate && (
        <section aria-label="Estimate" className="rounded-panel border border-line bg-surface2 px-3.5 py-2.5">
          <p className="text-[13px] font-semibold text-text2">It will use</p>
          <ul data-testid="regenerate-inputs" className="mt-1 flex list-disc flex-col gap-0.5 pl-5">
            {estimate.inputs.map((i) => (
              <li key={i} className="break-words">
                {i}
              </li>
            ))}
          </ul>
          <p className="mt-2 flex items-center justify-between border-t border-line pt-1.5 font-semibold">
            Estimate
            <span className="tnum font-mono" data-testid="regenerate-estimate">
              {usd(estimate.estimate_usd)}
            </span>
          </p>
          {estimate.needs_owner_approval && (
            <p className="mt-1 text-sm text-warn">
              Over {usd(estimate.approval_threshold_usd)}: an owner approves the cost before it runs.
            </p>
          )}
        </section>
      )}
      {draft && !estimate && <p className="text-sm text-text2">The note changed: estimate again before starting.</p>}
      {error && <Notice tone="error">{error}</Notice>}
    </Dialog>
  );
}

/**
 * The ⋮ menu of a brief or a run (#482): owners delete them (no editor or flow regenerates
 * them here), so nobody else sees it (#370).
 */
export function DeleteMenu({
  title,
  op,
  dependents,
  remove,
  onDeleted,
}: {
  title: string;
  /** The delete operation, so the menu shows only to roles that may call it (#370). */
  op: Operation;
  dependents: () => Promise<Schemas["DependentsOut"]>;
  remove: (query: { reason?: string | null; confirm_published?: boolean }) => Promise<Schemas["TrashEntryOut"]>;
  onDeleted?: () => void;
}) {
  const { can } = useMe();
  const [open, setOpen] = useState(false);
  if (!can(op)) return null;
  return (
    <>
      <RowMenu label={`Actions for ${title}`}>
        {(close) => (
          <RowMenuItem
            onClick={() => {
              close();
              setOpen(true);
            }}
          >
            Delete…
          </RowMenuItem>
        )}
      </RowMenu>
      {open &&
        createPortal(
          <DeleteDialog title={title} dependents={dependents} remove={remove} onClose={() => setOpen(false)} onDeleted={onDeleted} />,
          document.body,
        )}
    </>
  );
}
