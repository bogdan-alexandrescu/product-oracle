"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { MEMOS_KEY } from "@/app/company/market/_components/lib";
import { Button } from "@/components/ds";
import { api, unwrap } from "@/lib/api/client";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

/**
 * A pricing memo's header (H9): once its latest version is approved, Decide for the pricing
 * owner, who lands on the memo's proposed decision in Company › Decisions (created on the
 * first Decide, the same one after); everyone else reads "Waiting for <name> to decide".
 * Approving a memo means it is ready for the decision; it decides nothing.
 */
export function PricingDecide({ slug }: { slug: string }) {
  const router = useRouter();
  const { me, can } = useMe();
  const q = useQuery(MEMOS_KEY, () => unwrap(api.GET("/v1/pricing-memos")));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const memo = q.data?.find((m) => m.slug === slug);
  if (!memo || (memo.state !== "approved" && memo.state !== "decided")) return null;
  const owner = memo.pricing_owner;
  const mine = !!owner && owner.id === me?.user_id && can("decide_pricing_memo", true);

  if (memo.state === "decided" && memo.decision) {
    return (
      <Button variant="ghost" onClick={() => router.push(`/company/decisions?d=${memo.decision!.number}`)} data-testid="pricing-decided">
        Decided: D-{memo.decision.number}
        {memo.decision.chosen_label ? ` · ${memo.decision.chosen_label}` : ""}
      </Button>
    );
  }
  if (!mine) {
    return (
      <span className="text-sm font-medium text-text2" data-testid="pricing-waiting">
        Waiting for {owner?.name ?? "the pricing owner"} to decide
      </span>
    );
  }

  async function decide() {
    setBusy(true);
    setError(null);
    try {
      const d = await unwrap(api.POST("/v1/pricing-memos/{doc}/decide", { params: { path: { doc: slug } } }));
      router.push(`/company/decisions?d=${d.number}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <>
      {error && (
        <span role="alert" className="text-sm text-crit">
          {error}
        </span>
      )}
      <Button variant="primary" icon="check" disabled={busy} onClick={() => void decide()} data-testid="pricing-decide">
        Decide
      </Button>
    </>
  );
}
