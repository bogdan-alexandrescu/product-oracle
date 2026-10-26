"use client";

import Link from "next/link";
import { useState } from "react";

import { DocToolbar } from "@/components/DocToolbar";
import { baseName, changeSummary } from "@/components/roadmap/CompareBar";
import { horizonLabel } from "@/components/roadmap/item-row";
import { ChangeChips } from "@/components/roadmap/ItemChanges";
import { changeLine } from "@/components/roadmap/useItemsDiff";
import { Chip, Empty, InfoTip, LinkButton, Page, PageHeader, Panel, type ChipKind } from "@/components/ds";
import { VersionSwitcher } from "@/components/VersionSwitcher";
import { ErrorNote, LayerBadge, Loading, SpecStateBadge } from "@/components/ui";
import { api, ApiError, unwrap, type Schemas, type SectionDiff } from "@/lib/api/client";
import { useQuery } from "@/lib/use-query";
import { useScreenSubject } from "@/lib/screen-subject";
import { sectionHref } from "@/lib/section-link";

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

type Op = NonNullable<SectionDiff["words"]>[number];
type Line = Op[];
type Block = { kind: "text"; lines: Line[] } | { kind: "table"; rows: Line[][] };

/** Splits the word diff into lines; each line keeps its ops. */
function linesOf(words: Op[]): Line[] {
  const lines: Line[] = [[]];
  for (const w of words) {
    w.text.split("\n").forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part) lines[lines.length - 1].push({ op: w.op, text: part });
    });
  }
  return lines;
}

const lineText = (l: Line) => l.map((w) => w.text).join("").trim();
/** A markdown table's separator row ("| --- | :-: |"): dropped, the table is drawn instead. */
const TABLE_RULE = /^\|?(\s*:?-{3,}:?\s*\|)+(\s*:?-{3,}:?\s*)?$/;

/** A table row's cells: the line's ops cut at each pipe, the outer pipes dropped. */
function cellsOf(line: Line): Line[] {
  const cells: Line[] = [[]];
  for (const w of line) {
    w.text.split("|").forEach((part, i) => {
      if (i > 0) cells.push([]);
      if (part) cells[cells.length - 1].push({ op: w.op, text: part });
    });
  }
  const blank = (c: Line) => c.every((w) => !w.text.trim());
  if (cells.length > 1 && blank(cells[0])) cells.shift();
  if (cells.length > 1 && blank(cells[cells.length - 1])) cells.pop();
  return cells;
}

/**
 * Markdown tables become table blocks, as the version view draws them; the rest stays
 * text. A table is two or more consecutive lines with the same number of pipe-separated
 * cells ("| a | b |" or the plain text's "a | b"); its separator row is dropped.
 */
function blocksOf(words: Op[]): Block[] {
  const blocks: Block[] = [];
  const text = (line: Line) => {
    const last = blocks[blocks.length - 1];
    if (last?.kind === "text") last.lines.push(line);
    else blocks.push({ kind: "text", lines: [line] });
  };
  let run: Line[] = [];
  const flush = () => {
    if (run.length >= 2) blocks.push({ kind: "table", rows: run.map(cellsOf) });
    else run.forEach(text);
    run = [];
  };
  for (const line of linesOf(words)) {
    const t = lineText(line);
    if (run.length > 0 && TABLE_RULE.test(t)) continue;
    const cells = t.includes("|") ? cellsOf(line).length : 0;
    if (cells >= 2 && (run.length === 0 || cellsOf(run[0]).length === cells)) {
      run.push(line);
      continue;
    }
    flush();
    if (cells >= 2) run.push(line);
    else text(line);
  }
  flush();
  // The blank lines around a table belong to the table's margins.
  for (const b of blocks) {
    if (b.kind !== "text") continue;
    while (b.lines.length > 1 && b.lines[0].length === 0) b.lines.shift();
    while (b.lines.length > 1 && b.lines[b.lines.length - 1].length === 0) b.lines.pop();
  }
  return blocks;
}

function Ops({ ops }: { ops: Op[] }) {
  return (
    <>
      {ops.map((w, i) =>
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
    </>
  );
}

/** A whole row added or removed is tinted; a changed row shows its words. */
function rowTone(cells: Line[]): string {
  const ops = cells.flat().filter((w) => w.text.trim());
  if (ops.length > 0 && ops.every((w) => w.op === "insert")) return "bg-pass-bg";
  if (ops.length > 0 && ops.every((w) => w.op === "delete")) return "bg-crit-bg";
  return "";
}

function DiffTable({ rows }: { rows: Line[][] }) {
  const [head, ...body] = rows;
  return (
    <div className="doc-body my-2">
      <div className="table-wrap">
        <table data-testid="diff-table">
          <thead>
            <tr className={rowTone(head)}>
              {head.map((c, i) => (
                <th key={i}>
                  <Ops ops={c} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((r, j) => (
              <tr key={j} className={rowTone(r)}>
                {r.map((c, i) => (
                  <td key={i}>
                    <Ops ops={c} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Words({ words }: { words: NonNullable<SectionDiff["words"]> }) {
  return (
    <div className="text-[15px] leading-7 text-text" data-testid="word-diff">
      {blocksOf(words).map((b, i) =>
        b.kind === "table" ? (
          <DiffTable key={i} rows={b.rows} />
        ) : (
          <p key={i} className="whitespace-pre-wrap">
            {b.lines.map((l, j) => (
              <span key={j}>
                {j > 0 && "\n"}
                <Ops ops={l} />
              </span>
            ))}
          </p>
        ),
      )}
    </div>
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
          className={`min-w-0 truncate font-display text-lg leading-6 font-bold tracking-heading ${
            d.status === "removed" ? "text-text2 line-through" : quiet ? "text-text2" : ""
          }`}
        >
          {heading}
        </h2>
        <Chip kind={STATUS[d.status].kind}>{STATUS[d.status].label}</Chip>
        {/* E1: a spec section's state (an added section reads "Proposed · added in an edit"). */}
        {d.spec_states?.[0] && <SpecStateBadge state={d.spec_states[0]} />}
        {showLayer && <DiffLayer d={d} />}
        {d.moved && (
          <Chip kind="acc" title={`Position ${(d.from_ordinal ?? 0) + 1} → ${(d.to_ordinal ?? 0) + 1}`}>
            Moved
          </Chip>
        )}
        {/* The anchor and View stay on one line: when the row wraps, they move down together. */}
        <span className="ml-auto flex min-w-0 max-w-full items-center gap-2" data-testid="diff-anchor">
          <span className="min-w-0 truncate font-mono text-[13px] text-text2">#{d.section_key}</span>
          {d.status !== "removed" && (
            <Link
              href={sectionHref(doc, to, d.section_key)}
              className="flex-none text-sm font-medium text-accent-ink hover:underline"
            >
              View
            </Link>
          )}
        </span>
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

type ItemsDiffOrNot = { diff: Schemas["ItemsDiffOut"] } | { notReady: string };

/**
 * E3 on the text diff page: the roadmap items of the two versions compared item by item
 * (a PRD's draft items, or a roadmap version's items), as the Items tab compares them.
 * Changed, new and dropped items show; unchanged ones wait for the toggle. A version whose
 * draft items are not ready says so.
 */
function DiffItems({ doc, kind, from, to }: { doc: string; kind: "prd" | "roadmap"; from: number; to: number }) {
  const [showUnchanged, setShowUnchanged] = useState(false);
  const q = useQuery<ItemsDiffOrNot>(`diff-items|${doc}|${from}|${to}`, async () => {
    try {
      const query = { head: `${doc}@${to}`, base: `${doc}@${from}` };
      return { diff: await unwrap(api.GET("/v1/roadmap-items/diff", { params: { query } })) };
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) return { notReady: e.message };
      throw e;
    }
  });
  const diff = q.data && "diff" in q.data ? q.data.diff : null;
  const items = diff?.items ?? [];
  const shown = items.filter((c) => showUnchanged || c.change !== "unchanged");
  const titles = new Map(items.map((c) => [c.item_key, c.title]));
  const open = `/documents/${doc}/v/${to}/${kind === "prd" ? "roadmap" : "items"}`;
  if (q.error) return <ErrorNote>{q.error}</ErrorNote>;
  return (
    <Panel
      title="Roadmap items"
      count={diff?.base ? shown.length : undefined}
      testId="diff-items"
      tools={
        <>
          {diff?.base && (
            <Toggle label="Unchanged" name="Show unchanged items" checked={showUnchanged} onChange={setShowUnchanged} />
          )}
          <LinkButton href={open}>Open items</LinkButton>
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-2 px-4 py-3 max-[600px]:px-3">
        {!q.data && <Loading label="Comparing items…" />}
        {q.data && "notReady" in q.data && <p className="text-[15px] text-text2">{q.data.notReady}</p>}
        {diff && !diff.base && <p className="text-[15px] text-text2">No items to compare with</p>}
        {diff?.base && diff.summary && (
          <p data-testid="diff-items-summary" className="tnum text-sm text-text2">
            Since {baseName(diff, "previous")}: {changeSummary(diff.summary)}
          </p>
        )}
        {shown.length > 0 && (
          <ul className="flex flex-col">
            {shown.map((c) => {
              const dropped = c.change === "dropped";
              const horizon = dropped ? c.base_horizon : c.head_horizon;
              return (
                <li
                  key={`${c.change}-${c.item_key}`}
                  data-testid="diff-item"
                  data-change={c.change}
                  className="flex min-w-0 flex-col gap-1 border-t border-line py-2 first:border-t-0"
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className={`min-w-0 max-w-full truncate font-semibold ${dropped ? "text-text2" : ""}`} title={c.title}>
                      {dropped ? <s>{c.title}</s> : c.title}
                    </span>
                    {horizon && <Chip kind="na">{horizonLabel(horizon)}</Chip>}
                    <ChangeChips change={c} />
                  </div>
                  {(c.fields.length > 0 || c.notes.length > 0) && (
                    <ul className="flex flex-col gap-0.5 text-sm">
                      {c.fields.map((f) => (
                        <li key={f.field} className="break-words">
                          {changeLine(f, titles)}
                        </li>
                      ))}
                      {c.notes.map((f) => (
                        <li key={`note-${f.field}`} className="break-words text-text2">
                          {changeLine(f, titles)}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {diff?.base && shown.length === 0 && <p className="text-[15px] text-text2">No item changed</p>}
      </div>
    </Panel>
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
  // G7 3.3: the panel is about this document (the version compared to).
  useScreenSubject(docQ.data && toN != null ? { kind: "document", subject: { document_id: docQ.data.id, version: toN } } : null, docQ.data?.title);
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
            {(docQ.data?.kind === "prd" || docQ.data?.kind === "roadmap") && fromN !== toN && (
              <DiffItems doc={doc} kind={docQ.data.kind} from={fromN!} to={toN!} />
            )}
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
