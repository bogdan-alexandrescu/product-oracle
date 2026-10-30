"use client";

import { useState } from "react";

import { toast } from "@/components/ds/Toast";
import { api, unwrap, type Schemas } from "@/lib/api/client";

type Delivery = Schemas["SimpleDelivery"];
type Ref = Schemas["SimplePersonRef"];

/** "Ana's", "Ana's and Ben's", "Ana's, Ben's and Cy's": by first name. */
function whose(people: Ref[]): string {
  const names = people.map((p) => `${p.name.split(" ")[0]}'s`);
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const attendees = (n: number) => `${n} ${n === 1 ? "attendee" : "attendees"}`;

/**
 * dod-delivery: the minutes' email in plain words: "Emailed 4 of 5 attendees; Ana's didn't
 * go through", "Emailed all 5 attendees", "Emailing 5 attendees…". `retry` is true when it
 * failed (Retry requeues it).
 */
export function emailWords(d: Delivery): { text: string; retry: boolean } {
  const all = d.emails;
  const sent = all.filter((e) => e.status === "sent").length;
  const failed = all.filter((e) => e.status === "failed").map((e) => e.person);
  const again = all.filter((e) => e.status !== "sent" && e.status !== "failed").map((e) => e.person);
  if (d.email_status === "unavailable") return { text: "No email went: email isn't set up", retry: false };
  if (!all.length) return { text: d.email_status === "sent" ? "Emailed the attendees" : "Emailing the attendees…", retry: false };
  if (d.email_status === "failed") {
    return { text: sent ? `Emailed ${sent} of ${all.length} attendees; ${whose(failed)} didn't go through` : "Couldn't email the attendees", retry: true };
  }
  if (d.email_status === "sent") return { text: all.length === 1 ? "Emailed the 1 attendee" : `Emailed all ${attendees(all.length)}`, retry: false };
  if (!sent && d.email_status === "queued") return { text: `Emailing ${attendees(all.length)}…`, retry: false };
  return { text: `Emailed ${sent} of ${all.length} attendees; trying ${whose(again)} again`, retry: false };
}

/** dod-delivery: the Slack post: "Posted to #product", "Couldn't post to Slack". */
export function slackWords(d: Delivery): { text: string; retry: boolean } {
  const channel = d.slack_channel ?? "Slack";
  switch (d.slack_status) {
    case "sent":
      return { text: `Posted to ${channel}`, retry: false };
    case "failed":
      return { text: "Couldn't post to Slack", retry: true };
    case "retrying":
      return { text: `Couldn't post to ${channel} yet; trying again`, retry: false };
    default:
      return { text: `Posting to ${channel}…`, retry: false };
  }
}

/**
 * One delivery line with its Retry (whoever ended the meeting or an owner: the API's
 * can.retry_delivery or can_retry_delivery); others read who may retry.
 */
export function DeliveryLine({ meetingId, what, words, canRetry, reload, testId }: {
  meetingId: string;
  what: "email" | "slack";
  words: { text: string; retry: boolean };
  canRetry: boolean;
  reload: () => Promise<unknown>;
  testId: string;
}) {
  const [busy, setBusy] = useState(false);
  const retry = async () => {
    setBusy(true);
    try {
      await unwrap(api.POST("/v1/simple/meetings/{meeting_id}/delivery/retry", { params: { path: { meeting_id: meetingId } }, body: { what } }));
      await reload();
    } catch {
      toast({ message: what === "email" ? "Couldn't retry the email. Try again in a moment." : "Couldn't retry the Slack post. Try again in a moment." });
    } finally {
      setBusy(false);
    }
  };
  return (
    <span data-testid={testId}>
      {words.text}
      {words.retry && (canRetry ? (
        <>
          {" · "}
          <button type="button" className="font-semibold text-accent-ink hover:underline disabled:opacity-60 max-[600px]:min-h-11" disabled={busy} onClick={() => void retry()}>
            Retry
          </button>
        </>
      ) : (
        <span className="simple-small"> · whoever ended the meeting or an owner can retry</span>
      ))}
    </span>
  );
}
