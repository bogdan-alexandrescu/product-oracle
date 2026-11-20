import type { Metadata, Viewport } from 'next';
import { Suspense, type ReactNode } from 'react';

import { AppShell } from '@/components/ds/AppShell';
import { MODE_SCRIPT } from '@/components/ds/ModeSwitch';
import { ScrollbarRoom } from '@/components/ds/ScrollbarRoom';
import { MeProvider, MeSync } from '@/lib/me';
import { THEME_SCRIPT } from '@/lib/theme';
import './globals.css';

// I3 type (Open sky): self-hosted woff2 files (public/fonts, @font-face in globals.css), preloaded
// as next/font did; no runtime request to Google Fonts.
const FONTS = ['inter-tight-latin', 'dm-mono-latin-400', 'dm-mono-latin-500'];

// The default; the shell names each page, "<its H1> · Product Oracle" (qa-shell-2, AppShell's DocumentTitle).
export const metadata: Metadata = {
  title: 'Product Oracle',
  description: 'PRD review loop',
};

export const viewport: Viewport = {
  colorScheme: 'light dark',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <head>
        {FONTS.map((f) => (
          <link
            key={f}
            rel="preload"
            href={`/fonts/${f}.woff2`}
            as="font"
            type="font/woff2"
            crossOrigin="anonymous"
          />
        ))}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        {/* #723: html[data-mode] (Simple or Detailed) before paint; ModeRoot keeps it in step. */}
        <script dangerouslySetInnerHTML={{ __html: MODE_SCRIPT }} />
      </head>
      <body className="min-h-full">
        <ScrollbarRoom />
        <MeProvider>
          <Suspense fallback={null}>
            <MeSync />
          </Suspense>
          <AppShell>{children}</AppShell>
        </MeProvider>
      </body>
    </html>
  );
}
