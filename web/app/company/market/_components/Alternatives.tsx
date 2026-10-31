"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

import { Button, Chip, DataTable, InfoTip, Inspector, InspectorSection, Panel, Split, useFocusTrap, type Column } from "@/components/ds";
import { ErrorNote, INPUT } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { useCompanyZone } from "@/lib/dates";
import { formatDay } from "@/lib/format";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

import { CompanyEmpty } from "../../_empty";
import { FindingCard } from "./FindingCard";
import {
  KIND_LABEL,
  KINDS,
  LABEL_TITLE,
  LABELS,
  PAGE_STATE,
  RATING_KIND,
  RATING_LABEL,
  day,
  hostOf,
  originOf,
  type Competitor,
  type CompetitorDetail,
  type Kind,
  type Label,
  type WatchedPage,
} from "./lib";

/**
 * Market › Alternatives: what a customer could use instead (direct, indirect, the status
 * quo), one row each, and the picked one's inspector: about it, its watched pages, its change
 * log and its open web findings. Approvers and owners add alternatives and watch pages.
 */
export function Alternatives({
  picked,
  onPick,
  onOpenChange,
  adding,
  onAdding,
  onEmpty,
}: {
  picked: string | null;
  onPick: (id: string) => void;
  onOpenChange: (id: string) => void;
  adding: boolean;
  onAdding: (open: boolean) => void;
  /** Whether the list is known to be empty (its own Add button shows), so the header drops its one (qa-company-20); null while it loads. */
  onEmpty?: (empty: boolean | null) => void;
}) {
  const zone = useCompanyZone();
  const mayAdd = useMe().can("create_competitor");
  const list = useQuery("competitors", () => unwrap(api.GET("/v1/competitors")));
  const rows = list.data ?? [];
  const empty = list.data ? list.data.length === 0 : null;
  useEffect(() => {
    onEmpty?.(empty);
  }, [empty, onEmpty]);
  const selected = rows.find((c) => c.id === picked) ?? rows[0] ?? null;
  const detail = useQuery(
    `competitor|${selected?.id ?? "none"}`,
    () => (selected ? unwrap(api.GET("/v1/competitors/{competitor_id}", { params: { path: { competitor_id: selected.id } } })) : Promise.resolve(null)),
    { keepPrevious: true },
  );
  const shown = detail.data && detail.data.id === selected?.id ? detail.data : null;

  const columns: Column<Competitor>[] = [
    { key: "name", header: "Alternative", phone: "title", cell: (c) => <span className="truncate font-medium">{c.name}</span> },
    { key: "kind", header: "Kind", width: "112px", phone: "hide", cell: (c) => <span className="text-sm text-text2">{KIND_LABEL[c.kind]}</span> },
    {
      key: "pages",
      header: "Pages",
      width: "72px",
      align: "right",
      phone: "hide",
      cell: (c) => (
        <span data-col="pages" className="tnum text-sm">
          {c.pages}
        </span>
      ),
    },
    {
      key: "last",
      header: "Last change",
      width: "112px",
      phone: "meta",
      phoneLabel: "Last change",
      cell: (c) => <span className="tnum text-sm">{c.last_change_on ? formatDay(c.last_change_on) : "—"}</span>,
    },
    {
      key: "month",
      header: "Changes this month",
      width: "160px",
      align: "right",
      phone: "hide",
      cell: (c) => <span className="tnum text-sm">{c.changes_this_month}</span>,
    },
    {
      key: "state",
      header: "State",
      width: "180px",
      phone: "hide",
      cell: (c) =>
        c.watch_problem ? (
          <Chip kind="crit" dot>
            {c.watch_problem}
          </Chip>
        ) : c.status === "archived" ? (
          <Chip kind="na">Archived</Chip>
        ) : (
          <Chip kind="pass" dot>
            Active
          </Chip>
        ),
    },
  ];

  async function changed() {
    await Promise.all([list.reload(), detail.reload()]);
  }

  return (
    <>
      {list.error && <ErrorNote>{list.error}</ErrorNote>}
      <Split
        inspector={
          shown ? <CompetitorInspector key={shown.id} detail={shown} zone={zone} onChanged={changed} onOpenChange={onOpenChange} /> : undefined
        }
      >
        <Panel
          title="Alternatives"
          count={list.data ? rows.length : undefined}
          tools={
            <InfoTip label="alternatives" align="end">
              What a customer could use instead: a direct competitor, an indirect one (a different product for the same job) or the status quo (a
              spreadsheet, an agency, doing nothing). Oracle reads their watched public pages once a week and lists what changed.
            </InfoTip>
          }
        >
          {list.data && rows.length === 0 ? (
            <CompanyEmpty
              testId="alternatives-empty"
              title="No alternatives yet"
              action={
                mayAdd ? (
                  <Button icon="plus" onClick={() => onAdding(true)}>
                    Add your first alternative
                  </Button>
                ) : undefined
              }
            >
              Add what a customer could use instead of you: a competitor, a different kind of product, or a spreadsheet and habit. Oracle then
              reads their public pages every week and lists what changed.{mayAdd ? "" : " Approvers and owners add them."}
            </CompanyEmpty>
          ) : (
            <DataTable
              label="Alternatives"
              testId="alternatives-table"
              columns={columns}
              rows={list.data ? rows : undefined}
              loading={list.loading}
              rowKey={(c) => c.id}
              selected={selected?.id ?? null}
              onSelect={(id) => onPick(id)}
              rowProps={(c) => ({ "data-testid": "alternative-row", "data-id": c.id })}
            />
          )}
        </Panel>
      </Split>
      {adding && (
        <AddAlternativeDialog
          onClose={() => onAdding(false)}
          onAdded={async (c) => {
            onAdding(false);
            await list.reload();
            onPick(c.id);
          }}
        />
      )}
    </>
  );
}

function CompetitorInspector({
  detail,
  zone,
  onChanged,
  onOpenChange,
}: {
  detail: CompetitorDetail;
  zone: string;
  onChanged: () => Promise<void>;
  onOpenChange: (id: string) => void;
}) {
  const { can } = useMe();
  const [watching, setWatching] = useState(false);
  // The page just watched: its read is its first.
  const [firstRead, setFirstRead] = useState<string | null>(null);
  return (
    <Inspector
      eyebrow="Alternative"
      title={detail.name}
      testId="alternative-inspector"
      chips={
        <>
          <Chip hero kind="now">
            {KIND_LABEL[detail.kind]}
          </Chip>
          {detail.watch_problem && <Chip hero>{detail.watch_problem}</Chip>}
        </>
      }
      stats={[
        { label: "Pages", value: detail.pages },
        { label: "Changes this month", value: detail.changes_this_month },
        { label: "From the web", value: detail.open_web_findings },
      ]}
    >
      <InspectorSection label="About">
        <dl className="flex flex-col gap-1.5 text-sm [overflow-wrap:anywhere]">
          {detail.description && <dd className="text-[15px]">{detail.description}</dd>}
          <div className="flex gap-2">
            <dt className="font-semibold text-text2">Website</dt>
            <dd>{detail.website ? hostOf(detail.website) : "—"}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-semibold text-text2">Also called</dt>
            <dd>{detail.aliases.length ? detail.aliases.join(", ") : "—"}</dd>
          </div>
        </dl>
      </InspectorSection>
      <InspectorSection
        label="Watched pages"
        testId="watched-pages"
        tools={
          can("watch_competitor_page") &&
          !watching && (
            <Button variant="ghost" icon="plus" onClick={() => setWatching(true)}>
              Watch a page
            </Button>
          )
        }
      >
        {watching && (
          <WatchForm
            competitorId={detail.id}
            onCancel={() => setWatching(false)}
            onWatched={async (p) => {
              setWatching(false);
              setFirstRead(p.id);
              await onChanged();
            }}
          />
        )}
        {detail.page_list.length === 0 ? (
          <p className="text-sm text-text2">No pages watched</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {detail.page_list.map((p) => (
              <PageRow key={p.id} page={p} zone={zone} first={p.id === firstRead} onChanged={onChanged} />
            ))}
          </ul>
        )}
      </InspectorSection>
      <InspectorSection label="Change log" testId="alternative-changes">
        {detail.changes.length === 0 ? (
          <p className="text-sm text-text2">No changes yet</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {detail.changes.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  data-testid="change-row"
                  onClick={() => onOpenChange(c.id)}
                  className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg px-1.5 py-1 text-left text-sm hover:bg-surface2"
                >
                  <span className="font-semibold">{originOf(c)}</span>
                  <span className="tnum text-text2">{day(c.detected_at, zone)}</span>
                  {c.origin === "page" && (
                    <span className="tnum text-text2">
                      +{c.added_lines} −{c.removed_lines}
                    </span>
                  )}
                  <Chip kind={RATING_KIND[c.rating]}>{RATING_LABEL[c.rating]}</Chip>
                  {c.summary && <span className="basis-full text-text2 [overflow-wrap:anywhere]">{c.summary}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </InspectorSection>
      <InspectorSection label="From the web">
        {detail.web_findings.length === 0 ? (
          <p className="text-sm text-text2">No open web findings</p>
        ) : (
          <div className="flex flex-col divide-y divide-line">
            {detail.web_findings.map((f) => (
              <FindingCard
                key={f.id}
                finding={f}
                showCompetitor={false}
                canDecide={can("promote_web_finding")}
                onPromoted={() => void onChanged()}
                onDismissed={() => void onChanged()}
              />
            ))}
          </div>
        )}
      </InspectorSection>
    </Inspector>
  );
}

/** A watched page: label, host, last read, state; Check now, Pause or Resume, Remove (approvers). */
function PageRow({ page, zone, first, onChanged }: { page: WatchedPage; zone: string; first: boolean; onChanged: () => Promise<void> }) {
  const { can } = useMe();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = { params: { path: { page_id: page.id } } };
  const state = PAGE_STATE[page.status];
  async function act(call: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await call();
      await onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const read = page.last_checked_at ? `${first ? "First read" : "Read"} ${day(page.last_checked_at, zone)}` : "Not read yet";
  return (
    <li data-testid="watched-page" className="flex min-w-0 flex-col gap-1 py-2 text-sm">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-semibold">{LABEL_TITLE[page.label]}</span>
        <span className="min-w-0 text-text2 [overflow-wrap:anywhere]" title={page.url}>
          {page.host}
        </span>
        <span className="tnum text-text2">{read}</span>
        <Chip kind={state.kind} dot>
          {state.label}
        </Chip>
      </div>
      {page.last_error && <p className="text-text2">{page.last_error}</p>}
      <div className="flex flex-wrap gap-1.5">
        {can("check_competitor_page") && page.status !== "paused" && (
          <Button variant="ghost" disabled={busy} onClick={() => act(() => unwrap(api.POST("/v1/competitor-pages/{page_id}/check", path)))}>
            Check now
          </Button>
        )}
        {can("update_competitor_page") && (page.status === "active" || page.status === "paused") && (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() =>
              act(() => unwrap(api.PATCH("/v1/competitor-pages/{page_id}", { ...path, body: { status: page.status === "active" ? "paused" : "active" } })))
            }
          >
            {page.status === "active" ? "Pause" : "Resume"}
          </Button>
        )}
        {can("delete_competitor_page") && (
          <Button variant="ghost" disabled={busy} onClick={() => act(() => unwrap(api.DELETE("/v1/competitor-pages/{page_id}", path)))}>
            Remove
          </Button>
        )}
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
    </li>
  );
}

/** Watch a page: its https URL and label; Oracle reads it at once. */
function WatchForm({ competitorId, onCancel, onWatched }: { competitorId: string; onCancel: () => void; onWatched: (p: WatchedPage) => Promise<void> }) {
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState<Label>("pricing");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!url.trim().toLowerCase().startsWith("https://")) return setError("Only https:// pages can be watched");
    setBusy(true);
    setError(null);
    try {
      const page = await unwrap(
        api.POST("/v1/competitors/{competitor_id}/pages", { params: { path: { competitor_id: competitorId } }, body: { url: url.trim(), label } }),
      );
      await onWatched(page);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }
  return (
    <form className="mb-3 flex flex-col gap-2" onSubmit={submit} noValidate data-testid="watch-form">
      <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
        Page URL
        <input className={INPUT} type="url" value={url} placeholder="https://" onChange={(e) => setUrl(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
        Label
        <select className={INPUT} value={label} onChange={(e) => setLabel(e.target.value as Label)}>
          {LABELS.map((l) => (
            <option key={l} value={l}>
              {LABEL_TITLE[l]}
            </option>
          ))}
        </select>
      </label>
      <p className="text-sm text-text2">Oracle reads it now, then once a week. A page the site asks bots not to read is not read.</p>
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex gap-2">
        <Button type="submit" variant="solid" disabled={busy}>
          Watch
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Add alternative (approvers and owners): name, kind, website, description and aliases. */
function AddAlternativeDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (c: Competitor) => Promise<void> }) {
  const panel = useRef<HTMLDivElement>(null);
  useFocusTrap(panel, true, onClose);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind>("direct");
  const [website, setWebsite] = useState("");
  const [description, setDescription] = useState("");
  const [aliases, setAliases] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError("Give the alternative a name");
    const names = aliases
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean);
    if (names.length > 5) return setError("At most 5 other names");
    setBusy(true);
    setError(null);
    try {
      const c = await unwrap(
        api.POST("/v1/competitors", {
          body: { name: name.trim(), kind, website: website.trim() || null, description: description.trim() || null, aliases: names },
        }),
      );
      await onAdded(c);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-hero/50 px-4 py-10 max-[600px]:px-2 max-[600px]:py-4">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-alternative-title"
        tabIndex={-1}
        className="w-full max-w-lg min-w-0 rounded-inspector border border-line bg-surface text-text shadow-tip outline-none"
      >
        <div className="flex min-h-14 items-center border-b border-line px-5 max-[600px]:px-4">
          <h2 id="add-alternative-title" className="font-display text-xl font-bold tracking-heading">
            Add alternative
          </h2>
        </div>
        <form className="flex flex-col gap-3 px-5 py-4 max-[600px]:px-4" onSubmit={submit} noValidate>
          <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
            Name
            <input className={INPUT} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} data-autofocus="" />
          </label>
          <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
            Kind
            <select className={INPUT} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
            Website
            <input className={INPUT} type="url" value={website} placeholder="https://" maxLength={500} onChange={(e) => setWebsite(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
            Description
            <textarea className={`${INPUT} min-h-20`} value={description} maxLength={2000} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
            Aliases
            <input className={INPUT} value={aliases} placeholder="Other names, separated by commas" onChange={(e) => setAliases(e.target.value)} />
          </label>
          <p className="text-sm text-text2">Oracle lists requests that name it or one of its aliases in the monthly digest.</p>
          {error && <ErrorNote>{error}</ErrorNote>}
          <div className="flex justify-end gap-2 border-t border-line pt-3">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy}>
              Add alternative
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
