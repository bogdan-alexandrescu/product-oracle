"use client";

import { useParams } from "next/navigation";

import { RebuildSeen } from "@/components/RebuildSign";

/** Every pane of a version: opening it ends the rebuild sign's "v<n> ready: review it". */
export default function VersionLayout({ children }: { children: React.ReactNode }) {
  const { doc, n } = useParams<{ doc: string; n: string }>();
  return (
    <>
      <RebuildSeen slug={decodeURIComponent(doc)} version={Number(n)} />
      {children}
    </>
  );
}
