import { Chip, type ChipKind } from "@/components/ds";
import type { Schemas } from "@/lib/api/client";

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

export const pct = (v: number) => `${Math.round(v * 100)}%`;

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
              <th className="pb-1.5 text-right font-semibold">Value</th>
              <th className="pb-1.5 text-right font-semibold">Weight</th>
            </tr>
          </thead>
          <tbody>
            {factors.map((f) => (
              <tr key={f.key} className="border-t border-line">
                <td className="py-1 text-text">{f.label}</td>
                <td className="py-1 text-right font-semibold">{f.value.toFixed(2)}</td>
                <td className="py-1 text-right text-text2">{pct(f.share)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
