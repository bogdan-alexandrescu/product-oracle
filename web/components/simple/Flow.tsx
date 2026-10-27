import type { Schemas } from "@/lib/api/client";

/**
 * A proposal's or a draft's flow (S10 draws the flows): the thumbnail (up to four steps as
 * boxes) and the widened view, the user flow beside a wireframe of the screen it touches.
 */
export function FlowThumb({ flow }: { flow: Schemas["SimpleFlow"] }) {
  return (
    <svg width="64" height="40" viewBox="0 0 64 40" aria-hidden className="text-text2">
      {flow.steps.slice(0, 4).map((_, i) => (
        <g key={i}>
          <rect x={2 + i * 16} y={12} width={11} height={16} rx={2} fill="none" stroke="currentColor" />
          {i > 0 && <line x1={i * 16 - 3} y1={20} x2={i * 16 + 2} y2={20} stroke="currentColor" />}
        </g>
      ))}
    </svg>
  );
}

export function FlowDetail({ flow }: { flow: Schemas["SimpleFlow"] }) {
  return (
    <div className="mt-3 grid gap-4 sm:grid-cols-2" data-testid="flow-detail">
      <div>
        <h3 className="font-semibold">User flow: {flow.title}</h3>
        <ol className="mt-1 list-decimal pl-5">
          {flow.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      </div>
      <div aria-label={`Wireframe of ${flow.screen.title}`} role="img">
        <h3 className="font-semibold">Screen: {flow.screen.title}</h3>
        <div className="mt-1 flex flex-col gap-1 rounded-lg border border-line-strong bg-surface p-2">
          {flow.screen.regions.map((r) => (
            <div key={r} className="rounded border border-dashed border-line-strong px-2 py-1 text-[length:var(--simple-small)] text-text2">
              {r}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
