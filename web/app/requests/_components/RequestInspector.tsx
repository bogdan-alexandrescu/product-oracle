"use client";

import { useState, type FormEvent, type ReactNode } from "react";

import { Button, Chip, Inspector, InspectorSection } from "@/components/ds";
import { ErrorNote, INPUT } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatDate } from "@/lib/format";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

import { CHANNEL_LABEL, STATE } from "./RequestList";

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
};

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
}: {
  request: Request;
  /** The queue, for Merge into. */
  requests: Request[];
  themes: Theme[];
  goalTitles: Map<string, string>;
  onChange: (request: Request) => void;
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

  return (
    <Inspector
      eyebrow="Request · selected"
      label="Request"
      testId="request-inspector"
      title={request.title}
      chips={
        <>
          <Chip kind={STATE[request.state].kind}>{STATE[request.state].label}</Chip>
          <Chip kind="line">{CHANNEL_LABEL[request.channel]}</Chip>
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
      <InspectorSection label="Decision">
        <Decision request={request} requests={requests} canDecide={approver} busy={busy} run={run} />
      </InspectorSection>
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
        <Row label="PRD">{request.document?.title ?? "None"}</Row>
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

function Decision({ request, requests, canDecide, busy, run }: { request: Request; requests: Request[]; canDecide: boolean; busy: boolean; run: Run }) {
  const [open, setOpen] = useState<Action | null>(null);
  const [note, setNote] = useState("");
  const [into, setInto] = useState("");
  const [reason, setReason] = useState<Reason>("no_goal");
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
      {request.disqualify_reason && <p>{REASON_LABEL[request.disqualify_reason]}</p>}
      {request.decision_note && <p className="whitespace-pre-wrap text-text2">{request.decision_note}</p>}
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
                  {requests
                    .filter((r) => r.id !== request.id && r.state !== "merged" && r.state !== "disqualified")
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.title}
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
                done(() =>
                  unwrap(api.POST("/v1/requests/{request_id}/disqualify", { ...path, body: { ...lock, reason, note: note.trim() || null } })),
                );
              }}
            >
              <label className={LABEL}>
                Reason
                <select className={INPUT} value={reason} onChange={(e) => setReason(e.target.value as Reason)}>
                  {(Object.keys(REASON_LABEL) as Reason[]).map((r) => (
                    <option key={r} value={r}>
                      {REASON_LABEL[r]}
                    </option>
                  ))}
                </select>
              </label>
              <label className={LABEL}>
                Note
                <textarea className={INPUT} rows={2} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
              </label>
              <Button variant="danger" type="submit" disabled={busy || (reason === "other" && !note.trim())} className="self-end">
                Disqualify request
              </Button>
            </form>
          )}
        </>
      )}
    </div>
  );
}
