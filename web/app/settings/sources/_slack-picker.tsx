"use client";

import { useId } from "react";

import { Icon } from "@/components/ds";
import { api, unwrap } from "@/lib/api/client";
import { useCompanyZone } from "@/lib/dates";
import { zoneName } from "@/lib/format";
import { useQuery } from "@/lib/use-query";

import { INPUT } from "../_components/fields";
import { BrowseList, labelsOf, listOf, type BrowsePage, type PickerProps } from "./_browse-list";

const LABEL = "text-[13px] leading-4 font-semibold tracking-[0.02em] text-text2";

/** As oracle.sources.connectors.slack MAX_CHANNELS: a source allowlists at most this many. */
export const MAX_CHANNELS = 100;

/**
 * Slack source picker (S5): public channels and the private ones you are in, never DMs;
 * writes `{channels, since, until, timezone, labels}` (days in the Company time zone, which
 * `timezone` names (#401); the same range shape as Fireflies;
 * `labels` names each picked channel, "#product", for the source's row). Only
 * messages from `since` through `until` are read; nothing posted after `until` is, thread
 * replies included (S5, owner 2026-10-20). Narrowing the range removes what falls outside
 * it when the source is saved (S5, owner 2026-10-20: narrowing takes effect on save).
 */
export function SlackPicker({ connectionId, config, onChange }: PickerProps) {
  const sinceId = useId();
  const untilId = useId();
  const hintId = useId();
  const zone = useCompanyZone();
  const since = typeof config.since === "string" ? config.since : "";
  const until = typeof config.until === "string" ? config.until : "";
  const backwards = since !== "" && until !== "" && until < since;
  const over = listOf(config, "channels").length - MAX_CHANNELS;

  async function load(search: string, cursor: string | null): Promise<BrowsePage> {
    const page = await unwrap(
      api.GET("/v1/connections/{connection_id}/slack/channels", {
        params: { path: { connection_id: connectionId! }, query: { search, ...(cursor ? { cursor } : {}) } },
      }),
    );
    return {
      next: page.next_cursor,
      items: page.channels.map((c) => ({
        id: c.id,
        label: `#${c.name}`,
        isPrivate: c.is_private,
        hint: c.topic,
        meta:
          c.num_members == null ? null : (
            <span title={`${c.num_members} members`} className="flex items-center gap-1">
              <Icon name="user" size={16} />
              {c.num_members}
            </span>
          ),
      })),
    };
  }

  return (
    <BrowseList
      label="Slack channels"
      searchLabel="Search channels"
      pasteLabel="Channel ids"
      pasteExample="C0123PRODUCT"
      connectionId={connectionId}
      picked={listOf(config, "channels")}
      onPicked={(channels) => onChange({ ...config, channels })}
      labels={labelsOf(config)}
      onLabels={(labels) => onChange({ ...config, labels })}
      load={load}
      extra={
        <div className="flex min-w-0 flex-col gap-1.5">
          {over > 0 && (
            <p role="alert" data-testid="too-many-channels" className="text-sm font-medium text-crit">
              A source takes at most {MAX_CHANNELS} channels: untick {over} to save it.
            </p>
          )}
          <div className="grid max-w-96 grid-cols-2 gap-2.5">
            <span className="flex min-w-0 flex-col gap-1.5">
              <label htmlFor={sinceId} className={LABEL}>
                Since
              </label>
              <input
                id={sinceId}
                type="date"
                value={since}
                max={until || undefined}
                aria-describedby={hintId}
                onChange={(e) => onChange({ ...config, since: e.target.value || undefined, timezone: zone })}
                className={INPUT}
              />
            </span>
            <span className="flex min-w-0 flex-col gap-1.5">
              <label htmlFor={untilId} className={LABEL}>
                Until
              </label>
              <input
                id={untilId}
                type="date"
                value={until}
                min={since || undefined}
                aria-invalid={backwards || undefined}
                aria-describedby={hintId}
                onChange={(e) => onChange({ ...config, until: e.target.value || undefined, timezone: zone })}
                className={`${INPUT} aria-invalid:border-crit`}
              />
            </span>
          </div>
          {backwards ? (
            <p id={hintId} role="alert" className="text-sm font-medium text-crit">
              Until must be on or after Since.
            </p>
          ) : (
            <p id={hintId} className="text-[13px] leading-5 text-text2">
              Optional, whole days in the Company time zone ({zoneName(zone)}). Nothing posted after Until is read, thread replies included. Narrowing the
              range removes messages outside it when you save.
            </p>
          )}
        </div>
      }
    />
  );
}

/** Pages of the channel list read to name a source's unnamed channels. */
const NAME_PAGES = 5;

/**
 * Names of a Slack source's channels for its row, "#product": the names the source saved
 * (`labels`), and for a channel saved before names were kept, the name in the channel list of
 * its connection (read only when one is missing). A channel not found there reads "Channel <id>".
 */
export function useSlackChannelNames(connectionId: string | null, ids: string[], saved: Record<string, string>): (id: string) => string {
  const missing = connectionId ? ids.filter((id) => !saved[id]) : [];
  const q = useQuery(missing.length ? `slack-channel-names|${connectionId}|${missing.join(",")}` : "slack-channel-names|none", async () => {
    const found: Record<string, string> = {};
    if (!missing.length) return found;
    let cursor: string | null = null;
    for (let i = 0; i < NAME_PAGES; i++) {
      const page: { channels: { id: string; name: string }[]; next_cursor?: string | null } = await unwrap(
        api.GET("/v1/connections/{connection_id}/slack/channels", {
          params: { path: { connection_id: connectionId! }, query: { search: "", ...(cursor ? { cursor } : {}) } },
        }),
      );
      for (const c of page.channels) found[c.id] = `#${c.name}`;
      cursor = page.next_cursor ?? null;
      if (!cursor || missing.every((id) => found[id])) break;
    }
    return found;
  });
  return (id) => saved[id] ?? q.data?.[id] ?? (q.loading && missing.includes(id) ? "…" : `Channel ${id}`);
}
