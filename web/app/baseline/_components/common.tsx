import { Chip, Ring, type ChipKind } from "@/components/ds";
import { LockIcon } from "@/components/ui";
import type { EntityOut, GraphOut, NodeStatus } from "@/lib/api/client";
import { formatDate } from "@/lib/format";

/** Default `low` threshold of the confidence settings; the trace report carries the company's. */
export const DEFAULT_LOW = 0.4;

const SOURCE_KIND_LABEL: Record<string, string> = {
  slack: "Slack",
  notion: "Notion",
  google_docs: "Google Docs",
  gdocs: "Google Docs",
  github: "GitHub",
  "github:issue": "GitHub issue",
  "github:pull_request": "GitHub pull request",
  "github:release": "GitHub release",
  "github:readme": "GitHub readme",
  "github:file": "GitHub file",
  "github:milestone": "GitHub milestone",
  linear: "Linear",
  jira: "Jira",
  fireflies: "Meeting notes",
  upload: "Upload",
  manual: "Manual",
  web: "Web",
  code: "Code",
  tracker: "Tracker",
  docs: "Docs",
  meeting: "Meeting",
  chat: "Chat",
};

export function sourceKindLabel(kind: string | null | undefined): string {
  if (!kind) return "Unknown source";
  return SOURCE_KIND_LABEL[kind] ?? SOURCE_KIND_LABEL[kind.split(":")[0]] ?? kind;
}

export function confidenceTone(value: number, low = DEFAULT_LOW): "green" | "amber" | "red" {
  if (value >= 0.7) return "green";
  if (value >= low) return "amber";
  return "red";
}

const RING_TONE = { green: "accent", amber: "warn", red: "crit" } as const;

/** Confidence as a number chip (evidence, claims, link previews): "0.78". */
export function ConfidenceBadge({ value, low = DEFAULT_LOW }: { value: number | null | undefined; low?: number }) {
  if (value == null) {
    return (
      <Chip kind="na" title="Not scored yet">
        <span data-testid="confidence">no score</span>
      </Chip>
    );
  }
  const tone = confidenceTone(value, low);
  return (
    <Chip kind={tone === "green" ? "pass" : tone === "amber" ? "warn" : "crit"} title="Confidence">
      <span data-testid="confidence" data-tone={tone}>
        {value.toFixed(2)}
      </span>
    </Chip>
  );
}

/** Confidence of a baseline item as a ring, 0-100 (I3 rule 4). */
export function ConfidenceRing({
  value,
  low = DEFAULT_LOW,
  size = 34,
}: {
  value: number | null | undefined;
  low?: number;
  size?: number;
}) {
  const tone = value == null ? undefined : confidenceTone(value, low);
  return (
    <span data-testid="confidence" data-tone={tone} className="inline-flex align-middle" title="Confidence">
      <Ring
        value={value == null ? null : value * 100}
        size={size}
        stroke={size >= 40 ? 5 : 4}
        tone={tone ? RING_TONE[tone] : "accent"}
      />
    </span>
  );
}

export const NODE_STATUS_LABEL: Record<NodeStatus, string> = {
  proposed: "Proposed",
  confirmed: "Confirmed",
  rejected: "Rejected",
};

const NODE_STATUS_KIND: Record<NodeStatus, ChipKind> = { proposed: "warn", confirmed: "pass", rejected: "crit" };

export function NodeStatusBadge({ status, hero = false }: { status: NodeStatus; hero?: boolean }) {
  return (
    <Chip kind={NODE_STATUS_KIND[status]} hero={hero}>
      {NODE_STATUS_LABEL[status]}
    </Chip>
  );
}

/** A feature's delivery state (attrs.status) in sentence case, as goal states are: "in_progress" -> "In progress". */
export function DeliveryChip({ value, hero = false }: { value: unknown; hero?: boolean }) {
  if (value == null || value === "") return null;
  const v = formatValue(value).replace(/_/g, " ").toLowerCase();
  const text = v.charAt(0).toUpperCase() + v.slice(1);
  const kind: ChipKind = v === "shipped" || v === "done" ? "pass" : v === "in progress" || v === "in build" ? "acc" : "na";
  return (
    <Chip kind={kind} hero={hero}>
      {text}
    </Chip>
  );
}

function lockTitle(entity: Pick<EntityOut, "locked_by" | "locked_at">, meId?: string | null) {
  const who = entity.locked_by ? (entity.locked_by === meId ? "you" : `member ${entity.locked_by.slice(0, 8)}`) : "a person";
  const when = entity.locked_at ? ` on ${formatDate(entity.locked_at)}` : "";
  return `Locked by ${who}${when}: agents can only propose changes`;
}

/** Lock as a chip ("Locked"), for the inspector head. */
export function LockBadge({
  entity,
  meId,
  hero = false,
}: {
  entity: Pick<EntityOut, "locked" | "locked_by" | "locked_at">;
  meId?: string | null;
  hero?: boolean;
}) {
  if (!entity.locked) return null;
  return (
    <Chip kind="na" hero={hero} title={lockTitle(entity, meId)}>
      <LockIcon className="h-3.5 w-3.5" />
      Locked
    </Chip>
  );
}

/** Lock as an icon only, for one-line table rows; its name is "Locked". */
export function LockMark({ entity, meId }: { entity: Pick<EntityOut, "locked" | "locked_by" | "locked_at">; meId?: string | null }) {
  if (!entity.locked) return null;
  return (
    <span title={lockTitle(entity, meId)} className="inline-flex flex-none items-center text-text2">
      <LockIcon className="h-4 w-4" />
      <span className="sr-only">Locked</span>
    </span>
  );
}

export const FLAG_LABEL: Record<string, string> = {
  serves_no_goal: "Serves no goal",
  no_evidence: "No evidence",
  low_confidence: "Low confidence",
};

export function FlagBadges({ flags }: { flags: string[] }) {
  return (
    <>
      {flags.map((f) => (
        <Chip key={f} kind={f === "serves_no_goal" ? "crit" : "warn"}>
          <span data-testid="flag">{FLAG_LABEL[f] ?? f}</span>
        </Chip>
      ))}
    </>
  );
}

/** A value from attrs or a claim, as short text. */
export function formatValue(value: unknown): string {
  if (value == null || value === "") return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** "attrs.status" -> "status"; plain fields stay as they are. */
export function fieldLabel(field: string): string {
  return field.startsWith("attrs.") ? field.slice("attrs.".length) : field;
}

export function titleOf(graph: GraphOut | undefined, id: string | null | undefined): string {
  if (!id) return "—";
  return graph?.entities.find((e) => e.id === id)?.title ?? "Unknown item";
}

/** What a conflict or proposal is about: an entity's title, or "A → B" for an edge. */
export function targetTitle(graph: GraphOut | undefined, entityId?: string | null, edgeId?: string | null): string {
  if (entityId) return titleOf(graph, entityId);
  const edge = edgeId ? graph?.edges.find((e) => e.id === edgeId) : undefined;
  if (edge) return `${titleOf(graph, edge.src_id)} → ${titleOf(graph, edge.dst_id)} (${edge.type.replace("_", " ")})`;
  return "—";
}

const byTitle = (a: EntityOut, b: EntityOut) => a.title.localeCompare(b.title);

/** Live goals, heaviest first: the order of the ledger's goal columns and of their G1, G2 tags. */
export function sortedGoals(graph: GraphOut | undefined): EntityOut[] {
  return (graph?.entities ?? [])
    .filter((e) => e.type === "goal" && e.status !== "rejected")
    .sort((a, b) => Number(b.attrs?.weight ?? 0) - Number(a.attrs?.weight ?? 0) || byTitle(a, b));
}

/** Goal id -> "G1", "G2"… in ledger order. */
export function goalTags(graph: GraphOut | undefined): Map<string, string> {
  return new Map(sortedGoals(graph).map((g, i) => [g.id, `G${i + 1}`]));
}

/** Contribution of a supports edge, 0 (none) to 3 (strong). */
export function contributionOf(attrs: Record<string, unknown> | undefined): number {
  const c = Number(attrs?.contribution ?? 0);
  return Number.isFinite(c) ? Math.max(0, Math.min(3, c)) : 0;
}

/** Three small bars, `value` of them filled: a link's contribution 0-3. */
export function ContributionPips({ value, proposed = false }: { value: number; proposed?: boolean }) {
  return (
    <span
      role="img"
      aria-label={`Contribution ${value} of 3${proposed ? ", proposed" : ""}`}
      title={`Contribution ${value}/3${proposed ? " · proposed" : ""}`}
      className="inline-flex items-end gap-[3px] align-middle"
    >
      {[1, 2, 3].map((i) => (
        <span
          key={i}
          className={`block w-[7px] rounded-[2px] ${
            i <= value ? (proposed ? "bg-warn" : "bg-accent") : "bg-surface2 shadow-[inset_0_0_0_1px_var(--line)]"
          }`}
          style={{ height: 8 + i * 4 }}
        />
      ))}
    </span>
  );
}

/**
 * Wraps a KpiStrip so it folds into two columns on a phone instead of truncating
 * its labels (KpiStrip sets its columns inline, hence the important overrides).
 */
export const KPI_PHONE =
  "max-[600px]:[&>dl]:grid-cols-2! max-[600px]:[&>dl>div:nth-child(2n)]:border-r-0 max-[600px]:[&>dl>div:nth-child(n+3)]:border-t";
