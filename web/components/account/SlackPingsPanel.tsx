"use client";

import Link from "next/link";
import { useState } from "react";

import { Notice, Panel } from "@/components/ds";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

type Pings = Schemas["SlackPings"];
type Ping = keyof Pings;

/** The pings a member chooses (oracle.slack.pings): review requested and draft ready on by default, the rest off. */
export const PINGS: { key: Ping; label: string; detail: string }[] = [
  {
    key: "review_requested",
    label: "A review or decision is asked of me",
    detail: "A section to review, a re-review, a change to an approved section, a decision or a question asked of you.",
  },
  { key: "draft_ready", label: "A draft is ready for my review", detail: "A new draft of a document you review." },
  { key: "comments", label: "Comments and replies", detail: "New comments and replies on sections you own or review." },
  { key: "feedback_wanted", label: "Feedback is wanted", detail: "A call for feedback on a version that includes you." },
  { key: "published", label: "A document is published", detail: "A version you approved or own sections of is published." },
];

/** My account › Slack pings: which pings Oracle's Slack app sends this member. */
export function SlackPingsPanel() {
  const prefs = useQuery("my-preferences", () => unwrap(api.GET("/v1/me/preferences")));
  const slack = useQuery("slack-status", () => unwrap(api.GET("/v1/company-integrations/slack/status")));
  const { can } = useMe();
  // qa4-settings-19: whoever may open Settings › Notifications gets a link to it there.
  const canConnect = can("list_company_integrations");
  const [saving, setSaving] = useState<Ping | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pings = prefs.data?.slack_pings;

  async function toggle(key: Ping, on: boolean) {
    setSaving(key);
    setError(null);
    try {
      const saved = await unwrap(api.PATCH("/v1/me/preferences", { body: { slack_pings: { [key]: on } } }));
      prefs.setData(() => saved);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(null);
    }
  }

  return (
    <Panel title="Slack pings" testId="slack-pings">
      <div className="space-y-3 px-4 py-3 text-[15px] max-[600px]:px-3">
        <p className="text-text2">
          Oracle&apos;s Slack app sends you a direct message for what you choose here. If Oracle can&apos;t find you in Slack, it names you in
          the notifications channel instead, without the titles of approvers-only items.
        </p>
        {slack.data && !slack.data.connected && (
          <Notice testId="slack-pings-off">
            {canConnect ? (
              <>
                Slack is not connected yet: connect it in{" "}
                <Link href="/settings/notifications" className="font-medium text-accent-ink underline">
                  Settings › Notifications
                </Link>
                . Your choices apply once it is.
              </>
            ) : (
              "Slack is not connected yet: an owner connects it in Settings › Notifications. Your choices apply once it is."
            )}
          </Notice>
        )}
        {(prefs.error || error) && <Notice tone="error">{error ?? prefs.error}</Notice>}
        {pings && (
          <ul className="space-y-2">
            {PINGS.map((p) => (
              <li key={p.key}>
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={pings[p.key]}
                    disabled={saving !== null}
                    onChange={(e) => void toggle(p.key, e.target.checked)}
                    className="mt-1 size-4 accent-[var(--accent)]"
                    data-testid={`ping-${p.key}`}
                  />
                  <span>
                    <span className="font-medium">{p.label}</span>
                    <span className="block text-sm text-text2">{p.detail}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}
