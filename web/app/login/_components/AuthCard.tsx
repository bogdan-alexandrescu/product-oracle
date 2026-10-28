import type { ReactNode } from "react";

import { Mark, Wordmark } from "@/components/ds/Brand";

/**
 * The page outside the app shell (sign-in, OAuth consent): one surface card centred on
 * the page background, the brand mark and the title on top. The shell draws no phone header
 * here, so the H1 shows on every width.
 */
export function AuthCard({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <div className="grid min-h-dvh place-items-center bg-bg px-4 py-10 max-[600px]:px-2.5 max-[600px]:py-6">
      <section
        data-testid={testId}
        className="w-full max-w-[420px] rounded-inspector border border-line bg-surface p-7 shadow-panel max-[600px]:rounded-[14px] max-[600px]:p-5"
      >
        <div className="mb-5 flex items-center gap-3 text-[var(--brand-mark)]" data-testid="auth-brand">
          <Mark size={40} className="flex-none" />
          <Wordmark className="text-xl" />
        </div>
        <h1 className="mb-5 font-display text-[28px] leading-8 font-bold tracking-heading">
          {title}
        </h1>
        {children}
      </section>
    </div>
  );
}
