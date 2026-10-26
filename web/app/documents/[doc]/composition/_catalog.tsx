"use client";

import { useState } from "react";

import { Chip, DataTable, Inspector, InspectorRow, InspectorSection, Panel, Sheet, Split, type Column } from "@/components/ds";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatDate } from "@/lib/format";
import { useQuery } from "@/lib/use-query";

type Entry = Schemas["CatalogModuleOut"];

const MONO = "font-mono text-[13px]";

export const COMPANY_POLICY: Record<NonNullable<Entry["company_policy"]>, string> = {
  required: "Required",
  optional: "Optional",
  disabled: "Disabled",
};

export function CatalogFacts({ e }: { e: Entry }) {
  const list = (xs: string[]) => (xs.length ? <span className={MONO}>{xs.join(" ")}</span> : "—");
  return (
    <>
      <InspectorSection label="Catalog facts">
        <InspectorRow value={list(e.applies_to)}>Applies to packs</InspectorRow>
        <InspectorRow value={list(e.depends_on)}>Depends on</InspectorRow>
        <InspectorRow value={list(e.conflicts_with)}>Conflicts with</InspectorRow>
        <InspectorRow value={list(e.section_ids)}>Sections</InspectorRow>
        <InspectorRow value={[e.brief_layer && "brief", e.full_layer && "full"].filter(Boolean).join(" · ") || "—"}>Layers</InspectorRow>
        <InspectorRow value={e.required_review_role}>Review role</InspectorRow>
      </InspectorSection>
      <InspectorSection label="Versions">
        <ul className="space-y-1.5 text-sm">
          {e.versions.map((v) => (
            <li key={v.version} className="flex flex-wrap items-center gap-2">
              <span className="tnum font-semibold">{v.version}</span>
              <span>{v.origin}</span>
              {v.version === e.version && <Chip kind="acc">In effect</Chip>}
              <span className="text-text2">
                {formatDate(v.created_at)} · sha <span className={MONO}>{v.contract_hash.slice(0, 8)}</span>
              </span>
            </li>
          ))}
        </ul>
        {e.upgrade_available && <p className="mt-1 text-sm text-text2">Upgrade available: {e.upgrade_available}</p>}
      </InspectorSection>
    </>
  );
}

function CatalogDetail({ entryKey, bare }: { entryKey: string; bare: boolean }) {
  const q = useQuery(`catalog:${entryKey}`, () => unwrap(api.GET("/v1/module-catalog/{key}", { params: { path: { key: entryKey } } })));
  if (q.error) return <ErrorNote>{q.error}</ErrorNote>;
  if (!q.data) return <Loading />;
  const e = q.data;
  const body = (
    <>
      {e.description && (
        <InspectorSection label="Description">
          <p className="text-[15px]">{e.description}</p>
        </InspectorSection>
      )}
      <CatalogFacts e={e} />
      <InspectorSection label={`Contract (${e.version})`}>
        <pre data-testid="catalog-contract" className={`${MONO} max-h-80 overflow-auto rounded-lg bg-surface2 p-3 whitespace-pre-wrap [overflow-wrap:anywhere]`}>
          {JSON.stringify(e.contract, null, 2)}
        </pre>
      </InspectorSection>
    </>
  );
  if (bare) return <div data-testid="catalog-inspector">{body}</div>;
  return (
    <Inspector
      testId="catalog-inspector"
      eyebrow={`Catalog module · ${e.builtin ? "built-in" : "company"}`}
      title={e.title}
      chips={
        <>
          <Chip kind="line">v{e.version}</Chip>
          <Chip kind="line">Pack: {e.policy}</Chip>
          {e.company_policy && <Chip kind="acc">Company: {COMPANY_POLICY[e.company_policy]}</Chip>}
          {e.archived && <Chip kind="na">Archived</Chip>}
        </>
      }
      stats={[
        { label: "Sections", value: e.section_ids.length },
        { label: "Versions", value: e.versions.length },
      ]}
    >
      {body}
    </Inspector>
  );
}

/** The module catalogue (GET /v1/module-catalog): read by everyone. */
export function CatalogTab({ phone }: { phone: boolean }) {
  const q = useQuery("module-catalog", () => unwrap(api.GET("/v1/module-catalog")));
  const [picked, setPicked] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const rows = q.data ?? [];
  const selected = rows.find((r) => r.key === picked) ?? null;
  const columns: Column<Entry>[] = [
    {
      key: "module",
      header: "Module",
      phone: "title",
      cell: (e) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{e.title}</span>
          <span className={`${MONO} truncate text-text2`}>{e.key}</span>
        </span>
      ),
    },
    { key: "policy", header: "Pack policy", width: "130px", cell: (e) => e.policy },
    { key: "company", header: "Company policy", width: "150px", cell: (e) => (e.company_policy ? COMPANY_POLICY[e.company_policy] : "No policy") },
    { key: "version", header: "Version", width: "100px", align: "right", cell: (e) => <span className="tnum">{e.version}</span> },
  ];
  if (q.error) return <ErrorNote>{q.error}</ErrorNote>;
  return (
    <Split inspector={!phone && selected ? <CatalogDetail entryKey={selected.key} bare={false} /> : undefined}>
      <Panel title="Catalog" count={q.data ? rows.length : undefined}>
        <DataTable
          label="Catalog"
          testId="catalog-table"
          columns={columns}
          rows={q.data}
          loading={q.loading && !q.data}
          rowKey={(e) => e.key}
          rowProps={(e) => ({ "data-module": e.key })}
          selected={picked}
          onSelect={(k) => {
            setPicked(k);
            if (phone) setSheet(true);
          }}
          empty="No catalog modules"
        />
      </Panel>
      {phone && selected && (
        <Sheet open={sheet} title={selected.title} onClose={() => setSheet(false)}>
          <CatalogDetail entryKey={selected.key} bare />
        </Sheet>
      )}
    </Split>
  );
}
