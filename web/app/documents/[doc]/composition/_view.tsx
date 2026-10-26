"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useState, useSyncExternalStore } from "react";

import { DocCrumb } from "@/components/DocToolbar";
import { Button, Chip, DataTable, FilterChips, Notice, Page, PageHeader, Panel, SegmentedControl, Sheet, Split, type Column } from "@/components/ds";
import { Loading } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { formatDate } from "@/lib/format";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

import { CatalogTab } from "./_catalog";
import { ConfirmStep, EMPTY_INPUTS, PublishStep } from "./_confirm";
import { HistoryTab } from "./_history";
import {
  DECIDED_BY,
  FILTER_LABEL,
  NO_CHANGES,
  POLICY_SOURCE,
  SELECTION_LABEL,
  diffLine,
  hasProblems,
  matches,
  sortModules,
  toggle,
  type Changes,
  type Filter,
  type InspectorOut,
  type Module,
  type Problem,
  type Recommendation,
} from "./_lib";
import { ModuleDetail } from "./_module-inspector";
import { PolicyTab } from "./_policy";

const PHONE = "(max-width: 600px)";
const MONO = "font-mono text-[13px]";
const META = "inline-flex h-[26px] items-center rounded-full border border-line-strong px-2.5 font-mono text-[13px] text-text2";

function subscribePhone(onChange: () => void) {
  const mq = window.matchMedia(PHONE);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function useIsPhone(): boolean {
  return useSyncExternalStore(
    subscribePhone,
    () => window.matchMedia(PHONE).matches,
    () => false,
  );
}

type Tab = "modules" | "catalog" | "policy" | "history";
type Source = "working" | "current" | "preview";

const TABS: { value: Tab; label: string }[] = [
  { value: "modules", label: "Modules" },
  { value: "catalog", label: "Catalog" },
  { value: "policy", label: "Company policy" },
  { value: "history", label: "History" },
];

/** The Composition inspector of a PRD (v2 screen 1, picks.md 1). */
export function CompositionView({ doc }: { doc: string }) {
  const { can } = useMe();
  const phone = useIsPhone();
  const pathname = usePathname();
  const params = useSearchParams();
  const tab = (TABS.find((t) => t.value === params.get("tab"))?.value ?? "modules") as Tab;
  const docQ = useQuery(`doc:${doc}`, () => unwrap(api.GET("/v1/documents/{doc}", { params: { path: { doc } } })));
  const q = useQuery(`composition:${doc}`, () => unwrap(api.GET("/v1/documents/{doc}/composition", { params: { path: { doc } } })));
  const [changes, setChanges] = useState<Changes>(NO_CHANGES);
  const [confirming, setConfirming] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [result, setResult] = useState<{ text: string; problems: Problem[] } | null>(null);
  const [view, setView] = useState<Source | null>(null);
  const [preview, setPreview] = useState<Recommendation | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [picked, setPicked] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);

  const mayConfirm = can("confirm_composition_revision");
  const mayPublish = can("publish_composition");
  // A module whose contract asks for the owner role: only an owner adds or removes it.
  const ownerRole = can("put_module_policy");
  const data = q.data;
  const next = (data?.head_revision ?? 0) + 1;

  async function loadPreview() {
    setPreviewError(null);
    try {
      setPreview(await unwrap(api.POST("/v1/compositions/recommend", { body: { ...EMPTY_INPUTS, document: doc } })));
      setView("preview");
    } catch (e) {
      setPreviewError(errorMessage(e));
    }
  }

  function done(out: InspectorOut, status: "confirmed" | "working") {
    const n = out.head_revision;
    q.setData(() => out);
    setChanges(NO_CHANGES);
    setConfirming(false);
    setView(null);
    setResult({
      text: status === "confirmed" ? `Rev ${n} confirmed.` : `Rev ${n} saved as a working draft. It supersedes nothing until confirmed.`,
      problems: out.problems,
    });
  }

  const tabs = (
    <SegmentedControl
      label="Composition views"
      value={tab}
      items={TABS.map((t) => ({ value: t.value, label: t.label, href: t.value === "modules" ? pathname : `${pathname}?tab=${t.value}` }))}
    />
  );

  let body;
  if (q.error && !data) {
    body = (
      <Notice tone="error" action={<Button onClick={() => q.reload()}>Retry</Button>}>
        {q.error}
      </Notice>
    );
  } else if (!data) {
    body = <Loading label="Loading the composition…" />;
  } else if (tab === "catalog") {
    body = <CatalogTab phone={phone} />;
  } else if (tab === "policy") {
    body = <PolicyTab phone={phone} prdModules={(data.working ?? data.current ?? data.recommendation)?.modules ?? []} prdTitle={docQ.data?.title ?? data.slug} />;
  } else if (tab === "history") {
    body = <HistoryTab data={data} />;
  } else {
    const sources: { value: Source; label: string; modules: Module[] }[] = [];
    if (data.working) sources.push({ value: "working", label: `Working rev ${data.working.number}`, modules: data.working.modules });
    if (data.current) sources.push({ value: "current", label: `Confirmed rev ${data.current.number}`, modules: data.current.modules });
    if (preview || data.recommendation) sources.push({ value: "preview", label: "Recommendation", modules: (preview ?? data.recommendation)!.modules });
    const source = sources.find((s) => s.value === view) ?? sources[0];
    const all = sortModules(source?.modules ?? []);
    const rows = all.filter((m) => matches(m, filter));
    const selected = all.find((m) => m.key === picked) ?? null;
    const count = (f: Filter) => all.filter((m) => matches(m, f)).length;
    const titleOf = (key: string) => all.find((m) => m.key === key)?.title ?? key;
    const detail = (m: Module, bare: boolean) => (
      <ModuleDetail
        m={m}
        changes={changes}
        canChange={mayConfirm}
        ownerOnly={m.required_review_role === "owner" && !ownerRole}
        onToggle={() => setChanges((c) => toggle(c, m.key, m.included))}
        bare={bare}
      />
    );
    const columns: Column<Module>[] = [
      { key: "order", header: "#", width: "48px", phone: "hide", cell: (m) => <span className="tnum text-text2">{m.included ? m.order : "—"}</span> },
      {
        key: "module",
        header: "Module",
        phone: "title",
        cell: (m) => (
          <span className="flex min-w-0 flex-col">
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="truncate font-medium">{m.title}</span>
              {changes.add.includes(m.key) && <Chip kind="acc">+ in draft</Chip>}
              {changes.remove.includes(m.key) && <Chip kind="warn">− in draft</Chip>}
              {m.field_problems.length > 0 && (
                <Chip kind="warn">
                  {m.field_problems.length} field problem{m.field_problems.length === 1 ? "" : "s"}
                </Chip>
              )}
              {m.condition_error && <Chip kind="warn">condition error</Chip>}
            </span>
            <span className={`${MONO} truncate text-text2`}>
              {m.key}
              {m.required_review_role === "owner" ? " · owner review" : ""}
            </span>
          </span>
        ),
      },
      { key: "selection", header: "Selection", width: "110px", cell: (m) => SELECTION_LABEL[m.selection] },
      {
        key: "decided",
        header: "Decided by",
        width: "150px",
        phoneLabel: "Decided by",
        cell: (m) => (m.decided_by === "policy" ? POLICY_SOURCE[m.policy_source] : DECIDED_BY[m.decided_by]),
      },
      {
        key: "layout",
        header: "Layout",
        width: "90px",
        cell: (m) => (
          <span className="tnum" title="B = brief sections, F = full sections">
            B {m.layer_impact.brief_sections.length} F {m.layer_impact.full_sections.length}
          </span>
        ),
      },
      { key: "version", header: "Version", width: "80px", align: "right", cell: (m) => <span className="tnum">{m.version}</span> },
      {
        key: "state",
        header: "State",
        width: "100px",
        phone: "action",
        cell: (m) => (
          <Chip kind={m.included ? "pass" : "na"} dot>
            {m.included ? "Included" : "Excluded"}
          </Chip>
        ),
      },
    ];
    const staged = changes.add.length + changes.remove.length > 0;
    body = (
      <Split inspector={!phone && selected ? detail(selected, false) : undefined}>
        {data.legacy && data.recommendation && (
          <Notice
            testId="legacy-notice"
            action={
              mayConfirm ? (
                <Button variant="solid" onClick={() => setConfirming(true)}>
                  Review and confirm rev 1
                </Button>
              ) : undefined
            }
          >
            This PRD has no composition yet. Oracle recommends {data.recommendation.summary.included} modules from {data.recommendation.packs.join(", ")}.
          </Notice>
        )}
        {previewError && <Notice tone="error">{previewError}</Notice>}
        <Panel
          title="Modules"
          count={`${all.filter((m) => m.included).length} of ${all.length} included`}
          tools={
            sources.length > 1 ? (
              <div data-testid="composition-source">
                <SegmentedControl label="Show" size="sm" value={source.value} onChange={setView} items={sources.map((s) => ({ value: s.value, label: s.label }))} />
              </div>
            ) : (
              <span data-testid="composition-source" className="text-sm text-text2">
                {source?.label}
              </span>
            )
          }
        >
          <div className="border-b border-line px-4 py-2.5">
            <FilterChips
              label="Filter modules"
              value={filter}
              onChange={setFilter}
              items={(Object.keys(FILTER_LABEL) as Filter[]).map((f) => ({ value: f, label: FILTER_LABEL[f], count: count(f) }))}
            />
          </div>
          <DataTable
            label="Modules"
            testId="composition-modules"
            columns={columns}
            rows={rows}
            rowKey={(m) => m.key}
            rowProps={(m) => ({ "data-module": m.key, "data-problems": hasProblems(m) ? "1" : undefined })}
            group={filter === "all" ? (m) => m.selection : undefined}
            groupLabel={(g) => SELECTION_LABEL[g as Module["selection"]]}
            selected={picked}
            onSelect={(k) => {
              setPicked(k);
              if (phone) setSheet(true);
            }}
            empty={
              <span className="flex flex-col items-center gap-2">
                No modules match “{FILTER_LABEL[filter]}”.
                <Button onClick={() => setFilter("all")}>Show all</Button>
              </span>
            }
          />
          <p className="border-t border-line px-4 py-2.5 text-sm text-text2">
            {data.sections.unmapped.length > 0 && (
              <>
                {data.sections.unmapped.length} section{data.sections.unmapped.length === 1 ? "" : "s"} no module claims:{" "}
                <span className={MONO}>{data.sections.unmapped.join(" ")}</span> (kept as written) ·{" "}
              </>
            )}
            B = brief sections, F = full sections
          </p>
        </Panel>
        {staged && (
          <Panel
            testId="draft-changes"
            title="Draft changes"
            tools={
              <Button variant="solid" onClick={() => setConfirming(true)}>
                Confirm rev {next}…
              </Button>
            }
            bodyClassName="px-4 py-3"
          >
            <ul className="space-y-1.5 text-[15px]">
              {changes.add.map((k) => (
                <li key={k} className="flex items-center gap-2">
                  <span>+ {titleOf(k)}</span>
                  <span className={`${MONO} text-text2`}>{k}</span>
                  <Button variant="ghost" className="ml-auto" onClick={() => setChanges((c) => toggle(c, k, false))}>
                    Undo
                  </Button>
                </li>
              ))}
              {changes.remove.map((k) => (
                <li key={k} className="flex items-center gap-2">
                  <span>− {titleOf(k)}</span>
                  <span className={`${MONO} text-text2`}>{k}</span>
                  <Button variant="ghost" className="ml-auto" onClick={() => setChanges((c) => toggle(c, k, true))}>
                    Undo
                  </Button>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-sm text-text2">Nothing is written until you confirm or save a working draft.</p>
          </Panel>
        )}
        {data.working && (
          <Panel testId="working-draft" title={`Working draft rev ${data.working.number}`} tools={<Chip kind="warn">Supersedes nothing until confirmed</Chip>} bodyClassName="space-y-1.5 px-4 py-3 text-[15px]">
            <p className="text-sm text-text2">
              {data.working.parent_number != null ? `Started from rev ${data.working.parent_number}` : "First draft"}
              {data.working.decided_at ? ` · ${formatDate(data.working.decided_at)}` : ""}
            </p>
            {diffLine(data.working.diff) ? <p className={MONO}>{diffLine(data.working.diff)}</p> : <p className="text-text2">No module changes against the revision in force.</p>}
            {data.working.diff.material && data.working.diff.affected_sections.length > 0 && (
              <p className="text-sm text-text2">
                Material change. Approvals on <span className={MONO}>{data.working.diff.affected_sections.join(" ")}</span> will be invalidated when confirmed.
              </p>
            )}
            {data.working.reason && <q className="block">{data.working.reason}</q>}
          </Panel>
        )}
        {phone && selected && (
          <Sheet open={sheet} title={selected.title} onClose={() => setSheet(false)}>
            {detail(selected, true)}
          </Sheet>
        )}
      </Split>
    );
  }

  const pack = data?.current?.packs ?? data?.working?.packs ?? data?.recommendation?.packs ?? [];
  const packsSource = (data?.current ?? data?.working)?.inputs.policy?.packs_source;
  const template = data?.current ?? data?.working ?? data?.recommendation;

  return (
    <Page>
      <PageHeader
        back={<DocCrumb doc={docQ.data} />}
        title="Composition"
        status={
          data && (
            <>
              {data.current ? (
                <Chip kind="pass" data-testid="composition-in-force">
                  Rev {data.current.number} in force
                </Chip>
              ) : (
                <Chip kind="na">Legacy · no composition yet</Chip>
              )}
              {data.current?.status === "published" && <Chip kind="acc">Published</Chip>}
              {data.working && (
                <Chip kind="warn" data-testid="composition-working">
                  Working draft rev {data.working.number}
                </Chip>
              )}
              {template?.template && (
                <span className={META}>
                  {template.template}
                  {template.template_version ? ` v${template.template_version}` : ""}
                </span>
              )}
              {pack.length > 0 && (
                <span className={META}>
                  Pack: {pack.join(", ")}
                  {packsSource ? ` · ${packsSource}` : ""}
                </span>
              )}
            </>
          )
        }
        action={
          data && (
            <>
              <Button onClick={loadPreview}>Preview recommendation</Button>
              {mayPublish && data.current?.status === "confirmed" && <Button onClick={() => setPublishing(true)}>Publish rev {data.current.number}…</Button>}
              {mayConfirm && (
                <Button variant="primary" onClick={() => setConfirming(true)}>
                  Confirm rev {next}…
                </Button>
              )}
            </>
          )
        }
      />
      <div className="flex min-w-0 flex-col gap-4 max-[600px]:gap-3">
        <div className="min-w-0 max-w-full overflow-x-auto">{tabs}</div>
        {data && !mayConfirm && (
          <Notice testId="read-only">Read only. Preview writes nothing; confirming and publishing need an approver.</Notice>
        )}
        {result && (
          <div data-testid="composition-result" role="status" className="space-y-1.5 rounded-button bg-pass-bg px-3 py-2 text-sm font-medium text-pass">
            <p>{result.text}</p>
            {result.problems.map((p, i) => (
              <p key={i} className="text-text">
                <span className={MONO}>{p.code}</span> {p.message}
              </p>
            ))}
          </div>
        )}
        {body}
      </div>
      {confirming && data && (
        <ConfirmStep
          doc={doc}
          data={data}
          changes={changes}
          phone={phone}
          onClose={() => setConfirming(false)}
          onDone={done}
          onReload={() => {
            setConfirming(false);
            void q.reload();
          }}
        />
      )}
      {publishing && data?.current && (
        <PublishStep
          doc={doc}
          revision={data.current.number}
          phone={phone}
          onClose={() => setPublishing(false)}
          onDone={() => {
            setPublishing(false);
            setResult({ text: `Rev ${data.current!.number} published.`, problems: [] });
            void q.reload();
          }}
        />
      )}
    </Page>
  );
}
