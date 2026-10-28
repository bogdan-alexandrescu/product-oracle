"use client";

import { useState } from "react";

import { Chip, DataTable, Inspector, InspectorRow, InspectorSection, Panel, Sheet, Split, type Column } from "@/components/ds";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatDate, plural } from "@/lib/format";
import { useQuery } from "@/lib/use-query";

import { ORIGIN, PACK_POLICY } from "./_lib";

type Entry = Schemas["CatalogModuleOut"];

const ROLE: Record<string, string> = { viewer: "Viewer", commenter: "Commenter", approver: "Approver", owner: "Owner" };

export const COMPANY_POLICY: Record<NonNullable<Entry["company_policy"]>, string> = {
  required: "Required",
  optional: "Optional",
  disabled: "Disabled",
};

/** A module key's name from the catalogue, else the key in words. */
function useNames() {
  const catalog = useQuery("module-catalog", () => unwrap(api.GET("/v1/module-catalog")));
  const packs = useQuery("module-packs", () => unwrap(api.GET("/v1/module-packs")));
  return {
    module: (key: string) => catalog.data?.find((c) => c.key === key)?.title ?? key.split(".").pop()!.replace(/[-_]/g, " "),
    pack: (id: string) => packs.data?.find((p) => p.id === id)?.title ?? null,
  };
}

export function CatalogFacts({ e }: { e: Entry }) {
  const names = useNames();
  const list = (xs: (string | null)[]) => {
    const shown = xs.filter((x): x is string => !!x);
    return shown.length ? <span className="font-normal whitespace-normal [overflow-wrap:anywhere]">{shown.join(", ")}</span> : "None";
  };
  return (
    <>
      <InspectorSection label="Catalog facts">
        <InspectorRow value={list(e.applies_to.map(names.pack))}>Applies to packs</InspectorRow>
        <InspectorRow value={list(e.depends_on.map(names.module))}>Depends on</InspectorRow>
        <InspectorRow value={list(e.conflicts_with.map(names.module))}>Conflicts with</InspectorRow>
        <InspectorRow value={plural(e.section_ids.length, "section")}>Sections</InspectorRow>
        <InspectorRow value={[e.brief_layer && "Brief", e.full_layer && "Full"].filter(Boolean).join(" and ") || "None"}>Layers</InspectorRow>
        <InspectorRow value={ROLE[e.required_review_role] ?? e.required_review_role}>Review role</InspectorRow>
      </InspectorSection>
      <InspectorSection label="Versions">
        <ul className="space-y-1.5 text-sm">
          {e.versions.map((v, i) => (
            <li key={v.version} className="flex flex-wrap items-center gap-2">
              <span>{ORIGIN[v.origin] ?? "Company module"}</span>
              {v.version === e.version && <Chip kind="acc">In effect</Chip>}
              <span className="text-text2">
                {i === 0 ? "Added" : "Updated"} {formatDate(v.created_at)}
              </span>
            </li>
          ))}
        </ul>
        {e.upgrade_available && <p className="mt-1 text-sm text-text2">A newer version is available.</p>}
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
    </>
  );
  if (bare) return <div data-testid="catalog-inspector">{body}</div>;
  return (
    <Inspector
      testId="catalog-inspector"
      eyebrow={`Catalog module · ${e.builtin ? "Built-in" : "Company module"}`}
      title={e.title}
      chips={
        <>
          <Chip kind="line" hero>
            Pack policy: {PACK_POLICY[e.policy] ?? e.policy}
          </Chip>
          {e.company_policy && <Chip kind="acc" hero>Company: {COMPANY_POLICY[e.company_policy]}</Chip>}
          {e.archived && <Chip kind="na" hero>Archived</Chip>}
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
        <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{e.title}</span>
      ),
    },
    { key: "policy", header: "Pack policy", width: "150px", cell: (e) => PACK_POLICY[e.policy] ?? e.policy },
    {
      key: "company",
      header: "Company policy",
      width: "150px",
      cell: (e) => (e.company_policy ? COMPANY_POLICY[e.company_policy] : <span className="text-text2">Not set</span>),
    },
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
