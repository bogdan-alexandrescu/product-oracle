"use client";

import { useState } from "react";

import { Button, Chip, Empty, type ChipKind } from "@/components/ds";
import { PersonPicker, peopleByIds, type Person } from "@/components/PersonPicker";
import { FIELD_LABEL, InlineError, SELECT, TEXTAREA } from "@/components/review/parts";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

import { CATEGORY_LABEL, OPEN_GAP, categoryNote, type Category, type Summary } from "./_lib";

type RankedGap = Summary["gaps"][number];
type Importance = Schemas["GapCreate"]["importance"];

const IMPORTANCE: { value: Importance; label: string; kind: ChipKind }[] = [
  { value: "critical", label: "Critical", kind: "crit" },
  { value: "high", label: "High", kind: "warn" },
  { value: "medium", label: "Medium", kind: "na" },
  { value: "low", label: "Low", kind: "na" },
];
const IMPORTANCE_OF = Object.fromEntries(IMPORTANCE.map((i) => [i.value, i])) as Record<Importance, (typeof IMPORTANCE)[number]>;

/** A gap's status, in the page's words. */
export const GAP_STATUS: Record<RankedGap["status"], { label: string; kind: ChipKind }> = {
  unknown: { label: "Not known", kind: "na" },
  asked: { label: "Asked", kind: "warn" },
  under_investigation: { label: "Under investigation", kind: "acc" },
  answered: { label: "Answered", kind: "pass" },
  answered_pending_review: { label: "Waiting for review", kind: "warn" },
  validated: { label: "Validated", kind: "pass" },
  deferred: { label: "Deferred", kind: "na" },
  accepted_risk: { label: "Risk accepted", kind: "warn" },
};

// A control the signed-in role can never use is hidden (owner rule, #370); the note says who acts.
const ADD_REASON = "A commenter adds gaps";
const TRIAGE_REASON = "An approver sorts gaps";
/** qa4-work-12: the button says what it changes, not "Triage". */
const SORT_LABEL = "Set importance and owner";

/** A section key as a person reads it: "success_metrics" is "Success metrics". */
function sectionWords(key: string): string {
  const words = key.replace(/[-_.]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : key;
}

/** "a.b, c.d" → ["a.b", "c.d"]. */
const keysOf = (text: string) => [...new Set(text.split(",").map((k) => k.trim()).filter(Boolean))];

function AddGap({ intakeId, onDone, onCancel }: { intakeId: string; onDone: () => void; onCancel: () => void }) {
  const [category, setCategory] = useState<Category>("customer_user");
  const [statement, setStatement] = useState("");
  const [importance, setImportance] = useState<Importance>("medium");
  const [sections, setSections] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (!statement.trim()) {
      setError("Say what is not known first");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await unwrap(
        api.POST("/v1/gaps", {
          body: { intake_id: intakeId, category, statement: statement.trim(), importance, section_keys: keysOf(sections) },
        }),
      );
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="gap-add" className="flex min-w-0 flex-col gap-2.5 rounded-card border border-line bg-surface2 p-3">
      <div className="grid grid-cols-2 gap-2.5 max-[600px]:grid-cols-1">
        <label className={FIELD_LABEL}>
          Category
          <select value={category} onChange={(e) => setCategory(e.target.value as Category)} className={`${SELECT} h-9 w-full`}>
            {(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
        <label className={FIELD_LABEL}>
          Importance
          <select value={importance} onChange={(e) => setImportance(e.target.value as Importance)} className={`${SELECT} h-9 w-full`}>
            {IMPORTANCE.map((i) => (
              <option key={i.value} value={i.value}>
                {i.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className={FIELD_LABEL}>
        What is not known
        <textarea rows={2} maxLength={500} value={statement} onChange={(e) => setStatement(e.target.value)} className={TEXTAREA} />
      </label>
      <label className={FIELD_LABEL}>
        Sections
        <input value={sections} onChange={(e) => setSections(e.target.value)} placeholder="goals.outcomes, scope.non_goals" className={`${TEXTAREA} h-9`} />
      </label>
      {error && <InlineError>{error}</InlineError>}
      <div className="flex flex-wrap gap-1.5">
        <Button variant="solid" icon="plus" disabled={busy} onClick={add}>
          {busy ? "Adding…" : "Add gap"}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function Triage({
  gap,
  owner,
  onDone,
  onCancel,
}: {
  gap: RankedGap;
  owner: Person | undefined;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [importance, setImportance] = useState<Importance>(gap.importance);
  const [sections, setSections] = useState(gap.section_keys.join(", "));
  const [stop, setStop] = useState(gap.stop_condition ?? "");
  const [picked, setPicked] = useState<Person | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const body: Schemas["GapPatch"] = { lock_version: gap.lock_version };
    if (importance !== gap.importance) body.importance = importance;
    const keys = keysOf(sections);
    if (keys.join(",") !== gap.section_keys.join(",")) body.section_keys = keys;
    if (stop.trim() !== (gap.stop_condition ?? "")) body.stop_condition = stop.trim();
    if (picked && picked.user_id !== gap.owner_id) body.owner_id = picked.user_id;
    setBusy(true);
    setError(null);
    try {
      await unwrap(api.PATCH("/v1/gaps/{item_id}", { params: { path: { item_id: gap.id } }, body }));
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const ownerName = picked?.name ?? owner?.name;
  return (
    <div data-testid="gap-triage" className="flex min-w-0 flex-col gap-2.5 rounded-button border border-line bg-surface2 p-2.5">
      <label className={FIELD_LABEL}>
        Importance
        <select value={importance} onChange={(e) => setImportance(e.target.value as Importance)} className={`${SELECT} h-9 w-full max-w-60`}>
          {IMPORTANCE.map((i) => (
            <option key={i.value} value={i.value}>
              {i.label}
            </option>
          ))}
        </select>
      </label>
      <label className={FIELD_LABEL}>
        Sections
        <input value={sections} onChange={(e) => setSections(e.target.value)} className={`${TEXTAREA} h-9`} />
      </label>
      <label className={FIELD_LABEL}>
        Closed when
        <textarea rows={2} maxLength={500} value={stop} onChange={(e) => setStop(e.target.value)} className={TEXTAREA} />
      </label>
      <div className="flex min-w-0 flex-col gap-1.5">
        <span className={FIELD_LABEL}>Owner</span>
        <div className="flex flex-wrap items-center gap-2 text-sm text-text">
          <span>{ownerName ?? "Nobody yet"}</span>
          <Button variant="ghost" onClick={() => setPicking((v) => !v)}>
            Choose an owner
          </Button>
        </div>
        {picking && (
          <PersonPicker
            onPick={(p) => {
              setPicked(p);
              setPicking(false);
            }}
          />
        )}
      </div>
      {error && <InlineError>{error}</InlineError>}
      <div className="flex flex-wrap gap-1.5">
        <Button variant="solid" icon="check" disabled={busy} onClick={save}>
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function GapRow({
  gap,
  owner,
  researching,
  onChanged,
}: {
  gap: RankedGap;
  owner: Person | undefined;
  researching: boolean;
  onChanged: () => void;
}) {
  const [triaging, setTriaging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { can } = useMe();
  // Lowering a critical gap takes an owner; the API says so in place.
  const approver = can("update_knowledge_gap", true);
  const commenter = can("propose_gap_research");
  const open = OPEN_GAP.has(gap.status);
  const status = GAP_STATUS[gap.status];
  const importance = IMPORTANCE_OF[gap.importance];

  async function act(run: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await run();
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const setStatus = (next: "deferred" | "unknown") =>
    act(() => unwrap(api.PATCH("/v1/gaps/{item_id}", { params: { path: { item_id: gap.id } }, body: { lock_version: gap.lock_version, status: next } })));
  const research = () => act(() => unwrap(api.POST("/v1/gaps/{gap_id}/research", { params: { path: { gap_id: gap.id } } })));

  return (
    <li data-testid="gap-row" className="flex min-w-0 flex-col gap-2 rounded-card border border-line bg-surface p-3 text-text">
      <div className="flex min-w-0 flex-wrap items-start gap-2">
        <p className="min-w-0 flex-1 basis-60 text-[15px] break-words">{gap.statement}</p>
        <span className="flex flex-wrap gap-1.5">
          <Chip kind={importance.kind}>{importance.label}</Chip>
          <Chip kind={status.kind} dot data-testid="gap-status">
            {status.label}
          </Chip>
        </span>
      </div>
      <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-[13px] text-text2">
        {categoryNote(gap) && <span>{categoryNote(gap)}</span>}
        {/* qa-work-30: the PRD sections it touches in words ("Metrics"), not raw keys. */}
        {gap.section_keys.length > 0 && (
          <span className="break-words" data-testid="gap-sections">
            {gap.section_keys.length === 1 ? "PRD section" : "PRD sections"}: {gap.section_keys.map(sectionWords).join(", ")}
          </span>
        )}
        {owner && <span>Owner: {owner.name}</span>}
        {researching && <span className="font-semibold text-accent-ink">Research proposed</span>}
      </div>
      {gap.stop_condition && <p className="text-[13px] break-words text-text2">Closed when: {gap.stop_condition}</p>}
      {error && <InlineError>{error}</InlineError>}
      {triaging ? (
        <Triage
          gap={gap}
          owner={owner}
          onCancel={() => setTriaging(false)}
          onDone={() => {
            setTriaging(false);
            onChanged();
          }}
        />
      ) : (
        (approver || (commenter && open && !researching)) && (
          <div className="flex flex-wrap gap-1.5">
            {approver && (
              <Button title="Change its importance, owner, PRD sections and when it counts as closed" onClick={() => setTriaging(true)}>
                {SORT_LABEL}
              </Button>
            )}
            {commenter && open && !researching && (
              <Button icon="search" disabled={busy} onClick={research}>
                Research this
              </Button>
            )}
            {approver && open && (
              <Button variant="ghost" disabled={busy} onClick={() => setStatus("deferred")}>
                Defer
              </Button>
            )}
            {approver && gap.status === "deferred" && (
              <Button variant="ghost" disabled={busy} onClick={() => setStatus("unknown")}>
                Reopen
              </Button>
            )}
          </div>
        )
      )}
    </li>
  );
}

/** Who acts on the gap controls the signed-in role does not see; nothing for approvers and owners. */
function roleNote(canAdd: boolean, canTriage: boolean): string | null {
  if (!canAdd) return `You can read the gaps. ${ADD_REASON} and asks for research; an approver sorts them.`;
  if (!canTriage) return `${TRIAGE_REASON}: importance, owner, PRD sections, when it is closed, defer and reopen.`;
  return null;
}

/**
 * The brief's knowledge gaps (#343): add one by hand (commenter), triage it (approver:
 * importance, owner, sections, stop condition, defer, reopen; lowering a critical one takes
 * an owner, the API says so in place), and Research this (commenter), which proposes a run.
 */
export function GapsTab({ summary: s, onChanged }: { summary: Summary; onChanged: () => void }) {
  const { can, capsReady } = useMe();
  const [adding, setAdding] = useState(false);
  const ownerIds = s.gaps.map((g) => g.owner_id).filter((id): id is string => !!id);
  const owners = useQuery(`gap-owners|${[...new Set(ownerIds)].sort().join(",")}`, () => peopleByIds(ownerIds), { keepPrevious: true });
  const researching = new Set(s.proposals.filter((p) => p.kind === "research_run" && p.status === "proposed").map((p) => p.gap_id));
  const commenter = can("create_knowledge_gap");
  const note = capsReady ? roleNote(commenter, can("update_knowledge_gap", true)) : null;
  return (
    <div data-testid="intake-gaps" className="flex min-w-0 flex-col gap-3 pt-3">
      <div className="flex flex-wrap items-center gap-2">
        {commenter && (
          <Button icon="plus" disabled={adding} onClick={() => setAdding(true)}>
            Add a gap
          </Button>
        )}
        {note && (
          <p data-testid="gaps-role-note" role="note" className="min-w-0 flex-1 basis-60 text-[13px] text-text2">
            {note}
          </p>
        )}
      </div>
      {adding && (
        <AddGap
          intakeId={s.intake.id}
          onCancel={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            onChanged();
          }}
        />
      )}
      {s.gaps.length === 0 ? (
        <Empty>No gaps yet</Empty>
      ) : (
        <ul className="flex min-w-0 flex-col gap-2">
          {s.gaps.map((g) => (
            <GapRow
              key={`${g.id}-${g.lock_version}`}
              gap={g}
              owner={g.owner_id ? owners.data?.get(g.owner_id) : undefined}
              researching={researching.has(g.id)}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
