"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { api, unwrap, type Schemas } from "@/lib/api/client";
import { artifactsChanged } from "@/lib/artifacts";
import { useMe } from "@/lib/me";
import { errorMessage } from "@/lib/use-query";

type Entry = Schemas["TrashEntryOut"];

const BTN =
  "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-line-strong bg-surface px-3 text-[14px] font-[650] text-text hover:bg-surface2";
const DANGER =
  "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-transparent bg-warn px-3 text-[14px] font-[650] text-on-accent disabled:border-line-strong disabled:bg-surface2 disabled:text-text2";
const MENU =
  "absolute right-0 top-full z-30 mt-1 w-56 rounded-lg border border-line bg-surface p-1 text-[15px] shadow-lg";
const ITEM =
  "flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left hover:bg-surface2";

/**
 * EP2 a (ep2-a-open, ep2-a-hard): the ⋯ menu on a One-pagers row and on the one-pager's header.
 * Delete PRD for who may delete documents (the API's delete_document); a viewer and a commenter
 * see no ⋯ (ep2-a-readonly). It sends the PRD to Settings > Trash with what was built from it.
 */
export function PrdMenu({
  doc,
  btnClass,
  onDeleted,
}: {
  doc: { slug: string; title: string };
  btnClass?: string;
  onDeleted: (entry: Entry) => void;
}) {
  const { can } = useMe();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) =>
      !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  if (!can("delete_document")) return null;
  return (
    // Open, it sits over the next rows (each row's ⋯ is lifted over the row's link).
    <span
      ref={ref}
      className={`relative inline-flex ${open ? "z-[2]" : "z-[1]"}`}
    >
      <button
        type="button"
        aria-label={`More for ${doc.title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className={
          btnClass ??
          `inline-flex h-9 w-9 flex-none items-center justify-center rounded-lg border border-line-strong bg-surface text-[16px] text-text hover:bg-surface2 ${open ? "bg-surface2" : ""}`
        }
        onClick={() => setOpen((o) => !o)}
      >
        ⋯
      </button>
      {open && (
        <div role="menu" className={MENU}>
          <button
            type="button"
            role="menuitem"
            className={`${ITEM} text-warn`}
            onClick={() => {
              setOpen(false);
              setConfirm(true);
            }}
          >
            Delete PRD
          </button>
        </div>
      )}
      {confirm &&
        createPortal(
          <DeletePrdDialog
            doc={doc}
            onClose={() => setConfirm(false)}
            onDeleted={onDeleted}
          />,
          document.body,
        )}
    </span>
  );
}

/** EP2 a (ep2-a-delete, ep2-a-phone): Delete asks first, says where it goes and what goes with it; on a phone it rises from the bottom. */
function DeletePrdDialog({
  doc,
  onClose,
  onDeleted,
}: {
  doc: { slug: string; title: string };
  onClose: () => void;
  onDeleted: (entry: Entry) => void;
}) {
  const [deps, setDeps] = useState<Schemas["DependentsOut"] | null>(null);
  const [published, setPublished] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    unwrap(
      api.GET("/v1/documents/{doc}/dependents", {
        params: { path: { doc: doc.slug } },
      }),
    )
      .then((d) => alive && setDeps(d))
      .catch((e) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [doc.slug]);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("button:not([disabled])")?.focus();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  const working = (deps?.working_runs.length ?? 0) > 0;
  const withIt = deps?.items.filter((i) => i.type !== "run") ?? [];
  const ready = !!deps && !working && (!deps.published || published);
  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const entry = await unwrap(
        api.DELETE("/v1/documents/{doc}", {
          params: {
            path: { doc: doc.slug },
            query: { confirm_published: deps?.published || undefined },
          },
        }),
      );
      artifactsChanged();
      onClose();
      onDeleted(entry);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <div
      data-backdrop=""
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={`Delete ${doc.title}`}
        data-testid="delete-prd"
        className="w-full max-w-lg rounded-t-[var(--simple-card-radius)] border border-line bg-surface p-4 text-left shadow-lg sm:rounded-[var(--simple-card-radius)]"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-[length:var(--simple-h2)] font-semibold leading-[var(--simple-h2-leading)]">
          Delete {doc.title}?
        </h2>
        <p className="mt-1 text-[15px] text-text2">
          It goes to Settings &gt; Trash for 30 days.
        </p>
        {!deps && !error && (
          <p className="mt-2 text-[15px] text-text2">
            Finding what goes with it…
          </p>
        )}
        {withIt.length > 0 && (
          <div data-testid="delete-prd-with" className="mt-3 text-[15px]">
            <p className="font-semibold">These go with it:</p>
            <ul className="mt-1 flex flex-col gap-0.5">
              {withIt.map((i) => (
                <li key={i.id} className="break-words">
                  {i.title}
                </li>
              ))}
            </ul>
          </div>
        )}
        {deps?.published && (
          <label className="mt-3 flex items-start gap-2 text-[15px]">
            <input
              type="checkbox"
              className="mt-1"
              checked={published}
              onChange={(e) => setPublished(e.target.checked)}
            />
            It is published: its copy outside Oracle stays where it is.
          </label>
        )}
        {working && (
          <p className="mt-3 text-[15px] text-warn">
            A run is working on it. Delete it when the run ends.
          </p>
        )}
        {error && (
          <p role="alert" className="mt-3 text-[15px] text-warn">
            {error}
          </p>
        )}
        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            className={DANGER}
            disabled={!ready || busy}
            onClick={() => void remove()}
          >
            Delete PRD
          </button>
          <button type="button" className={BTN} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** Undo after a delete: the Trash entry's Restore. */
export async function restorePrd(entry: Entry): Promise<void> {
  await unwrap(
    api.POST("/v1/trash/{entry_id}/restore", {
      params: { path: { entry_id: entry.id } },
    }),
  );
  artifactsChanged();
}
