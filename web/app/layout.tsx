import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Inter, JetBrains_Mono } from "next/font/google";
import { Suspense } from "react";

import { AppShell } from "@/components/ds/AppShell";
import { MeProvider, MeSync } from "@/lib/me";
import { THEME_SCRIPT } from "@/lib/theme";
import "./globals.css";

// B1 type (tokens.json), self-hosted by next/font: no runtime request to Google Fonts.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  weight: ["600", "700"],
  variable: "--font-bricolage",
  display: "swap",
});
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["500"], variable: "--font-jetbrains", display: "swap" });

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
      className={`${inter.variable} ${bricolage.variable} ${mono.variable} h-full antialiased`}
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
