import type { ReactNode } from "react";

/**
 * The page outside the app shell (sign-in, OAuth consent): one surface card centred on
 * the page background, the brand mark and the title on top.
 */
export function AuthCard({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <div className="grid min-h-dvh place-items-center bg-bg px-4 py-10 max-[600px]:px-2.5 max-[600px]:py-6">
      <section
        data-testid={testId}
        className="w-full max-w-[420px] rounded-inspector border border-line bg-surface p-7 shadow-panel max-[600px]:rounded-[14px] max-[600px]:p-5"
      >
        <div className="mb-5 flex items-center gap-3">
          <span
            aria-hidden
            className="grid size-10 flex-none place-items-center rounded-xl bg-lime font-display text-[19px] font-bold text-on-lime"
          >
            Q
          </span>
          <span className="font-display text-[15px] font-semibold text-text2">Product Oracle</span>
        </div>
        <h1 className="mb-5 font-display text-[28px] leading-8 font-bold tracking-[-0.02em] max-[600px]:text-2xl max-[600px]:leading-7">
          {title}
        </h1>
        {children}
      </section>
    </div>
  );
}
