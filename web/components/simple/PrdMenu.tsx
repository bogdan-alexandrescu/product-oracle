"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { itemKind, itemTitle } from "@/components/ArtifactMenu";
import { toast } from "@/components/ds/Toast";
import { useFocusTrap } from "@/components/ds/ConfirmDialog";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { artifactsChanged } from "@/lib/artifacts";
import { useMe } from "@/lib/me";
import { errorMessage } from "@/lib/use-query";

type Entry = Schemas["TrashEntryOut"];
type Item = Schemas["TrashItem"];

const ICON =
  "inline-flex h-8 w-8 flex-none items-center justify-center rounded-lg border border-transparent text-[16px] text-text hover:border-line-strong hover:bg-surface2";
const BTN =
  "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-line-strong bg-surface px-3 text-[14px] font-[650] text-text hover:bg-surface2";
const DANGER =
  "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-transparent bg-warn px-3 text-[14px] font-[650] text-on-accent disabled:border-line-strong disabled:bg-surface2 disabled:text-text2";
const MENU = "absolute right-0 top-full z-30 mt-1 w-48 rounded-lg border border-line bg-surface p-1 text-[15px] shadow-lg";
const ITEM = "flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left hover:bg-surface2";

/**
 * delete-prd-simple, EP2 a "Menus on both" (the owner's pick, Nov 5): the ⋯ menu on a One-pagers row
 * and on the one-pager's header. Move up and Move down (prd-order, where given) and Delete PRD for
 * who may delete documents (the API's delete_document); with neither, no ⋯ (ep2-a-readonly).
 */
export function PrdMenu({
  doc,
  onUp,
  onDown,
  busy,
  btnClass,
  onDeleted,
}: {
  doc: { slug: string; title: string };
  onUp?: () => void;
  onDown?: () => void;
  busy?: boolean;
  btnClass?: string;
  onDeleted: (entry: Entry) => void;
}) {
  const { can } = useMe();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  const items: [string, () => void, string?][] = [];
  if (onUp) items.push(["Move up", onUp]);
  if (onDown) items.push(["Move down", onDown]);
  if (can("delete_document")) items.push(["Delete PRD", () => setConfirm(true), "text-warn"]);
  if (!items.length) return null;
  return (
    // Lifted over the row's stretched link; open, it sits over the next rows.
    <span ref={ref} className={`relative inline-flex ${open ? "z-20" : "z-10"}`}>
      <button
        type="button"
        aria-label={`More for ${doc.title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        className={btnClass ?? `${ICON} ${open ? "border-line-strong bg-surface2" : ""}`}
        onClick={() => setOpen((o) => !o)}
      >
        ⋯
      </button>
      {open && (
        <div role="menu" className={MENU}>
          {items.map(([label, go, tone]) => (
            <button
              key={label}
              type="button"
              role="menuitem"
              className={`${ITEM} ${tone ?? ""}`}
              onClick={() => {
                setOpen(false);
                go();
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {confirm && createPortal(<DeletePrdDialog doc={doc} onClose={() => setConfirm(false)} onDeleted={onDeleted} />, document.body)}
    </span>
  );
}

/**
 * The one-pager header's ⋯: deleted, the PRD goes back to One-pagers with Undo in the note. Undo opens
 * the one-pager again while the person is still on One-pagers; elsewhere it only restores, with a link.
 */
export function PrdHeaderMenu({ doc, btnClass }: { doc: { slug: string; title: string }; btnClass: string }) {
  const router = useRouter();
  return (
    <PrdMenu
      doc={doc}
      btnClass={btnClass}
      onDeleted={(entry) => {
        toast({
          message: deletedText(doc.title),
          action: {
            label: "Undo",
            onClick: () =>
              void restorePrd(entry)
                .then(() => {
                  const page = `/simple/one-pagers/${doc.slug}`;
                  if (window.location.pathname === "/simple/one-pagers") router.push(page);
                  else toast({ message: `Restored ${doc.title}.`, action: { label: "Open it", onClick: () => router.push(page) } });
                })
                // A failed restore says why, in the API's words.
                .catch((e) => toast({ message: errorMessage(e) })),
          },
        });
        router.push("/simple/one-pagers");
      }}
    />
  );
}

export const deletedText = (title: string) => `Deleted ${title}. It is in Settings > Trash for 30 days.`;

/** One line of the confirm's lists: what it is, then its name (a run by its day and what it wrote). */
function Row({ i, root }: { i: Item; root: string }) {
  return (
    <li className="flex min-w-0 items-baseline gap-2">
      <span className="flex-none text-[13px] font-semibold text-text2">{itemKind(i)}</span>
      <span className="min-w-0 break-words">{itemTitle(i, root)}</span>
    </li>
  );
}

/**
 * EP2 a (ep2-a-delete, ep2-a-phone): Delete asks first, says where it goes, what goes with it (the
 * documents built from it, the roadmap items and tracks that leave with its roadmap, and their runs)
 * and what it feeds that stays; on a phone it rises from the bottom. Focus stays in it until it closes.
 */
function DeletePrdDialog({ doc, onClose, onDeleted }: { doc: { slug: string; title: string }; onClose: () => void; onDeleted: (entry: Entry) => void }) {
  const [deps, setDeps] = useState<Schemas["DependentsOut"] | null>(null);
  const [published, setPublished] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    unwrap(api.GET("/v1/documents/{doc}/dependents", { params: { path: { doc: doc.slug } } }))
      .then((d) => alive && setDeps(d))
      .catch((e) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [doc.slug]);
  useFocusTrap(ref, true, onClose);
  const working = (deps?.working_runs.length ?? 0) > 0;
  // Its documents, then the items and tracks that leave with its roadmap, then the runs.
  const withIt = [...(deps?.items.filter((i) => i.type !== "run") ?? []), ...(deps?.feeds_going ?? []), ...(deps?.items.filter((i) => i.type === "run") ?? [])];
  const feeds = deps?.feeds ?? [];
  const root = deps?.root.title ?? doc.title;
  const ready = !!deps && !working && (!deps.published || published);
  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const entry = await unwrap(
        api.DELETE("/v1/documents/{doc}", { params: { path: { doc: doc.slug }, query: { confirm_published: deps?.published || undefined } } }),
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
    <div data-backdrop="" className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4" onClick={onClose}>
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`Delete ${doc.title}`}
        data-testid="delete-prd"
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-[var(--simple-card-radius)] border border-line bg-surface p-4 text-left shadow-lg sm:rounded-[var(--simple-card-radius)]"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-[length:var(--simple-h2)] font-semibold leading-[var(--simple-h2-leading)]">Delete {doc.title}?</h2>
        <p className="mt-1 text-[15px] text-text2">It goes to Settings &gt; Trash for 30 days.</p>
        {!deps && !error && <p className="mt-2 text-[15px] text-text2">Finding what goes with it…</p>}
        {withIt.length > 0 && (
          <div data-testid="delete-prd-with" className="mt-3 text-[15px]">
            <p className="font-semibold">These go with it:</p>
            <ul className="mt-1 flex flex-col gap-0.5">
              {withIt.map((i) => (
                <Row key={`${i.type}-${i.id}`} i={i} root={root} />
              ))}
            </ul>
          </div>
        )}
        {feeds.length > 0 && (
          <div data-testid="delete-prd-feeds" className="mt-3 text-[15px]">
            <p className="font-semibold">These stay, without it:</p>
            <ul className="mt-1 flex flex-col gap-0.5">
              {feeds.map((i) => (
                <Row key={`${i.type}-${i.id}`} i={i} root={root} />
              ))}
            </ul>
          </div>
        )}
        {deps?.published && (
          <label className="mt-3 flex items-start gap-2 text-[15px]">
            <input type="checkbox" className="mt-1" checked={published} onChange={(e) => setPublished(e.target.checked)} />
            It is published: its copy outside Oracle stays where it is.
          </label>
        )}
        {working && <p className="mt-3 text-[15px] text-warn">A run is working on it. Delete it when the run ends.</p>}
        {error && (
          <p role="alert" className="mt-3 text-[15px] text-warn">
            {error}
          </p>
        )}
        <div className="mt-4 flex items-center gap-2">
          <button type="button" className={DANGER} disabled={!ready || busy} onClick={() => void remove()}>
            Delete PRD
          </button>
          <button type="button" data-autofocus="" className={BTN} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** Undo after a delete: the Trash entry's Restore. */
export async function restorePrd(entry: Entry): Promise<void> {
  await unwrap(api.POST("/v1/trash/{entry_id}/restore", { params: { path: { entry_id: entry.id } } }));
  artifactsChanged();
}
