import { Chip, type ChipKind } from "@/components/ds";
import type { Schemas } from "@/lib/api/client";
import { formatPercent } from "@/lib/format";

type Confidence = Schemas["ConfidenceOut"];
type Kind = Schemas["SourceOut"]["kind"];

export const KIND_LABEL: Record<Kind, string> = {
  upload: "Uploads",
  github: "GitHub",
  slack: "Slack",
  notion: "Notion",
  fireflies: "Fireflies",
  google_docs: "Google Docs",
};

/** An item's kind in words, one ("Pull request") and many ("Pull requests"). */
const ITEM_KIND: Record<string, [one: string, many: string]> = {
  file: ["File", "Files"],
  page: ["Page", "Pages"],
  doc: ["Doc", "Docs"],
  message: ["Message", "Messages"],
  thread: ["Thread", "Threads"],
  transcript: ["Transcript", "Transcripts"],
  issue: ["Issue", "Issues"],
  pull_request: ["Pull request", "Pull requests"],
  release: ["Release", "Releases"],
  milestone: ["Milestone", "Milestones"],
  readme: ["README", "READMEs"],
};

/** The item kinds a search can filter on, in the filter's order. */
export const ITEM_KINDS = Object.keys(ITEM_KIND);

const kindWords = (k: string) => {
  const words = k.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** One item's kind: "Message", "Pull request". */
export const itemKind = (k: string) => ITEM_KIND[k]?.[0] ?? kindWords(k);

/** Items of a kind: "Messages", "Pull requests". */
export const itemKinds = (k: string) => ITEM_KIND[k]?.[1] ?? `${kindWords(k)}s`;

export const FACTOR_LABEL: Record<string, string> = {
  source: "Kind of source",
  freshness: "Freshness",
  mentions: "Independent mentions",
  goal_impact: "Goal impact",
};

export function confidenceLevel(c: Confidence): { label: string; kind: ChipKind } {
  if (c.low) return { label: "Low", kind: "crit" };
  if (c.value >= 0.7) return { label: "High", kind: "pass" };
  return { label: "Medium", kind: "warn" };
}

export const pct = formatPercent;

/** A 0..1 factor in words (qa-work-33): High, Medium or Low, never a raw score. */
export function factorLevel(v: number): string {
  if (v >= 0.7) return "High";
  if (v >= 0.4) return "Medium";
  return "Low";
}

/**
 * How well a hit's words match, in words, against the best match of the same search
 * (text relevance has no fixed scale, so it reads only next to the other hits).
 */
export function matchLevel(relevance: number, best: number): string {
  if (!best || relevance >= best * 0.67) return "Strong";
  if (relevance >= best * 0.34) return "Fair";
  return "Weak";
}

/** The factors behind a confidence value with their share of the weight. */
export function confidenceFactors(c: Confidence) {
  const factors = Object.entries(c.breakdown);
  const total = factors.reduce((sum, [, f]) => sum + f.weight, 0) || 1;
  return factors.map(([key, f]) => ({ key, label: FACTOR_LABEL[key] ?? key, value: f.value, share: f.weight / total }));
}

/** A confidence chip that opens the weighted factors behind it. */
export function ConfidenceBadge({ confidence }: { confidence: Confidence }) {
  const { label, kind } = confidenceLevel(confidence);
  const factors = confidenceFactors(confidence);
  return (
    <details className="group relative inline-block" data-testid="confidence">
      <summary
        className="cursor-pointer list-none rounded-full [&::-webkit-details-marker]:hidden"
        aria-label={`Confidence ${label} ${pct(confidence.value)}: show factors`}
      >
        <Chip kind={kind} dot>
          {label} confidence · {pct(confidence.value)}
        </Chip>
      </summary>
      <div className="absolute right-0 z-20 mt-1.5 w-72 rounded-button border border-line bg-surface p-3 text-sm shadow-tip">
        <table className="tnum w-full" aria-label="Confidence factors">
          <thead className="text-left text-[13px] text-text2">
            <tr>
              <th className="pb-1.5 font-semibold">Factor</th>
              <th className="pb-1.5 text-right font-semibold">Level</th>
              <th className="pb-1.5 text-right font-semibold">Counts for</th>
            </tr>
          </thead>
          <tbody>
            {factors.map((f) => (
              <tr key={f.key} className="border-t border-line">
                <td className="py-1 text-text">{f.label}</td>
                <td className="py-1 text-right font-semibold">{factorLevel(f.value)}</td>
                <td className="py-1 text-right text-text2">{pct(f.share)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
