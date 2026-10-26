"use client";

import Link from "next/link";
import { useId, useState, type ReactNode } from "react";

import { usePolling } from "@/components/JobsPanel";
import { peopleByIds } from "@/components/PersonPicker";
import { Button, Chip, LinkButton, Notice, Page, PageHeader, Panel, type ChipKind } from "@/components/ds";
import { findingSentence, findingText, WarningTicks, type Places } from "@/components/share/PublicWarnings";
import { ErrorNote, INPUT, Loading } from "@/components/ui";
import { api, unwrap, type LlmJob, type Schemas } from "@/lib/api/client";
import { formatDateTime, NO_ACCOUNT_REASON } from "@/lib/format";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

type Texts = Schemas["PublicTextsOut"];
type Row = Schemas["PublicRowOut"];
type Finding = Schemas["LeakFindingOut"];
type Stage = Schemas["PublicTextIn"]["stage"];
type TextIn = Schemas["PublicTextIn"];
type PageIn = Schemas["PublicPageIn"];

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
  | { kind: "blocking"; message: string; findings: Finding[] }
  | { kind: "warnings"; message: string; warnings: string[] }
  | { kind: "other"; message: string };

const toApprove = (r: Row) => (r.state === "draft" || r.state === "missing" || r.state === "changed") && r.left_out_reason !== "no_goal";

/** The 422 detail of PUT public-texts as a Refusal. */
function refusal(error: unknown, status: number): Refusal {
  const detail = error && typeof error === "object" && "detail" in error ? (error as { detail: unknown }).detail : null;
  if (detail && typeof detail === "object") {
    const d = detail as { code?: string; message?: string; findings?: Finding[]; warnings?: string[] };
    if (d.code === "leak_blocking") return { kind: "blocking", message: d.message ?? "", findings: d.findings ?? [] };
    if (d.code === "warnings_unchecked") return { kind: "warnings", message: d.message ?? 'Tick "I checked this" for each warning first', warnings: d.warnings ?? [] };
    if (d.message) return { kind: "other", message: d.message };
  }
  if (typeof detail === "string") return { kind: "other", message: detail };
  return { kind: "other", message: `Request failed (${status}).` };
}

/** Why Approve waits, beside the button. */
const UNTICKED = 'Tick "I checked this" for each warning to approve this text.';

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

async function putPage(doc: string, body: PageIn): Promise<Refusal | null> {
  try {
    const { error, response } = await api.PUT("/v1/roadmaps/{doc}/public-page", { params: { path: { doc } }, body });
    return response.ok ? null : refusal(error, response.status);
  } catch (e) {
    return { kind: "other", message: errorMessage(e) };
  }
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
  const approveWhyId = useId();

  // A tick is for the text it was given on: any change to the text clears every tick.
  const edit = (set: (v: string) => void) => (v: string) => {
    set(v);
    setTicked([]);
  };
  const changed =
    title !== (t?.title ?? "") || description !== (t?.description ?? "") || quarter !== (t?.announced_quarter ?? "") || url !== (t?.changelog_url ?? "");
  const warnings = row.findings.filter((f) => f.severity === "warning");
  const warningCodes = [...new Set([...warnings.map((f) => f.code), ...(refused?.kind === "warnings" ? refused.warnings : [])])];
  // The saved text's warnings are known; a changed text is checked again when it is saved.
  const unticked = !changed && warningCodes.some((c) => !ticked.includes(c));
  const places: Places = [
    ["the public title", t?.title],
    ["the public description", t?.description],
    ["the changelog link", t?.changelog_url],
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
        {(id) => <input id={id} className={INPUT} maxLength={80} required value={title} onChange={(e) => edit(setTitle)(e.target.value)} />}
      </Field>
      <Field label="Public description">
        {(id) => <textarea id={id} className={INPUT} rows={3} maxLength={280} value={description} onChange={(e) => edit(setDescription)(e.target.value)} />}
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
              onChange={(e) => edit(setQuarter)(e.target.value)}
            />
          )}
        </Field>
      </div>
      <Field label="Changelog link">
        {(id) => <input id={id} type="url" className={INPUT} placeholder="https://" value={url} onChange={(e) => edit(setUrl)(e.target.value)} />}
      </Field>
      {refused && <RefusalAlert refusal={refused} />}
      <WarningTicks
        codes={warningCodes}
        findings={warnings}
        places={places}
        ticked={ticked}
        onTick={(code, on) => setTicked((prev) => (on ? [...prev, code] : prev.filter((c) => c !== code)))}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || !title.trim()}>
          Save draft
        </Button>
        <Button
          variant="solid"
          disabled={busy || !title.trim() || unticked}
          aria-describedby={unticked ? approveWhyId : undefined}
          onClick={() => void save("approved")}
        >
          Approve
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {unticked && (
        <p id={approveWhyId} data-testid="public-approve-why" className="text-[13px] text-text2">
          {UNTICKED}
        </p>
      )}
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

/** What a public_text job came to, as the approver reads it. */
function draftOutcome(job: LlmJob): string {
  if (job.status === "queued" || job.status === "running") return "Oracle is drafting public texts…";
  if (job.status === "cancelled") return "The draft was cancelled.";
  if (job.status === "failed") {
    const why = (job.error_reason && NO_ACCOUNT_REASON[job.error_reason]) || job.error || "Oracle could not draft the public texts.";
    return `${why} Write the public texts yourself, or try again.`;
  }
  const n = Number((job.output as { drafted?: number } | null)?.drafted ?? 0);
  if (n === 0) return "Every item that serves a goal already has a public text.";
  return `Oracle drafted ${n} public ${n === 1 ? "text" : "texts"}. Check each one before you approve it.`;
}

/**
 * Draft public texts (O5-Q7): one public_text job writes a draft for each goal-serving item
 * with none; a person still edits and approves each text.
 */
function DraftTexts({ doc, version, onDrafted }: { doc: string; version: number; onDrafted: () => void }) {
  const [job, setJob] = useState<LlmJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const running = job?.status === "queued" || job?.status === "running";
  usePolling(running, async () => {
    if (!job) return;
    const next = await unwrap(api.GET("/v1/llm-jobs/{job_id}", { params: { path: { job_id: job.id } } }));
    setJob(next);
    if (next.status === "succeeded") onDrafted();
  });

  const draft = async () => {
    setBusy(true);
    setError(null);
    setJob(null);
    try {
      setJob(await unwrap(api.POST("/v1/roadmaps/{doc}/public-texts/draft", { params: { path: { doc }, query: { version } } })));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button disabled={busy || running} onClick={() => void draft()}>
          Draft public texts
        </Button>
        {job && (
          <p data-testid="public-draft" role="status" className="text-sm text-text2">
            {draftOutcome(job)}
          </p>
        )}
      </div>
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
  // Changelog links (target=_blank) open in a new tab outside the sandbox; nothing else runs.
  return <iframe title="Public page preview" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={q.data} className="block h-[75vh] w-full rounded-b-panel bg-white" />;
}

/**
 * The Public page's own title and intro. Nobody ticks them: the kinds an item text's
 * approver ticks block here, so each finding shows in words with no tick, and a save the
 * API refuses (422 leak_blocking) shows why in place.
 */
function PageText({ doc, data, onSaved }: { doc: string; data: Texts; onSaved: () => void }) {
  const { can } = useMe();
  const [title, setTitle] = useState(data.public_title ?? "");
  const [intro, setIntro] = useState(data.public_intro ?? "");
  const [refused, setRefused] = useState<{ refusal: Refusal; places: Places } | null>(null);
  const [busy, setBusy] = useState(false);
  const editable = can("put_public_page");
  const saved: Places = [
    ["the page title", data.public_title],
    ["the intro", data.public_intro],
  ];

  const save = async () => {
    setBusy(true);
    const places: Places = [
      ["the page title", title.trim()],
      ["the intro", intro.trim()],
    ];
    const result = await putPage(doc, { public_title: title.trim() || null, public_intro: intro.trim() || null });
    setBusy(false);
    setRefused(result && { refusal: result, places });
    if (!result) onSaved();
  };

  return (
    <Panel title="Page title and intro" bodyClassName="px-4 py-3">
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Page title" hint="Left empty, the page is titled with the company's name.">
          {(id, hintId) => (
            <input id={id} aria-describedby={hintId} className={INPUT} maxLength={120} disabled={!editable} value={title} onChange={(e) => setTitle(e.target.value)} />
          )}
        </Field>
        <Field label="Intro">
          {(id) => <textarea id={id} className={INPUT} rows={2} maxLength={600} disabled={!editable} value={intro} onChange={(e) => setIntro(e.target.value)} />}
        </Field>
        {data.page_findings.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label="Page findings">
            {data.page_findings.map((f) => (
              <li key={`${f.code}|${f.words.join()}`}>
                <Chip kind={f.severity === "blocking" ? "crit" : "warn"} wrap>
                  {findingSentence(f, saved)}
                </Chip>
              </li>
            ))}
          </ul>
        )}
        {data.page_findings.some((f) => f.severity === "blocking") && (
          <p className="text-[13px] text-text2">The page leaves its title or intro out until this is fixed.</p>
        )}
        {refused && (
          <div role="alert" className="rounded-button bg-crit-bg px-3 py-2 text-sm font-medium text-crit">
            {refused.refusal.kind === "blocking" ? (
              <>
                <p>{refused.refusal.message || "The public title or intro names something a public reader may not see"}</p>
                <ul className="mt-1 list-disc pl-5">
                  {refused.refusal.findings.map((f) => (
                    <li key={`${f.code}|${f.words.join()}`}>{findingSentence(f, refused.places)}</li>
                  ))}
                </ul>
              </>
            ) : (
              <p>{refused.refusal.message}</p>
            )}
          </div>
        )}
        {editable && (
          <div>
            <Button type="submit" disabled={busy}>
              Save
            </Button>
          </div>
        )}
      </form>
    </Panel>
  );
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
        <DraftTexts doc={doc} version={data.version} onDrafted={changed} />
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
            <PageText doc={doc} data={data} onSaved={changed} />
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
