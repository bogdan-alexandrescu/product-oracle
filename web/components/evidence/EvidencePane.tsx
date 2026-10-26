"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";

import {
  Button,
  Chip,
  DataTable,
  Empty,
  FilterChips,
  Inspector,
  InspectorSection,
  LinkButton,
  Notice,
  Panel,
  SegmentedControl,
  Sheet,
  Split,
  ViewOnly,
  type Column,
} from "@/components/ds";
import { peopleByIds } from "@/components/PersonPicker";
import { ErrorNote, INPUT, Loading } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import {
  GROUP_LABEL,
  KINDS,
  PRECISIONS,
  kindLabel,
  kindShort,
  layerLabel,
  leftOut,
  pivot,
  score,
  sourceLabel,
  staleCount,
  targetEyebrow,
  targetKey,
  targetTitle,
  tone,
  unsupported,
  weakest,
  type EvidenceCitation,
  type EvidenceInspector,
  type LinkKind,
  type LinkPrecision,
  type MatrixGroup,
  type MatrixRow,
  type SectionEvidence,
  type SectionLinkTarget,
  type SectionLinkView,
} from "@/lib/evidence";
import { formatDate } from "@/lib/format";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

const PHONE = "(max-width: 600px)";
function subscribePhone(onChange: () => void) {
  const mq = window.matchMedia(PHONE);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
function useIsPhone(): boolean {
  return useSyncExternalStore(subscribePhone, () => window.matchMedia(PHONE).matches, () => false);
}

type View = "coverage" | "sections";
type SectionFilter = "all" | "brief" | "detail" | "stale" | "none";

/** Tone classes of a matrix cell (the design system's status tones). */
const CELL: Record<"pass" | "warn" | "crit" | "na" | "cit", string> = {
  pass: "bg-pass-bg text-pass",
  warn: "bg-warn-bg text-warn",
  crit: "bg-crit-bg text-crit",
  na: "bg-na-bg text-na",
  cit: "bg-accent-soft text-accent-ink",
};

/**
 * v2 screen 3, the Evidence tab of a PRD version (picks.md 3): C's coverage matrix as the
 * main view (targets and the draft's citations as rows, sections as columns; an empty column
 * flags an unsupported section), with a view switch to A's section table and inspector
 * (links strongest first, the draft's citations, Add a section link). Reads
 * GET …/versions/{n}/evidence; adds with POST …/section-links and removes with
 * DELETE /v1/section-links/{id} (approvers and owners, unapproved versions only).
 */
export function EvidencePane({ doc, n, title, latest }: { doc: string; n: number; title: string; latest: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const phone = useIsPhone();
  const { can, capsReady } = useMe();
  const view: View = params.get("view") === "sections" ? "sections" : "coverage";
  const only = params.get("section");
  const setParams = useCallback(
    (next: Record<string, string | null>) => {
      const q = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(next)) {
        if (v == null) q.delete(k);
        else q.set(k, v);
      }
      const s = q.toString();
      router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );

  const evQ = useQuery(
    `evidence|${doc}|${n}|${only ?? ""}`,
    () =>
      unwrap(
        api.GET("/v1/documents/{doc}/versions/{n}/evidence", {
          params: { path: { doc, n }, query: only ? { section: only } : {} },
        }),
      ),
    { keepPrevious: true },
  );
  const data = evQ.data;
  const approved = !!data?.approved;
  const canAdd = capsReady && can("create_section_links") && !approved;
  const canRemove = capsReady && can("delete_section_link") && !approved;

  // Who made each link, by name.
  const peopleKey = [...new Set((data?.sections ?? []).flatMap((s) => s.links.map((l) => l.created_by)).filter(Boolean))].sort().join(",");
  const peopleQ = useQuery(`people-ids|${peopleKey}`, () => peopleByIds(peopleKey ? peopleKey.split(",") : []), { keepPrevious: true });
  const nameOf = useCallback((id: string | null | undefined) => (id ? (peopleQ.data?.get(id)?.name ?? null) : null), [peopleQ.data]);

  // The selected row is kept in the URL (?sel=entity:<id>, cite:<key>, section:<key>).
  const selected = params.get("sel");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [result, setResult] = useState<{ tone: "pass" | "error"; text: string } | null>(null);

  const select = (key: string, more: Record<string, string | null> = {}) => {
    setParams({ ...more, sel: key });
    setResult(null);
    if (phone) setSheetOpen(true);
  };
  const switchView = (v: View) => {
    setSheetOpen(false);
    setResult(null);
    setParams({ view: v === "coverage" ? null : v, sel: null });
  };

  const act = async (run: () => Promise<unknown>, done: string) => {
    setResult(null);
    try {
      await run();
      await evQ.reload();
      setResult({ tone: "pass", text: done });
      return true;
    } catch (e) {
      setResult({ tone: "error", text: errorMessage(e) });
      return false;
    }
  };
  const remove = (link: SectionLinkView) =>
    act(() => unwrap(api.DELETE("/v1/section-links/{item_id}", { params: { path: { item_id: link.id } } })), "Link removed.");
  const add = (body: NewLink) =>
    act(
      () =>
        unwrap(
          api.POST("/v1/documents/{doc}/versions/{n}/section-links", {
            params: { path: { doc, n } },
            body: { links: [body] },
          }),
        ),
      "Link added.",
    );

  if (evQ.error && !data) {
    // The API's 404: "version 7 of 'checkout-redesign' not found".
    const notFound = /^version \d+ of .* not found$/i.test(evQ.error);
    return notFound ? (
      <Panel testId="evidence-not-found">
        <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
          <p className="text-[15px] font-semibold text-text2">
            Version {n} of {title} was not found.
          </p>
          {latest !== n && <LinkButton href={`/documents/${doc}/v/${latest}/evidence`}>Go to the latest version (v{latest})</LinkButton>}
        </div>
      </Panel>
    ) : (
      <div className="flex flex-col items-start gap-2">
        <ErrorNote>{evQ.error}</ErrorNote>
        <Button onClick={() => void evQ.reload()}>Try again</Button>
      </div>
    );
  }
  if (!data) {
    return (
      <Panel title={view === "coverage" ? "Coverage" : "Sections"} busy testId="evidence-loading">
        <div className="flex flex-col gap-3 px-4 py-4">
          <Loading label="Loading evidence…" />
          {[80, 62, 70].map((w) => (
            <span key={w} aria-hidden className="h-3 animate-pulse rounded bg-surface2" style={{ width: `${w}%` }} />
          ))}
        </div>
      </Panel>
    );
  }

  const sections = data.sections;
  if (only && sections.length === 0) {
    return (
      <Panel testId="evidence-no-section">
        <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
          <p className="text-[15px] font-semibold text-text2">
            v{n} has no section <span className="font-mono">{only}</span>.
          </p>
          <Button onClick={() => setParams({ section: null, sel: null })}>Show all sections</Button>
        </div>
      </Panel>
    );
  }

  const rows = pivot(sections);
  const links = sections.reduce((a, s) => a + s.links.length, 0);
  const citations = sections.reduce((a, s) => a + s.citations.length, 0);
  const stale = sections.reduce((a, s) => a + staleCount(s), 0);
  const gaps = sections.filter(unsupported);
  const nothing = links === 0 && citations === 0;

  const roleNote = approved ? (
    <Notice testId="evidence-pinned">v{n} is approved: its evidence links are pinned. Read only.</Notice>
  ) : capsReady && !canAdd ? (
    can("create_comment") ? (
      <Notice testId="evidence-commenter">
        Section links are added by approvers. You can add an evidence link to a section&rsquo;s baseline item from the{" "}
        <Link href={`/documents/${doc}/v/${n}`} className="underline">
          Document tab
        </Link>
        .
      </Notice>
    ) : null
  ) : null;

  const toolbar = (
    <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="evidence-toolbar">
      <SegmentedControl<View>
        label="Evidence view"
        value={view}
        onChange={switchView}
        items={[
          { value: "coverage", label: "Coverage" },
          { value: "sections", label: "Sections" },
        ]}
      />
      {capsReady && !canAdd && !approved && <ViewOnly />}
      {stale > 0 && (
        <Chip kind="warn">
          {stale} stale link{stale === 1 ? "" : "s"}
        </Chip>
      )}
      {gaps.length > 0 && (
        <span data-testid="evidence-unsupported" className="inline-flex">
          <Chip kind="crit">{gaps.length === 1 ? `${gaps[0].heading} unsupported` : `${gaps.length} sections unsupported`}</Chip>
        </span>
      )}
      <span className="ml-auto text-[13px] text-text2 max-[1100px]:hidden">
        Rendered pages never show these links; exports list them under &ldquo;Sources and data points&rdquo;.
      </span>
    </div>
  );

  if (nothing) {
    return (
      <>
        {toolbar}
        {roleNote && <div className="mb-3">{roleNote}</div>}
        <Panel testId="evidence-empty">
          <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
            <p className="text-[15px] font-semibold text-text2">No section of v{n} is linked to evidence yet, and the draft cites nothing.</p>
            {canAdd && sections[0] && (
              <Button
                variant="solid"
                onClick={() => select(`section:${sections[0].section_key}`, { view: "sections" })}
              >
                Link a section
              </Button>
            )}
          </div>
        </Panel>
        {/* "Link a section" opens the first section's form, in the section view. */}
        {view === "sections" && selected && (
          <SectionsView
            {...{ data, sections, selected, select, phone, sheetOpen, setSheetOpen, canAdd, canRemove, nameOf, remove, add, result, doc, n, rows }}
          />
        )}
      </>
    );
  }

  return (
    <>
      {toolbar}
      {roleNote && <div className="mb-3">{roleNote}</div>}
      {view === "coverage" ? (
        <CoverageView
          {...{ data, sections, rows, selected, select, phone, sheetOpen, setSheetOpen, canAdd, canRemove, nameOf, remove, add, result, links, citations, stale }}
        />
      ) : (
        <SectionsView
          {...{ data, sections, selected, select, phone, sheetOpen, setSheetOpen, canAdd, canRemove, nameOf, remove, add, result, doc, n, rows }}
        />
      )}
    </>
  );
}

type NewLink = {
  section_key: string;
  kind: LinkKind;
  precision: LinkPrecision;
  claim?: string | null;
  entity_id?: string | null;
  evidence_id?: string | null;
  source_item_id?: string | null;
};

type Shared = {
  data: EvidenceInspector;
  sections: SectionEvidence[];
  rows: MatrixRow[];
  selected: string | null;
  select: (key: string) => void;
  phone: boolean;
  sheetOpen: boolean;
  setSheetOpen: (open: boolean) => void;
  canAdd: boolean;
  canRemove: boolean;
  nameOf: (id: string | null | undefined) => string | null;
  remove: (link: SectionLinkView) => Promise<boolean>;
  add: (link: NewLink) => Promise<boolean>;
  result: { tone: "pass" | "error"; text: string } | null;
};

/** Master and detail: the inspector right on a desktop, in a bottom sheet on a phone. */
function Layout({ phone, sheetOpen, setSheetOpen, inspector, sheetTitle, children }: { phone: boolean; sheetOpen: boolean; setSheetOpen: (o: boolean) => void; inspector: ReactNode; sheetTitle: string; children: ReactNode }) {
  return (
    <>
      <Split inspector={!phone ? inspector : undefined}>{children}</Split>
      {phone && (
        <Sheet open={sheetOpen && !!inspector} title={sheetTitle} onClose={() => setSheetOpen(false)} testId="evidence-sheet">
          {inspector}
        </Sheet>
      )}
    </>
  );
}

// --- C · the coverage matrix ------------------------------------------------------------------

function CoverageView(props: Shared & { links: number; citations: number; stale: number }) {
  const { sections, rows, selected, select, phone, data, links, citations, stale } = props;
  const [showLinks, setShowLinks] = useState(true);
  const [showCites, setShowCites] = useState(true);
  const [staleOnly, setStaleOnly] = useState(false);
  const shown = rows.filter((r) => {
    if (staleOnly) return r.stale;
    return r.group === "citations" ? showCites : showLinks;
  });
  const row = rows.find((r) => r.id === selected) ?? null;
  const groups = (["baseline", "evidence", "citations"] as MatrixGroup[]).filter((g) => shown.some((r) => r.group === g));

  const toggle = (label: string, count: number, on: boolean, flip: () => void) => (
    <button
      type="button"
      aria-pressed={on}
      onClick={flip}
      className={`flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-sm font-medium whitespace-nowrap max-[639px]:h-11 max-[639px]:px-3.5 ${
        on ? "border-accent bg-accent text-on-accent" : "border-line-strong bg-surface text-text hover:bg-surface2"
      }`}
    >
      {label} <b className={`tnum font-semibold ${on ? "text-on-accent" : "text-text2"}`}>{count}</b>
    </button>
  );

  const inspector = row ? <TargetInspector key={row.id} row={row} {...props} /> : null;

  return (
    <Layout phone={phone} sheetOpen={props.sheetOpen} setSheetOpen={props.setSheetOpen} inspector={inspector} sheetTitle={row?.title ?? "Evidence"}>
      <Panel
        title="Coverage"
        count={undefined}
        tools={
          <span className="text-sm text-text2">
            {rows.filter((r) => r.group !== "citations").length} targets · {sections.length} sections
          </span>
        }
        testId="evidence-coverage"
      >
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3 max-[600px]:px-3" role="group" aria-label="Rows shown">
          {toggle("Links", links, showLinks && !staleOnly, () => {
            setStaleOnly(false);
            setShowLinks((v) => !v);
          })}
          {toggle("Citations", citations, showCites && !staleOnly, () => {
            setStaleOnly(false);
            setShowCites((v) => !v);
          })}
          {toggle("Stale only", stale, staleOnly, () => setStaleOnly((v) => !v))}
          <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-text2 max-[1100px]:hidden" aria-label="Legend">
            <Cell tone="pass">0.85</Cell>≥ 0.70 <Cell tone="warn">0.55</Cell>0.40–0.70 <Cell tone="crit">0.38</Cell>&lt; 0.40{" "}
            <Cell tone="na" stale>
              stale
            </Cell>
            section changed
          </span>
        </div>
        {shown.length === 0 ? (
          <Empty>No rows match</Empty>
        ) : phone ? (
          <ul data-testid="evidence-list" className="flex flex-col">
            {groups.map((g) => (
              <li key={g}>
                <p className="bg-surface2 px-3 py-1.5 text-[13px] font-semibold text-text2">
                  {GROUP_LABEL[g]} <span className="tnum">{shown.filter((r) => r.group === g).length}</span>
                </p>
                <ul>
                  {shown
                    .filter((r) => r.group === g)
                    .map((r) => (
                      <li key={r.id} className="border-b border-line">
                        <button
                          type="button"
                          onClick={() => select(r.id)}
                          className={`flex w-full flex-col items-start gap-1.5 px-3 py-2.5 text-left ${r.id === selected ? "bg-accent-soft" : ""}`}
                        >
                          <span className={`font-medium [overflow-wrap:anywhere] ${r.muted ? "text-text2" : ""}`}>{r.title}</span>
                          <span className="font-mono text-[13px] text-text2 [overflow-wrap:anywhere]">{r.sub}</span>
                          <span className="flex flex-wrap gap-1.5">
                            {sections
                              .filter((s) => r.links.has(s.section_key) || r.cited.has(s.section_key))
                              .map((s) => (
                                <MatrixCell key={s.section_key} row={r} section={s.section_key} label={s.heading} />
                              ))}
                          </span>
                        </button>
                      </li>
                    ))}
                </ul>
              </li>
            ))}
          </ul>
        ) : (
          <div data-testid="evidence-matrix-scroll" className="max-w-full overflow-x-auto">
            <table data-testid="evidence-matrix" className="w-max min-w-full border-collapse text-[15px]" aria-label="Coverage">
              <thead>
                <tr className="border-b border-line">
                  <th scope="col" className="sticky left-0 z-10 min-w-[240px] bg-surface px-4 py-2 text-left text-[13px] font-semibold text-text2">
                    Linked to
                  </th>
                  {sections.map((s) => {
                    const gap = unsupported(s);
                    return (
                      <th
                        key={s.section_key}
                        scope="col"
                        data-section={s.section_key}
                        data-gap={gap ? "true" : undefined}
                        className={`w-[96px] min-w-[96px] px-1 py-2 text-center align-bottom text-[13px] leading-4 font-semibold ${gap ? "bg-crit-bg text-crit" : "text-text2"}`}
                      >
                        <span className="block [overflow-wrap:anywhere]">{s.heading}</span>
                        <span className="block font-mono font-medium text-text-faint">{s.section_key}</span>
                        {gap && <span className="block">unsupported</span>}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <MatrixGroupRows key={g} group={g} rows={shown.filter((r) => r.group === g)} sections={sections} selected={selected} select={select} />
                ))}
                <tr data-testid="evidence-totals" className="border-t border-line bg-surface2 text-sm font-semibold">
                  <td className="sticky left-0 bg-surface2 px-4 py-2">Per section</td>
                  {sections.map((s) => (
                    <td key={s.section_key} data-section={s.section_key} className={`tnum px-1 py-2 text-center ${unsupported(s) ? "bg-crit-bg text-crit" : ""}`}>
                      {s.links.length} · {s.citations.length}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        )}
        <p className="border-t border-line px-4 py-2 text-[13px] text-text2">
          Per section = links · citations. A red column has neither. Rendered pages never show these links; exports list them under
          &ldquo;Sources and data points&rdquo; (rejected and superseded items left out). Snapshot{" "}
          <span className="font-mono">{data.snapshot ?? "not recorded"}</span>.
        </p>
      </Panel>
      {!phone && !row && <p className="sr-only">Pick a cell to see every section that links its target.</p>}
    </Layout>
  );
}

function MatrixGroupRows({ group, rows, sections, selected, select }: { group: MatrixGroup; rows: MatrixRow[]; sections: SectionEvidence[]; selected: string | null; select: (k: string) => void }) {
  return (
    <>
      <tr className="border-b border-line bg-surface2">
        <th colSpan={sections.length + 1} scope="colgroup" className="sticky left-0 px-4 py-1.5 text-left text-[13px] font-semibold text-text2">
          {GROUP_LABEL[group]} <span className="tnum ml-1 text-text-faint">{rows.length}</span>
        </th>
      </tr>
      {rows.map((r) => (
        <tr
          key={r.id}
          data-target={r.id}
          aria-selected={r.id === selected}
          onClick={() => select(r.id)}
          className={`cursor-pointer border-b border-line hover:bg-surface2 ${r.id === selected ? "bg-accent-soft shadow-[inset_4px_0_0_var(--color-accent)]" : ""}`}
        >
          <td className={`sticky left-0 z-10 max-w-[320px] min-w-[240px] px-4 py-1.5 ${r.id === selected ? "bg-accent-soft" : "bg-surface"}`}>
            <span className={`block truncate font-medium ${r.muted ? "text-text2" : ""}`}>{r.title}</span>
            <span className="block truncate font-mono text-[13px] text-text-faint">{r.sub}</span>
          </td>
          {sections.map((s) => {
            const ls = r.links.get(s.section_key);
            const gap = unsupported(s);
            return (
              <td
                key={s.section_key}
                data-section={s.section_key}
                data-stale={ls?.some((l) => !l.current) ? "true" : undefined}
                className={`px-1 py-1 text-center ${gap ? "bg-crit-bg/60" : ""}`}
              >
                {ls || r.cited.has(s.section_key) ? (
                  <MatrixCell row={r} section={s.section_key} label={s.heading} onPick={() => select(r.id)} on={r.id === selected} />
                ) : (
                  <span aria-hidden className="text-line-strong">
                    ·
                  </span>
                )}
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}

function Cell({ tone: t, stale = false, on = false, children }: { tone: keyof typeof CELL; stale?: boolean; on?: boolean; children: ReactNode }) {
  return (
    <span
      className={`inline-flex h-7 min-w-16 items-center justify-center gap-1 rounded-md px-1.5 text-[13px] font-semibold whitespace-nowrap max-[600px]:min-w-0 ${CELL[t]} ${
        stale ? "outline-2 -outline-offset-2 outline-warn outline-dashed" : ""
      } ${on ? "ring-2 ring-accent" : ""}`}
    >
      {children}
    </span>
  );
}

/** One cell: the strongest link's kind and confidence (+n more), or "cited". */
function MatrixCell({ row, section, label, onPick, on = false }: { row: MatrixRow; section: string; label: string; onPick?: () => void; on?: boolean }) {
  const ls = row.links.get(section);
  const first = ls?.[0];
  const stale = !!ls?.some((l) => !l.current);
  const text = first ? `${kindShort(first.kind)} ${score(first.target.confidence)}` : "cited";
  const more = ls && ls.length > 1 ? ` +${ls.length - 1}` : "";
  const inner = (
    <Cell tone={first ? tone(first.target.confidence) : "cit"} stale={stale} on={on}>
      {onPick ? null : <span className="font-medium">{label} ·</span>}
      {text}
      {more}
    </Cell>
  );
  if (!onPick) return inner;
  return (
    <button
      type="button"
      aria-label={`${row.title} in ${label}: ${first ? `${kindLabel(first.kind)} ${score(first.target.confidence)}` : "cited"}${stale ? ", stale" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        onPick();
      }}
      className="rounded-md"
    >
      {inner}
    </button>
  );
}

function TargetInspector(props: Shared & { row: MatrixRow }) {
  const { row, sections, data, canAdd, canRemove, nameOf, remove, add, result } = props;
  const linked = sections.filter((s) => row.links.has(s.section_key) || row.cited.has(s.section_key));
  if (row.citation) return <CitationInspector citation={row.citation} sections={linked} result={result} />;
  const t = row.target!;
  const all = sections.flatMap((s) => (row.links.get(s.section_key) ?? []).map((l) => ({ s, l })));
  const best = all.map((x) => x.l.target.confidence).find((c) => c != null);
  return (
    <Inspector
      eyebrow={`${targetEyebrow(t)} · linked in ${linked.length} section${linked.length === 1 ? "" : "s"}`}
      title={row.title}
      testId="evidence-target-inspector"
      action={<TargetOpen target={t} />}
      chips={<TargetChips target={t} confidence={best} />}
    >
      {result && (
        <div className="px-5 pt-4 max-[600px]:px-4">
          <Notice tone={result.tone}>{result.text}</Notice>
        </div>
      )}
      <TargetNotes target={t} />
      <InspectorSection label={`Links in v${data.number}`}>
        <div className="flex flex-col gap-2">
          {all.map(({ s, l }) => (
            <div key={l.id} data-testid="evidence-link" className={`flex flex-col gap-1.5 rounded-lg border px-3 py-2.5 ${l.current ? "border-line" : "border-warn border-dashed"}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{s.heading}</span>
                <span className="font-mono text-[13px] text-text2">{s.section_key}</span>
                <span className="ml-auto text-[13px] font-semibold text-text2">
                  {kindLabel(l.kind)} · {l.precision}
                </span>
              </div>
              {l.claim && <p className="text-sm italic">&ldquo;{l.claim}&rdquo;</p>}
              {!l.current && (
                <p className="flex flex-wrap items-center gap-2 text-[13px] text-text2">
                  <Chip kind="warn">Stale link</Chip> Section changed since linking (hash now <span className="font-mono">#{s.section_hash.slice(0, 8)}</span>).
                </p>
              )}
              <LinkMeta link={l} nameOf={nameOf} canRemove={canRemove} remove={remove} />
            </div>
          ))}
        </div>
      </InspectorSection>
      {canAdd && <LinkElsewhereForm key={`${row.id}|${all.length}`} target={t} sections={sections} linked={new Set(row.links.keys())} add={add} />}
    </Inspector>
  );
}

function TargetOpen({ target: t }: { target: SectionLinkTarget }) {
  if (t.type === "entity") {
    return (
      <LinkButton variant="hero" href={`/baseline?entity=${t.id}`}>
        Open in Baseline
      </LinkButton>
    );
  }
  if (t.url && !t.restricted) {
    return (
      <a href={t.url} target="_blank" rel="noreferrer" className="text-sm font-semibold text-hero-text underline">
        Open source ↗
      </a>
    );
  }
  return null;
}

function TargetChips({ target: t, confidence }: { target: SectionLinkTarget; confidence?: number | null }) {
  const c = confidence ?? t.confidence;
  return (
    <>
      {t.ref && <Chip hero className="font-mono">{t.ref}</Chip>}
      {t.status && <Chip kind={t.status === "confirmed" ? "pass" : leftOut(t) ? "na" : "warn"}>{cap(t.status)}</Chip>}
      {t.locked && <Chip kind="line">Locked</Chip>}
      <Chip kind={tone(c)}>{c == null ? "no score" : score(c)}</Chip>
      {t.restricted && <Chip kind="na">Restricted</Chip>}
      {t.source_removed && <Chip kind="na">Source removed</Chip>}
    </>
  );
}

function TargetNotes({ target: t }: { target: SectionLinkTarget }) {
  const notes: string[] = [];
  if (t.restricted) notes.push("Restricted: someone else’s source. Only its kind is shown.");
  if (t.source_removed) notes.push("Exports label it “(source removed)”.");
  if (leftOut(t)) notes.push(`Left out of exports (${t.status}).`);
  if (!notes.length && !t.excerpt) return null;
  return (
    <InspectorSection>
      <div className="flex flex-col gap-1.5 text-sm text-text2">
        {t.excerpt && <blockquote className="border-l-2 border-line-strong pl-2.5 text-text">{t.excerpt}</blockquote>}
        {notes.map((x) => (
          <p key={x}>{x}</p>
        ))}
      </div>
    </InspectorSection>
  );
}

function LinkMeta({ link: l, nameOf, canRemove, remove }: { link: SectionLinkView; nameOf: (id: string | null | undefined) => string | null; canRemove: boolean; remove: (l: SectionLinkView) => Promise<boolean> }) {
  const [busy, setBusy] = useState(false);
  const meta = [
    nameOf(l.created_by),
    formatDate(l.created_at),
    l.module_key ? `module ${l.module_key}${l.composition_revision != null ? ` r${l.composition_revision}` : ""}` : null,
    l.current ? "current" : null,
  ].filter(Boolean);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="min-w-0 flex-1 text-[13px] text-text2">{meta.join(" · ")}</span>
      {canRemove && (
        <Button
          variant="ghost"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await remove(l);
            setBusy(false);
          }}
        >
          Remove
        </Button>
      )}
    </div>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");

function targetBody(t: SectionLinkTarget): Pick<NewLink, "entity_id" | "evidence_id" | "source_item_id"> {
  return t.type === "entity" ? { entity_id: t.id } : t.type === "evidence" ? { evidence_id: t.id } : { source_item_id: t.id };
}

/** C's "Link to another section": the selected target, linked to a section it is not on yet. */
function LinkElsewhereForm({ target, sections, linked, add }: { target: SectionLinkTarget; sections: SectionEvidence[]; linked: Set<string>; add: (l: NewLink) => Promise<boolean> }) {
  // Unsupported sections first: they are what most needs evidence.
  const options = sections.filter((s) => !linked.has(s.section_key)).sort((a, b) => Number(unsupported(b)) - Number(unsupported(a)));
  const [section, setSection] = useState(options[0]?.section_key ?? "");
  const [kind, setKind] = useState<LinkKind>("evidences");
  const [precision, setPrecision] = useState<LinkPrecision>("section");
  const [claim, setClaim] = useState("");
  const [busy, setBusy] = useState(false);
  if (!options.length) return null;
  const ready = !!section && (precision !== "claim" || !!claim.trim());
  return (
    <InspectorSection label="Link to another section">
      <form
        aria-label="Link to another section"
        className="flex flex-col gap-2.5"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!ready) return;
          setBusy(true);
          await add({ section_key: section, kind, precision, claim: precision === "claim" ? claim.trim() : null, ...targetBody(target) });
          setBusy(false);
        }}
      >
        <Field label="Section">
          <select aria-label="Section" className={INPUT} value={section} onChange={(e) => setSection(e.target.value)}>
            {options.map((s) => (
              <option key={s.section_key} value={s.section_key}>
                {s.heading} ({s.section_key}){unsupported(s) ? " · unsupported" : ""}
              </option>
            ))}
          </select>
        </Field>
        <KindPrecision {...{ kind, setKind, precision, setPrecision, claim, setClaim }} />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" disabled={!ready || busy}>
            Add link
          </Button>
          <span className="text-[13px] text-text2">Approvers and owners, unapproved versions only.</span>
        </div>
      </form>
    </InspectorSection>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[13px] leading-4 font-semibold text-text2">
        {label}
        {hint && <span className="font-normal"> {hint}</span>}
      </span>
      {children}
    </label>
  );
}

function KindPrecision({
  kind,
  setKind,
  precision,
  setPrecision,
  claim,
  setClaim,
}: {
  kind: LinkKind;
  setKind: (k: LinkKind) => void;
  precision: LinkPrecision;
  setPrecision: (p: LinkPrecision) => void;
  claim: string;
  setClaim: (c: string) => void;
}) {
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Kind">
          <select aria-label="Kind" className={INPUT} value={kind} onChange={(e) => setKind(e.target.value as LinkKind)}>
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Precision">
          <select aria-label="Precision" className={INPUT} value={precision} onChange={(e) => setPrecision(e.target.value as LinkPrecision)}>
            {PRECISIONS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Claim" hint="(claim precision only)">
        <input
          aria-label="Claim"
          className={INPUT}
          value={claim}
          disabled={precision !== "claim"}
          maxLength={2000}
          placeholder="The sentence this supports"
          onChange={(e) => setClaim(e.target.value)}
        />
      </Field>
    </>
  );
}

function CitationInspector({ citation: c, sections, result }: { citation: EvidenceCitation; sections: SectionEvidence[]; result: Shared["result"] }) {
  const url = /^https?:\/\//.test(c.ref) ? c.ref : null;
  return (
    <Inspector
      eyebrow={`Draft citation · ${sourceLabel(c.source)}`}
      title={c.title || c.ref}
      testId="evidence-citation-inspector"
      chips={<Chip hero className="font-mono">c:{c.cite_key}</Chip>}
      action={
        url ? (
          <a href={url} target="_blank" rel="noreferrer" className="text-sm font-semibold text-hero-text underline">
            Open source ↗
          </a>
        ) : null
      }
    >
      {result && (
        <div className="px-5 pt-4">
          <Notice tone={result.tone}>{result.text}</Notice>
        </div>
      )}
      <InspectorSection label={`Cited in ${sections.length} section${sections.length === 1 ? "" : "s"}`}>
        <ul className="flex flex-col gap-1 text-sm">
          {sections.map((s) => (
            <li key={s.section_key}>
              <span className="font-semibold">{s.heading}</span> <span className="font-mono text-[13px] text-text2">{s.section_key}</span>
            </li>
          ))}
        </ul>
      </InspectorSection>
      <InspectorSection label="Citation">
        <CitationBody c={c} />
      </InspectorSection>
    </Inspector>
  );
}

function CitationBody({ c }: { c: EvidenceCitation }) {
  return (
    <div data-testid="evidence-citation" className="flex flex-col gap-1 rounded-lg border border-line px-3 py-2.5 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[13px]">c:{c.cite_key}</span>
        <span className="text-[13px] font-semibold text-text2">{sourceLabel(c.source)}</span>
      </div>
      <span className="font-semibold">{c.title || c.ref}</span>
      <span className="font-mono text-[13px] break-all text-text2">{c.ref}</span>
      {c.excerpt && <blockquote className="border-l-2 border-line-strong pl-2.5">{c.excerpt}</blockquote>}
      {(!c.excerpt || !c.retrieved_at) && (
        <span className="text-[13px] text-text2">
          {[!c.excerpt ? "No excerpt" : null, c.retrieved_at ? `Retrieved ${formatDate(c.retrieved_at)}` : "retrieval date not recorded"]
            .filter(Boolean)
            .join(" · ")}
        </span>
      )}
      {c.excerpt && c.retrieved_at && <span className="text-[13px] text-text2">Retrieved {formatDate(c.retrieved_at)}</span>}
    </div>
  );
}

// --- A · the section table + inspector --------------------------------------------------------

function SectionsView(props: Shared & { doc: string; n: number }) {
  const { sections, selected, select, phone } = props;
  const [filter, setFilter] = useState<SectionFilter>("all");
  const hasBrief = sections.some((s) => s.layer === "brief");
  const match = (s: SectionEvidence, f: SectionFilter) =>
    f === "all" ? true : f === "brief" ? s.layer === "brief" : f === "detail" ? s.layer !== "brief" : f === "stale" ? staleCount(s) > 0 : unsupported(s);
  const count = (f: SectionFilter) => sections.filter((s) => match(s, f)).length;
  const rows = sections.filter((s) => match(s, filter));
  const sel = selected?.startsWith("section:") ? sections.find((s) => `section:${s.section_key}` === selected) : undefined;

  const columns: Column<SectionEvidence>[] = [
    {
      key: "section",
      header: "Section",
      cell: (s) => (
        <span className={`flex min-w-0 flex-col ${s.level > 2 ? "pl-4" : ""}`}>
          <span className="truncate font-medium">{s.heading}</span>
          <span className="truncate font-mono text-[13px] text-text-faint">{s.section_key}</span>
        </span>
      ),
    },
    { key: "layer", header: "Layer", width: "72px", phoneLabel: "Layer", cell: (s) => <span className="text-sm">{layerLabel(s.layer)}</span> },
    { key: "links", header: "Links", width: "64px", align: "right", phoneLabel: "Links", cell: (s) => <span className="tnum text-sm">{s.links.length}</span> },
    { key: "cites", header: "Citations", width: "84px", align: "right", phoneLabel: "Citations", cell: (s) => <span className="tnum text-sm">{s.citations.length}</span> },
    {
      key: "weakest",
      header: "Weakest",
      width: "118px",
      cell: (s) => {
        const w = weakest(s);
        if (unsupported(s)) return <Chip kind="crit" className="border border-dashed border-crit">unsupported</Chip>;
        if (!s.links.length) return <span className="text-sm text-text2">citations only</span>;
        return <Chip kind={tone(w)}>{w == null ? "no score" : score(w)}</Chip>;
      },
    },
    {
      key: "stale",
      header: "Stale",
      width: "92px",
      cell: (s) => (staleCount(s) ? <Chip kind="warn">{staleCount(s)} stale</Chip> : <span className="text-sm text-text2">—</span>),
    },
  ];

  const items: { value: SectionFilter; label: string; count: number }[] = [
    { value: "all", label: "All sections", count: count("all") },
    ...(hasBrief
      ? [
          { value: "brief" as const, label: "Brief layer", count: count("brief") },
          { value: "detail" as const, label: "Full layer", count: count("detail") },
        ]
      : []),
    { value: "stale", label: "Has stale links", count: count("stale") },
    { value: "none", label: "No links or citations", count: count("none") },
  ];

  const inspector = sel ? <SectionInspector key={sel.section_key} section={sel} {...props} /> : null;
  return (
    <Layout phone={phone} sheetOpen={props.sheetOpen} setSheetOpen={props.setSheetOpen} inspector={inspector} sheetTitle={sel?.heading ?? "Section"}>
      <Panel title="Sections" count={sections.length} tools={props.data.snapshot ? <span className="text-[13px] font-semibold text-text2">snapshot <span className="font-mono">{props.data.snapshot}</span></span> : undefined}>
        <div className="border-b border-line px-4 py-3 max-[600px]:px-3">
          <FilterChips label="Sections shown" items={items} value={filter} onChange={setFilter} />
        </div>
        <DataTable
          label="Sections"
          testId="evidence-sections"
          columns={columns}
          rows={rows}
          rowKey={(s) => `section:${s.section_key}`}
          selected={phone ? (props.sheetOpen ? (selected ?? null) : null) : (selected ?? null)}
          onSelect={(k) => select(k)}
          empty="No sections match"
          rowProps={(s) => ({ "data-section": s.section_key })}
        />
        <p className="border-t border-line px-4 py-2 text-[13px] text-text2">
          Links are listed strongest first (confidence high to low, unscored last). Citations are the draft&rsquo;s own{" "}
          <span className="font-mono">[c:id]</span> markers.
        </p>
      </Panel>
    </Layout>
  );
}

function SectionInspector(props: Shared & { section: SectionEvidence; doc: string; n: number }) {
  const { section: s, canAdd, canRemove, nameOf, remove, add, result, rows, doc, n } = props;
  const w = weakest(s);
  const st = staleCount(s);
  return (
    <Inspector
      eyebrow={`Section · ${layerLabel(s.layer).toLowerCase()} · level ${s.level}`}
      title={s.heading}
      testId="evidence-section-inspector"
      action={
        <LinkButton variant="hero" href={`/documents/${doc}/v/${n}#${s.section_key}`}>
          Open in document
        </LinkButton>
      }
      chips={
        <>
          <Chip hero className="font-mono">{s.section_key}</Chip>
          <Chip hero className="font-mono">#{s.section_hash.slice(0, 8)}</Chip>
          {st > 0 && (
            <Chip kind="warn">
              {st} stale link{st === 1 ? "" : "s"}
            </Chip>
          )}
          {unsupported(s) && <Chip kind="crit">Unsupported</Chip>}
        </>
      }
      stats={[
        { label: "Links", value: s.links.length },
        { label: "Citations", value: s.citations.length },
        { label: "Weakest", value: w == null ? "—" : score(w), tone: w != null && w < 0.4 ? "crit" : undefined },
      ]}
    >
      {result && (
        <div className="px-5 pt-4 max-[600px]:px-4">
          <Notice tone={result.tone}>{result.text}</Notice>
        </div>
      )}
      {unsupported(s) ? (
        <InspectorSection>
          <p className="text-sm text-text2">Nothing backs this section yet: no section links and no citations in the draft.</p>
        </InspectorSection>
      ) : (
        <>
          <InspectorSection
            label={
              <>
                Section links <span className="font-normal text-text-faint">strongest first</span>
              </>
            }
          >
            {s.links.length === 0 ? (
              <p className="text-sm text-text2">No section links; the draft&rsquo;s citations below.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {s.links.map((l) => (
                  <SectionLinkCard key={l.id} link={l} nameOf={nameOf} canRemove={canRemove} remove={remove} />
                ))}
              </div>
            )}
          </InspectorSection>
          <InspectorSection
            label={
              <>
                Citations in the draft <span className="font-normal text-text-faint">{s.citations.length}</span>
              </>
            }
          >
            {s.citations.length === 0 ? (
              <p className="text-sm text-text2">The draft cites nothing in this section.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {s.citations.map((c) => (
                  <CitationBody key={c.cite_key} c={c} />
                ))}
              </div>
            )}
          </InspectorSection>
        </>
      )}
      {canAdd && <AddSectionLinkForm key={`${s.section_key}|${s.links.length}`} section={s} rows={rows} add={add} />}
    </Inspector>
  );
}

function SectionLinkCard({ link: l, nameOf, canRemove, remove }: { link: SectionLinkView; nameOf: (id: string | null | undefined) => string | null; canRemove: boolean; remove: (l: SectionLinkView) => Promise<boolean> }) {
  const t = l.target;
  const c = t.confidence;
  return (
    <div data-testid="evidence-link" className={`flex flex-col gap-1.5 rounded-lg border px-3 py-2.5 ${l.current ? "border-line" : "border-dashed border-warn"}`}>
      {!l.current && (
        <div className="flex flex-wrap items-center gap-2">
          <Chip kind="warn">Stale link</Chip>
          <span className="text-[13px] text-text2">section changed since linking</span>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold text-text2">{kindLabel(l.kind)}</span>
        <span className="text-[13px] text-text-faint">· {l.precision}</span>
        <span className="ml-auto" data-confidence={c == null ? "" : String(c)}>
          <Chip kind={tone(c)}>{c == null ? "no score" : score(c)}</Chip>
        </span>
      </div>
      {l.claim && <p className="text-sm italic">&ldquo;{l.claim}&rdquo;</p>}
      <span className={`font-medium [overflow-wrap:anywhere] ${leftOut(t) || t.restricted ? "text-text2" : ""}`}>{targetTitle(t)}</span>
      {t.excerpt && <blockquote className="border-l-2 border-line-strong pl-2.5 text-sm">{t.excerpt}</blockquote>}
      <div className="flex flex-wrap items-center gap-1.5">
        {t.ref && t.type === "entity" && <span className="font-mono text-[13px] text-text2">{t.ref}</span>}
        {t.type !== "entity" && <span className="text-[13px] text-text2">{sourceLabel(t.source_kind)}</span>}
        {t.status && <Chip kind={t.status === "confirmed" ? "pass" : leftOut(t) ? "na" : "warn"}>{cap(t.status)}</Chip>}
        {t.locked && <Chip kind="line">Locked</Chip>}
        {t.source_removed && <Chip kind="na">Source removed</Chip>}
        {t.url && !t.restricted && (
          <a href={t.url} target="_blank" rel="noreferrer" className="text-[13px] font-semibold text-accent-ink hover:underline">
            Open source ↗
          </a>
        )}
      </div>
      {t.restricted && <p className="text-[13px] text-text2">Restricted: someone else&rsquo;s source. Only its kind is shown.</p>}
      {t.source_removed && <p className="text-[13px] text-text2">Exports label it &ldquo;(source removed)&rdquo;.</p>}
      {leftOut(t) && <p className="text-[13px] text-text2">Left out of exports ({t.status}).</p>}
      <LinkMeta link={l} nameOf={nameOf} canRemove={canRemove} remove={remove} />
    </div>
  );
}

/**
 * A's "Add a section link": kind, precision, what it links to (the company's baseline items,
 * GET /v1/baseline/entities, and the evidence and source items this version already links),
 * and the claim for a claim link.
 */
function AddSectionLinkForm({ section, rows, add }: { section: SectionEvidence; rows: MatrixRow[]; add: (l: NewLink) => Promise<boolean> }) {
  const entitiesQ = useQuery("evidence-entities", () => unwrap(api.GET("/v1/baseline/entities", {})));
  const [kind, setKind] = useState<LinkKind>("evidences");
  const [precision, setPrecision] = useState<LinkPrecision>("section");
  const [claim, setClaim] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const linked = useMemo(() => new Set(section.links.map((l) => targetKey(l.target))), [section]);
  const known = rows.filter((r) => r.target && r.target.type !== "entity" && !linked.has(r.id));
  const entities = (entitiesQ.data ?? []).filter((e) => !linked.has(`entity:${e.id}`) && e.status !== "rejected");
  const ready = !!to && (precision !== "claim" || !!claim.trim());
  const body = (): Pick<NewLink, "entity_id" | "evidence_id" | "source_item_id"> => {
    const [type, id] = [to.slice(0, to.indexOf(":")), to.slice(to.indexOf(":") + 1)];
    return type === "entity" ? { entity_id: id } : type === "evidence" ? { evidence_id: id } : { source_item_id: id };
  };
  return (
    <InspectorSection label="Add a section link">
      <form
        aria-label="Add a section link"
        className="flex flex-col gap-2.5"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!ready) return;
          setBusy(true);
          await add({ section_key: section.section_key, kind, precision, claim: precision === "claim" ? claim.trim() : null, ...body() });
          setBusy(false);
        }}
      >
        <KindPrecision {...{ kind, setKind, precision, setPrecision, claim, setClaim }} />
        <Field label="Links to">
          <select aria-label="Links to" className={INPUT} value={to} onChange={(e) => setTo(e.target.value)} aria-busy={entitiesQ.loading}>
            <option value="">Pick a baseline item, evidence or source item</option>
            {entities.length > 0 && (
              <optgroup label="Baseline items">
                {entities.map((e) => (
                  <option key={e.id} value={`entity:${e.id}`}>
                    {e.title} · {e.type}:{e.key}
                  </option>
                ))}
              </optgroup>
            )}
            {known.length > 0 && (
              <optgroup label="Evidence and source items in this version">
                {known.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title} · {r.sub}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </Field>
        {entitiesQ.error && <ErrorNote>{entitiesQ.error}</ErrorNote>}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" disabled={!ready || busy}>
            Add link
          </Button>
          <span className="text-[13px] text-text2">Pinned to this section&rsquo;s current text.</span>
        </div>
      </form>
    </InspectorSection>
  );
}
