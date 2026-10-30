"use client";

import Link from "next/link";
import { useState, useSyncExternalStore, type ReactNode } from "react";

import { Button, Chip, Icon, Inspector, InspectorSection, LinkButton, NotFoundPanel, Notice, Page, PageHeader, Panel, SegmentedControl, Sheet, Split, type ChipKind } from "@/components/ds";
import { FRESHNESS } from "@/components/tech-brief";
import { ErrorNote } from "@/components/ui";
import { ApiError, api, unwrap, type Schemas } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

type Spec = Schemas["SpecOut"];
type Design = Schemas["DesignArtifactOut"];
type Output = Schemas["DesignOutputOut"];
type Annotation = Schemas["AnnotationOut"];
type ReviewEvent = Schemas["DesignReviewEventOut"];
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
const shortHash = (h: string | null | undefined) => (h ? `${h.slice(0, 4)}…${h.slice(-4)}` : "Not recorded");
const MEDIA: Record<string, string> = { "image/svg+xml": "Drawing (SVG)", "text/html": "Web page (HTML)" };

/** How the page names the PRD a design rests on, and its sections (qa-docs-35). */
type PrdWords = { slug: string | null; title: string | null; heading: (key: string) => string | null };

/** A PRD slug the reasons name ("section s-5-2 changed in checkout-redesign v2"). */
const SLUG_IN_REASON = /\b(?:in|of) ([a-z0-9]+(?:-[a-z0-9]+)+)\b/;

/**
 * The PRD by its title and its sections by their headings: from the spec's PRD, the version's
 * dependencies, or the slug its staleness reasons name.
 */
function usePrdWords(spec: Spec | undefined, d: Design | undefined): PrdWords {
  const view = spec && d ? spec.stale.find((x) => x.artifact_version_id === d.version.id) : undefined;
  const deps = [...(d?.lineage?.dependencies ?? []), ...(view?.dependencies ?? []), ...(spec?.stale ?? []).flatMap((x) => x.dependencies)];
  const reasons = (spec?.stale ?? []).flatMap((x) => x.reasons);
  const known =
    spec?.prd?.slug ??
    deps.find((x) => x.upstream.document_kind === "prd" && x.upstream.document_slug)?.upstream.document_slug ??
    null;
  // A hyphenated word after "in"/"of" ("in real-time") is only a guess: it names the PRD
  // only when a PRD with that slug is found.
  const guess = known ? null : (reasons.map((r) => SLUG_IN_REASON.exec(r)?.[1]).find(Boolean) ?? null);
  const asked = known ?? guess;
  const docQ = useQuery(`doc|${asked}`, () =>
    asked ? unwrap(api.GET("/v1/documents/{doc}", { params: { path: { doc: asked } } })).catch(() => null) : Promise.resolve(null),
  );
  const slug = known ?? (guess && docQ.data?.slug === guess && docQ.data.kind === "prd" ? guess : null);
  const n = slug ? (docQ.data?.latest_version ?? null) : null;
  const versionQ = useQuery(`design-prd-sections|${slug}|${n}`, () =>
    slug && n ? unwrap(api.GET("/v1/documents/{doc}/versions/{n}", { params: { path: { doc: slug, n } } })) : Promise.resolve(null),
  );
  const headings = new Map((versionQ.data?.sections ?? []).map((x) => [x.section_key, x.heading]));
  return { slug, title: spec?.prd?.title ?? (slug ? docQ.data?.title : null) ?? null, heading: (key) => headings.get(key) ?? null };
}

/** A section by its heading ("5.2 Shipping step"), or "a section" while it is not known. */
const sectionName = (w: PrdWords, key: string) => w.heading(key) ?? "a section";

/** A staleness reason in words: section headings and the PRD's title, never keys or slugs. */
function reasonText(reason: string, w: PrdWords): string {
  // A key may hold dots ("s-5.2"), but the period that ends the sentence is kept.
  let out = reason.replace(/\bsection ([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)/g, (_, key: string) => (w.heading(key) ? `section "${w.heading(key)}"` : "a section"));
  if (w.slug) out = out.replaceAll(w.slug, w.title ?? "the PRD");
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/** A design version that is not there, said without its id (the API's 404 names it). */
const DESIGN_MISSING = "This design doesn't exist or was deleted.";

/**
 * v2 screen 4: one flow or wireframe version of a spec (picks.md 4: A's canvas + review
 * inspector, C's "no comments" filter, B's side by side for 2-4 wireframe screens). Every
 * output renders from its stored, sanitised content in a sandboxed, script-free frame; no
 * pins over it: annotation numbers are the labels Oracle writes into each wireframe.
 */
export function DesignReview({ specId, versionId }: { specId: string; versionId: string }) {
  const { me, can, capsReady, capsError } = useMe();
  const phone = useIsPhone();
  const specQ = useQuery(`spec-request|${specId}`, () =>
    unwrap(api.GET("/v1/spec-requests/{request_id}", { params: { path: { request_id: specId } } })),
  );
  const designQ = useQuery(`design-artifact|${versionId}`, () =>
    unwrap(api.GET("/v1/design-artifacts/{version_id}", { params: { path: { version_id: versionId } } })).catch((e) => {
      throw e instanceof ApiError && e.status === 404 ? new ApiError(404, DESIGN_MISSING) : e;
    }),
  );
  const words = usePrdWords(specQ.data, designQ.data);
  const [picked, setPicked] = useState<string | null>(null);
  const [compare, setCompare] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  const error = designQ.error ?? specQ.error;
  // qa-shell-7: an old link to a design version, in the app's one not-found pattern.
  if (designQ.error === DESIGN_MISSING) {
    const back = specQ.data ? briefHref(specQ.data) : null;
    return (
      <NotFoundPanel
        title="Design not found"
        icon="search"
        testId="design-not-found"
        actions={
          back && (
            <LinkButton href={back} variant="primary" icon="back" className="h-10">
              Back to the tech brief
            </LinkButton>
          )
        }
      >
        <p>{DESIGN_MISSING}</p>
      </NotFoundPanel>
    );
  }
  if (error) {
    const back = specQ.data ? briefHref(specQ.data) : null;
    return (
      <Page>
        <PageHeader title="Design" testId="page-header" />
        <ErrorNote>{error}</ErrorNote>
        {back && (
          <div className="mt-3">
            <LinkButton href={back}>Back to the tech brief</LinkButton>
          </div>
        )}
      </Page>
    );
  }
  const spec = specQ.data;
  const d = designQ.data;
  // Who may comment or decide comes from the role's capabilities: until they answer, the page
  // would offer a viewer's review to anyone.
  if (!spec || !d || !(capsReady || capsError)) return <LoadingState />;

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
  // as the API's review_design; approve_version is the same rule on the spec's own approach
  // (_may_approve_engineering): the approver role on its route, owners past any item.
  const named = spec.engineering_approver_ids;
  const engineer = named.length === 0 || (!!me?.user_id && named.includes(me.user_id));
  const roles = {
    comment: can("review_design_artifact", true),
    approverRole: can("approve_version", true),
    decide: can("approve_version", engineer) && can("review_design_artifact", engineer),
    owner: can("review_design_artifact"),
  };
  const fresh = FRESHNESS[v.freshness];
  const running = v.freshness === "potentially_stale" && !!spec.regeneration_run_id;
  const view = spec.stale.find((s) => s.artifact_version_id === v.id);
  const rawReasons = [...new Set([...(view?.reasons ?? []), ...(d.lineage?.reasons ?? [])])];
  const reasons = [...new Set(rawReasons.map((r) => reasonText(r, words)))];
  const status = VERSION_STATUS[v.status];
  const chipsOf = (kind: ChipKind) => (
    <>
      <Chip kind={kind}>{DESIGN_KIND[d.kind] ?? d.kind}</Chip>
      <Chip kind={status.kind}>{status.label}</Chip>
      <Chip kind={fresh.kind} dot>
        {running ? `${fresh.label} · regeneration running` : fresh.label}
      </Chip>
    </>
  );
  const chips = chipsOf("line");

  const inspector = (
    <ReviewInspector
      spec={spec}
      d={d}
      shown={shown}
      brief={brief}
      reasons={reasons}
      words={words}
      chips={chipsOf("na")}
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
            <Link href={brief} className="inline-flex items-center gap-1 hover:text-text hover:underline">
              <Icon name="back" size={16} />
              {spec.request.title}
            </Link>
          ) : undefined
        }
        title={d.title}
        suffix={`v${v.number}`}
        phoneTitle
        status={chips}
        action={
          phone ? (
            <Button variant="primary" onClick={() => setSheetOpen(true)}>
              Review
            </Button>
          ) : undefined
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
            {running ? "Potentially stale, regeneration running" : "Potentially stale"}
            {reasons.length > 0 && `: ${reasons.join("; ")}`}. Review or reconcile it on the tech brief before approving.
          </Notice>
        )}
        {shown
          .filter((o) => o.removed.length > 0)
          .map((o) => (
            <Notice key={o.name} tone="info" testId="sanitised">
              Sanitised: Oracle removed {o.removed.join("; ")} from {o.title ?? o.name} when it stored it.
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
                  items={d.outputs.map((o) => ({ value: o.name, label: o.title ?? o.name }))}
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
                <Chip key={k} kind={rawReasons.some((r) => r.includes(k)) ? "warn" : "line"}>
                  {sectionName(words, k)}
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
  return r?.title ?? "a requirement";
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
      {/* qa-docs-35: the file by its title; its name, type, size and fingerprint in a closed Details. */}
      <figcaption className="flex flex-wrap items-start gap-x-2.5 gap-y-1 border-b border-line bg-surface2 px-2.5 py-1.5 text-[13px] text-text2">
        <b className="min-w-0 font-semibold break-words text-text">{output.title ?? output.name}</b>
        <details data-testid="file-details" className="ml-auto min-w-0">
          <summary className="cursor-pointer select-none hover:text-text">Details</summary>
          <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
            <dt>File</dt>
            <dd className="break-words text-text">{output.name}</dd>
            <dt>Type</dt>
            <dd className="text-text">{MEDIA[output.media_type] ?? output.media_type}</dd>
            <dt>Size</dt>
            <dd className="tnum text-text">{kb(output.size_bytes)}</dd>
            <dt>Fingerprint</dt>
            <dd className="text-text" title={output.sha256}>
              {shortHash(output.sha256)}
            </dd>
          </dl>
        </details>
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
            className={`block w-full rounded border-0 bg-white ${output.media_type === "text/html" ? "h-[520px] max-[600px]:h-[440px]" : "h-[360px] max-[600px]:h-[220px]"}`}
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
  words,
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
  words: PrdWords;
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
        <VerdictSection spec={spec} d={d} brief={brief} roles={roles} readOnly={readOnly} post={post} />
      </InspectorSection>
      <AnnotationsSection spec={spec} words={words} outputs={shown} roles={roles} meId={meId} post={post} />
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
        <VersionMeta spec={spec} d={d} reasons={reasons} words={words} meId={meId} />
      </InspectorSection>
    </Inspector>
  );
}

function VerdictSection({
  spec,
  d,
  brief,
  roles,
  readOnly,
  post,
}: {
  spec: Spec;
  d: Design;
  brief: string | null;
  roles: Roles;
  readOnly: boolean;
  post: (body: Schemas["DesignReviewIn"]) => Promise<void>;
}) {
  const v = d.version;
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const stale = v.freshness === "potentially_stale";
  if (readOnly) {
    const latest = spec.design?.find((a) => a.request_id === d.request_id && a.version.id !== v.id)?.version;
    if (v.status === "superseded" && latest) {
      return (
        <Notice tone="info" action={<LinkButton href={designHref(spec.request.id, latest.id)}>Open v{latest.number}</LinkButton>}>
          v{latest.number} replaced this version. Comments are still allowed; verdicts are not.
        </Notice>
      );
    }
    return <Notice tone="info">{`Version ${v.number} is ${VERSION_STATUS[v.status].label.toLowerCase()}`}: comments are still allowed; verdicts are not.</Notice>;
  }
  if (!roles.comment) return <Notice tone="info">You can read this review. Commenting needs the commenter role.</Notice>;
  const named = spec.engineering_approvers ?? [];
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
  // qa-docs-67: when Approve is off it says why, once (the stale notice is on the page, not here too).
  const approveOff = !roles.decide
    ? null
    : v.status === "approved"
      ? "This version is already approved."
      : stale
        ? "Approve opens once this version is reviewed or reconciled on the tech brief: it may be stale."
        : null;
  return (
    <div className="flex flex-col gap-2.5">
      {approvedLine}
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
      {approveOff && (
        <p data-testid="approve-off" className="text-[13px] text-text2">
          {approveOff}
          {stale && brief && (
            <>
              {" "}
              <Link href={brief} className="font-medium text-accent-ink hover:underline">
                Go to the tech brief
              </Link>
            </>
          )}
        </p>
      )}
      {roles.decide && (
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-semibold text-text2">{NOTE_LABEL}</span>
          <textarea className={TEXTAREA} placeholder="Say why" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
      )}
      {err && <ErrorNote>{err}</ErrorNote>}
      {!roles.decide ? (
        <>
          <Notice tone="info">Only the spec&apos;s engineering approvers (or an owner) decide on it.</Notice>
          <p className="text-[13px] text-text2">
            {named.length > 0
              ? `Engineering approver${named.length === 1 ? "" : "s"} named on this spec: ${named.map((x) => x.name).join(", ")}`
              : "No engineering approvers are named on this spec."}
          </p>
        </>
      ) : (
        <p className="text-[13px] text-text2">
          {roles.owner
            ? "Owners always decide. Approving supersedes the previously approved version."
            : named.length > 0
              ? "You are a named engineering approver for this spec."
              : "No engineering approvers are named on this spec, so any approver decides."}
        </p>
      )}
    </div>
  );
}

function AnnotationsSection({
  spec,
  words,
  outputs,
  roles,
  meId,
  post,
}: {
  spec: Spec;
  words: PrdWords;
  outputs: Output[];
  roles: Roles;
  meId: string | null;
  post: (body: Schemas["DesignReviewIn"]) => Promise<void>;
}) {
  const [quiet, setQuiet] = useState(false);
  const total = outputs.reduce((n, o) => n + o.annotations.length, 0);
  const counts = { All: total, "Without comments": outputs.reduce((n, o) => n + o.annotations.filter((a) => a.reviews.length === 0).length, 0) };
  const filter = (
    <span className="inline-flex gap-1">
      {(["All", "Without comments"] as const).map((label) => {
        const on = (label === "Without comments") === quiet;
        return (
          <button
            key={label}
            type="button"
            aria-pressed={on}
            onClick={() => setQuiet(label === "Without comments")}
            className={`rounded-full px-2.5 py-0.5 text-[13px] whitespace-nowrap font-semibold ${on ? "bg-accent text-on-accent" : "bg-surface2 text-text2 hover:text-text"}`}
          >
            {label} <span className="tnum">{counts[label]}</span>
          </button>
        );
      })}
    </span>
  );
  const label = outputs.length === 1 ? `Annotations · ${outputs[0].title ?? outputs[0].name}` : "Annotations";
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
                {outputs.length > 1 && <p className="text-[13px] font-semibold text-text2">{o.title ?? o.name}</p>}
                {rows.length === 0 ? (
                  <p className="text-sm text-text2">{quiet ? "Every annotation here has comments." : "No annotations on this file."}</p>
                ) : (
                  <ul className="flex flex-col gap-3">
                    {rows.map(({ a, n }) => (
                      <AnnotationRow
                        key={a.id}
                        spec={spec}
                        words={words}
                        a={a}
                        n={n}
                        output={o.name}
                        many={outputs.length > 1}
                        canComment={roles.comment}
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
  spec,
  words,
  a,
  n,
  output,
  many,
  canComment,
  meId,
  post,
}: {
  spec: Spec;
  words: PrdWords;
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
          {a.section_key && <Chip kind="na">{sectionName(words, a.section_key)}</Chip>}
          {a.requirement_ids.map((id) => (
            <Chip key={id} kind="line">
              {requirementName(spec, id)}
            </Chip>
          ))}
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

/** An event's actor is "<principal kind>:<id>" (a member or an API token); "system" is Oracle. */
const ACTOR_KIND = new Map([
  ["user", "A member"],
  ["token", "An API token"],
]);

/** The API names each event's author (actor_name); yours reads "<name> (you)". */
function actorName(e: ReviewEvent, meId: string | null): string {
  const name = e.actor_name ?? ACTOR_KIND.get(e.actor.split(":")[0]) ?? "Oracle";
  if (meId && e.actor === `user:${meId}`) return e.actor_name ? `${e.actor_name} (you)` : "You";
  return name;
}

function EventRow({ e, meId }: { e: ReviewEvent; meId: string | null }) {
  const kind = EVENT[e.kind];
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        <b>{actorName(e, meId)}</b>
        <Chip kind={kind.kind}>{kind.label}</Chip>
        <span className="tnum text-xs text-text-faint">{formatDateTime(e.created_at)}</span>
      </div>
      {e.body && <p className="text-sm break-words text-text2">{e.body}</p>}
    </div>
  );
}

/** A comment box: Comment is off until there is text; any refusal from the API shows under it. */
function Composer({ label, send }: { label: string; send: (body: string) => Promise<void> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const empty = !text.trim();
  const submit = async () => {
    if (empty) return;
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
      {/* qa-docs-11: an empty comment cannot be sent; the hint says why the button is off. */}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="solid" disabled={busy || empty} onClick={() => void submit()}>
          Comment
        </Button>
        {empty && <span className="text-[13px] text-text2">Write a comment first</span>}
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

/** Who approved the version: the name on its latest approval event by that person. */
function approverName(d: Design, meId: string | null): string {
  const v = d.version;
  const e = d.reviews.findLast((x) => x.kind === "approved" && x.actor === `user:${v.approved_by}`);
  if (e) return actorName(e, meId);
  return meId && v.approved_by === meId ? "you" : "a member";
}

function VersionMeta({ spec, d, reasons, words, meId }: { spec: Spec; d: Design; reasons: string[]; words: PrdWords; meId: string | null }) {
  const v = d.version;
  const p = v.provenance as Record<string, unknown>;
  const str = (k: string) => (typeof p[k] === "string" || typeof p[k] === "number" ? String(p[k]) : null);
  const reqs = Array.isArray(p.requirement_ids) ? (p.requirement_ids as string[]) : [];
  const runId = str("run_id");
  const deps = d.lineage?.dependencies ?? [];
  const prd = words.title ?? "The PRD";
  // qa-docs-35: names, not ids; the technical record stays in a closed Details.
  const technical = [
    str("prompt_version") && { k: "Prompt", value: str("prompt_version") },
    str("runner_profile") && { k: "Runner", value: str("runner_profile") },
    v.composition_revision != null && { k: "Composition revision", value: String(v.composition_revision) },
    v.content_hash && { k: "Content fingerprint", value: shortHash(v.content_hash), title: v.content_hash },
  ].filter((x): x is { k: string; value: string; title?: string } => !!x);
  return (
    <div className="flex flex-col">
      {v.summary && <p className="mb-1.5 text-sm">{v.summary}</p>}
      <MetaRow k="Made by">
        {runId ? (
          <>
            Oracle,{" "}
            <Link href={`/runs/${runId}`} className="text-accent-ink hover:underline">
              in a run
            </Link>
          </>
        ) : str("origin") === "upload" ? (
          "Uploaded"
        ) : (
          "A person"
        )}
      </MetaRow>
      {str("prd_version") && (
        <MetaRow k="From PRD">
          {prd} v{str("prd_version")}
        </MetaRow>
      )}
      {reqs.length > 0 && <MetaRow k="Requirements">{reqs.map((id) => requirementName(spec, id)).join(", ")}</MetaRow>}
      <MetaRow k="Created">
        <span className="tnum">{formatDateTime(v.created_at)}</span>
      </MetaRow>
      {v.approved_at && (
        <MetaRow k="Approved">
          <span className="tnum">
            {formatDateTime(v.approved_at)}
            {v.approved_by && ` · by ${approverName(d, meId)}`}
          </span>
        </MetaRow>
      )}
      <MetaRow k="Depends on">
        {deps.length > 0
          ? deps.map((dep) => (
              <span key={dep.id} className="block">
                {dep.upstream.document_slug === words.slug || dep.upstream.document_kind === "prd" ? prd : "A document"}
                {dep.upstream.version_number != null && ` v${dep.upstream.version_number}`}
                {dep.upstream.section_key && `, ${sectionName(words, dep.upstream.section_key)}`}{" "}
                <Chip kind={FRESHNESS[dep.freshness].kind}>{FRESHNESS[dep.freshness].label}</Chip>
              </span>
            ))
          : reasons.length > 0
            ? reasons.join("; ")
            : words.slug
              ? prd
              : "Nothing recorded"}
      </MetaRow>
      {technical.length > 0 && (
        <details data-testid="version-details" className="mt-1.5 text-sm">
          <summary className="cursor-pointer text-text2 select-none hover:text-text">Technical details</summary>
          <div className="mt-1 flex flex-col">
            {technical.map((t) => (
              <MetaRow key={t.k} k={t.k}>
                <span title={t.title}>{t.value}</span>
              </MetaRow>
            ))}
          </div>
        </details>
      )}
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
