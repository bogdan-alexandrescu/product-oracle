"use client";

/**
 * The owner's one notice that Oracle's own AI is off (#403): no Claude account can take a
 * call, as the gateway decides it (the accounts page's `pool`). Says what is off, until
 * when (in the company's time zone, in words), why, and the two ways out: add an account,
 * or set a fallback credential. When every account is spent and a fallback is set, the
 * gateway runs on it (`pool.on_fallback`), and the notice says so and until when instead.
 * Drawn on Home and Settings > Claude accounts, owners only.
 */
import Link from "next/link";

import { Button, Notice } from "@/components/ds";
import type { Schemas } from "@/lib/api/client";
import { inWords } from "@/lib/format";

type Page = Schemas["AccountsPage"];

const LIMIT: Record<string, string> = { seven_day: "weekly limit", five_hour: "5-hour limit" };

/** A spent window in words: "weekly limit", "5-hour limit", else its name. */
export const limitWord = (window: string) => LIMIT[window] ?? `${window.replace(/_/g, "-")} limit`;

function why(page: Page): string {
  const { reason, until } = page.pool;
  if (reason === "no_account_available") {
    const binding = until ? page.accounts.find((a) => a.spent_until === until)?.spent_by : null;
    return `Every Claude account is spent${binding ? ` (${limitWord(binding)})` : ""}.`;
  }
  if (reason === "pool_paused") return "Every Claude account is paused, draining or needs a sign-in.";
  if (reason === "no_recent_reading") return "No Claude account has a recent usage reading; the next sweep reads them.";
  return "No Claude account is added and no fallback credential is set.";
}

const FALLBACK_NOTE = "used while no account is added or every account is spent";

export function ClaudeOffNotice({ page, onAdd, onFallback }: { page: Page; onAdd?: () => void; onFallback?: () => void }) {
  const until = page.pool.until ? ` until ${inWords(page.pool.until, page.time_zone)}` : "";
  if (page.pool.on_fallback && page.pool.reason === "no_account_available") {
    return (
      <Notice
        tone="info"
        testId="ai-off"
        action={
          onAdd ? (
            <Button onClick={onAdd}>Add an account</Button>
          ) : (
            <Link href="/settings/claude-accounts" className="font-semibold underline underline-offset-2">
              Claude accounts
            </Link>
          )
        }
      >
        <b className="font-semibold">Oracle is using the fallback credential{until}</b>. {why(page)} To run on an account again
        sooner, add one.
      </Notice>
    );
  }
  if (page.pool.takes_calls) return null;
  return (
    <Notice
      tone="warn"
      testId="ai-off"
      action={
        onAdd || onFallback ? (
          <>
            {onAdd && <Button onClick={onAdd}>Add an account</Button>}
            {onFallback && !page.fallback && (
              <Button variant="ghost" title={`A fallback credential is ${FALLBACK_NOTE}.`} onClick={onFallback}>
                Set a fallback credential
              </Button>
            )}
          </>
        ) : (
          <Link href="/settings/claude-accounts" className="font-semibold underline underline-offset-2">
            Claude accounts
          </Link>
        )
      }
    >
      <b className="font-semibold">Oracle&apos;s AI is off{until}</b>: live replies, interviews and Ask Oracle can&apos;t run. {why(page)}{" "}
      To turn it back on, add an account{page.fallback ? "" : ` or set a fallback credential (${FALLBACK_NOTE})`}.
    </Notice>
  );
}
