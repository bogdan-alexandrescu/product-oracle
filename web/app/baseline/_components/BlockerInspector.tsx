"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";

import { Button, Chip, InfoTip, Inspector, InspectorSection, Notice, ViewOnly, type ChipKind } from "@/components/ds";
import { findPeople, type Person } from "@/components/PersonPicker";
import { INPUT, Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { addDays, todayIn, useCompanyZone, zoneDateTime, zoneDay, zoneInstant } from "@/lib/dates";
import { useMe } from "@/lib/me";
import { useRiskPolicy } from "@/lib/risk-policy";
import { errorMessage, useAuthRedirect, useQuery } from "@/lib/use-query";

type Strategy = Schemas["BlockerStrategy"];
type Blocker = Strategy["blocker"];
type Option = Schemas["BlockerOptionView"];
type Experiment = Schemas["FeasibilityExperimentOut"];
type Status = Blocker["status"];
type Plain = Schemas["BlockerStatusIn"]["status"];

export const BLOCKER_STATUS: Record<Status, string> = {
  open: "Open",
  mitigating: "Mitigating",
  resolved: "Resolved",
  accepted_risk: "Accepted risk",
  feasibility_only: "Feasibility only",
};
export const BLOCKER_STATUS_KIND: Record<Status, ChipKind> = {
  open: "crit",
  mitigating: "warn",
  resolved: "pass",
  accepted_risk: "na",
  feasibility_only: "acc",
};
export const GATE_KIND: Record<Blocker["gate"]["status"], ChipKind> = { critical: "crit", warning: "warn", pass: "pass", not_applicable: "na" };
export const GATE_LABEL: Record<Blocker["gate"]["status"], string> = {
  critical: "Gates publishing",
  warning: "Warning",
  pass: "Does not gate",
  not_applicable: "Not linked",
};
const TYPES: [Blocker["type"], string][] = [
  ["hard", "Hard"],
  ["soft", "Soft"],
  ["temporary", "Temporary"],
  ["unknown", "Unknown"],
];
const SEVERITIES: [Blocker["severity"], string][] = [
  ["critical", "Critical"],
  ["high", "High"],
  ["medium", "Medium"],
  ["low", "Low"],
];
const PLAIN: [Plain, string][] = [
  ["open", "Open"],
  ["mitigating", "Mitigating"],
  ["resolved", "Resolved"],
];
const APPROACHES: [Option["approach"], string][] = [
  ["direct_remedy", "Direct remedy"],
  ["alternative_workflow", "Alternative workflow"],
  ["architecture", "Architecture"],
  ["partnership", "Partnership"],
  ["operations", "Operations"],
  ["distribution", "Distribution"],
];
const FEASIBILITY: [Option["technical_feasibility"], string][] = [
  ["high", "High"],
  ["medium", "Medium"],
  ["low", "Low"],
  ["unknown", "Unknown"],
];
const COMPLIANCE: [Option["compliance"], string][] = [
  ["needs_review", "Needs review"],
  ["compliant", "Compliant"],
  ["non_compliant", "Non-compliant"],
];
const OPTION_STATUS: Record<Option["status"], [string, ChipKind]> = {
  proposed: ["Proposed", "na"],
  evaluating: ["Evaluating", "warn"],
  selected: ["Selected", "pass"],
  fallback: ["Fallback", "acc"],
  rejected: ["Rejected", "crit"],
};
const EXPERIMENT_STATUS: Record<Experiment["status"], [string, ChipKind]> = {
  planned: ["Planned", "na"],
  running: ["Running", "now"],
  succeeded: ["Succeeded", "pass"],
  failed: ["Failed", "crit"],
  inconclusive: ["Inconclusive", "warn"],
  cancelled: ["Cancelled", "na"],
};
const OUTCOMES: [Experiment["status"], string][] = [
  ["succeeded", "Succeeded"],
  ["failed", "Failed"],
  ["inconclusive", "Inconclusive"],
  ["cancelled", "Cancelled"],
];
const label = (options: [string, string][], v: string) => options.find(([k]) => k === v)?.[1] ?? v;
const gating = (b: Pick<Blocker, "type" | "severity">) => b.type === "hard" && b.severity === "critical";
const live = (x: Experiment) => x.status === "planned" || x.status === "running";

/** Runs a write, then reloads; resolves to the error to show (null when it worked). */
type Act = (run: () => Promise<unknown>, message: string) => Promise<string | null>;
/** Why the item's state blocks a control the role could use, or null when it does not. */
type Denied = string | null;
/** #370: what the signed-in role may ever do in the inspector; a control it may not is hidden. */
type May = Record<"status" | "edit" | "propose" | "editOption" | "select" | "fallback" | "reject" | "plan" | "run" | "scope", boolean>;

/**
 * The blocker inspector (#340): status, owner and description; the solution options
 * (propose, review, select, fallback, reject); the feasibility scope; the experiments and
 * their results; and the blocker's history. Every write is the blocker route's own, so
 * its roles and checks apply. A control the role can never use is hidden (#370); one the
 * item's state blocks is disabled, with the reason; a role that can do nothing sees View only.
 */
export function BlockerInspector({
  blockerId,
  onClose,
  onChanged,
}: {
  blockerId: string;
  onClose: () => void;
  /** Called after a write, so the lists behind the inspector refresh. */
  onChanged: () => void;
}) {
  const { me, can, capsReady } = useMe();
  const zone = useCompanyZone();
  const policy = useRiskPolicy();
  const onAuth = useAuthRedirect();
  const q = useQuery(`blocker:${blockerId}`, () =>
    unwrap(api.GET("/v1/blockers/{blocker_id}", { params: { path: { blocker_id: blockerId } } })),
  );
  const people = useQuery("blocker-people", () => findPeople("")).data;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (window.matchMedia("(max-width: 1100px)").matches) root.current?.scrollIntoView({ block: "start" });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const act: Act = async (run, message) => {
    setBusy(true);
    setNotice(null);
    try {
      await run();
      setNotice(message);
      await q.reload();
      onChanged();
      return null;
    } catch (e) {
      return onAuth(e) ? null : errorMessage(e);
    } finally {
      setBusy(false);
    }
  };

  const s = q.data;
  const b = s?.blocker;
  // #370: what the role may do comes from can(); lowering a gating blocker takes an owner, the API says so.
  // Set status asks the blocker too: reopening one resolved while it gated, lowered or narrowed since, takes an owner (B4).
  const may: May = {
    status: can("set_blocker_status", true),
    edit: can("update_blocker", true),
    propose: can("create_blocker_option"),
    editOption: can("update_blocker_option"),
    select: can("select_blocker_option"),
    fallback: can("mark_blocker_option_fallback"),
    reject: can("reject_blocker_option"),
    plan: can("create_feasibility_experiment"),
    run: can("update_feasibility_experiment"),
    scope: can("approve_feasibility_scope", true),
  };
  const viewOnly = capsReady && !Object.values(may).some(Boolean);
  const name = (id: string | null | undefined) =>
    !id ? "No owner" : id === me?.user_id ? "You" : (people?.find((p) => p.user_id === id)?.name ?? `Member ${id.slice(0, 8)}`);

  return (
    <div role="dialog" aria-label={b?.statement ?? "Blocker"} aria-modal="false" ref={root} className="scroll-mt-4">
      <Inspector
        testId="blocker-inspector"
        label={b?.statement ?? "Blocker"}
        eyebrow={
          <>
            Blocker{b && <> · <span className="font-mono">{b.key}</span></>}
          </>
        }
        title={b?.statement}
        chips={
          b && (
            <>
              <Chip kind={BLOCKER_STATUS_KIND[b.status]} hero>
                {BLOCKER_STATUS[b.status]}
              </Chip>
              <Chip hero>
                {label(SEVERITIES, b.severity)} · {label(TYPES, b.type)}
              </Chip>
              <Chip kind={GATE_KIND[b.gate.status]} hero>
                {GATE_LABEL[b.gate.status]}
              </Chip>
              {b.locked && (
                <Chip hero data-testid="blocker-locked">
                  Locked
                </Chip>
              )}
              {viewOnly && <ViewOnly hero />}
            </>
          )
        }
        action={
          <Button variant="hero" icon="x" onClick={onClose} aria-label="Close">
            Close
          </Button>
        }
        stats={
          s && [
            { label: "Options", value: s.options.filter((o) => o.status !== "rejected").length },
            { label: "Experiments", value: s.experiments.length },
            { label: "Documents", value: s.documents.length },
          ]
        }
      >
        {(q.error || notice || (q.loading && !s)) && (
          <InspectorSection>
            <div className="flex flex-col gap-2">
              {q.error && <Notice tone="error">{q.error}</Notice>}
              {q.loading && !s && <Loading />}
              {notice && <Notice>{notice}</Notice>}
            </div>
          </InspectorSection>
        )}
        {s && b && (
          <>
            <StatusSection
              blocker={b}
              busy={busy}
              may={may.status}
              denied={can("set_blocker_status", s.can_set_status) ? null : (s.set_status_why_not ?? null)}
              act={act}
            />
            <Details blocker={b} people={people} name={name} busy={busy} may={may.edit} act={act} />
            <Options strategy={s} busy={busy} may={may} act={act} />
            <Scope
              strategy={s}
              busy={busy}
              may={may.scope}
              denied={gating(b) && !can("approve_feasibility_scope", policy.role !== "owner") ? `${policy.role === "owner" ? "Only an owner" : "Only approvers and owners"} can approve this feasibility scope` : null}
              act={act}
            />
            <Experiments strategy={s} people={people} meId={me?.user_id} name={name} busy={busy} may={may} act={act} />
            <InspectorSection label="History">
              {s.events.length === 0 ? (
                <p className="text-text2">No changes recorded</p>
              ) : (
                <ul className="flex flex-col gap-1.5" aria-label="History">
                  {[...s.events].reverse().map((e) => (
                    <li key={e.id} className="text-sm">
                      <span className="tnum text-text2">{zoneDateTime(e.created_at, zone)}</span> {e.summary}
                      {e.reason && <span className="text-text2"> · {e.reason}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </InspectorSection>
          </>
        )}
      </Inspector>
    </div>
  );
}

// --- form parts -----------------------------------------------------------------------------

const FIELD = "flex min-w-0 flex-col gap-1 text-[13px] font-semibold tracking-[0.02em] text-text2";

/** A labelled input, textarea or select; the label sits beside a select so its options are not part of its name. */
function Field({ name, children }: { name: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className={FIELD}>
      <label htmlFor={id}>{name}</label>
      {children(id)}
    </div>
  );
}

function Select<T extends string>({ name, value, options, onChange }: { name: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <Field name={name}>
      {(id) => (
        <select id={id} className={INPUT} value={value} onChange={(e) => onChange(e.target.value as T)}>
          {options.map(([v, text]) => (
            <option key={v} value={v}>
              {text}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

function Text({ name, value, onChange, rows, type }: { name: string; value: string; onChange: (v: string) => void; rows?: number; type?: string }) {
  return (
    <Field name={name}>
      {(id) =>
        rows ? (
          <textarea id={id} className={INPUT} rows={rows} value={value} onChange={(e) => onChange(e.target.value)} />
        ) : (
          <input id={id} className={INPUT} type={type} value={value} onChange={(e) => onChange(e.target.value)} />
        )
      }
    </Field>
  );
}

/** People to own a blocker or an experiment: "No owner", the company's members, and the current owner. */
function ownerOptions(people: Person[] | undefined, current: string | null | undefined, name: (id: string) => string): [string, string][] {
  const ids = [...new Set([...(current ? [current] : []), ...(people ?? []).map((p) => p.user_id)])];
  return [["", "No owner"], ...ids.map((id): [string, string] => [id, name(id)])];
}

/** A form's own error and submit: closes it (done) when the write worked. */
function useSubmit(act: Act) {
  const [error, setError] = useState<string | null>(null);
  const submit = async (run: () => Promise<unknown>, message: string, done?: () => void) => {
    const err = await act(run, message);
    setError(err);
    if (!err) done?.();
  };
  return { error, setError, submit };
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

// --- sections -------------------------------------------------------------------------------

function StatusSection({ blocker: b, busy, may, denied, act }: { blocker: Blocker; busy: boolean; may: boolean; denied: Denied; act: Act }) {
  const [status, setStatus] = useState<Plain>(PLAIN.find(([v]) => v === b.status)?.[0] ?? "open");
  const [reason, setReason] = useState("");
  const { error, submit } = useSubmit(act);
  const save = (e: FormEvent) => {
    e.preventDefault();
    void submit(
      () =>
        unwrap(
          api.POST("/v1/blockers/{blocker_id}/status", {
            params: { path: { blocker_id: b.id } },
            body: { status, reason: reason.trim() || null },
          }),
        ),
      `Status set to ${label(PLAIN, status).toLowerCase()}.`,
      () => setReason(""),
    );
  };
  return (
    <InspectorSection
      label="Status"
      tools={
        <Chip kind={BLOCKER_STATUS_KIND[b.status]} data-testid="blocker-status">
          {BLOCKER_STATUS[b.status]}
        </Chip>
      }
    >
      <p className={may ? "mb-3 text-sm text-text2" : "text-sm text-text2"}>{b.gate.rationale}</p>
      {may && (
        <form onSubmit={save} aria-label="Change status" className="flex flex-col gap-3">
          <fieldset disabled={!!denied} className="m-0 grid min-w-0 grid-cols-2 gap-3 border-0 p-0 max-[600px]:grid-cols-1">
            <Select name="Status" value={status} options={PLAIN} onChange={setStatus} />
            <Text name="Reason" value={reason} onChange={setReason} />
          </fieldset>
          {denied && <p className="text-sm font-medium">{denied}</p>}
          {error && <Notice tone="error">{error}</Notice>}
          <Actions>
            <Button type="submit" variant="solid" disabled={busy || !!denied} title={denied ?? undefined}>
              Set status
            </Button>
            <InfoTip label="status" align="start">
              Resolving needs a reason. Accepted risk and feasibility only are set by accepting the risk or approving a
              feasibility scope.
            </InfoTip>
          </Actions>
        </form>
      )}
    </InspectorSection>
  );
}

function Details({
  blocker: b,
  people,
  name,
  busy,
  may,
  act,
}: {
  blocker: Blocker;
  people: Person[] | undefined;
  name: (id: string | null | undefined) => string;
  busy: boolean;
  may: boolean;
  act: Act;
}) {
  const [editing, setEditing] = useState(false);
  const rows: [string, ReactNode, string?][] = [
    ["Owner", name(b.owner_id), "blocker-owner"],
    ["Severity", label(SEVERITIES, b.severity), "blocker-severity"],
    ["Type", label(TYPES, b.type)],
    ["Kind", b.limit_kind_label],
    ...(b.third_party ? [["Third party", b.third_party] as [string, ReactNode]] : []),
    ...(b.threshold ? [["Threshold", b.threshold] as [string, ReactNode]] : []),
  ];
  return (
    <InspectorSection
      label="Details"
      tools={
        may &&
        !editing && (
          <Button onClick={() => setEditing(true)} disabled={busy}>
            Edit blocker
          </Button>
        )
      }
    >
      {editing ? (
        <EditBlocker blocker={b} people={people} name={name} busy={busy} act={act} onDone={() => setEditing(false)} />
      ) : (
        <>
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5">
            {rows.map(([k, v, testId]) => (
              <div key={k} className="contents">
                <dt className="text-text2">{k}</dt>
                <dd className="min-w-0 font-semibold break-words" data-testid={testId}>
                  {v}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 whitespace-pre-line text-text2" data-testid="blocker-detail">
            {b.detail || "No description"}
          </p>
        </>
      )}
    </InspectorSection>
  );
}

function EditBlocker({
  blocker: b,
  people,
  name,
  busy,
  act,
  onDone,
}: {
  blocker: Blocker;
  people: Person[] | undefined;
  name: (id: string | null | undefined) => string;
  busy: boolean;
  act: Act;
  onDone: () => void;
}) {
  const [statement, setStatement] = useState(b.statement);
  const [detail, setDetail] = useState(b.detail ?? "");
  const [type, setType] = useState(b.type);
  const [severity, setSeverity] = useState(b.severity);
  const [owner, setOwner] = useState(b.owner_id ?? "");
  const [reason, setReason] = useState("");
  const { error, setError, submit } = useSubmit(act);
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!statement.trim()) return setError("The statement cannot be empty.");
    // Only what changed: an untouched field is not rewritten.
    const body: Schemas["BlockerPatch"] = { revision: b.revision, confirm_decision: false };
    if (statement.trim() !== b.statement) body.statement = statement.trim();
    if ((detail.trim() || null) !== (b.detail ?? null)) body.detail = detail.trim() ? detail : null;
    if (type !== b.type) body.type = type;
    if (severity !== b.severity) body.severity = severity;
    if ((owner || null) !== (b.owner_id ?? null)) body.owner_id = owner || null;
    if (reason.trim()) body.reason = reason.trim();
    void submit(
      async () => {
        const res = await api.PATCH("/v1/blockers/{blocker_id}", { params: { path: { blocker_id: b.id } }, body });
        await unwrap(Promise.resolve(res));
      },
      "Blocker saved.",
      onDone,
    );
  };
  return (
    <form onSubmit={save} aria-label="Edit blocker" className="flex flex-col gap-3">
      <Text name="Statement" value={statement} onChange={setStatement} />
      <Text name="Description" value={detail} onChange={setDetail} rows={4} />
      <div className="grid grid-cols-2 gap-3 max-[600px]:grid-cols-1">
        <Select name="Type" value={type} options={TYPES} onChange={setType} />
        <Select name="Severity" value={severity} options={SEVERITIES} onChange={setSeverity} />
        <Select name="Owner" value={owner} options={ownerOptions(people, b.owner_id, name)} onChange={setOwner} />
        <Text name="Reason (optional)" value={reason} onChange={setReason} />
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <Actions>
        <Button type="submit" variant="solid" disabled={busy}>
          Save
        </Button>
        <Button onClick={onDone} disabled={busy}>
          Cancel
        </Button>
        <InfoTip label="saving" align="start">
          A person&apos;s edit locks the blocker: agents can only propose changes to it. Lowering a blocker that gates
          publishing takes an owner.
        </InfoTip>
      </Actions>
    </form>
  );
}

function Options({ strategy: s, busy, may, act }: { strategy: Strategy; busy: boolean; may: May; act: Act }) {
  const [adding, setAdding] = useState(false);
  return (
    <InspectorSection
      label="Options"
      tools={
        may.propose &&
        !adding && (
          <Button onClick={() => setAdding(true)} disabled={busy}>
            Propose option
          </Button>
        )
      }
    >
      {adding && <ProposeOption strategy={s} busy={busy} act={act} onDone={() => setAdding(false)} />}
      {s.options.length === 0 ? (
        !adding && <p className="text-text2">No options yet</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line" aria-label="Options">
          {s.options.map((o) => (
            <OptionRow key={o.id} option={o} busy={busy} may={may} act={act} />
          ))}
        </ul>
      )}
    </InspectorSection>
  );
}

function ProposeOption({ strategy: s, busy, act, onDone }: { strategy: Strategy; busy: boolean; act: Act; onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [approach, setApproach] = useState<Option["approach"]>(APPROACHES.find(([v]) => v === s.compliant_paths[0]?.approach)?.[0] ?? "direct_remedy");
  const [description, setDescription] = useState("");
  const { error, setError, submit } = useSubmit(act);
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return setError("Give the option a title.");
    void submit(
      () =>
        unwrap(
          api.POST("/v1/blockers/{blocker_id}/options", {
            params: { path: { blocker_id: s.blocker.id } },
            body: {
              title: title.trim(),
              approach,
              description: description.trim() || null,
              technical_feasibility: "unknown",
              policy_feasibility: "unknown",
              details: {},
              evidence_ids: [],
            },
          }),
        ),
      "Option proposed. An approver reviews its compliance before it can be selected.",
      onDone,
    );
  };
  return (
    <form onSubmit={save} aria-label="Propose option" className="mb-3 flex flex-col gap-3">
      <Text name="Title" value={title} onChange={setTitle} />
      <Select name="Approach" value={approach} options={APPROACHES} onChange={setApproach} />
      <Text name="Description" value={description} onChange={setDescription} rows={3} />
      <p className="text-[13px] text-text2">{s.prohibited}</p>
      {error && <Notice tone="error">{error}</Notice>}
      <Actions>
        <Button type="submit" variant="solid" disabled={busy}>
          Propose
        </Button>
        <Button onClick={onDone} disabled={busy}>
          Cancel
        </Button>
      </Actions>
    </form>
  );
}

function OptionRow({ option: o, busy, may, act }: { option: Option; busy: boolean; may: May; act: Act }) {
  const [mode, setMode] = useState<null | "select" | "reject" | "edit">(null);
  const [reason, setReason] = useState("");
  const { error, setError, submit } = useSubmit(act);
  const [status, kind] = OPTION_STATUS[o.status];
  const chosen = o.compliance === "compliant" && o.policy_flags.length === 0;
  const notChosen: Denied = chosen ? null : "Only an option reviewed as compliant can be chosen";
  const canSelect = may.select && o.status !== "selected";
  const canFallback = may.fallback && o.status !== "selected" && o.status !== "fallback";
  const path = { params: { path: { item_id: o.id } } };
  const done = () => {
    setMode(null);
    setReason("");
  };
  const decision = (e: FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) return setError(`Say why you ${mode} this option.`);
    const body = { lock_version: o.lock_version, reason: reason.trim() };
    void submit(
      () =>
        mode === "select"
          ? unwrap(api.POST("/v1/blocker-options/{item_id}/select", { ...path, body }))
          : unwrap(api.POST("/v1/blocker-options/{item_id}/reject", { ...path, body })),
      mode === "select" ? "Option selected." : "Option rejected.",
      done,
    );
  };
  const fallback = () =>
    void submit(() => unwrap(api.POST("/v1/blocker-options/{item_id}/fallback", { ...path, body: { lock_version: o.lock_version } })), "Kept as the fallback.");

  return (
    <li className="flex min-w-0 flex-col gap-2 py-3 first:pt-0 last:pb-0" data-testid="blocker-option">
      <span className="min-w-0 font-semibold break-words">{o.title}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Chip kind={kind}>{status}</Chip>
        <Chip kind={o.compliance === "compliant" ? "pass" : o.compliance === "non_compliant" ? "crit" : "warn"}>
          {label(COMPLIANCE, o.compliance)}
        </Chip>
        {o.recommended && <Chip kind="acc">Recommended</Chip>}
      </div>
      <p className="text-sm text-text2">
        {label(APPROACHES, o.approach)} · technical {o.technical_feasibility} · policy {o.policy_feasibility}
      </p>
      {o.description && <p className="text-sm whitespace-pre-line">{o.description}</p>}
      {o.selected_reason && o.status === "selected" && <p className="text-sm text-text2">Why: {o.selected_reason}</p>}
      {o.policy_flags.map((f) => (
        <Notice key={f.category} tone="error">
          {f.message} (“{f.match}”)
        </Notice>
      ))}
      {mode === "edit" ? (
        <EditOption option={o} busy={busy} act={act} onDone={done} />
      ) : mode ? (
        <form onSubmit={decision} aria-label={mode === "select" ? "Select option" : "Reject option"} className="flex flex-col gap-2">
          <Text name="Reason" value={reason} onChange={setReason} />
          {error && <Notice tone="error">{error}</Notice>}
          <Actions>
            <Button type="submit" variant={mode === "reject" ? "danger" : "solid"} disabled={busy}>
              {mode === "select" ? "Select" : "Reject"}
            </Button>
            <Button onClick={done} disabled={busy}>
              Cancel
            </Button>
          </Actions>
        </form>
      ) : (
        o.status !== "rejected" &&
        (canSelect || canFallback || may.reject || may.editOption) && (
          <>
            {error && <Notice tone="error">{error}</Notice>}
            <Actions>
              {canSelect && (
                <Button onClick={() => setMode("select")} disabled={busy || !!notChosen} title={notChosen ?? undefined}>
                  Select
                </Button>
              )}
              {canFallback && (
                <Button onClick={fallback} disabled={busy || !!notChosen} title={notChosen ?? undefined}>
                  Fallback
                </Button>
              )}
              {may.reject && (
                <Button onClick={() => setMode("reject")} disabled={busy}>
                  Reject
                </Button>
              )}
              {may.editOption && (
                <Button variant="ghost" onClick={() => setMode("edit")} disabled={busy}>
                  Edit
                </Button>
              )}
            </Actions>
          </>
        )
      )}
    </li>
  );
}

function EditOption({ option: o, busy, act, onDone }: { option: Option; busy: boolean; act: Act; onDone: () => void }) {
  const [title, setTitle] = useState(o.title);
  const [approach, setApproach] = useState(o.approach);
  const [description, setDescription] = useState(o.description ?? "");
  const [technical, setTechnical] = useState(o.technical_feasibility);
  const [policy, setPolicy] = useState(o.policy_feasibility);
  const [compliance, setCompliance] = useState(o.compliance);
  const { error, setError, submit } = useSubmit(act);
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return setError("Give the option a title.");
    // Only what changed: a selected or fallback option keeps its text.
    const body: Schemas["BlockerOptionPatch"] = { lock_version: o.lock_version };
    if (title.trim() !== o.title) body.title = title.trim();
    if (approach !== o.approach) body.approach = approach;
    if ((description.trim() || null) !== (o.description ?? null)) body.description = description.trim() || null;
    if (technical !== o.technical_feasibility) body.technical_feasibility = technical;
    if (policy !== o.policy_feasibility) body.policy_feasibility = policy;
    if (compliance !== o.compliance) body.compliance = compliance;
    void submit(
      () => unwrap(api.PATCH("/v1/blocker-options/{item_id}", { params: { path: { item_id: o.id } }, body })),
      "Option saved.",
      onDone,
    );
  };
  return (
    <form onSubmit={save} aria-label="Edit option" className="flex flex-col gap-3">
      <Text name="Title" value={title} onChange={setTitle} />
      <Text name="Description" value={description} onChange={setDescription} rows={3} />
      <div className="grid grid-cols-2 gap-3 max-[600px]:grid-cols-1">
        <Select name="Approach" value={approach} options={APPROACHES} onChange={setApproach} />
        <Select name="Compliance" value={compliance} options={COMPLIANCE} onChange={setCompliance} />
        <Select name="Technical feasibility" value={technical} options={FEASIBILITY} onChange={setTechnical} />
        <Select name="Policy feasibility" value={policy} options={FEASIBILITY} onChange={setPolicy} />
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <Actions>
        <Button type="submit" variant="solid" disabled={busy}>
          Save
        </Button>
        <Button onClick={onDone} disabled={busy}>
          Cancel
        </Button>
      </Actions>
    </form>
  );
}

function Scope({ strategy: s, busy, may, denied, act }: { strategy: Strategy; busy: boolean; may: boolean; denied: Denied; act: Act }) {
  const b = s.blocker;
  const choices = s.experiments.filter(live);
  const [picked, setPicked] = useState("");
  const [reason, setReason] = useState("");
  const { error, setError, submit } = useSubmit(act);
  const experimentId = picked || choices[0]?.id || "";
  const approved = [...s.events].reverse().find((e) => e.kind === "feasibility_scope_approved");
  const current = b.status === "feasibility_only" ? s.experiments.find((x) => x.id === approved?.experiment_id) : undefined;
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) return setError("Say why the blocker may proceed as a feasibility experiment.");
    void submit(
      () =>
        unwrap(
          api.POST("/v1/blockers/{blocker_id}/feasibility-scope", {
            params: { path: { blocker_id: b.id } },
            body: { experiment_id: experimentId, reason: reason.trim() },
          }),
        ),
      "Feasibility scope approved: work proceeds only as this experiment.",
      () => setReason(""),
    );
  };
  return (
    <InspectorSection label="Feasibility scope" testId="feasibility-scope">
      {b.status === "feasibility_only" ? (
        <p>
          Proceeding only as a scoped feasibility experiment
          {current && (
            <>
              : <b>{current.hypothesis}</b>
            </>
          )}
          {approved?.reason && <span className="text-text2"> · {approved.reason}</span>}
        </p>
      ) : b.status === "resolved" ? (
        <p className="text-text2">The blocker is resolved; it needs no feasibility scope.</p>
      ) : !may ? (
        <p className="text-text2">No feasibility scope approved</p>
      ) : (
        <form onSubmit={save} aria-label="Feasibility scope" className="flex flex-col gap-3">
          <p className="text-sm text-text2">
            Proceed only as a planned or running experiment with an owner, a success threshold and a decision gate. If it
            fails or is cancelled, the blocker reopens.
          </p>
          {choices.length === 0 ? (
            <p className="text-text2">Plan an experiment first.</p>
          ) : (
            <div className="grid grid-cols-2 gap-3 max-[600px]:grid-cols-1">
              <Select name="Experiment" value={experimentId} options={choices.map((x): [string, string] => [x.id, x.hypothesis])} onChange={setPicked} />
              <Text name="Reason" value={reason} onChange={setReason} />
            </div>
          )}
          {denied && <p className="text-sm font-medium">{denied}</p>}
          {error && <Notice tone="error">{error}</Notice>}
          <Actions>
            <Button type="submit" variant="solid" disabled={busy || !!denied || choices.length === 0} title={denied ?? undefined}>
              Approve scope
            </Button>
          </Actions>
        </form>
      )}
    </InspectorSection>
  );
}

function Experiments({
  strategy: s,
  people,
  meId,
  name,
  busy,
  may,
  act,
}: {
  strategy: Strategy;
  people: Person[] | undefined;
  meId?: string | null;
  name: (id: string | null | undefined) => string;
  busy: boolean;
  may: May;
  act: Act;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <InspectorSection
      label="Experiments"
      tools={
        may.plan &&
        !adding && (
          <Button onClick={() => setAdding(true)} disabled={busy}>
            Plan experiment
          </Button>
        )
      }
    >
      {adding && <PlanExperiment strategy={s} people={people} meId={meId} name={name} busy={busy} act={act} onDone={() => setAdding(false)} />}
      {s.experiments.length === 0 ? (
        !adding && <p className="text-text2">No experiments yet</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line" aria-label="Experiments">
          {s.experiments.map((x) => (
            <ExperimentRow key={x.id} experiment={x} name={name} busy={busy} may={may.run} act={act} />
          ))}
        </ul>
      )}
    </InspectorSection>
  );
}

function PlanExperiment({
  strategy: s,
  people,
  meId,
  name,
  busy,
  act,
  onDone,
}: {
  strategy: Strategy;
  people: Person[] | undefined;
  meId?: string | null;
  name: (id: string | null | undefined) => string;
  busy: boolean;
  act: Act;
  onDone: () => void;
}) {
  const [hypothesis, setHypothesis] = useState("");
  const [option, setOption] = useState("");
  const [method, setMethod] = useState("");
  const [threshold, setThreshold] = useState("");
  const [owner, setOwner] = useState(meId ?? "");
  const [gate, setGate] = useState("");
  const zone = useCompanyZone();
  const today = todayIn(zone);
  const { error, setError, submit } = useSubmit(act);
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!hypothesis.trim()) return setError("Say what the experiment tests.");
    void submit(
      () =>
        unwrap(
          api.POST("/v1/blockers/{blocker_id}/experiments", {
            params: { path: { blocker_id: s.blocker.id } },
            body: {
              hypothesis: hypothesis.trim(),
              option_id: option || null,
              method: method.trim() || null,
              success_threshold: threshold.trim() || null,
              owner_id: owner || null,
              // 09:00 on the chosen day in the Company time zone.
              decision_gate_at: gate ? zoneInstant(gate, "09:00", zone) : null,
              evidence_ids: [],
            },
          }),
        ),
      "Experiment planned.",
      onDone,
    );
  };
  const options: [string, string][] = [["", "The blocker itself"], ...s.options.filter((o) => o.status !== "rejected").map((o): [string, string] => [o.id, o.title])];
  return (
    <form onSubmit={save} aria-label="Plan experiment" className="mb-3 flex flex-col gap-3">
      <Text name="Hypothesis" value={hypothesis} onChange={setHypothesis} />
      <Select name="Tests" value={option} options={options} onChange={setOption} />
      <Text name="Method" value={method} onChange={setMethod} rows={2} />
      <div className="grid grid-cols-2 gap-3 max-[600px]:grid-cols-1">
        <Text name="Success threshold" value={threshold} onChange={setThreshold} />
        <Select name="Owner" value={owner} options={ownerOptions(people, meId, name)} onChange={setOwner} />
        <Field name="Decision gate">
          {(id) => <input id={id} className={INPUT} type="date" min={addDays(today, 1)} value={gate} onChange={(e) => setGate(e.target.value)} />}
        </Field>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <Actions>
        <Button type="submit" variant="solid" disabled={busy}>
          Plan
        </Button>
        <Button onClick={onDone} disabled={busy}>
          Cancel
        </Button>
      </Actions>
    </form>
  );
}

function ExperimentRow({
  experiment: x,
  name,
  busy,
  may,
  act,
}: {
  experiment: Experiment;
  name: (id: string | null | undefined) => string;
  busy: boolean;
  may: boolean;
  act: Act;
}) {
  const zone = useCompanyZone();
  const [concluding, setConcluding] = useState(false);
  const [outcome, setOutcome] = useState<Experiment["status"]>("succeeded");
  const [result, setResult] = useState("");
  const { error, submit } = useSubmit(act);
  const [status, kind] = EXPERIMENT_STATUS[x.status];
  const patch = (body: Omit<Schemas["FeasibilityExperimentPatch"], "lock_version">, message: string, done?: () => void) =>
    void submit(
      () =>
        unwrap(
          api.PATCH("/v1/feasibility-experiments/{item_id}", {
            params: { path: { item_id: x.id } },
            body: { ...body, lock_version: x.lock_version },
          }),
        ),
      message,
      done,
    );
  const rows: [string, string | null | undefined][] = [
    ["Method", x.method],
    ["Success threshold", x.success_threshold],
    ["Owner", name(x.owner_id)],
    ["Decision gate", x.decision_gate_at && zoneDay(x.decision_gate_at, zone)],
    ["Result", x.result],
  ];
  return (
    <li className="flex min-w-0 flex-col gap-2 py-3 first:pt-0 last:pb-0" data-testid="experiment">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-[12rem] flex-1 font-semibold break-words">{x.hypothesis}</span>
        <Chip kind={kind}>{status}</Chip>
      </div>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
        {rows
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-text2">{k}</dt>
              <dd className="min-w-0 break-words">{v}</dd>
            </div>
          ))}
      </dl>
      {concluding ? (
        <form
          aria-label="Conclude experiment"
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            patch({ status: outcome, result: result.trim() || null }, `Experiment ${outcome}.`, () => setConcluding(false));
          }}
        >
          <Select name="Outcome" value={outcome} options={OUTCOMES} onChange={setOutcome} />
          <Text name="Result" value={result} onChange={setResult} rows={3} />
          {error && <Notice tone="error">{error}</Notice>}
          <Actions>
            <Button type="submit" variant="solid" disabled={busy}>
              Save result
            </Button>
            <Button onClick={() => setConcluding(false)} disabled={busy}>
              Cancel
            </Button>
          </Actions>
        </form>
      ) : (
        may &&
        live(x) && (
          <>
            {error && <Notice tone="error">{error}</Notice>}
            <Actions>
              {x.status === "planned" && (
                <Button onClick={() => patch({ status: "running" }, "Experiment started.")} disabled={busy}>
                  Start
                </Button>
              )}
              <Button onClick={() => setConcluding(true)} disabled={busy}>
                Conclude
              </Button>
            </Actions>
          </>
        )
      )}
    </li>
  );
}
