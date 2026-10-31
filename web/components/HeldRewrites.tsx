"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Button, Chip } from "@/components/ds";
import { FIELD_LABEL, InlineError, TEXTAREA } from "@/components/review/parts";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { sectionHref } from "@/lib/section-link";
import { useQuery } from "@/lib/use-query";

type Patch = Schemas["SectionPatchOut"];

/** The document's section patches: agent rewrites held because their section was approved. */
export function useHeldRewrites(doc: string) {
  const [key, setKey] = useState(0);
  const q = useQuery(
    `section-patches|${doc}|${key}`,
    () => unwrap(api.GET("/v1/documents/{doc}/section-patches", { params: { path: { doc } } })),
    { keepPrevious: true },
  );
  const rows = q.data ?? [];
  return { rows, open: rows.filter((p) => p.status === "open").length, reload: () => setKey((k) => k + 1) };
}

/** "Held rewrites" with a badge counting the ones still waiting for a decision. */
export function HeldRewritesButton({ open, active, onClick }: { open: number; active: boolean; onClick: () => void }) {
  return (
    <Button icon="flag" aria-expanded={active} onClick={onClick}>
      Held rewrites
      {open > 0 && (
        <b className="tnum ml-1 rounded-full bg-warn-bg px-1.5 text-warn" data-testid="held-count">
          {open}
        </b>
      )}
    </Button>
  );
}

/**
 * The agent rewrites held because their section was approved. Each shows why it was held
 * and a word diff against the section's current text; approvers Accept it (the next
 * version) or Reject it (the approved text stays), with a reason.
 */
export function HeldRewritesPanel({
  doc,
  rows,
  headings,
  canDecide,
  onChanged,
  onClose,
}: {
  doc: string;
  rows: Patch[];
  headings: Map<string, string>;
  canDecide: boolean;
  onChanged: () => void;
  onClose: () => void;
}) {
  const ordered = [...rows.filter((p) => p.status === "open"), ...rows.filter((p) => p.status !== "open")];
  // qa4-docs-33: Escape closes it, as it closes every dialog and menu: from inside it, from
  // its Held rewrites button, or from the page; not while a dialog, a menu or another
  // field has the key.
  const ref = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target instanceof Element ? e.target : null;
      const inside = !!t && !!ref.current?.contains(t);
      if (!inside && t?.closest('[role="dialog"], [role="menu"], input, textarea, select, [contenteditable="true"]')) return;
      close.current();
    };
    // On window: a menu's or a sheet's own Escape (on document) runs first and takes it.
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <section ref={ref} aria-label="Held rewrites" data-testid="held-rewrites" className="mb-4 rounded-panel border border-line bg-surface px-4 py-3 shadow-panel">
      <div className="flex items-center gap-2">
        <h2 className="font-display text-lg leading-6 font-bold text-text">Held rewrites</h2>
        <Button variant="ghost" className="ml-auto" onClick={onClose}>
          Close
        </Button>
      </div>
      {/* qa4-docs-7: they were approved in an earlier version, not (yet) in the one shown. */}
      <p className="text-sm text-text2" data-testid="held-intro">
        An agent draft rewrote these sections after they were approved in an earlier version. The approved text was kept until
        someone decides.
      </p>
      {ordered.length === 0 && <p className="mt-2 text-sm text-text2">No held rewrites.</p>}
      <ul className="mt-2 flex flex-col gap-2">
        {ordered.map((p) => (
          <HeldRewrite key={p.id} doc={doc} patch={p} heading={headings.get(p.section_key) ?? p.heading} canDecide={canDecide} onChanged={onChanged} />
        ))}
      </ul>
    </section>
  );
}

const DECIDED: Record<Exclude<Patch["status"], "open">, string> = {
  accepted: "Accepted",
  rejected: "Rejected",
  superseded: "Superseded",
};

function HeldRewrite({
  doc,
  patch,
  heading,
  canDecide,
  onChanged,
}: {
  doc: string;
  patch: Patch;
  heading: string;
  canDecide: boolean;
  onChanged: () => void;
}) {
  const router = useRouter();
  const isOpen = patch.status === "open";
  const [reloads, setReloads] = useState(0);
  const detail = useQuery(`section-patch|${patch.id}|${patch.lock_version}|${reloads}`, () =>
    isOpen ? unwrap(api.GET("/v1/section-patches/{patch_id}", { params: { path: { patch_id: patch.id } } })) : Promise.resolve(null),
  );
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  // Accept is checked against the section's current revision; a section the latest version dropped has none.
  const gone = !!detail.data && !detail.data.current_revision;

  async function decide(action: "accept" | "reject") {
    const d = detail.data;
    if (!d || (action === "accept" && !d.current_revision)) return;
    setBusy(true);
    setError(null);
    setStale(false);
    const reason = note.trim() || null;
    try {
      const { data, error: err, response } =
        action === "accept"
          ? await api.POST("/v1/section-patches/{patch_id}/accept", {
              params: { path: { patch_id: patch.id } },
              body: { base_revision: d.current_revision!, lock_version: d.lock_version, note: reason },
            })
          : await api.POST("/v1/section-patches/{patch_id}/reject", {
              params: { path: { patch_id: patch.id } },
              body: { lock_version: d.lock_version, note: reason },
            });
      if (response.status === 409) {
        setStale(true);
        setError("This rewrite or its section changed since you loaded it. Nothing was decided.");
      } else if (!response.ok) {
        const detailText = err && typeof err === "object" && "detail" in err ? err.detail : null;
        setError(typeof detailText === "string" ? detailText : "Could not record the decision.");
      } else {
        onChanged();
        if (action === "accept" && data && "number" in data) router.push(sectionHref(doc, data.number, patch.section_key));
      }
    } catch {
      setError("Could not record the decision.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-button border border-line bg-surface2 px-3 py-2.5" data-testid="held-rewrite">
      <div className="flex flex-wrap items-center gap-2">
        {/* qa4-docs-22: the section by its name only, no anchor. */}
        <p className="min-w-0 truncate font-semibold text-text" data-testid="held-heading">{heading}</p>
        {patch.action === "remove" && <Chip kind="crit">Removes the section</Chip>}
        {!isOpen && <Chip kind={patch.status === "accepted" ? "pass" : "na"}>{DECIDED[patch.status as keyof typeof DECIDED]}</Chip>}
      </div>
      {patch.rationale && <p className="mt-1 text-sm text-text2">{patch.rationale}</p>}
      {!isOpen && patch.decision_note && (
        <p className="mt-1 text-sm text-text">
          <span className="font-semibold">Reason:</span> {patch.decision_note}
        </p>
      )}
      {isOpen && detail.data && (
        <>
          {gone ? (
            <p className="mt-1 text-sm font-medium text-warn">This section is no longer in the latest version. Reject it to close it.</p>
          ) : (
            detail.data.rebase_needed && (
              <p className="mt-1 text-sm font-medium text-warn">The section changed since this rewrite was proposed.</p>
            )
          )}
          <p className="mt-2 rounded-lg border border-line bg-surface px-2.5 py-2 text-sm leading-6 whitespace-pre-wrap text-text" data-testid="held-diff">
            {detail.data.words.map((w, i) =>
              w.op === "insert" ? (
                <ins key={i} className="diff-ins">
                  {w.text}{" "}
                </ins>
              ) : w.op === "delete" ? (
                <del key={i} className="diff-del">
                  {w.text}{" "}
                </del>
              ) : (
                <span key={i}>{w.text} </span>
              ),
            )}
          </p>
          {canDecide ? (
            <div className="mt-2 flex flex-col gap-2">
              <label className={FIELD_LABEL}>
                Reason
                <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} className={TEXTAREA} />
              </label>
              <div className="flex flex-wrap gap-1.5">
                <Button variant="solid" icon="check" disabled={busy || gone} onClick={() => decide("accept")}>
                  Accept
                </Button>
                <Button disabled={busy} onClick={() => decide("reject")}>
                  Reject
                </Button>
                {stale && (
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setStale(false);
                      setError(null);
                      setReloads((k) => k + 1);
                      onChanged();
                    }}
                  >
                    Reload
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <p className="mt-2 text-sm text-text2">An approver accepts or rejects it.</p>
          )}
        </>
      )}
      {error && <InlineError>{error}</InlineError>}
    </li>
  );
}
