"use client";

import Link from "next/link";
import { useId, useState, type ReactNode } from "react";

import { peopleByIds } from "@/components/PersonPicker";
import { Button, Chip, LinkButton, Notice, Page, PageHeader, Panel, type ChipKind } from "@/components/ds";
import { ErrorNote, INPUT, Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

type Texts = Schemas["PublicTextsOut"];
type Row = Schemas["PublicRowOut"];
type Finding = Schemas["LeakFindingOut"];
type Stage = Schemas["PublicTextIn"]["stage"];
type TextIn = Schemas["PublicTextIn"];

/** The leak check's finding codes, as a person reads them. */
const FINDING: Record<string, string> = {
  person_name: "Person name",
  email_or_phone: "Email or phone",
  customer_name: "Customer name",
  alternative_name: "Alternative name",
  internal_code: "Internal code",
  internal_host: "Internal address",
  internal_document: "Internal document",
  decision: "Decision",
  pricing: "Pricing",
  internal_note: "Internal note",
  money_or_metric: "Money or metric",
  date: "Date",
  internal_title_copy: "Internal title copy",
};
const findingLabel = (code: string) => FINDING[code] ?? code.replace(/_/g, " ");
const findingText = (f: Finding) => `${findingLabel(f.code)}: ${f.words.join(", ")}`;

const STATE: Record<Row["state"], { label: string; kind: ChipKind }> = {
  approved: { label: "Approved", kind: "pass" },
  draft: { label: "Draft", kind: "warn" },
  excluded: { label: "Excluded", kind: "na" },
  missing: { label: "Missing", kind: "crit" },
  changed: { label: "Internal item changed", kind: "warn" },
};

const STAGES: [Stage, string][] = [
  ["exploring", "Exploring"],
  ["planned", "Planned"],
  ["in_progress", "In progress"],
  ["shipped", "Shipped"],
];

/** The removed categories of the "What is removed" panel, in their fixed order. */
const REMOVED: [string, string][] = [
  ["internal_titles", "internal titles"],
  ["owners", "owners"],
  ["goals", "goals"],
  ["dates_not_announced", "dates not announced"],
  ["tracker_links", "tracker links"],
  ["dependencies", "dependencies"],
  ["economics", "economics"],
  ["prose_sections", "prose sections"],
];

type Filter = "approve" | "findings" | "all";
type Pane = "review" | "preview";

/** A row's refusal: blocking findings, unticked warnings, or a plain message. */
type Refusal =
  | { kind: "blocking"; findings: Finding[] }
  | { kind: "warnings"; message: string; warnings: string[] }
  | { kind: "other"; message: string };

const toApprove = (r: Row) => (r.state === "draft" || r.state === "missing" || r.state === "changed") && r.left_out_reason !== "no_goal";

/** The 422 detail of PUT public-texts as a Refusal. */
function refusal(error: unknown, status: number): Refusal {
  const detail = error && typeof error === "object" && "detail" in error ? (error as { detail: unknown }).detail : null;
  if (detail && typeof detail === "object") {
    const d = detail as { code?: string; message?: string; findings?: Finding[]; warnings?: string[] };
    if (d.code === "leak_blocking") return { kind: "blocking", findings: d.findings ?? [] };
    if (d.code === "warnings_unchecked") return { kind: "warnings", message: d.message ?? 'Tick "I checked this" for each warning first', warnings: d.warnings ?? [] };
    if (d.message) return { kind: "other", message: d.message };
  }
  if (typeof detail === "string") return { kind: "other", message: detail };
  return { kind: "other", message: `Request failed (${status}).` };
}

async function putText(doc: string, version: number, itemKey: string, body: TextIn): Promise<Refusal | null> {
  try {
    const { error, response } = await api.PUT("/v1/roadmaps/{doc}/public-texts/{item_key}", {
      params: { path: { doc, item_key: itemKey }, query: { version } },
      body,
    });
    return response.ok ? null : refusal(error, response.status);
  } catch (e) {
    return { kind: "other", message: errorMessage(e) };
  }
}

function RefusalAlert({ refusal }: { refusal: Refusal }) {
  return (
    <div role="alert" className="rounded-button bg-crit-bg px-3 py-2 text-sm font-medium text-crit">
      {refusal.kind === "blocking" ? (
        <>
          <p>This text names something a public reader may not see.</p>
          <ul className="mt-1 list-disc pl-5">
            {refusal.findings.map((f) => (
              <li key={f.code}>{findingText(f)}</li>
            ))}
          </ul>
        </>
      ) : (
        <p>{refusal.message}</p>
      )}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: (id: string, hintId?: string) => ReactNode }) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-semibold">
        {label}
      </label>
      {children(id, hintId)}
      {hint && (
        <p id={hintId} className="text-[13px] text-text2">
          {hint}
        </p>
      )}
    </div>
  );
}

/** The inline editor of one item's public text. */
function TextEditor({
  doc,
  version,
  row,
  initialRefusal,
  onSaved,
  onCancel,
}: {
  doc: string;
  version: number;
  row: Row;
  initialRefusal: Refusal | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const t = row.text;
  const [title, setTitle] = useState(t?.title ?? "");
  const [description, setDescription] = useState(t?.description ?? "");
  const [stage, setStage] = useState<Stage>(t?.stage ?? "exploring");
  const [quarter, setQuarter] = useState(t?.announced_quarter ?? "");
  const [url, setUrl] = useState(t?.changelog_url ?? "");
  const [ticked, setTicked] = useState<string[]>(t?.checked_warnings ?? []);
  const [refused, setRefused] = useState<Refusal | null>(initialRefusal);
  const [busy, setBusy] = useState(false);

  const warningCodes = [
    ...new Set([
      ...row.findings.filter((f) => f.severity === "warning").map((f) => f.code),
      ...(refused?.kind === "warnings" ? refused.warnings : []),
    ]),
  ];

  const save = async (state: "draft" | "approved") => {
    setBusy(true);
    const result = await putText(doc, version, row.item_key, {
      title: title.trim(),
      description: description.trim(),
      stage,
      announced_quarter: quarter.trim() || null,
      changelog_url: url.trim() || null,
      state,
      checked_warnings: ticked,
    });
    setBusy(false);
    if (result) setRefused(result);
    else onSaved();
  };

  return (
    <form
      className="mt-3 flex flex-col gap-3 rounded-button border border-line bg-surface2 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save("draft");
      }}
    >
      <Field label="Public title">
        {(id) => <input id={id} className={INPUT} maxLength={80} required value={title} onChange={(e) => setTitle(e.target.value)} />}
      </Field>
      <Field label="Public description">
        {(id) => <textarea id={id} className={INPUT} rows={3} maxLength={280} value={description} onChange={(e) => setDescription(e.target.value)} />}
      </Field>
      <div className="grid grid-cols-2 gap-3 max-[639px]:grid-cols-1">
        <Field label="Stage">
          {(id) => (
            <select id={id} className={INPUT} value={stage} onChange={(e) => setStage(e.target.value as Stage)}>
              {STAGES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Announced quarter" hint="Has this quarter been said in public?">
          {(id, hintId) => (
            <input
              id={id}
              aria-describedby={hintId}
              className={INPUT}
              placeholder="2026-Q4"
              pattern="\d{4}-Q[1-4]"
              value={quarter}
              onChange={(e) => setQuarter(e.target.value)}
            />
          )}
        </Field>
      </div>
      <Field label="Changelog link">
        {(id) => <input id={id} type="url" className={INPUT} placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} />}
      </Field>
      {refused && <RefusalAlert refusal={refused} />}
      {warningCodes.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {warningCodes.map((code) => (
            <li key={code}>
              <label className="inline-flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={ticked.includes(code)}
                  onChange={(e) => setTicked((prev) => (e.target.checked ? [...prev, code] : prev.filter((c) => c !== code)))}
                />
                {findingLabel(code)} — I checked this
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || !title.trim()}>
          Save draft
        </Button>
        <Button variant="solid" disabled={busy || !title.trim()} onClick={() => void save("approved")}>
          Approve
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ReviewRow({ doc, version, row, onChanged }: { doc: string; version: number; row: Row; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);
  const state = STATE[row.state];
  const t = row.text;

  const quick = async (next: "approved" | "excluded") => {
    if (next === "approved" && !t) {
      setRefused(null);
      setEditing(true);
      return;
    }
    setBusy(true);
    const result = await putText(doc, version, row.item_key, {
      title: (t?.title || row.internal_title).slice(0, 80),
      description: t?.description ?? "",
      stage: t?.stage || "exploring",
      announced_quarter: t?.announced_quarter ?? null,
      changelog_url: t?.changelog_url ?? null,
      state: next,
      checked_warnings: t?.checked_warnings ?? [],
    });
    setBusy(false);
    if (!result) {
      setRefused(null);
      onChanged();
    } else if (next === "approved" && result.kind !== "other") {
      // A finding to fix or a warning to tick: open the editor with the refusal in it.
      setRefused(result);
      setEditing(true);
    } else {
      setRefused(result);
    }
  };

  return (
    <li data-testid="public-row" className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="min-w-0 font-semibold break-words">{row.internal_title}</span>
        <span className="text-[13px] text-text2 capitalize">{row.horizon}</span>
        <span className="flex-1" />
        <Chip kind={state.kind} dot data-testid="public-state">
          {state.label}
        </Chip>
      </div>
      {t ? (
        <div className="mt-1.5 text-sm">
          <p className="font-medium">{t.title}</p>
          {t.description && <p className="text-text2">{t.description}</p>}
          <p className="mt-0.5 text-[13px] text-text2">
            {STAGES.find(([s]) => s === t.stage)?.[1]}
            {t.announced_quarter && ` · Announced for ${t.announced_quarter}`}
          </p>
        </div>
      ) : (
        <p className="mt-1.5 text-sm text-text2">No public text yet.</p>
      )}
      {row.left_out_reason === "no_goal" && <p className="mt-1 text-[13px] text-text2">Left out: serves no confirmed goal.</p>}
      {row.findings.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Findings">
          {row.findings.map((f) => (
            <li key={f.code}>
              <Chip kind={f.severity === "blocking" ? "crit" : "warn"} wrap>
                {findingText(f)}
              </Chip>
            </li>
          ))}
        </ul>
      )}
      {editing ? (
        <TextEditor
          doc={doc}
          version={version}
          row={row}
          initialRefusal={refused}
          onCancel={() => {
            setEditing(false);
            setRefused(null);
          }}
          onSaved={() => {
            setEditing(false);
            setRefused(null);
            onChanged();
          }}
        />
      ) : (
        <>
          {refused && (
            <div className="mt-2">
              <RefusalAlert refusal={refused} />
            </div>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              disabled={busy}
              onClick={() => {
                setRefused(null);
                setEditing(true);
              }}
            >
              Edit
            </Button>
            {row.state !== "approved" && (
              <Button disabled={busy} onClick={() => void quick("approved")}>
                Approve
              </Button>
            )}
            {row.state !== "excluded" && (
              <Button variant="ghost" disabled={busy} onClick={() => void quick("excluded")}>
                Exclude
              </Button>
            )}
          </div>
        </>
      )}
    </li>
  );
}

/** One choice of a few as a radiogroup (the review filter, the phone's pane switch). */
function Radios<V extends string>({
  label,
  items,
  value,
  onChange,
  className = "",
}: {
  label: string;
  items: { value: V; label: string; count?: number }[];
  value: V;
  onChange: (v: V) => void;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={`inline-flex max-w-full overflow-x-auto rounded-button border border-line-strong bg-surface ${className}`}>
      {items.map((it) => {
        const on = it.value === value;
        return (
          <button
            key={it.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(it.value)}
            className={`flex h-8 items-center gap-2 border-r border-line px-3 text-sm font-medium whitespace-nowrap last:border-r-0 ${
              on ? "bg-accent text-on-accent" : "text-text hover:bg-surface2"
            }`}
          >
            {it.label}
            {it.count != null && <b className={`tnum font-semibold ${on ? "text-on-accent" : "text-text2"}`}>{it.count}</b>}
          </button>
        );
      })}
    </div>
  );
}

function Summary({ data }: { data: Texts }) {
  const { no_approved_text: noText = 0, excluded = 0, no_goal: noGoal = 0 } = data.left_out as Record<string, number>;
  const left = noText + excluded + noGoal;
  return (
    <p data-testid="public-summary" className="text-sm">
      <span className="font-semibold">
        {data.shown} shown · {left} left out
      </span>
      <span className="text-text2">
        {" "}
        ({noText} without an approved text · {excluded} excluded · {noGoal} {noGoal === 1 ? "serves" : "serve"} no confirmed goal)
      </span>
    </p>
  );
}

function CheckState({ doc, data, onChecked }: { doc: string; data: Texts; onChecked: () => void }) {
  const check = data.check.check;
  const pubs = useQuery(`publications|${doc}`, () => unwrap(api.GET("/v1/documents/{doc}/publications", { params: { path: { doc } } })));
  const people = useQuery(`people|${check?.checked_by ?? "none"}`, () => peopleByIds([check?.checked_by]));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pub = (pubs.data ?? []).filter((p) => p.version_number === data.version).sort((a, b) => b.number - a.number)[0];
  const who = check ? (people.data?.get(check.checked_by)?.name ?? "a member") : "";

  const mark = async () => {
    if (!pub) return;
    setBusy(true);
    setError(null);
    try {
      await unwrap(api.POST("/v1/roadmaps/{doc}/publications/{p}/public-check", { params: { path: { doc, p: pub.number } } }));
      onChecked();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p data-testid="public-check" className="text-sm font-medium">
          {data.check.state === "none" || !check
            ? "Not checked yet"
            : data.check.state === "checked"
              ? `Checked by ${who} on ${formatDateTime(check.checked_at)}`
              : `Changed since checked (checked by ${who} on ${formatDateTime(check.checked_at)})`}
        </p>
        <span className="flex-1" />
        {pubs.data && !pub ? (
          <LinkButton href={`/documents/${doc}/publish`}>Publish this version first</LinkButton>
        ) : (
          <Button variant="solid" disabled={busy || !pub || data.not_ready.length > 0} onClick={() => void mark()}>
            Mark as checked
          </Button>
        )}
      </div>
      {data.not_ready.length > 0 && <p className="text-[13px] text-text2">Approve or exclude every item&apos;s public text first.</p>}
      {pubs.error && <ErrorNote>{pubs.error}</ErrorNote>}
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}

function Preview({ doc, version, rev }: { doc: string; version: number; rev: number }) {
  const q = useQuery(
    `public-preview|${doc}|${version}|${rev}`,
    () => unwrap<string>(api.GET("/v1/roadmaps/{doc}/versions/{n}/public-preview", { params: { path: { doc, n: version } }, parseAs: "text" })),
    { keepPrevious: true },
  );
  if (q.error) return <div className="p-4"><ErrorNote>{q.error}</ErrorNote></div>;
  if (q.data == null) return <div className="p-4"><Loading /></div>;
  return <iframe title="Public page preview" sandbox="" srcDoc={q.data} className="block h-[75vh] w-full rounded-b-panel bg-white" />;
}

/**
 * O5 §2, the Public check: every item's public text with its leak findings (left) beside
 * the exact page a link holder sees (right); on a phone one pane at a time.
 */
export function PublicCheck({ doc }: { doc: string }) {
  const { can, capsReady } = useMe();
  const allowed = capsReady && can("list_public_texts");
  const texts = useQuery(
    `public-texts|${doc}|${allowed}`,
    () => (allowed ? unwrap(api.GET("/v1/roadmaps/{doc}/public-texts", { params: { path: { doc } } })) : Promise.resolve(undefined)),
    { keepPrevious: true },
  );
  const [filter, setFilter] = useState<Filter>("all");
  const [pane, setPane] = useState<Pane>("review");
  const [rev, setRev] = useState(0);

  const changed = () => {
    void texts.reload();
    setRev((n) => n + 1);
  };

  const header = (
    <PageHeader
      title="Public version"
      suffix={texts.data ? `v${texts.data.version}` : undefined}
      back={
        <Link href={`/documents/${doc}`} className="hover:underline">
          Back to the roadmap
        </Link>
      }
    />
  );

  if (!capsReady) {
    return (
      <Page>
        {header}
        <Loading />
      </Page>
    );
  }
  if (!allowed) {
    return (
      <Page>
        {header}
        <Notice>Approvers and owners check the Public version.</Notice>
      </Page>
    );
  }
  const data = texts.data;
  if (texts.error && !data) {
    return (
      <Page>
        {header}
        <ErrorNote>{texts.error}</ErrorNote>
      </Page>
    );
  }
  if (!data) {
    return (
      <Page>
        {header}
        <Loading />
      </Page>
    );
  }

  const counts = { approve: data.rows.filter(toApprove).length, findings: data.rows.filter((r) => r.findings.length > 0).length, all: data.rows.length };
  const rows = data.rows.filter((r) => (filter === "approve" ? toApprove(r) : filter === "findings" ? r.findings.length > 0 : true));
  const removed = data.removed as Record<string, number>;

  return (
    <Page>
      {header}
      <div className="flex flex-col gap-4">
        <Summary data={data} />
        <CheckState doc={doc} data={data} onChecked={changed} />
        <Radios<Pane>
          label="Pane"
          className="min-[640px]:hidden"
          items={[
            { value: "review", label: "Review" },
            { value: "preview", label: "Preview" },
          ]}
          value={pane}
          onChange={setPane}
        />
        <div className="grid grid-cols-2 items-start gap-4 max-[1100px]:grid-cols-1">
          <div className={`flex min-w-0 flex-col gap-4 ${pane === "review" ? "" : "max-[639px]:hidden"}`}>
            <Panel
              title="Review"
              count={data.rows.length}
              tools={
                <Radios<Filter>
                  label="Filter"
                  items={[
                    { value: "approve", label: "To approve", count: counts.approve },
                    { value: "findings", label: "Findings", count: counts.findings },
                    { value: "all", label: "All", count: counts.all },
                  ]}
                  value={filter}
                  onChange={setFilter}
                />
              }
            >
              {rows.length === 0 ? (
                <p className="px-4 py-8 text-center text-[15px] text-text2">Nothing here.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {rows.map((r) => (
                    <ReviewRow key={r.item_key} doc={doc} version={data.version} row={r} onChanged={changed} />
                  ))}
                </ul>
              )}
            </Panel>
            <Panel title="What is removed" bodyClassName="px-4 py-3">
              <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                {REMOVED.map(([key, label]) => (
                  <li key={key}>
                    <b className="tnum font-semibold">{removed[key] ?? 0}</b> {label}
                  </li>
                ))}
              </ul>
            </Panel>
          </div>
          <div className={`min-w-0 xl:sticky xl:top-4 ${pane === "preview" ? "" : "max-[639px]:hidden"}`}>
            <Panel title="Public page" bodyClassName="p-0">
              <Preview doc={doc} version={data.version} rev={rev} />
            </Panel>
          </div>
        </div>
      </div>
    </Page>
  );
}
