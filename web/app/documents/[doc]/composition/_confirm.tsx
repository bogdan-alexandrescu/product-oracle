"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { Button, Chip, Icon, Label, Notice, SegmentedControl, Sheet, useFocusTrap } from "@/components/ds";
import { INPUT } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/use-query";

import { plural } from "@/lib/format";

import { changesIn, diffOf, titler, touchedNames, type Changes, type InspectorOut, type Module, type Problem, type Recommendation } from "./_lib";

/** Nothing beyond what the API derives from the document and its newest revision. */
export const EMPTY_INPUTS = { inputs: {}, provenance: {}, advisory: {}, field_values: {} };

/** A dialog on a desktop, the bottom Sheet on a phone. */
export function Modal({
  title,
  eyebrow,
  phone,
  onClose,
  children,
}: {
  title: string;
  eyebrow: string;
  phone: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const id = useId();
  const dialog = useRef<HTMLDivElement>(null);
  // On a desktop focus stays inside the dialog and Escape closes it (the Sheet does both on a phone).
  useFocusTrap(dialog, !phone, onClose);
  if (phone) {
    return (
      <Sheet open title={title} onClose={onClose}>
        {children}
      </Sheet>
    );
  }
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-hero/50 px-4 py-10">
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-labelledby={`${id}-title`}
        className="w-full max-w-4xl overflow-hidden rounded-inspector border border-line bg-surface text-text shadow-tip"
      >
        <div className="bg-hero px-5 pt-4 pb-[18px] text-hero-text">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[13px] leading-4 font-semibold tracking-[0.02em] text-hero-text2">{eyebrow}</span>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="grid size-8 place-items-center rounded-lg text-hero-text2 hover:bg-hero-2 hover:text-hero-text"
            >
              <Icon name="x" size={20} />
            </button>
          </div>
          <h2 id={`${id}-title`} className="mt-1 font-display text-[22px] leading-[27px] font-bold tracking-heading">
            {title}
          </h2>
        </div>
        {children}
      </div>
    </div>
  );
}

function ProblemList({ problems, testId }: { problems: Problem[]; testId?: string }) {
  return (
    <ul data-testid={testId} className="space-y-1.5 text-sm">
      {problems.map((p, i) => (
        <li key={`${p.code}-${p.module}-${i}`} className="flex flex-wrap items-start gap-2">
          <Chip kind={p.fatal ? "crit" : "warn"}>{p.fatal ? "Blocks confirming" : "Note"}</Chip>
          <span className="min-w-0 flex-1">{p.message}</span>
        </li>
      ))}
    </ul>
  );
}

type Layer = "both" | "brief" | "full";

/**
 * A's Confirm step with B's diff and Brief/Full outline: previews the change
 * (POST /v1/compositions/recommend, which writes nothing), then confirms or saves a working
 * draft based on the head revision with the required reason. A stale base is a 409.
 */
export function ConfirmStep({
  doc,
  data,
  changes,
  phone,
  onClose,
  onDone,
  onReload,
}: {
  doc: string;
  data: InspectorOut;
  changes: Changes;
  phone: boolean;
  onClose: () => void;
  onDone: (out: InspectorOut, status: "confirmed" | "working") => void;
  onReload: () => void;
}) {
  const next = (data.head_revision ?? 0) + 1;
  const [preview, setPreview] = useState<Recommendation | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [layer, setLayer] = useState<Layer>("both");
  const [status, setStatus] = useState<"confirmed" | "working">("confirmed");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; stale: boolean } | null>(null);
  const [refused, setRefused] = useState<Problem[]>([]);

  useEffect(() => {
    let live = true;
    unwrap(
      api.POST("/v1/compositions/recommend", {
        body: { ...EMPTY_INPUTS, document: doc, changes: changesIn(changes) },
      }),
    )
      .then((r) => live && setPreview(r))
      .catch((e) => live && setPreviewError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [doc, changes]);

  const before: Module[] = data.current?.modules ?? [];
  const diff = preview ? diffOf(before, preview.modules) : null;
  const added = new Set(diff?.added.map((m) => m.key));
  const fatal = preview?.problems.filter((p) => p.fatal) ?? [];
  const missing = preview?.modules.filter((m) => m.included && m.missing_information.length).flatMap((m) => m.missing_information.map((x) => `${m.title}: ${x}`)) ?? [];
  const trimmed = reason.trim();
  const ready = !!preview && preview.valid && trimmed.length >= 1 && trimmed.length <= 2000 && !busy;
  const label = status === "confirmed" ? `Confirm revision ${next}` : "Save working draft";
  const titleOf = titler(preview?.modules, before);

  async function submit() {
    setBusy(true);
    setError(null);
    setRefused([]);
    const result = await api.POST("/v1/documents/{doc}/composition/revisions", {
      params: { path: { doc } },
      body: {
        ...EMPTY_INPUTS,
        base_revision: data.head_revision ?? null,
        reason: trimmed,
        status,
        changes: changesIn(changes),
      },
    });
    const err = result.error as { problems?: Problem[] } | undefined;
    if (result.response.status === 422 && err && Array.isArray(err.problems)) {
      setRefused(err.problems);
      setBusy(false);
      return;
    }
    try {
      const out = await unwrap(Promise.resolve(result));
      onDone(out, status);
    } catch (e) {
      setError({ message: errorMessage(e), stale: result.response.status === 409 });
      setBusy(false);
    }
  }

  const outline = preview?.outline ?? [];
  // Each heading once: a module adding several sections under its own name is one line.
  const entries = (which: "brief" | "full") =>
    outline.filter((o, i) => o.layer === which && !outline.slice(0, i).some((p) => p.layer === which && p.heading === o.heading));
  const column = (which: "brief" | "full") => (
    <div data-testid={`outline-${which}`} className="min-w-0">
      <Label>
        {which === "brief" ? "Brief" : "Full"} · {plural(entries(which).length, "section")}
      </Label>
      <ul className="mt-1.5 space-y-1 text-sm">
        {entries(which).map((o, i) => {
          const isNew = !!o.module && added.has(o.module);
          return (
            <li key={`${o.section_id}-${i}`} className={`flex flex-wrap items-center gap-x-2 rounded px-1.5 py-0.5 ${isNew ? "bg-accent-soft text-accent-ink" : ""}`}>
              {isNew && <span aria-label="new">+</span>}
              <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{o.heading}</span>
              {o.module && o.origin === "template" && <span className="text-text2">· {titleOf(o.module)}</span>}
            </li>
          );
        })}
        {entries(which).length === 0 && <li className="text-text2">{which === "brief" ? "This PRD has no brief layer." : "No sections"}</li>}
      </ul>
    </div>
  );

  return (
    <Modal title={`Confirm revision ${next}`} eyebrow={data.legacy && data.head_revision == null ? "First composition" : `New revision · starts from revision ${data.head_revision}`} phone={phone} onClose={onClose}>
      <div className="grid gap-5 px-5 py-4 text-[15px] min-[901px]:grid-cols-[minmax(0,1fr)_320px] max-[600px]:px-4">
        <div className="min-w-0 space-y-4">
          {!preview && !previewError && <p role="status" className="text-sm text-text2">Previewing…</p>}
          {previewError && <Notice tone="error">{previewError}</Notice>}
          {diff && (
            <section data-testid="confirm-diff" className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-display text-lg font-bold">What changes</h3>
                <span className="text-sm text-text2">{data.current ? `against revision ${data.current.number}` : "the first composition"}</span>
                {diff.material ? <Chip kind="warn">Changes sections</Chip> : diff.reordered ? <Chip kind="na">Order only · sections unchanged</Chip> : <Chip kind="na">No change</Chip>}
              </div>
              <ul className="space-y-1 text-sm">
                {diff.added.map((m) => (
                  <li key={m.key}>+ {m.title}</li>
                ))}
                {diff.removed.map((m) => (
                  <li key={m.key}>− {m.title}</li>
                ))}
                {diff.versionChanged.map((v) => (
                  <li key={v.key}>~ {v.title} moves to a newer version</li>
                ))}
                {diff.reordered && <li>↕ Reordered</li>}
              </ul>
              {diff.material && diff.affectedSections.length > 0 && (
                <p data-testid="confirm-approvals" className="text-sm text-text2">
                  Approvals on the sections of{" "}
                  {touchedNames(
                    diff.added.map((m) => m.key),
                    diff.removed.map((m) => m.key),
                    diff.versionChanged.map((v) => v.key),
                    titleOf,
                  )}{" "}
                  will be cleared when you confirm.
                </p>
              )}
            </section>
          )}
          {preview && (
            <section className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-display text-lg font-bold">PRD outline after confirm</h3>
                <SegmentedControl
                  label="Outline layer"
                  size="sm"
                  value={layer}
                  onChange={setLayer}
                  items={[
                    { value: "both", label: "Both layers" },
                    { value: "brief", label: "Brief" },
                    { value: "full", label: "Full" },
                  ]}
                />
              </div>
              <div className={`grid gap-4 ${layer === "both" ? "min-[601px]:grid-cols-2" : ""}`}>
                {layer !== "full" && column("brief")}
                {layer !== "brief" && column("full")}
              </div>
              <p className="text-sm text-text2">
                {entries("brief").length > 0 ? `The brief keeps its ${plural(entries("brief").length, "section")}. ` : ""}A preview: nothing is saved until you confirm.
              </p>
            </section>
          )}
        </div>
        <div className="min-w-0 space-y-4">
          {preview && (
            <section className="space-y-2">
              <Label>Problems and missing information</Label>
              {preview.problems.length ? <ProblemList testId="preview-problems" problems={preview.problems} /> : <p className="text-sm text-text2">Nothing blocks confirming.</p>}
              {missing.length > 0 && (
                <ul className="space-y-1 text-sm text-text2">
                  {missing.map((x) => (
                    <li key={x}>Missing: {x}</li>
                  ))}
                </ul>
              )}
            </section>
          )}
          <section className="space-y-2">
            <Label>Save as</Label>
            <SegmentedControl
              label="Save as"
              size="sm"
              value={status}
              onChange={setStatus}
              items={[
                { value: "confirmed", label: "Confirmed, in force" },
                { value: "working", label: "Working draft" },
              ]}
            />
            <p className="text-sm text-text2">
              {status === "confirmed"
                ? data.current
                  ? `Confirming replaces revision ${data.current.number} and drafts saved since.`
                  : `Confirming puts revision ${next} in force.`
                : "A working draft replaces nothing until confirmed."}
            </p>
          </section>
          <div>
            <label htmlFor="composition-reason" className="mb-1.5 block text-[13px] leading-4 font-semibold tracking-[0.02em] text-text2">
              Reason (required)
            </label>
            <textarea id="composition-reason" rows={4} maxLength={2000} className={INPUT} value={reason} onChange={(e) => setReason(e.target.value)} />
            <p className="tnum mt-1 text-right text-[13px] text-text2">{reason.length} / 2000</p>
          </div>
          <p className="text-sm text-text2">{data.head_revision != null ? `Starts from revision ${data.head_revision}, the newest.` : "No revision yet: this is the first."}</p>
          {fatal.length > 0 && <Notice tone="error">Can’t confirm: fix the problems above first.</Notice>}
          {refused.length > 0 && (
            <div role="alert" className="rounded-button bg-crit-bg px-3 py-2">
              <ProblemList problems={refused} />
            </div>
          )}
          {error && (
            <Notice tone="error" action={error.stale ? <Button onClick={onReload}>Reload</Button> : undefined}>
              {error.message}
            </Notice>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="solid" disabled={!ready} onClick={submit}>
              {label}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** Publish the revision in force with an approved document version (POST …/publish). */
export function PublishStep({
  doc,
  revision,
  phone,
  onClose,
  onDone,
}: {
  doc: string;
  revision: number;
  phone: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [version, setVersion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = Number(version);
  async function publish() {
    setBusy(true);
    setError(null);
    try {
      await unwrap(api.POST("/v1/documents/{doc}/composition/publish", { params: { path: { doc } }, body: { version: n } }));
      onDone();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <Modal title={`Publish revision ${revision}`} eyebrow="Pin the composition to an approved version" phone={phone} onClose={onClose}>
      <div className="space-y-3 px-5 py-4 text-[15px] max-[600px]:px-4">
        <p className="text-sm text-text2">The published composition is pinned to the version and never changed afterwards.</p>
        <div>
          <label htmlFor="publish-version" className="mb-1.5 block text-[13px] leading-4 font-semibold tracking-[0.02em] text-text2">
            Approved document version
          </label>
          <input id="publish-version" type="number" min={1} className={INPUT} value={version} onChange={(e) => setVersion(e.target.value)} />
        </div>
        {error && <Notice tone="error">{error}</Notice>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="solid" disabled={busy || !Number.isInteger(n) || n < 1} onClick={publish}>
            Publish
          </Button>
        </div>
      </div>
    </Modal>
  );
}
