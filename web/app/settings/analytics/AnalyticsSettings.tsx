"use client";

import { useState } from "react";

import { Button, confirmInPage, PageHeader, Panel } from "@/components/ds";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useCompanyZone, zoneDateTime } from "@/lib/dates";
import { plural } from "@/lib/format";
import { errorMessage, useQuery } from "@/lib/use-query";

import { Field, INPUT, SELECT_FIELD } from "../_components/fields";

type Analytics = Schemas["AnalyticsOut"];

const CLOUD: Record<string, string> = { us: "US cloud", eu: "EU cloud" };

/** "Connected to PostHog · project 12345 · EU cloud", or "Not connected". */
export function connectionText(a: Analytics): string {
  if (a.status === "disconnected" || !a.project_id) return "Not connected";
  const host = a.host ? (CLOUD[a.host] ?? a.host) : "";
  return `Connected to PostHog · project ${a.project_id}${host ? ` · ${host}` : ""}`;
}

/**
 * Settings › Analytics (H5, owners): the company's PostHog query connection the weekly
 * metrics are read from. Save tests the key first; the key is write-only (never shown, the
 * field is always empty). Disconnect deletes the key and pauses the PostHog metrics.
 */
export function AnalyticsSettings() {
  const zone = useCompanyZone();
  const q = useQuery("analytics-integration", () => unwrap(api.GET("/v1/company-integrations/analytics")));
  const a = q.data;
  const [host, setHost] = useState<string | null>(null);
  const [ownHost, setOwnHost] = useState<string | null>(null);
  const [project, setProject] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (q.error) return <ErrorNote>{q.error}</ErrorNote>;
  if (!a) return <Loading />;
  const connected = a.status !== "disconnected";
  const storedHost = a.host ?? "eu";
  const hostChoice = host ?? (storedHost in CLOUD ? storedHost : "own");
  const ownValue = ownHost ?? (storedHost in CLOUD ? "" : storedHost);
  const projectValue = project ?? a.project_id ?? "";

  async function run(call: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await call();
      setKey("");
      setHost(null);
      setOwnHost(null);
      setProject(null);
      await q.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    run(() =>
      unwrap(
        api.PUT("/v1/company-integrations/analytics", {
          body: { provider: "posthog", host: hostChoice === "own" ? ownValue.trim() : hostChoice, project_id: projectValue.trim(), api_key: key.trim() },
        }),
      ),
    );
  const disconnect = async () => {
    const n = a.metrics;
    const ok = await confirmInPage({
      action: "Disconnect",
      message: `Disconnect PostHog? The key is deleted and ${plural(n, "PostHog metric pauses", "PostHog metrics pause")} until it is connected again. Their values stay.`,
      destructive: true,
    });
    if (ok) await run(() => unwrap(api.DELETE("/v1/company-integrations/analytics")));
  };

  return (
    <>
      <PageHeader title="Analytics" />
      <Panel title="PostHog" testId="analytics-posthog">
        <div className="flex max-w-xl flex-col gap-3 px-4 py-3">
          <p className="text-[15px] font-semibold" data-testid="analytics-state">
            {connectionText(a)}
          </p>
          {connected && (
            <p className="text-sm text-text2">
              {[a.connected_by_name && `Connected by ${a.connected_by_name}`, a.connected_at && zoneDateTime(a.connected_at, zone)].filter(Boolean).join(", ")}
              {` · ${plural(a.metrics, "PostHog metric")}`}
            </p>
          )}
          {a.last_error && <ErrorNote>{a.last_error}</ErrorNote>}
          <p className="text-sm text-text2">
            Oracle reads each metric&apos;s weekly value with a query in your PostHog project. Use a personal API key that may only read queries.
          </p>
          {/* Field: the label is bold, the value regular, as in every other settings form. */}
          <Field label="Host">
            <select className={SELECT_FIELD} value={hostChoice} onChange={(e) => setHost(e.target.value)}>
              <option value="us">US cloud</option>
              <option value="eu">EU cloud</option>
              <option value="own">Own host</option>
            </select>
          </Field>
          {hostChoice === "own" && (
            <Field label="Own host address">
              <input className={INPUT} value={ownValue} placeholder="https://posthog.example.com" onChange={(e) => setOwnHost(e.target.value)} />
            </Field>
          )}
          <Field label="Project ID">
            <input className={INPUT} value={projectValue} inputMode="numeric" onChange={(e) => setProject(e.target.value)} />
          </Field>
          <Field label="Personal API key">
            <input
              className={INPUT}
              type="password"
              autoComplete="off"
              value={key}
              placeholder={connected ? "Replace key" : ""}
              onChange={(e) => setKey(e.target.value)}
            />
          </Field>
          {error && <ErrorNote>{error}</ErrorNote>}
          <div className="flex flex-wrap gap-2">
            <Button variant="solid" disabled={busy || !key.trim() || !projectValue.trim()} onClick={save}>
              Save
            </Button>
            {connected && (
              <Button disabled={busy} onClick={disconnect}>
                Disconnect
              </Button>
            )}
          </div>
        </div>
      </Panel>
    </>
  );
}
