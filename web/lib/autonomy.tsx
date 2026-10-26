"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useQuery } from "@/lib/use-query";

type Level = Schemas["AutonomyItem"]["level"];

/**
 * H11: how far Oracle goes on its own for one responsibility, as Settings › Autonomy shows
 * it (GET /v1/autonomy, everyone reads it). Null until it loads, or when it cannot.
 */
export function useAutonomyLevel(key: string): Level | null {
  const q = useQuery("autonomy", () => unwrap(api.GET("/v1/autonomy")));
  return q.data?.items.find((i) => i.key === key)?.level ?? null;
}

/**
 * One line saying what the level keeps Oracle from drafting, with the way to change it.
 * `onFollow`: what the link closes first (the sheet or dialog it sits in), so coming back
 * does not find it still open.
 */
export function AutonomyNote({ testId, children, onFollow }: { testId: string; children: ReactNode; onFollow?: () => void }) {
  return (
    <p data-testid={testId} className="text-[15px] text-text2">
      {children}{" "}
      <Link href="/settings/autonomy" onClick={onFollow} className="font-medium text-accent-ink hover:underline">
        Settings, Autonomy
      </Link>
    </p>
  );
}
