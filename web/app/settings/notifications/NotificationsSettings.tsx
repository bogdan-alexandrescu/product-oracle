"use client";

/**
 * Settings › Notifications (F6): Oracle's own Slack app, installed once for the company by an
 * owner, the channel the weekly alignment report posts to, a test message, Disconnect (which
 * revokes the token at Slack, and ends every discussion's Slack mirror, G8), and the report's
 * schedule. No credential is ever shown.
 */
import { useSearchParams } from "next/navigation";
import { useState } from "react";

import { Button, confirmInPage, Notice, PageHeader, Panel } from "@/components/ds";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { hasRole, useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

import { Field, INPUT, SELECT_FIELD } from "../_components/fields";

type ReportSetting = {
  enabled: boolean;
  weekday: string;
  time: string;
  timezone: string;
  slack_channel: { id: string; name: string } | null;
};

const KEY = { params: { path: { key: "alignment_report" } } };
const WEEKDAYS: [string, string][] = [
  ["mon", "Monday"],
  ["tue", "Tuesday"],
  ["wed", "Wednesday"],
  ["thu", "Thursday"],
  ["fri", "Friday"],
  ["sat", "Saturday"],
  ["sun", "Sunday"],
];
const ZONES = ["America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York", "Europe/London", "Europe/Berlin", "Asia/Tokyo", "Australia/Sydney", "UTC"];

const loadSetting = () => unwrap(api.GET("/v1/settings/{key}", KEY)).then((s) => s.value as ReportSetting);
const saveSetting = (value: ReportSetting) => unwrap(api.PUT("/v1/settings/{key}", { ...KEY, body: { value } })).then((s) => s.value as ReportSetting);

export function NotificationsSettings() {
  const { role, loading } = useMe();
  const owner = hasRole(role, "owner");
  return (
    <>
      <PageHeader title="Notifications" />
      {loading && !role ? (
        <Loading />
      ) : !owner ? (
        <Notice>Owners manage notifications: Oracle&apos;s Slack app and the weekly alignment report.</Notice>
      ) : (
        <OwnerSettings />
      )}
    </>
  );
}

function OwnerSettings() {
  const params = useSearchParams();
  const integrations = useQuery("company-integrations", () => unwrap(api.GET("/v1/company-integrations")));
  // G8: whether discussions can be mirrored with this install (or it needs a reconnect).
  const status = useQuery("slack-status", () => unwrap(api.GET("/v1/company-integrations/slack/status")));
  const setting = useQuery("settings|alignment_report", loadSetting);
  const slack = integrations.data?.find((i) => i.provider === "slack" && i.purpose === "notifications") ?? null;
  const connected = params.get("connected") === "slack";
  const returned = params.get("error");
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {connected && slack && <Notice tone="pass">Slack is connected for notifications.</Notice>}
      {returned && <Notice tone="error">{returned}</Notice>}
      {(integrations.error || setting.error) && <ErrorNote>{integrations.error ?? setting.error}</ErrorNote>}
      {(integrations.loading || setting.loading) && !(integrations.data && setting.data) && <Loading />}
      {integrations.data && setting.data && (
        <>
          <SlackPanel
            key={slack?.id ?? "none"}
            slack={slack}
            status={status.data ?? null}
            setting={setting.data}
            onSetting={(v) => setting.setData(() => v)}
            onChange={async () => {
              await Promise.all([integrations.reload(), setting.reload(), status.reload()]);
            }}
          />
          <SchedulePanel setting={setting.data} onSaved={(v) => setting.setData(() => v)} />
        </>
      )}
    </div>
  );
}

type Slack = Schemas["CompanyIntegrationOut"];

function SlackPanel({
  slack,
  status,
  setting,
  onSetting,
  onChange,
}: {
  slack: Slack | null;
  status: Schemas["SlackStatusOut"] | null;
  setting: ReportSetting;
  onSetting: (v: ReportSetting) => void;
  onChange: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [channel, setChannel] = useState(setting.slack_channel?.id ?? "");
  const [sent, setSent] = useState(false);
  const channels = useQuery(`slack-channels|${slack?.id ?? "none"}`, () =>
    slack ? unwrap(api.GET("/v1/company-integrations/slack/channels")) : Promise.resolve([]),
  );

  async function act(key: string, call: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await call();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const connect = () =>
    act("connect", async () => {
      const { url } = await unwrap(api.GET("/v1/company-integrations/slack/install"));
      window.location.assign(url);
    });
  const saveChannel = () =>
    act("channel", async () => {
      const picked = (channels.data ?? []).find((c) => c.id === channel);
      onSetting(await saveSetting({ ...setting, slack_channel: picked ? { id: picked.id, name: picked.name } : null }));
    });
  const test = () =>
    act("test", async () => {
      setSent(false);
      await unwrap(api.POST("/v1/company-integrations/slack/test", { body: { channel_id: channel } }));
      setSent(true);
    });
  const disconnect = async () => {
    if (!slack) return;
    const ok = await confirmInPage({
      destructive: true,
      action: "Disconnect",
      message:
        "Disconnect revokes Oracle's Slack token at Slack and deletes it. The weekly report stops posting to Slack until an owner connects it again. Every mirrored discussion thread gets a closing line and stops mirroring. People's own Slack connections are not touched.",
    });
    if (!ok) return;
    await act("disconnect", async () => {
      await unwrap(api.DELETE("/v1/company-integrations/{integration_id}", { params: { path: { integration_id: slack.id } } }));
      setSent(false);
      await onChange();
    });
  };

  return (
    <Panel title="Slack" testId="slack-notifications">
      <div className="space-y-3 px-4 py-3 text-[15px] max-[600px]:px-3">
        {!slack ? (
          <>
            <p className="text-text2">
              Oracle&apos;s Slack app posts the weekly alignment report to a channel you pick, and people can mirror discussions to a Slack
              thread. It is installed once for the company and posts as Product Oracle.
            </p>
            <Button variant="solid" disabled={busy !== null} onClick={connect}>
              Connect Oracle to Slack
            </Button>
          </>
        ) : (
          <>
            <p data-testid="slack-connected">
              Connected to <b>{status?.label ?? slack.account_label ?? slack.account_id}</b> as @Product Oracle
            </p>
            {status?.needs_reconnect ? (
              <Notice
                tone="warn"
                testId="slack-reconnect"
                action={
                  <Button disabled={busy !== null} onClick={connect}>
                    Reconnect Slack
                  </Button>
                }
              >
                Reconnect Slack to allow mirroring discussions
              </Notice>
            ) : (
              status?.mirroring && <p className="text-sm text-text2">People can mirror discussions to a Slack thread.</p>
            )}
            {channels.error && <ErrorNote>{channels.error}</ErrorNote>}
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Channel" className="w-72 max-w-full">
                <select className={SELECT_FIELD} value={channel} onChange={(e) => setChannel(e.target.value)} disabled={!channels.data}>
                  <option value="">No channel</option>
                  {(channels.data ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      #{c.name}
                      {c.is_private ? " (private)" : ""}
                    </option>
                  ))}
                </select>
              </Field>
              <Button disabled={busy !== null || channel === (setting.slack_channel?.id ?? "")} onClick={saveChannel}>
                Save channel
              </Button>
              <Button disabled={busy !== null || !channel} onClick={test}>
                Send test message
              </Button>
              {sent && (
                <span role="status" className="text-sm font-semibold text-pass">
                  Sent
                </span>
              )}
            </div>
            <p className="text-sm text-text2">
              {setting.slack_channel ? `Reports post to #${setting.slack_channel.name}.` : "Pick a channel: until then reports are not posted."}
            </p>
            <Button variant="danger" disabled={busy !== null} onClick={disconnect}>
              Disconnect
            </Button>
          </>
        )}
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Panel>
  );
}

function SchedulePanel({ setting, onSaved }: { setting: ReportSetting; onSaved: (v: ReportSetting) => void }) {
  const [draft, setDraft] = useState(setting);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const zones = ZONES.includes(draft.timezone) ? ZONES : [draft.timezone, ...ZONES];

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      onSaved(await saveSetting({ ...setting, enabled: draft.enabled, weekday: draft.weekday, time: draft.time, timezone: draft.timezone }));
      setSaved(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Weekly alignment report" testId="report-schedule">
      <div className="space-y-3 px-4 py-3 text-[15px] max-[600px]:px-3">
        <p className="text-text2">
          Every week Oracle reports the roadmap against engineering for the week that ended: in owners&apos; Inbox and in the Slack channel.
        </p>
        <label className="flex items-center gap-2 font-medium">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
            className="size-4 accent-[var(--accent)]"
          />
          Make the weekly report
        </label>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Day" className="w-40 max-w-full">
            <select className={SELECT_FIELD} value={draft.weekday} onChange={(e) => setDraft({ ...draft, weekday: e.target.value })}>
              {WEEKDAYS.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Time" className="w-32 max-w-full">
            <input type="time" className={INPUT} value={draft.time} onChange={(e) => setDraft({ ...draft, time: e.target.value })} />
          </Field>
          <Field label="Time zone" className="w-64 max-w-full">
            <select className={SELECT_FIELD} value={draft.timezone} onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </Field>
          <Button variant="solid" disabled={busy} onClick={save}>
            Save schedule
          </Button>
          {saved && (
            <span role="status" className="text-sm font-semibold text-pass">
              Saved
            </span>
          )}
        </div>
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Panel>
  );
}
