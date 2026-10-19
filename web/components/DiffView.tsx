"use client";

import Link from "next/link";
import { useState } from "react";

import { DocToolbar } from "@/components/DocToolbar";
import { Chip, Empty, InfoTip, LinkButton, Page, PageHeader, Panel, type ChipKind } from "@/components/ds";
import { VersionSwitcher } from "@/components/VersionSwitcher";
import { ErrorNote, LayerBadge, Loading } from "@/components/ui";
import { api, unwrap, type SectionDiff } from "@/lib/api/client";
import { useQuery } from "@/lib/use-query";

const STATUS: Record<SectionDiff["status"], { label: string; kind: ChipKind }> = {
  added: { label: "Added", kind: "pass" },
  removed: { label: "Removed", kind: "crit" },
  changed: { label: "Changed", kind: "warn" },
  unchanged: { label: "Unchanged", kind: "na" },
};

const SUMMARY: [keyof ReturnType<typeof countOf>, ChipKind][] = [
  ["changed", "warn"],
  ["added", "pass"],
  ["removed", "crit"],
  ["moved", "acc"],
  ["unchanged", "na"],
];

function countOf(sections: SectionDiff[]) {
  return {
    changed: sections.filter((s) => s.status === "changed").length,
    added: sections.filter((s) => s.status === "added").length,
    removed: sections.filter((s) => s.status === "removed").length,
    moved: sections.filter((s) => s.moved).length,
    unchanged: sections.filter((s) => s.status === "unchanged" && !s.moved).length,
  };
}

function Words({ words }: { words: NonNullable<SectionDiff["words"]> }) {
  return (
    <p className="text-[15px] leading-7 whitespace-pre-wrap text-text" data-testid="word-diff">
      {words.map((w, i) =>
        w.op === "insert" ? (
          <ins key={i} className="rounded-sm bg-pass-bg px-0.5 text-pass no-underline">
            {w.text}
          </ins>
        ) : w.op === "delete" ? (
          <del key={i} className="rounded-sm bg-crit-bg px-0.5 text-crit line-through">
            {w.text}
          </del>
        ) : (
          <span key={i}>{w.text}</span>
        ),
      )}
    </p>
  );
}

/** O1f: the section's layer, and its move between brief and detail. */
function DiffLayer({ d }: { d: SectionDiff }) {
  const from = d.from_layer ?? null;
  const to = d.to_layer ?? null;
  if (from && to && from !== to) {
    return (
      <span data-testid="layer-change" className="inline-flex items-center gap-1 text-sm text-text2">
        <LayerBadge layer={from} />→<LayerBadge layer={to} />
      </span>
    );
  }
  return <LayerBadge layer={to ?? from} />;
}

function DiffSection({ d, doc, to, showLayer }: { d: SectionDiff; doc: string; to: number; showLayer: boolean }) {
  const heading = d.to_heading ?? d.from_heading ?? d.section_key;
  const renamed = d.from_heading && d.to_heading && d.from_heading !== d.to_heading;
  const quiet = d.status === "unchanged" && !d.moved;
  const bar =
    d.status === "added"
      ? "shadow-[inset_4px_0_0_var(--pass)]"
      : d.status === "removed"
        ? "shadow-[inset_4px_0_0_var(--crit)]"
        : d.status === "changed"
          ? "shadow-[inset_4px_0_0_var(--warn)]"
          : "shadow-panel";
  return (
    <li
      data-testid="diff-section"
      data-status={d.status}
      className={`min-w-0 overflow-hidden rounded-panel border border-line bg-surface ${bar}`}
    >
      <div className="flex min-h-12 flex-wrap items-center gap-2 px-4 py-2">
        <h2
          className={`min-w-0 truncate font-display text-lg leading-6 font-bold tracking-[-0.01em] ${
            d.status === "removed" ? "text-text2 line-through" : quiet ? "text-text2" : ""
          }`}
        >
          {heading}
        </h2>
        <Chip kind={STATUS[d.status].kind}>{STATUS[d.status].label}</Chip>
        {showLayer && <DiffLayer d={d} />}
        {d.moved && (
          <Chip kind="acc" title={`Position ${(d.from_ordinal ?? 0) + 1} → ${(d.to_ordinal ?? 0) + 1}`}>
            Moved
          </Chip>
        )}
        <span className="ml-auto truncate font-mono text-[13px] text-text2">#{d.section_key}</span>
        {d.status !== "removed" && (
          <Link href={`/documents/${doc}/v/${to}#s-${d.section_key}`} className="text-sm font-medium text-accent-ink hover:underline">
            View
          </Link>
        )}
      </div>
      {(renamed || (d.words && d.words.length > 0)) && (
        <div className="border-t border-line px-4 py-3">
          {renamed && (
            <p className="mb-2 text-sm text-text2">
              Renamed from <span className="font-semibold text-text">“{d.from_heading}”</span>
            </p>
          )}
          {d.words && d.words.length > 0 && <Words words={d.words} />}
        </div>
      )}
    </li>
  );
}

function Toggle({ label, name, checked, onChange }: { label: string; name: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-lg border border-line-strong px-3 text-sm font-semibold text-text hover:bg-surface2">
      <input
        type="checkbox"
        aria-label={name}
        className="size-4 accent-[var(--accent)]"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

export function DiffView({ doc, from, to }: { doc: string; from?: number; to?: number }) {
  const [showUnchanged, setShowUnchanged] = useState(false);
  const [briefOnly, setBriefOnly] = useState(false);
  const docQ = useQuery(`doc|${doc}`, () => unwrap(api.GET("/v1/documents/{doc}", { params: { path: { doc } } })));
  const versions = docQ.data?.versions ?? [];
  const latest = versions.at(-1)?.number;
  const toN = to ?? latest;
  const fromN = from ?? (toN != null ? Math.max(1, toN - 1) : undefined);
  const ready = fromN != null && toN != null;

  const diffQ = useQuery(`diff|${doc}|${fromN}|${toN}`, async () =>
    ready
      ? unwrap(api.GET("/v1/documents/{doc}/diff", { params: { path: { doc }, query: { from: fromN, to: toN } } }))
      : undefined,
  );

  const sections = diffQ.data?.sections ?? [];
  const counts = countOf(sections);
  // Diffs of versions with a brief layer label each section and can show the brief only.
  const showLayer = sections.some((s) => s.from_layer === "brief" || s.to_layer === "brief");
  const shown = sections
    .filter((s) => showUnchanged || s.status !== "unchanged" || s.moved)
    .filter((s) => !briefOnly || !showLayer || s.from_layer === "brief" || s.to_layer === "brief");
  const href = (f: number, t: number) => `/documents/${doc}/diff?from=${f}&to=${t}`;

  return (
    <div>
      <DocToolbar doc={docQ.data}>
        {ready && versions.length > 0 && (
          <>
            <VersionSwitcher doc={doc} versions={versions} current={fromN} label="From" hrefFor={(f) => href(f, toN)} />
            <span aria-hidden className="text-text2">
              →
            </span>
            <VersionSwitcher doc={doc} versions={versions} current={toN} label="To" hrefFor={(t) => href(fromN, t)} />
          </>
        )}
      </DocToolbar>
      <Page>
        <PageHeader
          title={ready ? `Changes from v${fromN} to v${toN}` : "Compare versions"}
          status={
            diffQ.data && (
              <span data-testid="diff-summary" className="flex flex-wrap items-center gap-2">
                {SUMMARY.filter(([k]) => counts[k] > 0).map(([k, kind]) => (
                  <Chip key={k} kind={kind}>
                    {counts[k]} {k}
                  </Chip>
                ))}
                {sections.length === 0 && <Chip kind="na">0 changed</Chip>}
              </span>
            )
          }
          action={
            ready && (
              <LinkButton variant="primary" href={`/documents/${doc}/v/${toN}`}>
                Open v{toN}
              </LinkButton>
            )
          }
        />
        {(docQ.error || diffQ.error) && <ErrorNote>{docQ.error || diffQ.error}</ErrorNote>}
        {docQ.data && versions.length < 2 && (
          <Panel>
            <Empty>One version only</Empty>
          </Panel>
        )}
        {ready && fromN === toN && versions.length >= 2 && (
          <Panel>
            <Empty>Pick two versions</Empty>
          </Panel>
        )}
        {ready && !diffQ.data && !diffQ.error && <Loading label="Computing diff…" />}
        {diffQ.data && (
          <div className="flex flex-col gap-3">
            <Panel
              title="Sections"
              count={shown.length}
              tools={
                <>
                  {showLayer && (
                    <Toggle label="Brief only" name="Brief sections only" checked={briefOnly} onChange={setBriefOnly} />
                  )}
                  <Toggle label="Unchanged" name="Show unchanged sections" checked={showUnchanged} onChange={setShowUnchanged} />
                  <InfoTip label="the diff">
                    Sections are matched by key across versions. Unchanged sections stay hidden until you show them;
                    a moved section changed position.
                  </InfoTip>
                </>
              }
            />
            <ol className="flex flex-col gap-3">
              {shown.map((d) => (
                <DiffSection key={`${d.status}-${d.section_key}`} d={d} doc={doc} to={toN!} showLayer={showLayer} />
              ))}
            </ol>
            {shown.length === 0 && (
              <Panel>
                <Empty>No differences</Empty>
              </Panel>
            )}
          </div>
        )}
      </Page>
    </div>
  );
}
