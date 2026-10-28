"use client";

import Link from "next/link";
import { useState } from "react";

import {
  Chip,
  DataTable,
  Dialog,
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
import { ThemePreview, ThemeThumbnail } from "@/components/ThemePreview";
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
const SWATCHES: { name: string; label: string }[] = [
  { name: "background", label: "Background colour" },
  { name: "text", label: "Text colour" },
  { name: "heading", label: "Heading colour" },
  { name: "muted", label: "Muted colour" },
  { name: "accent", label: "Accent colour" },
  { name: "rule", label: "Rule colour" },
  { name: "surface", label: "Surface colour" },
];

/** The theme's own colours (theme data, so inline styles), overlapping dots, each named (qa-settings-21). */
function Swatches({ t, size = 20 }: { t: Theme; size?: number }) {
  return (
    <span className="inline-flex align-middle">
      {SWATCHES.map(({ name, label }) => (
        <span
          key={name}
          role="img"
          aria-label={`${label} ${t.tokens.colors?.[name] ?? "not set"}`}
          title={`${label} ${t.tokens.colors?.[name] ?? "not set"}`}
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

/** "A4 · Portrait", not the enum values. */
function pageLabel(t: Theme): string {
  const page = t.tokens.page;
  if (!page) return "—";
  return `${page.size} · ${page.orientation === "landscape" ? "Landscape" : "Portrait"}`;
}

function ThemeInspector({ t }: { t: Theme }) {
  const [large, setLarge] = useState(false);
  const kind = t.kind === "roadmap" ? "roadmap" : "prd";
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
        {/* qa-settings-21: the thumbnail is only a picture; a click opens a legible preview. */}
        <button
          type="button"
          onClick={() => setLarge(true)}
          aria-label={`Open a larger preview of ${t.name}`}
          className="group flex flex-col items-start gap-1.5 rounded text-left"
        >
          <ThemeThumbnail tokens={t.tokens} css={t.css} kind={kind} scale={0.5} />
          <span className="text-sm text-accent-ink group-hover:underline">Open a larger preview</span>
        </button>
        {large && (
          <Dialog title={`${t.name} preview`} size="lg" onClose={() => setLarge(false)} testId="theme-preview-dialog">
            <ThemePreview tokens={t.tokens} css={t.css} kind={kind} tall />
          </Dialog>
        )}
      </InspectorSection>
      <InspectorSection label="Colours">
        <Swatches t={t} size={28} />
      </InspectorSection>
      <InspectorSection label="Facts">
        <InspectorRow value={pageLabel(t)}>Page</InspectorRow>
        <InspectorRow value={formatDate(t.updated_at)}>Updated</InspectorRow>
      </InspectorSection>
      {t.description && (
        <InspectorSection label="Description">
          <p className="text-[15px] text-text">{t.description}</p>
        </InspectorSection>
      )}
      <InspectorSection label="For developers">
        <InspectorRow value={<span className="font-mono text-sm font-medium">{t.key}</span>}>Key</InspectorRow>
      </InspectorSection>
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
        info={
          <InfoTip label="themes" align="start" side="bottom">
            How exported PRDs and roadmaps look: fonts, colours, spacing, page and layout features. Text colours must be
            readable on the background (WCAG AA).
          </InfoTip>
        }
        status={capsReady && !canCreate && <ViewOnly />}
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
