"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";

import { Button, Chip, Inspector, InspectorSection } from "@/components/ds";
import { free, startPrdHref } from "@/components/RequestsBehind";
import { ErrorNote, INPUT } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatDate, formatDay } from "@/lib/format";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

import { CHANNEL_LABEL, STATE } from "./RequestList";
import { ProblemBlock } from "./Themes";
import { WhyNot } from "./WhyNot";

type Request = Schemas["RequestOut"];
type Theme = Schemas["RequestThemeOut"];
type Reason = NonNullable<Request["disqualify_reason"]>;
type Part = Schemas["AcceptSuggestionIn"]["parts"][number];

export const REASON_LABEL: Record<Reason, string> = {
  no_goal: "No goal",
  out_of_scope: "Out of scope",
  duplicate: "Duplicate",
  not_a_request: "Not a request",
  wont_do: "Won't do",
  other: "Other",
  strategy_stop: "On the stop list",
  already_exists: "Already possible",
  few_customers: "Too few would use it",
};

// The Disqualify form's order: the reasons that answer the asker, then housekeeping (H10).
const REASONS: Reason[] = ["no_goal", "out_of_scope", "strategy_stop", "already_exists", "few_customers", "wont_do", "other", "duplicate", "not_a_request"];
const HOUSEKEEPING: Reason[] = ["duplicate", "not_a_request"];
// The reasons whose basis the form asks for (H10): the record the reply cites.
const BASIS_PICKER: Partial<Record<Reason, { label: string; kind: "strategy_choice" | "feature" }>> = {
  strategy_stop: { label: "Stop choice", kind: "strategy_choice" },
  already_exists: { label: "Feature", kind: "feature" },
};

/** A decline that answers the asker: a decision is logged and replies are drafted (H10). */
const isNo = (reason: Reason, note: string) => !HOUSEKEEPING.includes(reason) && (reason !== "wont_do" || !!note.trim());

/** "Said no on Oct 3 · D-31 Say no to bulk export": a declined request in the merge picker. */
function declinedLabel(r: Request): string {
  const day = r.decided_at ? ` · Said no on ${formatDay(r.decided_at)}` : " · Said no";
  return `${r.title}${day}${r.decision_number ? ` · D-${r.decision_number} ${r.decision_title ?? ""}`.trimEnd() : ""}`;
}

type Prefill = { reason: Reason; basisId: string | null };

const LABEL = "flex flex-col gap-1 text-sm font-semibold text-text2";

/**
 * The selected request (#348): its words (the filer edits them while New), its links to
 * goals, a theme, a feature and a PRD, Oracle's suggestion to accept or decline, and the
 * decisions: Qualify (with a reason), Merge into another request, Disqualify (with a
 * reason), Reopen. Links, the suggestion's buttons and decisions are an approver's; other
 * roles, and a Merged or Disqualified request, show the links read-only. A declined
 * suggestion stays, marked with who declined it and when. A decision the state blocks is
 * disabled, with the reason. Every change hands the saved request to `onChange`. Key it by the
 * request's id so its forms start over for each request.
 */
export function RequestInspector({
  request,
  requests,
  themes,
  goalTitles,
  onChange,
  onTheme,
}: {
  request: Request;
  /** The queue, for Merge into. */
  requests: Request[];
  themes: Theme[];
  goalTitles: Map<string, string>;
  onChange: (request: Request) => void;
  /** A theme's problem confirmed, dismissed or edited from the inspector (H10). */
  onTheme?: (theme: Theme) => void;
}) {
  const { me, can } = useMe();
  // #370: links and decisions are an approver's (the decision routes' role), the suggestion's buttons its routes'.
  const approver = can("qualify_request");
  const canSuggest = can("accept_request_suggestion");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(call: () => Promise<Request>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      onChange(await call());
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  }
  const path = { params: { path: { request_id: request.id } } };
  const lock = { lock_version: request.lock_version };
  const s = request.suggestion;
  const offered = request.state === "new" && s && !s.declined_at && suggestedParts(s).length > 0;
  const declined = s?.declined_at ? s : null;
  const features = useQuery("request-features", () => unwrap(api.GET("/v1/baseline/entities", { params: { query: { type: "feature" } } })));
  const featureTitle = (id: string) => (features.data ?? []).find((f) => f.id === id)?.title;
  const canEdit = request.origin !== "interview" && !!me?.user_id && request.filed_by === me.user_id;
  // H10: Oracle's decline suggestion; Use this opens the Disqualify form prefilled.
  const decline = request.state === "new" && s && !s.declined_at ? s.decline : null;
  const [prefill, setPrefill] = useState<{ n: number; value: Prefill } | null>(null);
  const theme = request.theme ? themes.find((t) => t.id === request.theme!.id) : undefined;
  // A decline with no note or for housekeeping has no Why not panel, whatever an earlier no left.
  const showWhyNot =
    request.state === "disqualified" ? request.no_reply_reason == null && (request.replies.total > 0 || request.decision_number != null) : request.replies.total > 0;

  return (
    <Inspector
      eyebrow="Request · selected"
      label="Request"
      testId="request-inspector"
      title={request.title}
      chips={
        <>
          <Chip kind={STATE[request.state].kind}>{STATE[request.state].label}</Chip>
          {/* #549: on the dark head, the hero tone; the plain line chip's dark text vanished there. */}
          <Chip hero kind="line" data-testid="request-channel">
            {CHANNEL_LABEL[request.channel]}
          </Chip>
        </>
      }
    >
      <InspectorSection label="What it is and why">
        <Words request={request} canEdit={canEdit} busy={busy} run={run} />
      </InspectorSection>
      {offered && (
        <InspectorSection label="Oracle's suggestion">
          <div data-testid="request-suggestion" className="flex flex-col gap-2 text-[15px]">
            {s.rationale && <p>{s.rationale}</p>}
            <ul className="flex flex-col gap-1 text-sm text-text2">
              {(s.theme_title || s.theme_id) && <li>Theme: {s.theme_title ?? themes.find((t) => t.id === s.theme_id)?.title}</li>}
              {s.goal_ids.length > 0 && <li>Goals: {s.goal_ids.map((id) => goalTitles.get(id) ?? "A goal").join(", ")}</li>}
              {s.duplicate_of && <li>Same as: {requests.find((r) => r.id === s.duplicate_of)?.title ?? "another request"}</li>}
              {s.feature_id && <li data-testid="suggested-feature">Feature: {featureTitle(s.feature_id) ?? "Loading…"}</li>}
            </ul>
            {canSuggest && (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="solid"
                  disabled={busy}
                  onClick={() =>
                    run(() =>
                      unwrap(api.POST("/v1/requests/{request_id}/suggestion/accept", { ...path, body: { ...lock, parts: suggestedParts(s) } })),
                    )
                  }
                >
                  Accept suggestion
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => run(() => unwrap(api.POST("/v1/requests/{request_id}/suggestion/decline", { ...path, body: lock })))}
                >
                  Decline
                </Button>
              </div>
            )}
          </div>
        </InspectorSection>
      )}
      {decline && (
        <InspectorSection label="Oracle's suggestion">
          <div className="flex flex-col gap-2 text-[15px]">
            <p data-testid="decline-suggestion">
              Oracle suggests saying no: {REASON_LABEL[decline.reason]}
              {decline.why ? ` · ${decline.why}` : ""}
            </p>
            {approver && (
              <Button
                className="self-start"
                onClick={() => setPrefill((p) => ({ n: (p?.n ?? 0) + 1, value: { reason: decline.reason, basisId: decline.basis?.id ?? null } }))}
              >
                Use this
              </Button>
            )}
          </div>
        </InspectorSection>
      )}
      {declined && (
        <InspectorSection label="Oracle's suggestion">
          <p data-testid="request-suggestion" className="text-sm text-text2">
            Declined by {declined.declined_by_name ?? "an approver"}, {formatDate(declined.declined_at!)}
          </p>
        </InspectorSection>
      )}
      <InspectorSection label="Links">
        <Links
          request={request}
          themes={themes}
          goalTitles={goalTitles}
          features={features.data ?? []}
          // The API refuses link changes on a Merged or Disqualified request: shown read-only.
          canLink={approver && request.state !== "merged" && request.state !== "disqualified"}
          busy={busy}
          run={run}
        />
      </InspectorSection>
      {(request.intake || request.document || (free(request) && can("create_intake", true))) && (
        <InspectorSection label="PRD">
          <PrdLink request={request} canStart={free(request) && can("create_intake", true)} />
        </InspectorSection>
      )}
      {theme && (theme.problem_state !== "none" || theme.problem) && (
        <InspectorSection label={`Problem · ${theme.title}`}>
          <ProblemBlock theme={theme} canChange={can("confirm_request_theme_problem")} onChange={(t) => onTheme?.(t)} />
        </InspectorSection>
      )}
      <InspectorSection label="Decision">
        <Decision
          key={prefill?.n ?? 0}
          request={request}
          requests={requests}
          features={features.data ?? []}
          prefill={prefill?.value ?? null}
          canDecide={approver}
          busy={busy}
          run={run}
        />
      </InspectorSection>
      {showWhyNot && (
        <InspectorSection label="Why not">
          <WhyNot request={request} onRequest={onChange} />
        </InspectorSection>
      )}
      {error && (
        <div className="px-5 pb-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
    </Inspector>
  );
}

/** Oracle's suggested parts not yet accepted; the duplicate (a merge) only when nothing else is left. */
function suggestedParts(s: Schemas["Suggestion"]): Part[] {
  const parts: Part[] = [];
  if (s.theme_id || s.theme_title) parts.push("theme");
  if (s.goal_ids.length) parts.push("goals");
  if (s.feature_id) parts.push("feature");
  const left = parts.filter((p) => !s.accepted.includes(p));
  return left.length || !s.duplicate_of ? left : ["duplicate"];
}

type Run = (call: () => Promise<Request>) => Promise<boolean>;

/**
 * Where the request went (C1 lane 2): the brief it is behind and the PRD made for it, each a
 * link everyone who reads the request follows; Start a PRD on a qualified request opens New
 * PRD with it ticked under "Requests behind it".
 */
function PrdLink({ request, canStart }: { request: Request; canStart: boolean }) {
  const router = useRouter();
  const link = "font-semibold text-accent-ink underline-offset-2 hover:underline [overflow-wrap:anywhere]";
  return (
    <div className="flex flex-col gap-2 text-sm">
      {(request.intake || request.document) && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          {request.intake && (
            <Row label="Brief">
              <Link href={`/intakes/${request.intake.id}`} className={link}>
                {request.intake.title}
              </Link>
            </Row>
          )}
          {request.document && (
            <Row label="PRD">
              <Link href={`/documents/${request.document.slug}`} className={link} data-testid="request-prd-link">
                {request.document.title}
              </Link>
            </Row>
          )}
        </dl>
      )}
      {canStart && (
        <Button className="self-start" onClick={() => router.push(startPrdHref([request.id]))}>
          Start a PRD
        </Button>
      )}
    </div>
  );
}

function Words({ request, canEdit, busy, run }: { request: Request; canEdit: boolean; busy: boolean; run: Run }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(request.title);
  const [body, setBody] = useState(request.body ?? "");
  const isNew = request.state === "new";
  async function save(e: FormEvent) {
    e.preventDefault();
    const ok = await run(() =>
      unwrap(
        api.PATCH("/v1/requests/{request_id}", {
          params: { path: { request_id: request.id } },
          body: { lock_version: request.lock_version, title: title.trim(), body: body.trim() || null },
        }),
      ),
    );
    if (ok) setEditing(false);
  }
  if (editing) {
    return (
      <form className="flex flex-col gap-2" onSubmit={save}>
        <label className={LABEL}>
          Title
          <input className={INPUT} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className={LABEL}>
          What it is and why
          <textarea className={INPUT} rows={4} value={body} maxLength={4000} onChange={(e) => setBody(e.target.value)} />
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <Button variant="solid" type="submit" disabled={busy || !title.trim()}>
            Save
          </Button>
        </div>
      </form>
    );
  }
  return (
    <div className="flex flex-col gap-2 text-[15px]">
      <p className="whitespace-pre-wrap">{request.body ?? "No description"}</p>
      {request.requester_name && <p className="text-sm text-text2">From {request.requester_name}</p>}
      {canEdit && (
        <span className="flex flex-wrap items-center gap-2">
          <Button
            disabled={!isNew}
            title={isNew ? undefined : "Words change only while it is New"}
            onClick={() => {
              setTitle(request.title);
              setBody(request.body ?? "");
              setEditing(true);
            }}
          >
            Edit
          </Button>
          {!isNew && <span className="text-sm text-text2">Words change only while it is New</span>}
        </span>
      )}
    </div>
  );
}

function Links({
  request,
  themes,
  goalTitles,
  features,
  canLink,
  busy,
  run,
}: {
  request: Request;
  themes: Theme[];
  goalTitles: Map<string, string>;
  features: Schemas["EntityOut"][];
  canLink: boolean;
  busy: boolean;
  run: Run;
}) {
  const goals = useQuery("request-confirmed-goals", () =>
    unwrap(api.GET("/v1/baseline/entities", { params: { query: { type: "goal", status: "confirmed" } } })),
  );
  const prds = useQuery("request-prds", () => unwrap(api.GET("/v1/documents", { params: { query: { kind: "prd" } } })));
  const [goalIds, setGoalIds] = useState(request.goal_ids);
  const [themeId, setThemeId] = useState(request.theme?.id ?? "");
  const [featureId, setFeatureId] = useState(request.feature_id ?? "");
  const [documentId, setDocumentId] = useState(request.document?.id ?? "");
  const featureTitle = features.find((f) => f.id === request.feature_id)?.title;

  if (!canLink) {
    return (
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <Row label="Goals">{request.goal_ids.map((id) => goalTitles.get(id) ?? "A goal").join(", ") || "None"}</Row>
        <Row label="Theme">{request.theme?.title ?? "None"}</Row>
        <Row label="Feature">{featureTitle ?? (request.feature_id ? "A feature" : "None")}</Row>
      </dl>
    );
  }
  const save = (e: FormEvent) => {
    e.preventDefault();
    run(() =>
      unwrap(
        api.PATCH("/v1/requests/{request_id}", {
          params: { path: { request_id: request.id } },
          body: {
            lock_version: request.lock_version,
            goal_ids: goalIds,
            theme_id: themeId || null,
            feature_id: featureId || null,
            document_id: documentId || null,
          },
        }),
      ),
    );
  };
  const live = themes.filter((t) => !t.archived || t.id === request.theme?.id);
  return (
    <form className="flex flex-col gap-2" onSubmit={save}>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm font-semibold text-text2">Goals</legend>
        {(goals.data ?? []).length === 0 && <p className="text-sm text-text2">{goals.loading ? "Loading goals…" : "No confirmed goals yet"}</p>}
        {(goals.data ?? []).map((g) => (
          <label key={g.id} className="flex items-center gap-2 text-[15px]">
            <input
              type="checkbox"
              checked={goalIds.includes(g.id)}
              onChange={(e) => setGoalIds((ids) => (e.target.checked ? [...ids, g.id] : ids.filter((x) => x !== g.id)))}
            />
            {g.title}
          </label>
        ))}
      </fieldset>
      <label className={LABEL}>
        Theme
        <select className={INPUT} value={themeId} onChange={(e) => setThemeId(e.target.value)}>
          <option value="">None</option>
          {live.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
        </select>
      </label>
      <label className={LABEL}>
        Feature
        <select className={INPUT} value={featureId} onChange={(e) => setFeatureId(e.target.value)}>
          <option value="">None</option>
          {features.map((f) => (
            <option key={f.id} value={f.id}>
              {f.title}
            </option>
          ))}
        </select>
      </label>
      <label className={LABEL}>
        PRD
        <select className={INPUT} value={documentId} onChange={(e) => setDocumentId(e.target.value)}>
          <option value="">None</option>
          {(prds.data ?? []).map((d) => (
            <option key={d.id} value={d.id}>
              {d.title}
            </option>
          ))}
        </select>
      </label>
      <div className="flex justify-end">
        <Button variant="solid" type="submit" disabled={busy}>
          Save links
        </Button>
      </div>
    </form>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="font-semibold text-text2">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

type Action = "qualify" | "merge" | "disqualify";

function Decision({
  request,
  requests,
  features,
  prefill,
  canDecide,
  busy,
  run,
}: {
  request: Request;
  requests: Request[];
  features: Schemas["EntityOut"][];
  prefill: Prefill | null;
  canDecide: boolean;
  busy: boolean;
  run: Run;
}) {
  const [open, setOpen] = useState<Action | null>(prefill ? "disqualify" : null);
  const [note, setNote] = useState("");
  const [into, setInto] = useState("");
  const [reason, setReason] = useState<Reason>(prefill?.reason ?? "no_goal");
  // The basis picked per reason; Oracle's preselection (the request's feature, the stop choice on it) until a person picks.
  const [picked, setPicked] = useState<Partial<Record<Reason, string>>>(prefill?.basisId ? { [prefill.reason]: prefill.basisId } : {});
  const detail = useQuery(open === "disqualify" ? `request-detail:${request.id}:${request.lock_version}` : "request-detail:none", () =>
    open === "disqualify" ? unwrap(api.GET("/v1/requests/{request_id}", { params: { path: { request_id: request.id } } })) : Promise.resolve(null),
  );
  const stops = useQuery(open === "disqualify" ? "request-stop-choices" : "request-stop-choices:none", () =>
    open === "disqualify"
      ? unwrap(api.GET("/v1/baseline/entities", { params: { query: { type: "strategy_choice", status: "confirmed" } } })).then((list) =>
          list.filter((e) => (e.attrs as Record<string, unknown> | null)?.stance === "stop"),
        )
      : Promise.resolve([]),
  );
  const picker = BASIS_PICKER[reason];
  const basisId = picked[reason] ?? detail.data?.suggested_basis?.[reason]?.id ?? "";
  const options = picker?.kind === "strategy_choice" ? (stops.data ?? []) : picker ? features : [];
  const askers = request.mentions;
  const path = { params: { path: { request_id: request.id } } };
  const lock = { lock_version: request.lock_version };
  const live = request.state === "new" || request.state === "qualified";
  const blocked: Record<Action | "reopen", string | null> = {
    qualify: request.state !== "new" ? "Only a New request can be qualified" : null,
    merge: live ? null : "Only a New or Qualified request can be merged",
    disqualify: live ? null : "Only a New or Qualified request can be disqualified",
    reopen: live ? "Only a Merged or Disqualified request can be reopened" : null,
  };
  const reasonShown = blocked.qualify ?? (live ? null : blocked.merge);
  const mergedInto = request.merged_into_id ? requests.find((r) => r.id === request.merged_into_id) : undefined;
  const done = async (call: () => Promise<Request>) => {
    if (await run(call)) {
      setOpen(null);
      setNote("");
    }
  };
  const toggle = (a: Action) => {
    setOpen((o) => (o === a ? null : a));
    setNote("");
  };

  return (
    <div className="flex flex-col gap-2 text-[15px]">
      {request.state === "merged" && <p>Merged into {mergedInto?.title ?? "another request"}</p>}
      {request.decision_number != null && (
        <Link
          href={`/company/decisions?d=${request.decision_number}`}
          data-testid="decision-chip"
          title={request.decision_status === "reversed" ? "Reversed on Reopen" : undefined}
          className="self-start rounded-full bg-accent-soft px-2.5 py-0.5 text-sm font-semibold text-accent-ink hover:underline"
        >
          D-{request.decision_number} {request.decision_title}
        </Link>
      )}
      {request.disqualify_reason && <p>{REASON_LABEL[request.disqualify_reason]}</p>}
      {request.basis?.title && <p className="text-sm text-text2">Basis: {request.basis.title}</p>}
      {request.decision_note && <p className="whitespace-pre-wrap text-text2">{request.decision_note}</p>}
      {request.no_reply_reason === "no_note" && (
        <p data-testid="no-reply-reason" className="text-sm text-text2">
          No note: no decision was logged and no replies were drafted
        </p>
      )}
      {request.asked_again > 0 && (
        <span className="self-start">
          <Chip kind="warn" data-testid="asked-again">
            Asked again {request.asked_again}
          </Chip>
        </span>
      )}
      {!canDecide && request.state === "new" && <p className="text-sm text-text2">Waiting for an approver</p>}
      {canDecide && (
        <>
          <div className="flex flex-wrap gap-2">
            {(["qualify", "merge", "disqualify"] as const).map((a) => (
              <Button
                key={a}
                variant={a === "disqualify" ? "danger" : "secondary"}
                aria-expanded={open === a}
                disabled={busy || !!blocked[a]}
                title={blocked[a] ?? undefined}
                onClick={() => toggle(a)}
              >
                {a === "qualify" ? "Qualify" : a === "merge" ? "Merge" : "Disqualify"}
              </Button>
            ))}
            <Button
              disabled={busy || !!blocked.reopen}
              title={blocked.reopen ?? undefined}
              onClick={() => done(() => unwrap(api.POST("/v1/requests/{request_id}/reopen", { ...path, body: lock })))}
            >
              Reopen
            </Button>
          </div>
          {reasonShown && (
            <p data-testid="decide-reason" className="text-sm text-text2">
              {reasonShown}
            </p>
          )}
          {open === "qualify" && (
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                done(() => unwrap(api.POST("/v1/requests/{request_id}/qualify", { ...path, body: { ...lock, note: note.trim() } })));
              }}
            >
              <label className={LABEL}>
                Reason
                <textarea className={INPUT} rows={2} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
              </label>
              <Button variant="solid" type="submit" disabled={busy || !note.trim()} className="self-end">
                Qualify request
              </Button>
            </form>
          )}
          {open === "merge" && (
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                done(() => unwrap(api.POST("/v1/requests/{request_id}/merge", { ...path, body: { ...lock, into_id: into } })));
              }}
            >
              <label className={LABEL}>
                Merge into
                <select className={INPUT} value={into} onChange={(e) => setInto(e.target.value)}>
                  <option value="">Pick a request</option>
                  {/* H10: a request said no to is listed too; joining it gives the asker the same reply. */}
                  {requests
                    .filter((r) => r.id !== request.id && r.state !== "merged")
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.state === "disqualified" ? declinedLabel(r) : r.title}
                      </option>
                    ))}
                </select>
              </label>
              <Button variant="solid" type="submit" disabled={busy || !into} className="self-end">
                Merge request
              </Button>
            </form>
          )}
          {open === "disqualify" && (
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const basis = picker && basisId ? { kind: picker.kind, id: basisId } : null;
                done(() =>
                  unwrap(api.POST("/v1/requests/{request_id}/disqualify", { ...path, body: { ...lock, reason, note: note.trim() || null, basis } })),
                );
              }}
            >
              <label className={LABEL}>
                Reason
                <select className={INPUT} value={reason} onChange={(e) => setReason(e.target.value as Reason)}>
                  {REASONS.map((r) => (
                    <option key={r} value={r}>
                      {REASON_LABEL[r]}
                    </option>
                  ))}
                </select>
              </label>
              {picker && (
                <label className={LABEL}>
                  {picker.label}
                  <select className={INPUT} value={basisId} onChange={(e) => setPicked((p) => ({ ...p, [reason]: e.target.value }))}>
                    <option value="">{picker.kind === "feature" ? "Pick the feature" : "Pick the stop choice"}</option>
                    {options.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.title}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className={LABEL}>
                Note
                <textarea className={INPUT} rows={2} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
              </label>
              {!HOUSEKEEPING.includes(reason) && (
                <p data-testid="disqualify-line" className="text-sm text-text2">
                  {isNo(reason, note)
                    ? `A decision is logged and Oracle will draft a reply to the ${askers} ${askers === 1 ? "person" : "people"} who asked`
                    : "No note: no decision is logged and no replies are drafted"}
                </p>
              )}
              <Button variant="danger" type="submit" disabled={busy || (reason === "other" && !note.trim()) || (!!picker && !basisId)} className="self-end">
                Disqualify request
              </Button>
            </form>
          )}
        </>
      )}
    </div>
  );
}
