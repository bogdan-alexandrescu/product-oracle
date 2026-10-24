"use client";

import Link from "next/link";
import { useState } from "react";

import {
  Chip,
  DataTable,
  InfoTip,
  Inspector,
  InspectorRow,
  InspectorSection,
  LinkButton,
  Notice,
  PageHeader,
  ViewOnly,
  Panel,
  Split,
  type Column,
} from "@/components/ds";
import { ThemeThumbnail } from "@/components/ThemePreview";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatDate } from "@/lib/format";
import { useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";

type Theme = Schemas["ThemeOut"];

const KIND_LABEL: Record<Theme["kind"], string> = {
  prd: "PRD",
  roadmap: "Roadmap",
  vision: "Vision",
  strategy: "Product strategy",
  update: "Update",
  pricing: "Pricing memo",
  any: "Any document",
};
const GROUP_LABEL: Record<Theme["kind"], string> = {
  prd: "PRD themes",
  roadmap: "Roadmap themes",
  vision: "Vision themes",
  strategy: "Product strategy themes",
  update: "Update themes",
  pricing: "Pricing memo themes",
  any: "Any document",
};
const SWATCHES = ["background", "text", "heading", "muted", "accent", "rule", "surface"];

/** The theme's own colours (theme data, so inline styles), overlapping dots. */
function Swatches({ t, size = 20 }: { t: Theme; size?: number }) {
  return (
    <span className="inline-flex align-middle">
      {SWATCHES.map((name) => (
        <span
          key={name}
          title={`${name} ${t.tokens.colors?.[name] ?? ""}`}
          // A hairline ring in the text colour, so a dark swatch shows on the dark surface (and a
          // light one on the light surface); the surface ring parts the overlapping swatches.
          className="-ml-1 flex-none rounded-full shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--text)_45%,transparent),0_0_0_1.5px_var(--surface)] first:ml-0"
          style={{ background: t.tokens.colors?.[name], width: size, height: size }}
        />
      ))}
    </span>
  );
}

const COLUMNS: Column<Theme>[] = [
  {
    key: "name",
    header: "Theme",
    cell: (t) => (
      <span className="flex min-w-0 items-center gap-2">
        <Link
          href={`/settings/themes/${t.key}`}
          onClick={(e) => e.stopPropagation()}
          className={`min-w-0 truncate font-medium hover:underline ${t.archived_at ? "text-text2" : "text-text"}`}
        >
          {t.name}
        </Link>
        {t.builtin && <Chip kind="na">Built-in</Chip>}
        {t.archived_at && <Chip kind="warn">Archived</Chip>}
      </span>
    ),
  },
  { key: "colours", header: "Colours", width: "150px", cell: (t) => <Swatches t={t} /> },
  {
    key: "updated",
    header: "Updated",
    width: "120px",
    align: "right",
    hideOnPhone: true,
    cell: (t) => <span className="tnum text-text2">{formatDate(t.updated_at)}</span>,
  },
];

function ThemeInspector({ t }: { t: Theme }) {
  return (
    <Inspector
      eyebrow="Theme · selected"
      title={t.name}
      testId="theme-inspector"
      chips={
        <>
          <Chip hero kind="acc">
            {KIND_LABEL[t.kind]}
          </Chip>
          {t.builtin && (
            <Chip hero kind="na">
              Built-in
            </Chip>
          )}
          {t.archived_at && (
            <Chip hero kind="warn">
              Archived
            </Chip>
          )}
        </>
      }
      action={
        <LinkButton variant="hero" href={`/settings/themes/${t.key}`}>
          Open
        </LinkButton>
      }
    >
      <InspectorSection label="Preview">
        <ThemeThumbnail tokens={t.tokens} css={t.css} kind={t.kind === "roadmap" ? "roadmap" : "prd"} scale={0.5} />
      </InspectorSection>
      <InspectorSection label="Colours">
        <Swatches t={t} size={28} />
      </InspectorSection>
      <InspectorSection label="Facts">
        <InspectorRow value={<span className="font-mono text-sm font-medium">{t.key}</span>}>Key</InspectorRow>
        <InspectorRow value={t.tokens.page ? `${t.tokens.page.size} · ${t.tokens.page.orientation}` : "—"}>Page</InspectorRow>
        <InspectorRow value={formatDate(t.updated_at)}>Updated</InspectorRow>
      </InspectorSection>
      {t.description && (
        <InspectorSection label="Description">
          <p className="text-[15px] text-text">{t.description}</p>
        </InspectorSection>
      )}
    </Inspector>
  );
}

export default function ThemesPage() {
  const { can, capsReady } = useMe();
  const canCreate = can("create_theme");
  const [showArchived, setShowArchived] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const q = useQuery(`themes|${showArchived}`, () =>
    unwrap(api.GET("/v1/themes", { params: { query: { include_archived: showArchived } } })),
  );
  const themes = q.data
    ? [...q.data].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
    : undefined;
  const current = themes?.find((t) => t.key === selected) ?? themes?.[0];

  return (
    <>
      <PageHeader
        title="Themes"
        status={
          <>
            <InfoTip label="themes" align="start" side="bottom">
              How exported PRDs and roadmaps look: fonts, colours, spacing, page and layout features. Text colours must be
              readable on the background (WCAG AA).
            </InfoTip>
            {capsReady && !canCreate && <ViewOnly />}
          </>
        }
        action={
          canCreate && (
            <LinkButton variant="primary" icon="plus" href="/settings/themes/new">
              New theme
            </LinkButton>
          )
        }
      />
      <Split inspector={current ? <ThemeInspector t={current} /> : undefined}>
        {q.error && <Notice tone="error">{q.error}</Notice>}
        <Panel
          title="All themes"
          count={themes?.length}
          tools={
            <label className="inline-flex items-center gap-2 text-sm text-text2">
              <input
                type="checkbox"
                className="size-4 accent-[var(--accent)]"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
              />
              Show archived
            </label>
          }
        >
          <DataTable
            label="Themes"
            columns={COLUMNS}
            rows={themes}
            loading={q.loading}
            rowKey={(t) => t.key}
            group={(t) => GROUP_LABEL[t.kind]}
            selected={current?.key}
            onSelect={(k) => setSelected(k)}
            rowProps={(t) => ({ "data-testid": `theme-row-${t.key}` })}
            empty="No themes yet"
          />
        </Panel>
      </Split>
    </>
  );
}
