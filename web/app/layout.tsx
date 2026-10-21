import type { Metadata, Viewport } from "next";
import { DM_Mono, Inter_Tight } from "next/font/google";
import { Suspense } from "react";

import { AppShell } from "@/components/ds/AppShell";
import { MeProvider, MeSync } from "@/lib/me";
import { THEME_SCRIPT } from "@/lib/theme";
import "./globals.css";
import type { LayoutProps } from "@/lib/route-props";

// I3 type (Open sky): Inter Tight for the UI and headings, DM Mono for figures, ids and code.
// Self-hosted by next/font: no runtime request to Google Fonts.
const interTight = Inter_Tight({ subsets: ["latin"], variable: "--font-inter-tight", display: "swap" });
// DM Mono ships 300/400/500; the rail badge's 600 is synthesised from 500.
const mono = DM_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-dm-mono", display: "swap" });

export const metadata: Metadata = {
  title: "Product Oracle",
  description: "PRD review loop",
};

export const viewport: Viewport = {
  colorScheme: "light dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${interTight.variable} ${mono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-full">
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
