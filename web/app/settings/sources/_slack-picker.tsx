"use client";

import { useId } from "react";

import { Icon } from "@/components/ds";
import { api, unwrap } from "@/lib/api/client";

import { INPUT } from "../_components/fields";
import { BrowseList, listOf, type BrowsePage, type PickerProps } from "./_browse-list";

/**
 * Slack source picker (S5): public channels and the private ones you are in, never DMs;
 * writes `{channels, since}`. `since` (a day) keeps older messages out.
 */
export function SlackPicker({ connectionId, config, onChange }: PickerProps) {
  const sinceId = useId();
  const since = typeof config.since === "string" ? config.since : "";

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
      load={load}
      extra={
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={sinceId} className="text-[13px] leading-4 font-semibold tracking-[0.02em] text-text2">
            Since
          </label>
          <input
            id={sinceId}
            type="date"
            value={since}
            onChange={(e) => onChange({ ...config, since: e.target.value || undefined })}
            className={`${INPUT} w-44 max-[600px]:flex-1`}
          />
        </div>
      }
    />
  );
}
