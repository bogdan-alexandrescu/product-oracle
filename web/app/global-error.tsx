"use client";

import "./globals.css";

/**
 * The root layout itself failed: no shell to draw in, so this page brings its own html and
 * body, on the app's tokens, with Try again and Go to Home.
 */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <head>
        <title>Something went wrong · Product Oracle</title>
      </head>
      <body className="bg-bg text-text">
        <main className="mx-auto flex max-w-md flex-col items-center gap-4 px-6 py-16 text-center">
          <h1 className="font-display text-[28px] leading-8 font-bold tracking-heading">Something went wrong.</h1>
          <div className="flex flex-wrap justify-center gap-2">
            <button
              type="button"
              onClick={reset}
              className="inline-flex h-10 items-center rounded-button bg-accent px-4 text-[15px] font-semibold text-on-accent hover:brightness-110"
            >
              Try again
            </button>
            {/* A full load: the root layout is what failed. */}
            <a
              href="/home"
              className="inline-flex h-10 items-center rounded-button border border-line-strong bg-surface px-4 text-[15px] font-semibold text-text hover:bg-surface2"
            >
              Go to Home
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
