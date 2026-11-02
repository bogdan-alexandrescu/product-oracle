import Link from "next/link";

import type { Schemas } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";

/** walkc-roadmap-tasks: who took a decision, when, and (taken in a meeting) a link to its minutes. */
export function DecidedWho({ d }: { d: Schemas["SimpleDecidedRef"] }) {
  if (!d.decided_by && !d.decided_at && !d.minutes_url) return null;
  return (
    <span className="block text-[13px] text-text2" data-testid="decided-who">
      {d.decided_by ? `Decided by ${d.decided_by.name}` : "Decided"}
      {d.decided_at ? ` · ${formatDateTime(d.decided_at)}` : ""}
      {d.minutes_url && (
        <>
          {" · "}
          <Link href={d.minutes_url} className="text-accent-ink hover:underline" data-testid="decided-minutes">
            Minutes{d.meeting ? ` of ${d.meeting.title}` : ""}
          </Link>
        </>
      )}
    </span>
  );
}
