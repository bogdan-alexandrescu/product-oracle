import { Badge } from "@/components/ui";
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

const FACTOR_LABEL: Record<string, string> = {
  source: "Kind of source",
  freshness: "Freshness",
  mentions: "Independent mentions",
  goal_impact: "Goal impact",
};

function level(c: Confidence): { label: string; tone: "green" | "amber" | "red" } {
  if (c.low) return { label: "Low", tone: "red" };
  if (c.value >= 0.7) return { label: "High", tone: "green" };
  return { label: "Medium", tone: "amber" };
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

/** A confidence badge that opens the weighted factors behind it. */
export function ConfidenceBadge({ confidence }: { confidence: Confidence }) {
  const { label, tone } = level(confidence);
  const factors = Object.entries(confidence.breakdown);
  const total = factors.reduce((sum, [, f]) => sum + f.weight, 0) || 1;
  return (
    <details className="group relative inline-block" data-testid="confidence">
      <summary className="cursor-pointer list-none" aria-label={`Confidence ${label} ${pct(confidence.value)}: show factors`}>
        <Badge tone={tone}>
          {label} confidence · {pct(confidence.value)}
        </Badge>
      </summary>
      <div className="absolute right-0 z-10 mt-1 w-72 rounded-md border border-neutral-200 bg-white p-3 text-xs shadow-lg">
        <table className="w-full" aria-label="Confidence factors">
          <thead className="text-left text-neutral-500">
            <tr>
              <th className="pb-1 font-medium">Factor</th>
              <th className="pb-1 text-right font-medium">Value</th>
              <th className="pb-1 text-right font-medium">Weight</th>
            </tr>
          </thead>
          <tbody>
            {factors.map(([key, f]) => (
              <tr key={key}>
                <td className="py-0.5 text-neutral-700">{FACTOR_LABEL[key] ?? key}</td>
                <td className="py-0.5 text-right tabular-nums">{f.value.toFixed(2)}</td>
                <td className="py-0.5 text-right tabular-nums text-neutral-500">{pct(f.weight / total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-neutral-500">
          Confidence is the weighted mean of these factors; it sets how much this item counts in search ranking and
          outputs.
        </p>
      </div>
    </details>
  );
}
