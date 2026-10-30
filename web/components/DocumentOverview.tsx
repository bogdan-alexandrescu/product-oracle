"use client";

import { RoleBadge } from "@/components/RoleBadge";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { DocStatusChip } from "@/app/documents/_components/DocStatusChip";
import { BuildRoadmapButton, SourceLink } from "@/components/BuildRoadmap";
import { DocToolbar } from "@/components/DocToolbar";
import { DOC_MISSING, DocumentNotFound } from "@/components/DocumentNotFound";
import { RoadmapSharing } from "@/components/share/RoadmapSharing";
import { PricingDecide } from "@/components/PricingDecide";
import { DraftWithOracleButton, isTemplateOnly } from "@/components/DraftWithOracle";
import {
  Button,
  Chip,
  DataTable,
  Inspector,
  InspectorRow,
  InspectorSection,
  LinkButton,
  Page,
  PageHeader,
  PageSkeleton,
  Panel,
  Split,
  type Column,
} from "@/components/ds";
import { ORACLE_WORK } from "@/components/JobsPanel";
import { RequestSpecDialog, SPEC_STATE, specHref, useSpecs, type SpecSummary } from "@/components/RequestSpec";
import { Campaigns, ReviewSettingsButton, SectionAssignments } from "@/components/ReviewSetup";
import { FRESHNESS, sizeText } from "@/components/tech-brief";
import { ErrorNote, Loading } from "@/components/ui";
import { api, ApiError, unwrap, type Schemas, type VersionSummary } from "@/lib/api/client";
import { formatDate, formatDateTime, plural } from "@/lib/format";
import { useMe } from "@/lib/me";
import { useScreenSubject } from "@/lib/screen-subject";
import { NAMES_FAILED, useTemplateNames } from "@/lib/template-names";
import { useQuery, type Query } from "@/lib/use-query";
import { versionHref } from "@/lib/version-href";

/** A template or theme beside the title, by its name: a small hairline pill. */
const META = "inline-flex min-h-[26px] max-w-full items-center rounded-full border border-line-strong px-2.5 text-[13px] text-text2";

/** The one empty marker on this page (qa-docs-42). */
const NONE = "–";

type SectionState = Schemas["SectionStateOut"];

/**
 * The sections a person assigns (qa-docs-45): the opening section that carries the document's
 * title reads as the Introduction, as the version page names it (and may be assigned, as it
 * may be reviewed); not another heading that only repeats the title, and not a subsection
 * that only repeats its parent's heading ("Sources" under "Sources and data points").
 */
export function assignableSections(states: SectionState[], title: string): SectionState[] {
  const norm = (h: string) => h.replace(/^[\d.]+\s+/, "").trim().toLowerCase();
  const t = norm(title);
  return states.flatMap((s, i) => {
    if (i === 0 && title && s.heading.trim() === title.trim()) return [{ ...s, heading: "Introduction" }];
    const h = norm(s.heading);
    if (h === t || `${h} prd` === t || h === `${t} prd`) return [];
    const prev = i > 0 ? norm(states[i - 1]!.heading) : "";
    return prev && prev !== h && prev.startsWith(`${h} `) ? [] : [s];
  });
}

function versionColumns(doc: string, kind: string | null | undefined, latest: number | null | undefined): Column<VersionSummary>[] {
  return [
    {
      key: "number",
      header: "Version",
      width: "120px",
      cell: (v) => (
        <Link href={versionHref(doc, kind, v.number)} className="font-medium text-text hover:underline">
          Version {v.number}
        </Link>
      ),
    },
    {
      key: "state",
      header: "State",
      cell: (v) => (
        <span className="inline-flex items-center gap-1.5">
          {v.approved_at ? (
            <Chip kind="pass" dot>
              Approved
            </Chip>
          ) : v.number === latest ? (
            <Chip kind="now">Latest</Chip>
          ) : null}
          {v.warnings.length > 0 && (
            <Chip kind="warn" title={v.warnings.map((w) => w.message).join("\n")}>
              {plural(v.warnings.length, "warning")}
            </Chip>
          )}
        </span>
      ),
    },
    {
      key: "created",
      header: "Imported",
      width: "176px",
      hideOnPhone: true,
      className: "tnum text-text2",
      cell: (v) => formatDateTime(v.created_at),
    },
    {
      key: "diff",
      header: "Changes",
      width: "128px",
      align: "right",
      phone: "action",
      cell: (v) =>
        v.number > 1 ? (
          // qa-docs-25: the link colour (accent), which reads as a link in dark mode too, where
          // accent-ink is a near-white tint.
          <Link href={`/documents/${doc}/diff?from=${v.number - 1}&to=${v.number}`} className="text-accent hover:underline">
            Diff from v{v.number - 1}
          </Link>
        ) : (
          <span className="text-text2">{NONE}</span>
        ),
    },
  ];
}

function VersionInspector({
  doc,
  kind,
  v,
  latest,
}: {
  doc: string;
  kind: string | null | undefined;
  v: VersionSummary;
  latest: number | null | undefined;
}) {
  const { can } = useMe();
  return (
    <Inspector
      testId="version-inspector"
      label={`v${v.number} details`}
      eyebrow="Version · selected"
      title={`v${v.number}`}
      chips={
        <>
          {v.approved_at && <Chip hero>Approved</Chip>}
          {v.number === latest && <Chip kind="now" hero>Latest</Chip>}
        </>
      }
      action={
        // qa-docs-46: the header's Open latest opens the latest; an earlier version opens here.
        // qa-docs-68: a roadmap's header has no Open latest (its page shows the latest), so here.
        (v.number !== latest || kind === "roadmap") && (
          <LinkButton variant="hero" href={versionHref(doc, kind, v.number)}>
            {`Open v${v.number}`}
          </LinkButton>
        )
      }
    >
      <InspectorSection label="Details">
        <InspectorRow value={<span data-testid="version-approved">{v.approved_at ? formatDate(v.approved_at) : "Not approved"}</span>}>
          Approved
        </InspectorRow>
        <InspectorRow value={v.warnings.length ? plural(v.warnings.length, "warning") : "None"}>Warnings</InspectorRow>
        <InspectorRow value={formatDateTime(v.created_at)}>Imported</InspectorRow>
        {v.imported_by_name && (
          <InspectorRow
            value={
              <span data-testid="version-importer">
                {v.imported_by_name}
              </span>
            }
          >
            Imported by
          </InspectorRow>
        )}
        {v.imported_again && (
          // A run's refused draft a person imported again: who and when (Company time zone).
          <InspectorRow value={<span data-testid="version-imported-again">{v.imported_again}</span>}>Retried</InspectorRow>
        )}
      </InspectorSection>
      {v.source && (
        <InspectorSection label="Source">
          <SourceLink source={v.source} />
        </InspectorSection>
      )}
      {v.warnings.length > 0 && (
        <InspectorSection label="Warnings">
          <ul className="flex flex-col gap-2">
            {v.warnings.map((w, i) => (
              <li key={i} className="rounded-button bg-warn-bg px-3 py-2 text-sm text-warn">
                {w.message}
              </li>
            ))}
          </ul>
        </InspectorSection>
      )}
      {/* #370: Oracle's work is where its jobs are run (POST /v1/documents/{doc}/llm-jobs). */}
      {can("create_llm_job") && (
        <InspectorSection>
          <Link href={`/documents/${doc}/v/${v.number}?tab=history#${ORACLE_WORK}`} className="text-sm font-medium text-accent-ink hover:underline">
            Oracle&apos;s work on v{v.number}
          </Link>
        </InspectorSection>
      )}
    </Inspector>
  );
}

type LatestOf = (slug: string | null | undefined) => number | null;

/** A spec document's latest version, by its slug (qa-docs-66): only fetched when a spec has one. */
function useSpecLatest(specs: SpecSummary[]): LatestOf {
  const needDocs = specs.some((s) => s.document_slug);
  const specDocs = useQuery(`documents|spec|${needDocs}`, () =>
    needDocs ? unwrap(api.GET("/v1/documents", { params: { query: { kind: "spec" } } })) : Promise.resolve(null),
  );
  return (slug: string | null | undefined) => specDocs.data?.find((x) => x.slug === slug)?.latest_version ?? null;
}

/** A requested spec's row: its title, depth, state, freshness and Open spec. */
function SpecRow({ s, latestOf }: { s: SpecSummary; latestOf: LatestOf }) {
  const state = SPEC_STATE[s.state];
  const fresh = s.freshness && s.freshness !== "fresh" && s.state !== "stale" ? FRESHNESS[s.freshness as keyof typeof FRESHNESS] : null;
  // qa-docs-66: a spec opens on its document's latest version (an edit after the run adds one
  // the spec's own record does not count).
  const latest = latestOf(s.document_slug);
  return (
    <li data-testid="engineering-spec" className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
      <span className="min-w-0 font-semibold break-words">{s.request.title}</span>
      <span className="text-sm text-text2">{s.depth === "full" ? "Full engineering spec" : "Tech brief"}</span>
      <span className="flex-1" />
      <Chip kind={state.kind} dot>
        {state.label}
      </Chip>
      {fresh && <Chip kind={fresh.kind}>{fresh.label}</Chip>}
      <Link
        href={latest != null ? `/documents/${s.document_slug}/v/${latest}` : specHref(s)}
        aria-label={`Open ${s.request.title}`}
        className="text-sm font-medium text-accent-ink hover:underline"
      >
        Open spec
      </Link>
    </li>
  );
}

/**
 * The PRD's tech briefs (F5-1, one per feature, each opening its brief page), and the specs
 * requested at the Tech brief depth (qa-docs-29: a technical brief is listed with the tech
 * briefs, not under Engineering specs). Hidden until there is one; a failed load shows its error.
 */
function TechBriefs({ doc, specs, latestOf }: { doc: string; specs: SpecSummary[]; latestOf: LatestOf }) {
  const q = useQuery(`tech-briefs|${doc}`, () => unwrap(api.GET("/v1/tech-briefs", { params: { query: { prd: doc } } })));
  const briefs = q.data ?? [];
  if (q.error) {
    return (
      <Panel title="Tech briefs" testId="tech-briefs">
        <div className="p-4">
          <ErrorNote>{q.error}</ErrorNote>
        </div>
        {specs.length > 0 && (
          <ul className="divide-y divide-line border-t border-line">
            {specs.map((s) => (
              <SpecRow key={s.request.id} s={s} latestOf={latestOf} />
            ))}
          </ul>
        )}
      </Panel>
    );
  }
  if (briefs.length + specs.length === 0) return null;
  return (
    <Panel title="Tech briefs" count={briefs.length + specs.length} testId="tech-briefs">
      <ul className="divide-y divide-line">
        {briefs.map((b) => (
          <li key={b.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
            <Link href={`/briefs/${b.id}`} className="min-w-0 font-semibold break-words text-accent-ink hover:underline">
              {b.feature.title}
            </Link>
            <span className="text-sm text-text2">{sizeText(b.size)}</span>
            <span className="flex-1" />
            <Chip kind={FRESHNESS[b.freshness].kind} dot>
              {FRESHNESS[b.freshness].label}
            </Chip>
          </li>
        ))}
        {specs.map((s) => (
          <SpecRow key={s.request.id} s={s} latestOf={latestOf} />
        ))}
      </ul>
    </Panel>
  );
}

/**
 * F5 lane 3: the PRD's full engineering specs, newest first, each with its state, freshness and
 * Open; Request spec (approvers and owners, once a version is approved) picks one of the
 * PRD's approved roadmap items and opens the Request spec dialog. A spec requested at the
 * Tech brief depth is listed under Tech briefs (qa-docs-29).
 */
function EngineeringSpecs({ doc, approved, q, latestOf }: { doc: string; approved: boolean; q: Query<SpecSummary[]>; latestOf: LatestOf }) {
  const { can } = useMe();
  const [open, setOpen] = useState(false);
  const may = approved && can("create_spec_request");
  const plan = useQuery(`plan|approved|specs|${doc}|${open}`, () =>
    open ? unwrap(api.GET("/v1/plan", { params: { query: { scope: "approved" } } })) : Promise.resolve(null),
  );
  const items = (plan.data?.items ?? []).filter((i) => i.prd?.slug === doc && i.origin === "approved");
  const specs = (q.data ?? []).filter((s) => s.depth === "full");
  const briefs = (q.data ?? []).length - specs.length;
  return (
    <Panel
      title="Engineering specs"
      count={specs.length || undefined}
      testId="engineering-specs"
      tools={may ? <Button onClick={() => setOpen(true)}>Request spec</Button> : undefined}
    >
      {q.error ? (
        <div className="p-4">
          <ErrorNote>{q.error}</ErrorNote>
        </div>
      ) : !q.data ? (
        <div className="px-4">
          <Loading />
        </div>
      ) : specs.length === 0 ? (
        // qa-docs-17: what unlocks a spec, and who asks for one.
        <p data-testid="engineering-specs-empty" className="px-4 py-3 text-text2">
          {briefs > 0
            ? `No full engineering spec yet. ${briefs === 1 ? "The tech brief requested is" : "The tech briefs requested are"} under Tech briefs.`
            : !approved
              ? can("publish_version")
                ? "No engineering spec yet. Approve a version to request a spec."
                : "No engineering spec yet. A spec can be requested once a version is approved."
              : may
                ? "No engineering spec yet. Request one for an approved roadmap item."
                : "No engineering spec yet. An approver or owner can request one."}
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {specs.map((s) => (
            <SpecRow key={s.request.id} s={s} latestOf={latestOf} />
          ))}
        </ul>
      )}
      {open && plan.data && <RequestSpecDialog prd={doc} items={items} onClose={() => setOpen(false)} />}
      {open && plan.error && <ErrorNote>{plan.error}</ErrorNote>}
    </Panel>
  );
}

export function DocumentOverview({ doc }: { doc: string }) {
  const router = useRouter();
  // qa-shell-1: a document the API does not have says so in words, never the API's own text.
  const q = useQuery(`doc|${doc}`, () =>
    unwrap(api.GET("/v1/documents/{doc}", { params: { path: { doc } } })).catch((e: unknown) => {
      throw e instanceof ApiError && e.status === 404 ? new ApiError(404, DOC_MISSING) : e;
    }),
  );
  const d = q.data;
  const versions = [...(d?.versions ?? [])].reverse();
  const [picked, setPicked] = useState<number | null>(null);
  const selected = versions.find((v) => v.number === picked) ?? versions[0] ?? null;
  // Review setup (#342): each section of the latest version, its owner, reviewers and due date.
  const latest = d?.latest_version ?? null;
  const statesQ = useQuery(`section-states|${doc}|${latest}`, () =>
    latest == null
      ? Promise.resolve(null)
      : unwrap(api.GET("/v1/documents/{doc}/versions/{n}/section-states", { params: { path: { doc, n: latest } } })),
  );
  const states = assignableSections(statesQ.data?.sections ?? [], d?.title ?? "");
  const names = useTemplateNames();
  // F5 lane 3: the PRD's requested specs, split by depth between Tech briefs and Engineering specs (qa-docs-29).
  const specsQ = useSpecs(d?.kind === "prd" ? doc : null);
  const specLatest = useSpecLatest(specsQ.data ?? []);
  const templateOnly = isTemplateOnly(d?.kind, d?.versions ?? []);
  // G7 3.3: the panel is about this document (its latest version).
  useScreenSubject(d && versions[0] ? { kind: "document", subject: { document_id: d.id, version: versions[0].number } } : null, d?.title);
  // A missing document: the one not-found page, no crumb waiting on a title that never comes.
  if (q.error === DOC_MISSING) return <DocumentNotFound />;
  return (
    <div>
      {/* qa-docs-24: the title and its status show once, in the header below; the crumb leads back.
          qa-docs-27: the header's Open latest is the one Open, so the ⋯ menu repeats none. */}
      <DocToolbar doc={d} withTitle={false} openItem={false} />
      <Page>
        {q.error && <ErrorNote>{q.error}</ErrorNote>}
        {!d && !q.error && <PageSkeleton bare />}
        {d && (
          <>
            <PageHeader
              title={d.title}
              // qa-docs-6: the version the panel shows (the latest until another is picked).
              suffix={selected ? `v${selected.number}` : d.latest_version != null ? `v${d.latest_version}` : undefined}
              status={
                <>
                  <DocStatusChip status={d.status} />
                  <RoleBadge />
                  {d.template && (
                    <span className={META} data-testid="doc-template" title={d.template_version ? `Template, its version ${d.template_version}` : "Template"}>
                      Template: {names.template(d.template)}
                      {/* qa-docs-68: a roadmap's header is busier (sharing below it): its theme shares the template's pill. */}
                      {d.kind === "roadmap" && d.theme && ` · Theme: ${names.theme(d.theme)}`}
                    </span>
                  )}
                  {d.theme && !(d.kind === "roadmap" && d.template) && (
                    <span className={META} data-testid="doc-theme" title="Theme">
                      Theme: {names.theme(d.theme)}
                    </span>
                  )}
                  {d.source && (
                    <span className="text-sm text-text2">
                      <SourceLink source={d.source} />
                    </span>
                  )}
                </>
              }
              action={
                <>
                  {d.kind === "prd" && <LinkButton href={`/documents/${d.slug}/composition`}>Composition</LinkButton>}
                  {d.kind === "prd" && <BuildRoadmapButton prd={d} />}
                  {d.kind === "pricing" && <PricingDecide slug={d.slug} />}
                  {statesQ.data && <ReviewSettingsButton doc={doc} sections={states} onSaved={statesQ.reload} />}
                  {templateOnly && <DraftWithOracleButton slug={d.slug} />}
                  {/* qa-docs-68: a roadmap's page already shows its latest version (the audience view). */}
                  {d.latest_version != null && d.kind !== "roadmap" && (
                    <LinkButton variant={templateOnly ? "secondary" : "primary"} href={versionHref(doc, d.kind, d.latest_version)}>
                      Open latest (v{d.latest_version})
                    </LinkButton>
                  )}
                </>
              }
            />
            {names.failed && (d.template || d.theme) && (
              <p data-testid="template-names-failed" role="status" className="mb-3 text-[13px] text-text2">
                {NAMES_FAILED}
              </p>
            )}
            {d.kind === "roadmap" && <RoadmapSharing d={d} />}
            <Split inspector={selected ? <VersionInspector doc={doc} kind={d.kind} v={selected} latest={d.latest_version} /> : undefined}>
              <Panel title="Versions" count={versions.length}>
                <DataTable
                  label="Versions"
                  testId="versions-table"
                  columns={versionColumns(doc, d.kind, d.latest_version)}
                  rows={versions}
                  rowKey={(v) => String(v.number)}
                  selected={selected ? String(selected.number) : null}
                  onSelect={(k) => setPicked(Number(k))}
                  onActivate={(k) => router.push(versionHref(doc, d.kind, k))}
                  empty="No versions yet"
                />
              </Panel>
              {d.kind === "prd" && <TechBriefs doc={doc} specs={(specsQ.data ?? []).filter((s) => s.depth !== "full")} latestOf={specLatest} />}
              {d.kind === "prd" && <EngineeringSpecs doc={doc} approved={d.versions.some((v) => v.approved_at)} q={specsQ} latestOf={specLatest} />}
              {statesQ.error && <ErrorNote>{statesQ.error}</ErrorNote>}
              {statesQ.data && <SectionAssignments doc={doc} states={states} onSaved={statesQ.reload} />}
              {latest != null && <Campaigns doc={doc} />}
            </Split>
          </>
        )}
      </Page>
    </div>
  );
}
