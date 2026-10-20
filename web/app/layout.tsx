import type { Metadata, Viewport } from "next";
import { DM_Mono, Inter_Tight } from "next/font/google";
import { Suspense } from "react";

import { AppHeader, HeaderShell } from "@/components/AppHeader";
import { AppNav } from "@/components/AppNav";
import { MeProvider, MeSync } from "@/lib/me";
import "./globals.css";

// I3 type (Open sky), as on main: Inter Tight for the UI and headings, DM Mono for figures,
// ids and code. Self-hosted by next/font: no runtime request to Google Fonts.
const interTight = Inter_Tight({ subsets: ["latin"], variable: "--font-inter-tight", display: "swap" });
const mono = DM_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-dm-mono", display: "swap" });

export const metadata: Metadata = {
  title: "Product Oracle",
  description: "PRD review loop",
};

// The design system's tokens follow the system theme (globals.css).
export const viewport: Viewport = {
  colorScheme: "light dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${interTight.variable} ${mono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <MeProvider>
          <Suspense fallback={null}>
            <MeSync />
          </Suspense>
          <Suspense fallback={<HeaderShell />}>
            <AppHeader />
          </Suspense>
          <div className="flex w-full flex-1 max-[600px]:flex-col">
            <Suspense fallback={null}>
              <AppNav />
            </Suspense>
            <main className="min-w-0 flex-1">{children}</main>
          </div>
        </MeProvider>
      </body>
    </html>
  );
}
