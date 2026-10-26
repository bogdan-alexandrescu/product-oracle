"use client";

import Link from "next/link";
import { useState, useSyncExternalStore, type ReactNode } from "react";

import { Button, Chip, Inspector, InspectorSection, LinkButton, Notice, Page, PageHeader, Panel, SegmentedControl, Sheet, Split, type ChipKind } from "@/components/ds";
import { FRESHNESS } from "@/components/tech-brief";
import { ErrorNote } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

type Spec = Schemas["SpecOut"];
type Design = Schemas["DesignArtifactOut"];
type Output = Schemas["DesignOutputOut"];
type Annotation = Schemas["AnnotationOut"];
type ReviewEvent = Schemas["ArtifactReviewEventOut"];
type Verdict = Exclude<Schemas["DesignReviewIn"]["kind"], "comment">;

const PHONE = "(max-width: 600px)";
function subscribePhone(onChange: () => void) {
  const mq = window.matchMedia(PHONE);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
function useIsPhone(): boolean {
  return useSyncExternalStore(subscribePhone, () => window.matchMedia(PHONE).matches, () => false);
}

export const DESIGN_KIND: Record<string, string> = { user_flow: "User flow", wireframe: "Wireframes" };
export const VERSION_STATUS: Record<Schemas["ArtifactVersionOut"]["status"], { label: string; kind: ChipKind }> = {
  draft: { label: "Draft", kind: "na" },
  in_review: { label: "In review", kind: "acc" },
  approved: { label: "Approved", kind: "pass" },
  rejected: { label: "Rejected", kind: "crit" },
  superseded: { label: "Superseded", kind: "na" },
};
const EVENT: Record<ReviewEvent["kind"], { label: string; kind: ChipKind }> = {
  comment: { label: "Comment", kind: "na" },
  approved: { label: "Approved", kind: "pass" },
  changes_requested: { label: "Changes requested", kind: "warn" },
  rejected: { label: "Rejected", kind: "crit" },
  marked_stale: { label: "Marked stale", kind: "warn" },
  reconciled: { label: "Reconciled", kind: "pass" },
};
const NOTE_LABEL = "Note (required to request changes or reject)";
const TEXTAREA =
  "min-h-14 w-full rounded-button border border-line-strong bg-surface px-2.5 py-2 text-[15px] text-text placeholder:text-text-faint";

/** The spec's tech brief: its latest version page. */
export function briefHref(spec: Spec): string | null {
  return spec.document_slug ? `/documents/${spec.document_slug}/v/${spec.latest_version ?? 1}` : null;
}

export function designHref(specId: string, versionId: string): string {
  return `/specs/${specId}/design/${versionId}`;
}

const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
const shortHash = (h: string | null | undefined) => (h ? `${h.slice(0, 4)}…${h.slice(-4)}` : "—");

/**
 * v2 screen 4: one flow or wireframe version of a spec (picks.md 4: A's canvas + review
 * inspector, C's "no comments" filter, B's side by side for 2-4 wireframe screens). Every
 * output renders from its stored, sanitised content in a sandboxed, script-free frame; no
 * pins over it: annotation numbers are the labels Oracle writes into each wireframe.
 */
export function DesignReview({ specId, versionId }: { specId: string; versionId: string }) {
  const { me, can } = useMe();
  const phone = useIsPhone();
  const specQ = useQuery(`spec-request|${specId}`, () =>
    unwrap(api.GET("/v1/spec-requests/{request_id}", { params: { path: { request_id: specId } } })),
  );
  const designQ = useQuery(`design-artifact|${versionId}`, () =>
    unwrap(api.GET("/v1/design-artifacts/{version_id}", { params: { path: { version_id: versionId } } })),
  );
  const [picked, setPicked] = useState<string | null>(null);
  const [compare, setCompare] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  const error = designQ.error ?? specQ.error;
  if (error) {
    return (
      <Page>
        <PageHeader title="Design" testId="page-header" />
        <ErrorNote>{error}</ErrorNote>
      </Page>
    );
  }
  const spec = specQ.data;
  const d = designQ.data;
  if (!spec || !d) return <LoadingState />;

  const v = d.version;
  const output = d.outputs.find((o) => o.name === picked) ?? d.outputs[0];
  const canCompare = d.kind === "wireframe" && d.outputs.length >= 2 && d.outputs.length <= 4;
  const shown = compare && canCompare ? d.outputs : output ? [output] : [];
  const brief = briefHref(spec);
  const reload = () => {
    void designQ.reload();
    void specQ.reload();
  };

  // The spec's engineering approvers (any approver when none are named) or an owner decide,
  // as the API's review_design; regenerate_spec carries the same per-item rule.
  const named = spec.engineering_approver_ids;
  const engineer = me?.role === "owner" || named.length === 0 || (!!me?.user_id && named.includes(me.user_id));
  const roles = {
    comment: can("review_design_artifact", true),
    approverRole: can("regenerate_spec", true),
    decide: can("regenerate_spec", engineer) && can("review_design_artifact", engineer),
    owner: can("review_design_artifact"),
  };
  const fresh = FRESHNESS[v.freshness];
  const running = v.freshness === "potentially_stale" && !!spec.regeneration_run_id;
  const view = spec.stale.find((s) => s.artifact_version_id === v.id);
  const reasons = [...new Set([...(view?.reasons ?? []), ...(d.lineage?.reasons ?? [])])];
  const status = VERSION_STATUS[v.status];
  const chips = (
    <>
      <Chip kind="line">{DESIGN_KIND[d.kind] ?? d.kind}</Chip>
      <Chip kind={status.kind}>{status.label}</Chip>
      <Chip kind={fresh.kind} dot>
        {running ? `${fresh.label} · regeneration running` : fresh.label}
      </Chip>
    </>
  );

  const inspector = (
    <ReviewInspector
      spec={spec}
      d={d}
      shown={shown}
      brief={brief}
      reasons={reasons}
      chips={chips}
      roles={roles}
      meId={me?.user_id ?? null}
      onChanged={reload}
    />
  );

  return (
    <Page>
      <PageHeader
        testId="page-header"
        back={
          brief ? (
            <Link href={brief} className="hover:underline">
              ← {spec.request.title} · tech brief
            </Link>
          ) : undefined
        }
        title={d.title}
        suffix={`v${v.number}`}
        status={chips}
        action={
          <>
            {brief && !phone && <LinkButton href={brief}>Open tech brief</LinkButton>}
            {phone && (
              <Button variant="primary" onClick={() => setSheetOpen(true)}>
                Review
              </Button>
            )}
          </>
        }
      />
      <nav aria-label="Design artifacts" className="mb-4 flex gap-1 overflow-x-auto border-b border-line">
        {(spec.design ?? []).map((a) => {
          const current = a.version.id === v.id;
          return (
            <Link
              key={a.version.id}
              href={designHref(specId, a.version.id)}
              aria-current={current ? "page" : undefined}
              className={`-mb-px flex-none border-b-2 px-3 py-2 text-[15px] font-semibold whitespace-nowrap ${
                current ? "border-accent text-text" : "border-transparent text-text2 hover:text-text"
              }`}
            >
              {a.title} · v{a.version.number}
            </Link>
          );
        })}
      </nav>
      <Split inspector={phone ? undefined : inspector}>
        {v.freshness === "potentially_stale" && (
          <Notice
            tone="warn"
            testId="stale-notice"
            action={
              <>
                {running && spec.regeneration_run_id && <LinkButton href={`/runs/${spec.regeneration_run_id}`}>Open the run</LinkButton>}
                {brief && <LinkButton href={brief}>Review on tech brief</LinkButton>}
              </>
            }
          >
            {running ? "Potentially stale · regeneration running" : "Potentially stale"}
            {reasons.length > 0 && `: ${reasons.join("; ")}`}
          </Notice>
        )}
        {shown
          .filter((o) => o.removed.length > 0)
          .map((o) => (
            <Notice key={o.name} tone="info" testId="sanitised">
              Sanitised: Oracle removed {o.removed.join("; ")} from {o.name} when it stored it.
            </Notice>
          ))}
        <Panel
          title="Files"
          count={d.outputs.length}
          tools={
            <>
              {d.outputs.length > 1 && !(compare && canCompare) && (
                <SegmentedControl
                  label="Files"
                  size="sm"
                  items={d.outputs.map((o) => ({ value: o.name, label: o.name }))}
                  value={output?.name}
                  onChange={setPicked}
                />
              )}
              {canCompare && (
                <Button variant="ghost" aria-pressed={compare} onClick={() => setCompare((c) => !c)}>
                  {compare ? "One at a time" : "Side by side"}
                </Button>
              )}
            </>
          }
        >
          {d.outputs.length === 0 ? (
            <p className="px-4 py-8 text-center text-[15px] text-text2">This version has no files.</p>
          ) : (
            <div data-testid="design-canvas" className={`grid gap-3 bg-surface2 p-4 max-[600px]:p-2 ${shown.length > 1 ? "grid-cols-2 max-[900px]:grid-cols-1" : ""}`}>
              {shown.map((o) => (
                <OutputFrame key={o.name} versionId={v.id} output={o} />
              ))}
            </div>
          )}
          {output && (
            <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2.5 text-sm">
              <span className="font-semibold text-text2">PRD sections</span>
              {[...new Set(shown.flatMap((o) => o.section_keys))].map((k) => (
                <Chip key={k} kind={reasons.some((r) => r.includes(k)) ? "warn" : "line"}>
                  {k}
                </Chip>
              ))}
              <span className="font-semibold text-text2 sm:ml-2">Requirements</span>
              {[...new Set(shown.flatMap((o) => o.requirement_ids))].map((id) => (
                <Chip key={id} kind="line">
                  {requirementName(spec, id)}
                </Chip>
              ))}
              <span className="ml-auto text-[13px] text-text2">Shown in a sandboxed frame, no scripts.</span>
            </div>
          )}
        </Panel>
      </Split>
      {phone && (
        <Sheet open={sheetOpen} title={`Review · ${d.title}`} onClose={() => setSheetOpen(false)} testId="design-review-sheet">
          {inspector}
        </Sheet>
      )}
    </Page>
  );
}

function requirementName(spec: Spec, id: string): string {
  const r = spec.requirements.find((x) => x.id === id);
  return r?.key ?? r?.title ?? id.slice(0, 8);
}

function LoadingState() {
  return (
    <Page>
      <div role="status" aria-label="Loading the design" className="flex flex-col gap-4 py-4">
        <span className="block h-8 w-64 animate-pulse rounded bg-surface2" />
        <span className="block h-72 animate-pulse rounded-panel bg-surface2" />
        <span className="block h-4 w-2/3 animate-pulse rounded bg-surface2" />
      </div>
    </Page>
  );
}

/** An SVG drawn as the whole document of the frame. */
function asDocument(output: Output, content: string): string {
  if (output.media_type === "text/html") return content;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>html,body{margin:0;background:#fff}svg{display:block;width:100%;height:auto}</style></head><body>${content}</body></html>`;
}

/**
 * One output in a framed canvas. Its content is read with the API client and shown with
 * srcdoc in a sandbox with no permissions: no scripts, no same origin, no forms, no network.
 */
function OutputFrame({ versionId, output }: { versionId: string; output: Output }) {
  const q = useQuery(`design-output|${versionId}|${output.name}`, () =>
    unwrap(
      api.GET("/v1/design-artifacts/{version_id}/outputs/{name}", {
        params: { path: { version_id: versionId, name: output.name } },
        parseAs: "text",
      }),
    ) as Promise<string>,
  );
  return (
    <figure className="m-0 min-w-0 overflow-hidden rounded-button border border-line-strong bg-surface">
      <figcaption className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-line bg-surface2 px-2.5 py-1.5 font-mono text-[13px] text-text2">
        {output.title && <b className="font-sans font-semibold text-text">{output.title}</b>}
        <span className="break-all">{output.name}</span>
        <span>
          {output.media_type} · {kb(output.size_bytes)}
        </span>
        <span className="ml-auto" title={output.sha256}>
          sha256 {shortHash(output.sha256)}
        </span>
      </figcaption>
      <div className="p-3 max-[600px]:p-2">
        {q.error ? (
          <ErrorNote>{q.error}</ErrorNote>
        ) : q.data == null ? (
          <span role="status" aria-label={`Loading ${output.name}`} className="block h-64 animate-pulse rounded bg-surface2" />
        ) : (
          <iframe
            sandbox=""
            referrerPolicy="no-referrer"
            title={`${output.title ?? output.name} (${output.name})`}
            srcDoc={asDocument(output, q.data)}
            className={`block w-full rounded border-0 bg-white ${output.media_type === "text/html" ? "h-[520px]" : "h-[360px]"}`}
          />
        )}
      </div>
    </figure>
  );
}

type Roles = { comment: boolean; approverRole: boolean; decide: boolean; owner: boolean };

function ReviewInspector({
  spec,
  d,
  shown,
  brief,
  reasons,
  chips,
  roles,
  meId,
  onChanged,
}: {
  spec: Spec;
  d: Design;
  shown: Output[];
  brief: string | null;
  reasons: string[];
  chips: ReactNode;
  roles: Roles;
  meId: string | null;
  onChanged: () => void;
}) {
  const v = d.version;
  const readOnly = v.status === "superseded" || v.status === "rejected";
  const annotationReviews = d.outputs.reduce((n, o) => n + o.annotations.reduce((m, a) => m + a.reviews.length, 0), 0);
  const roleName = roles.owner ? "owner" : roles.approverRole ? "approver" : roles.comment ? "commenter" : "viewer";
  const post = async (body: Schemas["DesignReviewIn"]) => {
    await unwrap(api.POST("/v1/design-artifacts/{version_id}/reviews", { params: { path: { version_id: v.id } }, body }));
    onChanged();
  };
  return (
    <Inspector
      label="Design review"
      eyebrow={`Design review · viewing as ${roleName}`}
      title={`${d.title} v${v.number}`}
      chips={chips}
      stats={[
        { label: d.outputs.length === 1 ? "File" : "Files", value: d.outputs.length },
        { label: "Annotations", value: d.outputs.reduce((n, o) => n + o.annotations.length, 0) },
        { label: "Reviews", value: d.reviews.length + annotationReviews },
      ]}
    >
      <InspectorSection label={`Verdict on v${v.number}`} testId="verdict">
        <VerdictSection spec={spec} d={d} brief={brief} reasons={reasons} roles={roles} readOnly={readOnly} post={post} />
      </InspectorSection>
      <AnnotationsSection outputs={shown} roles={roles} readOnly={readOnly} meId={meId} post={post} />
      <InspectorSection label="Version reviews · oldest first" testId="version-reviews">
        <div className="flex flex-col gap-3.5">
          {d.reviews.length === 0 ? (
            <p className="text-sm text-text2">No reviews yet. Comments and verdicts on this version show here.</p>
          ) : (
            d.reviews.map((e) => <EventRow key={e.id} e={e} meId={meId} />)
          )}
          {roles.comment && <Composer label={`Comment on v${v.number}`} send={(body) => post({ kind: "comment", body })} />}
        </div>
      </InspectorSection>
      <InspectorSection label="Version" testId="version-meta">
        <VersionMeta spec={spec} d={d} reasons={reasons} meId={meId} />
      </InspectorSection>
    </Inspector>
  );
}

function VerdictSection({
  spec,
  d,
  brief,
  reasons,
  roles,
  readOnly,
  post,
}: {
  spec: Spec;
  d: Design;
  brief: string | null;
  reasons: string[];
  roles: Roles;
  readOnly: boolean;
  post: (body: Schemas["DesignReviewIn"]) => Promise<void>;
}) {
  const v = d.version;
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const stale = v.freshness === "potentially_stale";
  if (readOnly) return <Notice tone="info">{`version ${v.number} is ${v.status}`}: read only.</Notice>;
  if (!roles.comment) return <Notice tone="info">You can read this review. Commenting needs the commenter role.</Notice>;
  const named = spec.engineering_approver_ids.length;
  const approvedLine = v.status === "approved" && v.approved_at && (
    <p className="mb-2 text-sm text-text2">Approved {formatDateTime(v.approved_at)}.</p>
  );
  if (!roles.approverRole) {
    return (
      <>
        {approvedLine}
        <p className="text-[13px] text-text2">Verdicts are for the spec&apos;s engineering approvers.</p>
      </>
    );
  }
  const decide = async (kind: Verdict) => {
    setBusy(true);
    setErr(null);
    try {
      await post({ kind, body: note.trim() || null });
      setNote("");
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const off = busy || !roles.decide;
  return (
    <div className="flex flex-col gap-2.5">
      {approvedLine}
      {stale && (
        <Notice tone="warn" action={brief ? <LinkButton href={brief}>Open tech brief</LinkButton> : undefined}>
          Potentially stale{reasons.length > 0 && `: ${reasons.join("; ")}`}. Review or reconcile it on the tech brief before approving.
        </Notice>
      )}
      <div className="flex flex-wrap gap-2 max-[600px]:[&>button]:flex-1">
        <Button variant="primary" disabled={off || stale || v.status === "approved"} onClick={() => void decide("approved")}>
          Approve
        </Button>
        <Button disabled={off} onClick={() => void decide("changes_requested")}>
          Request changes
        </Button>
        <Button variant="danger" disabled={off} onClick={() => void decide("rejected")}>
          Reject
        </Button>
      </div>
      {roles.decide && (
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-semibold text-text2">{NOTE_LABEL}</span>
          <textarea className={TEXTAREA} placeholder="Say why" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
      )}
      {err && <ErrorNote>{err}</ErrorNote>}
      {!roles.decide ? (
        <>
          <Notice tone="error">only the spec&apos;s engineering approvers (or an owner) decide on it</Notice>
          <p className="text-[13px] text-text2">
            {named} engineering approver{named === 1 ? " is" : "s are"} named on this spec.
          </p>
        </>
      ) : (
        <p className="text-[13px] text-text2">
          {roles.owner
            ? "Owners always decide. Approving supersedes the previously approved version."
            : named > 0
              ? "You are a named engineering approver for this spec."
              : "No engineering approvers are named on this spec, so any approver decides."}
        </p>
      )}
    </div>
  );
}

function AnnotationsSection({
  outputs,
  roles,
  readOnly,
  meId,
  post,
}: {
  outputs: Output[];
  roles: Roles;
  readOnly: boolean;
  meId: string | null;
  post: (body: Schemas["DesignReviewIn"]) => Promise<void>;
}) {
  const [quiet, setQuiet] = useState(false);
  const total = outputs.reduce((n, o) => n + o.annotations.length, 0);
  const filter = (
    <span className="inline-flex gap-1">
      {(["All", "No comments"] as const).map((label) => {
        const on = (label === "No comments") === quiet;
        return (
          <button
            key={label}
            type="button"
            aria-pressed={on}
            onClick={() => setQuiet(label === "No comments")}
            className={`rounded-full px-2.5 py-0.5 text-[13px] font-semibold ${on ? "bg-accent text-on-accent" : "bg-surface2 text-text2 hover:text-text"}`}
          >
            {label}
          </button>
        );
      })}
    </span>
  );
  const label = outputs.length === 1 ? `Annotations · ${outputs[0].name}` : "Annotations";
  return (
    <InspectorSection label={label} tools={total > 0 ? filter : undefined} testId="annotations">
      {total === 0 ? (
        <p className="text-sm text-text2">No annotations on this file.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {outputs.map((o) => {
            // The number is the annotation's place in the file, as Oracle labels it ("1. id [section]").
            const rows = o.annotations.map((a, i) => ({ a, n: i + 1 })).filter(({ a }) => !quiet || a.reviews.length === 0);
            return (
              <div key={o.name} className="flex flex-col gap-3">
                {outputs.length > 1 && <p className="font-mono text-[13px] text-text2">{o.name}</p>}
                {rows.length === 0 ? (
                  <p className="text-sm text-text2">{quiet ? "Every annotation here has comments." : "No annotations on this file."}</p>
                ) : (
                  <ul className="flex flex-col gap-3">
                    {rows.map(({ a, n }) => (
                      <AnnotationRow
                        key={a.id}
                        a={a}
                        n={n}
                        output={o.name}
                        many={outputs.length > 1}
                        canComment={roles.comment && !readOnly}
                        meId={meId}
                        post={post}
                      />
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </InspectorSection>
  );
}

function AnnotationRow({
  a,
  n,
  output,
  many,
  canComment,
  meId,
  post,
}: {
  a: Annotation;
  n: number;
  output: string;
  many: boolean;
  canComment: boolean;
  meId: string | null;
  post: (body: Schemas["DesignReviewIn"]) => Promise<void>;
}) {
  return (
    <li data-testid="annotation" className="flex min-w-0 items-start gap-2.5">
      <span aria-hidden className="grid size-[26px] flex-none place-items-center rounded-full bg-accent-soft font-mono text-[13px] font-bold text-accent-ink">
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold break-words">
          <span className="sr-only">{n}. </span>
          {a.note}
        </p>
        <div className="mt-1 flex flex-wrap gap-1.5">
          <Chip kind="line">{a.id}</Chip>
          <Chip kind="na">→ {a.target}</Chip>
          {a.section_key && <Chip kind="na">{a.section_key}</Chip>}
        </div>
        <div className="mt-2 flex flex-col gap-2 border-l-2 border-line pl-2.5">
          {a.reviews.length === 0 ? (
            <p className="text-[13px] text-text2">No comments on this annotation yet.</p>
          ) : (
            a.reviews.map((e) => <EventRow key={e.id} e={e} meId={meId} />)
          )}
          {canComment && (
            <Composer
              label={many ? `Comment on annotation ${n} of ${output}` : `Comment on annotation ${n}`}
              send={(body) => post({ kind: "comment", body, output, annotation_id: a.id })}
            />
          )}
        </div>
      </div>
    </li>
  );
}

/** An event's actor is "<principal kind>:<id>" (a member or an API token); "system" is Oracle. No route returns names to every role. */
const ACTOR_KIND = new Map([
  ["user", "A member"],
  ["token", "An API token"],
]);

function actorName(actor: string, meId: string | null): string {
  if (meId && actor === `user:${meId}`) return "You";
  return ACTOR_KIND.get(actor.split(":")[0]) ?? "Oracle";
}

function EventRow({ e, meId }: { e: ReviewEvent; meId: string | null }) {
  const kind = EVENT[e.kind];
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        <b>{actorName(e.actor, meId)}</b>
        <Chip kind={kind.kind}>{kind.label}</Chip>
        <span className="tnum text-xs text-text-faint">{formatDateTime(e.created_at)}</span>
      </div>
      {e.body && <p className="text-sm break-words text-text2">{e.body}</p>}
    </div>
  );
}

/** A comment box: the API's refusal (an empty comment) shows under it. */
function Composer({ label, send }: { label: string; send: (body: string) => Promise<void> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await send(text);
      setText("");
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <textarea aria-label={label} placeholder={label} className={TEXTAREA} value={text} onChange={(e) => setText(e.target.value)} />
      {err && <ErrorNote>{err}</ErrorNote>}
      <div>
        <Button variant="solid" disabled={busy} onClick={() => void submit()}>
          Comment
        </Button>
      </div>
    </div>
  );
}

function MetaRow({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex min-h-8 flex-wrap items-center gap-x-2.5 text-sm">
      <span className="text-text2">{k}</span>
      <span className="ml-auto min-w-0 text-right break-words">{children}</span>
    </div>
  );
}

function VersionMeta({ spec, d, reasons, meId }: { spec: Spec; d: Design; reasons: string[]; meId: string | null }) {
  const v = d.version;
  const p = v.provenance as Record<string, unknown>;
  const str = (k: string) => (typeof p[k] === "string" || typeof p[k] === "number" ? String(p[k]) : null);
  const reqs = Array.isArray(p.requirement_ids) ? (p.requirement_ids as string[]) : [];
  const runId = str("run_id");
  const deps = d.lineage?.dependencies ?? [];
  return (
    <div className="flex flex-col">
      {v.summary && <p className="mb-1.5 text-sm">{v.summary}</p>}
      <MetaRow k="Made by">
        {runId ? (
          <>
            Oracle run{" "}
            <Link href={`/runs/${runId}`} className="font-mono text-accent-ink hover:underline">
              {runId.slice(0, 8)}
            </Link>
          </>
        ) : (
          (str("origin") ?? "—")
        )}
      </MetaRow>
      {str("prd_version") && (
        <MetaRow k="From PRD">
          {spec.prd?.slug ?? "PRD"} v{str("prd_version")}
        </MetaRow>
      )}
      {reqs.length > 0 && <MetaRow k="Requirements">{reqs.map((id) => requirementName(spec, id)).join(", ")}</MetaRow>}
      {(str("prompt_version") || str("runner_profile")) && (
        <MetaRow k="Prompt · runner">
          <span className="font-mono">{[str("prompt_version"), str("runner_profile")].filter(Boolean).join(" · ")}</span>
        </MetaRow>
      )}
      <MetaRow k="Composition revision">{v.composition_revision ?? "—"}</MetaRow>
      <MetaRow k="Content hash">
        <span className="font-mono" title={v.content_hash ?? undefined}>
          {shortHash(v.content_hash)}
        </span>
      </MetaRow>
      <MetaRow k="Created">
        <span className="tnum">{formatDateTime(v.created_at)}</span>
      </MetaRow>
      {v.approved_at && (
        <MetaRow k="Approved">
          <span className="tnum">
            {formatDateTime(v.approved_at)}
            {v.approved_by && ` · ${meId && v.approved_by === meId ? "by you" : "by a member"}`}
          </span>
        </MetaRow>
      )}
      <MetaRow k="Depends on">
        {deps.length > 0
          ? deps.map((dep) => (
              <span key={dep.id} className="block">
                {dep.upstream.document_slug ?? "PRD"}
                {dep.upstream.version_number != null && ` v${dep.upstream.version_number}`}
                {dep.upstream.section_key && ` · ${dep.upstream.section_key}`} <Chip kind={FRESHNESS[dep.freshness].kind}>{FRESHNESS[dep.freshness].label}</Chip>
              </span>
            ))
          : reasons.length > 0
            ? reasons.join("; ")
            : (spec.prd?.slug ?? "—")}
      </MetaRow>
    </div>
  );
}

/** The design artifacts of a spec, linked from its tech brief page. */
export function SpecDesignLinks({ doc }: { doc: string }) {
  const listQ = useQuery(`spec-requests|${doc}`, () => unwrap(api.GET("/v1/spec-requests")));
  const requestId = listQ.data?.find((s) => s.document_slug === doc)?.request.id ?? null;
  const specQ = useQuery(`spec-request|${requestId}`, () =>
    requestId ? unwrap(api.GET("/v1/spec-requests/{request_id}", { params: { path: { request_id: requestId } } })) : Promise.resolve(null),
  );
  const spec = specQ.data;
  if (!spec || !spec.design?.length) return null;
  return (
    <div data-testid="spec-design" className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-button border border-line bg-surface px-4 py-3">
      <span className="text-[13px] font-semibold text-text2">Flows and wireframes</span>
      {spec.design.map((a) => (
        <span key={a.version.id} className="inline-flex flex-wrap items-center gap-1.5">
          <Link href={designHref(spec.request.id, a.version.id)} className="font-medium text-accent-ink hover:underline">
            {a.title} · v{a.version.number}
          </Link>
          <Chip kind={VERSION_STATUS[a.version.status].kind}>{VERSION_STATUS[a.version.status].label}</Chip>
        </span>
      ))}
    </div>
  );
}
