"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

import { Button, Chip } from "@/components/ds";
import { FRESHNESS } from "@/components/tech-brief";
import { ErrorNote } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

type Spec = Schemas["SpecOut"];
type Output = Schemas["TraceOutput"];

const INPUT = "rounded-button border border-line-strong bg-surface px-2.5 py-2 text-[15px] font-normal text-text";

/**
 * #481 A spec version that may be stale, on its tech brief page: the Potentially stale label
 * with its reasons, and the controls that settle it. Review marks it reviewed against the
 * changed PRD (an optional note), writing the trace's staleness action as the Plan
 * inspector's does, so the label clears. Reconcile opens Regenerate from the PRD with the
 * changed sections named, and only proposes the draft run (owner decision 2026-10-23): the
 * version stays Potentially stale, and Approve refused, until the regenerated version
 * supersedes it or someone presses Review; meanwhile the label says its regeneration is
 * running and there is no second Reconcile. The controls are for the roles that may approve
 * the spec (#370); others see the label only.
 */
export function SpecStaleness({ doc, n, mayApprove, onChanged }: { doc: string; n: number; mayApprove: boolean; onChanged: () => void }) {
  const { can, me } = useMe();
  const listQ = useQuery(`spec-requests|${doc}`, () => unwrap(api.GET("/v1/spec-requests")));
  const requestId = listQ.data?.find((s) => s.document_slug === doc)?.request.id ?? null;
  const specQ = useQuery(`spec-request|${requestId}`, () =>
    requestId ? unwrap(api.GET("/v1/spec-requests/{request_id}", { params: { path: { request_id: requestId } } })) : Promise.resolve(null),
  );
  const spec = specQ.data ?? null;
  const av = spec?.versions.find((v) => v.document_version === n)?.artifact_version;
  if (!spec || !av || av.freshness === "fresh") return null;
  const view = spec.stale.find((s) => s.artifact_version_id === av.id);
  const fresh = FRESHNESS[av.freshness];
  // The spec's proposed regeneration, while its run has not ended.
  const runId = spec.regeneration_run_id ?? null;
  const label = av.freshness === "potentially_stale" && runId ? `${fresh.label} · regeneration running` : fresh.label;
  // The spec's engineering approvers (all approvers when it names none) decide on it, as the API's checks.
  const named = spec.engineering_approver_ids;
  const engineer = me?.role === "owner" || named.length === 0 || (!!me?.user_id && named.includes(me.user_id));
  const changed = () => {
    void specQ.reload();
    onChanged();
  };
  return (
    <div data-testid="spec-staleness" className="mb-3 flex flex-col gap-2 rounded-button border border-line bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Chip kind={fresh.kind} dot>
          {label}
        </Chip>
        {view && view.reasons.length > 0 && <span className="text-sm text-text2">{view.reasons.join("; ")}</span>}
      </div>
      {runId && (
        <p className="text-sm text-text2">
          A draft run regenerates this spec from the PRD.{" "}
          <Link href={`/runs/${runId}`} className="font-medium text-accent-ink hover:underline">
            Estimate and start it
          </Link>
        </p>
      )}
      {av.freshness === "potentially_stale" && mayApprove && engineer && can("act_on_staleness") && (
        <StaleActions
          key={av.id}
          spec={spec}
          versionId={av.id}
          view={view}
          mayRegenerate={!runId && can("regenerate_spec", engineer)}
          onChanged={changed}
        />
      )}
    </div>
  );
}

function StaleActions({
  spec,
  versionId,
  view,
  mayRegenerate,
  onChanged,
}: {
  spec: Spec;
  versionId: string;
  view: Output | undefined;
  mayRegenerate: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState<"review" | "reconcile" | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function markReviewed() {
    await unwrap(
      api.POST("/v1/trace/staleness/actions", {
        body: { action: "review", artifact_version_id: versionId, dependency_ids: [], reason: note.trim() || null },
      }),
    );
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setOpen(null);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const review = (e: FormEvent) => {
    e.preventDefault();
    void run(markReviewed);
  };
  // Only proposes the draft run (nothing starts until a person estimates and starts it);
  // this version's staleness is left as it is.
  const regenerate = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await unwrap(
        api.POST("/v1/spec-requests/{request_id}/regenerate", {
          params: { path: { request_id: spec.request.id } },
          body: { reason: note.trim() || null, knobs: { depth: "standard", roles: {}, checkpoints: {} } },
        }),
      );
    });
  };

  return (
    <div className="flex flex-col gap-2">
      {!open && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setOpen("review")} disabled={busy}>
            Review
          </Button>
          {mayRegenerate && (
            <Button onClick={() => setOpen("reconcile")} disabled={busy}>
              Reconcile
            </Button>
          )}
        </div>
      )}
      {open === "review" && (
        <form onSubmit={review} className="flex flex-col gap-2" role="group" aria-label="Review">
          <p className="text-sm text-text2">Mark this version reviewed against the changed PRD. Its Potentially stale label clears.</p>
          <NoteField value={note} onChange={setNote} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" disabled={busy}>
              Mark reviewed
            </Button>
            <Button variant="ghost" onClick={() => setOpen(null)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {open === "reconcile" && <Reconcile view={view} note={note} setNote={setNote} busy={busy} onSubmit={regenerate} onCancel={() => setOpen(null)} />}
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}

/** Regenerate from the PRD, the PRD sections that changed named by their headings. */
function Reconcile({
  view,
  note,
  setNote,
  busy,
  onSubmit,
  onCancel,
}: {
  view: Output | undefined;
  note: string;
  setNote: (v: string) => void;
  busy: boolean;
  onSubmit: (e: FormEvent) => void;
  onCancel: () => void;
}) {
  const ups = (view?.dependencies ?? []).filter((d) => d.freshness === "potentially_stale" && d.upstream.section_key && d.upstream.document_slug);
  const first = ups[0]?.upstream;
  const prdQ = useQuery(`spec-stale-prd|${first?.document_slug}|${first?.version_number}`, () =>
    first?.document_slug && first.version_number
      ? unwrap(api.GET("/v1/documents/{doc}/versions/{n}", { params: { path: { doc: first.document_slug, n: first.version_number } } }))
      : Promise.resolve(null),
  );
  const headings = new Map((prdQ.data?.sections ?? []).map((s) => [s.section_key, s.heading]));
  const names = [...new Set(ups.map((d) => headings.get(d.upstream.section_key!)).filter((h): h is string => !!h))];
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2" role="group" aria-label="Regenerate from the PRD">
      <p className="text-sm text-text2">
        {names.length > 0 ? (
          <>
            Changed in the PRD: {names.map((h) => `"${h}"`).join(", ")}.{" "}
          </>
        ) : (
          "The PRD changed since this spec was written. "
        )}
        Regenerating proposes a draft run from the latest approved PRD; nothing runs until you estimate and start it, and this version stays Potentially stale until the regenerated one replaces it.
      </p>
      <NoteField value={note} onChange={setNote} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={busy}>
          Regenerate from the PRD
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function NoteField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
      Note (optional)
      <textarea value={value} onChange={(e) => onChange(e.target.value)} maxLength={2000} rows={2} className={INPUT} />
    </label>
  );
}
