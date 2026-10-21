import type { Metadata } from "next";
import { Geist, Geist_Mono, Noto_Naskh_Arabic, Source_Serif_4 } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Display/reading faces for the printed similarity report (components/report/report-v2/similarity-print-report.tsx):
// a Latin serif, and an Arabic naskh face limited to the Arabic range. No metric-fallback faces: a fallback is a
// system font that also carries Arabic glyphs, and it would catch them before the Arabic face does.
const sourceSerif = Source_Serif_4({
  variable: "--font-serif",
  subsets: ["latin", "latin-ext"],
  adjustFontFallback: false,
});

const notoNaskhArabic = Noto_Naskh_Arabic({
  variable: "--font-arabic",
  subsets: ["arabic"],
  adjustFontFallback: false,
  preload: false,
});

export const metadata: Metadata = {
  title: "TurnitPlus - AI & Similarity Detection",
  description:
    "Private AI-writing and similarity detection with highlighted evidence, source details and downloadable reports.",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${sourceSerif.variable} ${notoNaskhArabic.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
