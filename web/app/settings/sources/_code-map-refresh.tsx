"use client";

import { useId, useState } from "react";

import { InfoTip, Notice, Panel } from "@/components/ds";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage, useQuery } from "@/lib/use-query";

import { Field, SELECT_FIELD } from "../_components/fields";

const KEY = "code_map_refresh";

/** The choices, as oracle.engineering.codemaps.REFRESH_EVERY names them. */
export const REFRESH_CHOICES = [
  { value: "hourly", label: "Hourly" },
  { value: "every_6_hours", label: "Every 6 hours" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "on_demand", label: "Only on demand" },
] as const;

/**
 * Refresh stale code maps (owner, 2026-10-26): how often Oracle's ticker refreshes a code
 * map a merge made stale, daily unless an owner chooses otherwise; "Only on demand" never
 * refreshes on its own. Map the code refreshes at once whatever the choice. Owners only.
 */
export function CodeMapRefreshSetting() {
  const id = useId();
  const q = useQuery(`setting|${KEY}`, () =>
    unwrap(api.GET("/v1/settings/{key}", { params: { path: { key: KEY } } })).then((s) => String(s.value)),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function change(value: string) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const s = await unwrap(api.PUT("/v1/settings/{key}", { params: { path: { key: KEY } }, body: { value } }));
      q.setData(() => String(s.value));
      setSaved(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Code maps">
      <div className="flex flex-col gap-2 px-4 py-3">
        <Field
          label="Refresh stale code maps"
          htmlFor={id}
          tip={
            // Pass F F-36: the cost behind an (i), not a sentence on the page.
            <InfoTip label="what a refresh costs" align="start">
              <span data-testid="code-map-refresh-cost">Each refresh costs like Map the code. Less often costs less; only on demand costs nothing.</span>
            </InfoTip>
          }
        >
          <select
            id={id}
            className={`${SELECT_FIELD} sm:max-w-[260px]`}
            disabled={busy || !q.data}
            value={q.data ?? "daily"}
            onChange={(e) => void change(e.target.value)}
          >
            {REFRESH_CHOICES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
        {saved && (
          <p role="status" className="text-sm text-text2">
            Saved
          </p>
        )}
        {q.error && <Notice tone="error">{q.error}</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Panel>
  );
}
