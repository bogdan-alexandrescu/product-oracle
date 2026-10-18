import type { ReactNode } from "react";

import { Badge, LockIcon } from "@/components/ui";
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

export function ConfidenceBadge({ value, low = DEFAULT_LOW }: { value: number | null | undefined; low?: number }) {
  if (value == null) {
    return (
      <Badge title="Not scored yet">
        <span data-testid="confidence">no score</span>
      </Badge>
    );
  }
  return (
    <Badge tone={confidenceTone(value, low)} title="Confidence">
      <span data-testid="confidence" data-tone={confidenceTone(value, low)}>
        {value.toFixed(2)}
      </span>
    </Badge>
  );
}

export const NODE_STATUS_LABEL: Record<NodeStatus, string> = {
  proposed: "Proposed",
  confirmed: "Confirmed",
  rejected: "Rejected",
};

export function NodeStatusBadge({ status }: { status: NodeStatus }) {
  return (
    <Badge tone={status === "confirmed" ? "green" : status === "rejected" ? "red" : "blue"}>
      {NODE_STATUS_LABEL[status]}
    </Badge>
  );
}

export function LockBadge({ entity, meId }: { entity: Pick<EntityOut, "locked" | "locked_by" | "locked_at">; meId?: string | null }) {
  if (!entity.locked) return null;
  const who = entity.locked_by ? (entity.locked_by === meId ? "you" : `member ${entity.locked_by.slice(0, 8)}`) : "a person";
  const when = entity.locked_at ? ` on ${formatDate(entity.locked_at)}` : "";
  return (
    <Badge title={`Locked by ${who}${when}: agents can only propose changes`}>
      <LockIcon className="h-3 w-3" />
      Locked
    </Badge>
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
        <Badge key={f} tone={f === "serves_no_goal" ? "red" : "amber"}>
          <span data-testid="flag">{FLAG_LABEL[f] ?? f}</span>
        </Badge>
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

export function Panel({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
      <header className="flex items-center justify-between border-b border-neutral-200 bg-neutral-50 px-4 py-2">
        <h2 className="text-sm font-semibold text-neutral-800">{title}</h2>
        {actions}
      </header>
      {children}
    </section>
  );
}
