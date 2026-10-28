"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { Button, Chip, type ChipKind } from "@/components/ds";
import { FIELD_LABEL, InlineError, SELECT, TEXTAREA } from "@/components/review/parts";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import {
  actOnChange,
  applyChange,
  ApplyPushback,
  askSummary,
  createChange,
  editChange,
  isOpen,
  kindLabel,
  listChangeKinds,
  listChanges,
  stripMarkers,
  VERB_ROUTE,
  type ChangeKindOut,
  type ChangeOut,
  type ChangeVerb,
  type PushbackItem,
} from "@/lib/api/discussion-changes";
import { useMe, type Operation } from "@/lib/me";
import { errorMessage } from "@/lib/use-query";

import { ChangeForm } from "./ChangeForm";
import { ReplyBody } from "./cited";
import { plural } from "./DiscussionList";

type Discussion = Schemas["DiscussionOut"];

const STATUS: Record<ChangeOut["status"], { label: string; kind: ChipKind }> = {
  proposed: { label: "Proposed", kind: "line" },
  suggested: { label: "Suggested", kind: "acc" },
  staged: { label: "Staged", kind: "pass" },
  done: { label: "Done", kind: "pass" },
  dismissed: { label: "Dismissed", kind: "na" },
  superseded: { label: "Replaced", kind: "na" },
};

/** Each verb's route (#370): can() asks whether the caller may call it, and the change (per item) decides below its role. */
const VERB_OP: Partial<Record<ChangeVerb, Operation>> = {
  Stage: "stage_discussion_change",
  Propose: "propose_discussion_change",
  Resolve: "resolve_discussion_change",
  "Use as answer": "answer_with_discussion_change",
  Record: "record_discussion_change",
  // G3's Ask and Apply.
  Ask: "ask_discussion_change",
  Apply: "apply_discussion_change",
};

function byWhom(c: ChangeOut): string {
  if (c.suggested_by) return `Suggested by ${c.suggested_by.name}`;
  if (c.proposed_by_kind === "oracle") return "Proposed by Oracle";
  return `Proposed by ${c.proposed_by?.name ?? "someone"}`;
}

/** Stage's questions first: Oracle's pushback, and in a private discussion the shared reason. */
function StageForm({
  c,
  subject,
  busy,
  onStage,
  onCancel,
}: {
  c: ChangeOut;
  subject: string;
  busy: boolean;
  onStage: (extra: { override_reason?: string; reason?: string }) => void;
  onCancel: () => void;
}) {
  const [why, setWhy] = useState("");
  const [reason, setReason] = useState(() => stripMarkers(c.rationale));
  const ready = (!c.pushback || !!why.trim()) && (!c.needs_reason || !!reason.trim());
  return (
    <form
      className="mt-2 flex flex-col gap-2"
      data-testid="stage-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        onStage({ ...(c.pushback ? { override_reason: why.trim() } : {}), ...(c.needs_reason ? { reason: reason.trim() } : {}) });
      }}
    >
      {c.pushback && (
        <>
          <p className="rounded-lg bg-warn-bg px-2.5 py-2 text-sm leading-5 text-text" data-testid="change-pushback" role="note">
            <span className="font-semibold text-warn">Oracle pushed back on this: </span>
            {c.pushback.reason}
          </p>
          <label className={FIELD_LABEL}>
            Why stage it anyway?
            <textarea aria-label="Why stage it anyway?" rows={2} maxLength={1000} className={TEXTAREA} value={why} onChange={(e) => setWhy(e.target.value)} />
          </label>
        </>
      )}
      {c.needs_reason && (
        <>
          <p className="text-sm leading-5 text-text2" data-testid="stage-shares">
            This change and this reason will be visible to everyone who can see {subject}. The discussion stays private.
          </p>
          <label className={FIELD_LABEL}>
            The reason everyone will see
            <textarea aria-label="The reason everyone will see" rows={2} maxLength={1000} className={TEXTAREA} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
        </>
      )}
      <span className="flex gap-2">
        <Button type="submit" variant="solid" disabled={busy || !ready}>
          {c.action?.verb ?? "Stage"}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </span>
    </form>
  );
}

/** Apply's pushback: Oracle's reasons, then why to apply it anyway (the reason everyone sees). */
function ApplyForm({
  items,
  busy,
  onApply,
  onCancel,
}: {
  items: PushbackItem[];
  busy: boolean;
  onApply: (reason: string) => void;
  onCancel: () => void;
}) {
  const [why, setWhy] = useState("");
  return (
    <form
      className="mt-2 flex flex-col gap-2"
      data-testid="apply-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (why.trim()) onApply(why.trim());
      }}
    >
      <div className="rounded-lg bg-warn-bg px-2.5 py-2 text-sm leading-5 text-text" data-testid="apply-pushback" role="note">
        <p className="font-semibold text-warn">Oracle pushed back on this:</p>
        <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-5">
          {items.map((x, i) => (
            <li key={`${x.code}:${i}`}>{x.message}</li>
          ))}
        </ul>
      </div>
      <label className={FIELD_LABEL}>
        Why apply it anyway?
        <textarea aria-label="Why apply it anyway?" rows={2} maxLength={500} className={TEXTAREA} value={why} onChange={(e) => setWhy(e.target.value)} />
      </label>
      <span className="flex gap-2">
        <Button type="submit" variant="solid" disabled={busy || !why.trim()}>
          Apply anyway
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </span>
    </form>
  );
}

/** A proposed decision's link in the decision log ("Open D-12"), from the change's result. */
function decisionLink(c: ChangeOut): { href: string; label: string } | null {
  const ref = c.result_ref ?? {};
  const id = typeof ref.decision_id === "string" ? ref.decision_id : null;
  if (c.kind !== "decision" || c.status !== "done" || !id) return null;
  const number = typeof ref.number === "string" || typeof ref.number === "number" ? String(ref.number) : null;
  const label = number ? (number.startsWith("D-") ? number : `D-${number}`) : "the decision";
  return { href: `/company/decisions?d=${encodeURIComponent(id)}`, label: `Open ${label}` };
}

/** One change: its sentence, why (with citation chips), who put it forward, and what the reader may do. */
function ChangeRow({ c, d, onDone }: { c: ChangeOut; d: Discussion; onDone: () => Promise<void> }) {
  const [mode, setMode] = useState<"edit" | "stage" | "apply" | null>(null);
  const [pushback, setPushback] = useState<PushbackItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { can } = useMe();
  const live = isOpen(c) && d.status === "open";
  const action = live ? c.action : null;
  // #370: the route's capability, the change deciding below the role its handler never refuses
  // (Record: F3's date rights, which the change's action carries).
  const op = action ? VERB_OP[action.verb] : undefined;
  const allowed = !!action?.allowed && (!op || can(op, action.allowed));

  const run = async (call: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await call();
      setMode(null);
      await onDone();
    } catch (e) {
      setError(errorMessage(e));
      await onDone();
    } finally {
      setBusy(false);
    }
  };
  /** Apply: Oracle may push back first (nothing stored); then "Apply anyway" with a reason. */
  const apply = async (opts: { reason?: string; confirm?: boolean } = {}) => {
    setBusy(true);
    setError(null);
    try {
      await applyChange(c, opts);
      setMode(null);
      await onDone();
    } catch (e) {
      if (e instanceof ApplyPushback) {
        setPushback(e.pushback);
        setMode("apply");
      } else {
        setError(errorMessage(e));
        await onDone();
      }
    } finally {
      setBusy(false);
    }
  };
  const act = () => {
    if (!action) return;
    if (action.verb === "Stage" && (c.pushback || c.needs_reason)) setMode("stage");
    else if (action.verb === "Apply") void apply();
    else void run(() => actOnChange(c, VERB_ROUTE[action.verb]));
  };
  const opened = decisionLink(c);
  const buttons = live && (action || c.can.suggest || c.can.edit || c.can.withdraw || c.can.dismiss);
  const status = STATUS[c.status];

  return (
    <li className="flex min-w-0 flex-col gap-1 border-t border-line pt-2 first:border-t-0 first:pt-0" data-testid="change-row" data-status={c.status} data-kind={c.kind}>
      <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[15px] leading-[22px] font-semibold break-words text-text">
        <span data-testid="change-label">{c.label}</span>
        {!isOpen(c) && <Chip kind={status.kind}>{status.label}</Chip>}
      </p>
      {c.rationale && (
        <p className="text-sm leading-5 break-words text-text2" data-testid="change-rationale">
          <ReplyBody text={c.rationale} citations={[]} loose />
        </p>
      )}
      <p className="text-[13px] text-text2" data-testid="change-by">
        {byWhom(c)}
      </p>
      {c.decision_note && !isOpen(c) && <p className="text-[13px] text-text2">{c.decision_note}</p>}
      {opened && (
        <Link href={opened.href} className="text-sm font-medium text-accent-ink hover:underline" data-testid="change-decision-link">
          {opened.label}
        </Link>
      )}
      {buttons && mode === null && (
        <span className="flex flex-wrap gap-1" data-testid="change-actions">
          {action && (
            <Button variant="solid" disabled={busy || !allowed} title={allowed ? undefined : (action.why_not ?? undefined)} onClick={act}>
              {action.verb}
            </Button>
          )}
          {c.can.suggest && (
            <Button disabled={busy} onClick={() => void run(() => actOnChange(c, "suggest"))}>
              Suggest
            </Button>
          )}
          {c.can.edit && (
            <Button disabled={busy} onClick={() => setMode("edit")}>
              Edit
            </Button>
          )}
          {c.can.withdraw && (
            <Button variant="ghost" disabled={busy} onClick={() => void run(() => actOnChange(c, "withdraw"))}>
              Withdraw
            </Button>
          )}
          {c.can.dismiss && (
            <Button variant="ghost" disabled={busy} onClick={() => void run(() => actOnChange(c, "dismiss"))}>
              Dismiss
            </Button>
          )}
        </span>
      )}
      {mode === "stage" && (
        <StageForm c={c} subject={d.subject_label} busy={busy} onStage={(extra) => void run(() => actOnChange(c, "stage", extra))} onCancel={() => setMode(null)} />
      )}
      {mode === "apply" && <ApplyForm items={pushback} busy={busy} onApply={(reason) => void apply({ reason, confirm: true })} onCancel={() => setMode(null)} />}
      {mode === "edit" && (
        <div className="mt-1">
          <ChangeForm
            kind={c.kind}
            initial={c.edited_payload ?? c.payload}
            onCancel={() => setMode(null)}
            onSave={async (payload) => {
              try {
                await editChange(c, payload);
                setMode(null);
                await onDone();
                return null;
              } catch (e) {
                await onDone();
                return errorMessage(e);
              }
            }}
          />
        </div>
      )}
      {error && <InlineError>{error}</InlineError>}
    </li>
  );
}

/** "Propose a change": the subject's kinds, then the kind's form. */
function ProposeChange({ d, onDone }: { d: Discussion; onDone: () => Promise<void> }) {
  const [kinds, setKinds] = useState<ChangeKindOut[] | null>(null);
  const [kind, setKind] = useState("");
  const [error, setError] = useState<string | null>(null);
  const subject = d.subject as Record<string, unknown>;

  const open = async () => {
    setError(null);
    try {
      const rows = await listChangeKinds(d.id);
      setKinds(rows);
      setKind(rows[0]?.kind ?? "");
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const close = () => {
    setKinds(null);
    setKind("");
  };
  const itemKey = typeof subject.item_key === "string" ? subject.item_key : "";
  const initial = (k: string): Record<string, unknown> =>
    k === "section_edit"
      ? { section_key: typeof subject.section_key === "string" ? subject.section_key : "", instruction: "" }
      : k === "item_horizon"
        ? { item_key: itemKey, horizon: "next" }
        : k === "basis_record"
          ? { prd_document_id: subject.document_id ?? "", kind: "estimate", reference: "", supports_date: "", ...(itemKey ? { item_key: itemKey } : {}) }
          : k === "scope_feature"
            ? { decision: "include", reason: "" }
            : k === "scope_requirement"
              ? { op: "add" }
              : k === "priority_pin"
                ? { position: 1, reason: "" }
                : k === "decision"
                  ? { title: "", reversibility: "reversible" }
                  : {};
  // The feature the subject names (an entity, or a checkpoint's item), prefilled where a kind picks one.
  const featureHint = typeof subject.entity_id === "string" ? subject.entity_id : itemKey || undefined;

  if (!kinds)
    return (
      <div className="flex flex-col gap-1">
        <span>
          <Button icon="plus" onClick={() => void open()}>
            Propose a change
          </Button>
        </span>
        {error && <InlineError>{error}</InlineError>}
      </div>
    );
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line p-3" data-testid="propose-change">
      {kinds.length === 0 ? (
        <p className="text-sm text-text2">No changes can be proposed on {d.subject_label}.</p>
      ) : (
        <label className={FIELD_LABEL}>
          Kind of change
          <select aria-label="Kind of change" className={SELECT} value={kind} onChange={(e) => setKind(e.target.value)}>
            {kinds.map((k) => (
              <option key={k.kind} value={k.kind}>
                {kindLabel(k.kind)}
              </option>
            ))}
          </select>
        </label>
      )}
      {kind ? (
        <ChangeForm
          key={kind}
          kind={kind}
          initial={initial(kind)}
          featureHint={featureHint}
          fresh
          withRationale
          saveLabel="Propose"
          onCancel={close}
          onSave={async (payload, rationale) => {
            const target: Record<string, unknown> = { ...subject };
            if (typeof payload.item_key === "string") target.item_key = payload.item_key;
            if (typeof payload.section_key === "string") target.section_key = payload.section_key;
            try {
              await createChange(d.id, { kind, target, payload, rationale });
              close();
              await onDone();
              return null;
            } catch (e) {
              return errorMessage(e);
            }
          }}
        />
      ) : (
        <span>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
        </span>
      )}
    </div>
  );
}

/** "Summary · draft by Oracle" or "Summary": Edit and Confirm for the starter, "Ask Oracle to summarize" for writers. */
function SummaryBlock({ d, onChanged }: { d: Discussion; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(d.summary ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = d.status === "open";
  const starter = d.me.can_manage && open;
  const writer = d.me.can_write && open;
  const draft = d.summary_status === "draft";
  if (!d.summary && !writer) return null;

  const run = async (call: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await call();
      setEditing(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  // Confirm: the starter's text becomes the summary (G1's PATCH, summary_status "confirmed").
  const confirm = (summary: string) => {
    const body = { summary, summary_status: "confirmed", lock_version: d.lock_version } as Schemas["DiscussionPatch"];
    return run(() => unwrap(api.PATCH("/v1/discussions/{discussion_id}", { params: { path: { discussion_id: d.id } }, body })));
  };

  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-lg bg-surface2 px-3 py-2" data-testid="discussion-summary" data-summary-status={d.summary_status}>
      <p className="text-[13px] font-semibold text-text2">{draft ? "Summary · draft by Oracle" : "Summary"}</p>
      {editing ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void confirm(text.trim());
          }}
        >
          <textarea aria-label="Summary" rows={4} maxLength={1200} className={TEXTAREA} value={text} onChange={(e) => setText(e.target.value)} />
          <span className="flex gap-2">
            <Button type="submit" variant="solid" disabled={busy || !text.trim()}>
              Confirm
            </Button>
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </span>
        </form>
      ) : (
        d.summary && <p className="text-sm leading-5 break-words whitespace-pre-wrap text-text">{d.summary}</p>
      )}
      {!editing && (starter || writer) && (
        <span className="flex flex-wrap gap-1">
          {starter && d.summary && (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setText(d.summary ?? "");
                setEditing(true);
              }}
            >
              Edit
            </Button>
          )}
          {starter && draft && d.summary && (
            <Button variant="ghost" disabled={busy} onClick={() => void confirm(d.summary ?? "")}>
              Confirm
            </Button>
          )}
          {writer && (
            <Button variant="ghost" disabled={busy} onClick={() => void run(() => askSummary(d.id, starter && d.summary_status === "confirmed"))}>
              Ask Oracle to summarize
            </Button>
          )}
        </span>
      )}
      {error && <InlineError>{error}</InlineError>}
    </div>
  );
}

/**
 * G3: what the discussion turns into, under the thread. "From this discussion · N changes"
 * lists the open ones first and folds the handled ones; each row shows only the actions its
 * reader can take (none for a viewer), and a disabled one says why. Writers can propose a
 * change by hand; the summary sits at the bottom. `refreshKey` changes when a reply ends.
 * `focus` (the Inbox's Review changes, G6) scrolls to it once it has open changes; `leaveOut`
 * names kinds the page shows elsewhere (B6's goal versions under Oracle's messages).
 */
export function ChangesCard({
  d,
  refreshKey,
  onThreadChanged,
  focus = false,
  leaveOut,
}: {
  d: Discussion;
  refreshKey: number;
  onThreadChanged: () => void;
  focus?: boolean;
  leaveOut?: string[];
}) {
  const [changes, setChanges] = useState<ChangeOut[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let live = true;
    listChanges(d.id)
      .then((rows) => {
        if (!live) return;
        setChanges(rows);
        setError(null);
      })
      .catch((e: unknown) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [d.id, refreshKey, reloads]);

  // After any action: the changes again, and the thread (a system line, the counts).
  const done = async () => {
    try {
      setChanges(await listChanges(d.id));
    } catch {
      setReloads((n) => n + 1);
    }
    onThreadChanged();
  };

  const rows = (changes ?? []).filter((c) => !leaveOut?.includes(c.kind));
  const open = rows.filter(isOpen);
  const ref = useRef<HTMLElement>(null);
  const scrolled = useRef(false);
  useEffect(() => {
    if (focus && open.length > 0 && !scrolled.current && ref.current) {
      scrolled.current = true;
      ref.current.scrollIntoView({ block: "center" });
    }
  }, [focus, open.length]);
  const handled = rows.filter((c) => !isOpen(c));
  const canPropose = d.me.can_write && d.status === "open";
  if (!rows.length && !canPropose && !d.summary && !error) return null;

  return (
    <section ref={ref} className="flex min-w-0 flex-col gap-3 rounded-lg border border-line p-3" data-testid="changes-card" aria-label="Changes from this discussion">
      {rows.length > 0 && (
        <h4 className="font-display text-[15px] font-bold tracking-heading" data-testid="changes-header">
          From this discussion · {plural(open.length, "change", "changes")}
        </h4>
      )}
      {error && <InlineError>{error}</InlineError>}
      {open.length > 0 && (
        <ul className="flex min-w-0 flex-col gap-2" aria-label="Open changes">
          {open.map((c) => (
            <ChangeRow key={`${c.id}:${c.lock_version}`} c={c} d={d} onDone={done} />
          ))}
        </ul>
      )}
      {handled.length > 0 && (
        <details className="min-w-0" data-testid="changes-handled">
          <summary className="cursor-pointer text-sm font-semibold text-text2">{handled.length} handled</summary>
          <ul className="mt-2 flex min-w-0 flex-col gap-2" aria-label="Handled changes">
            {handled.map((c) => (
              <ChangeRow key={`${c.id}:${c.lock_version}`} c={c} d={d} onDone={done} />
            ))}
          </ul>
        </details>
      )}
      {canPropose && <ProposeChange d={d} onDone={done} />}
      <SummaryBlock key={`${d.summary_status}:${d.lock_version}`} d={d} onChanged={onThreadChanged} />
    </section>
  );
}
