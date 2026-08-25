import type { Metadata } from "next";
import { Geist, Geist_Mono, Inter, Instrument_Serif } from "next/font/google";
import "./globals.css";

// Dashboard typeface.
const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

// Landing typefaces. next/font self-hosts these at build time, so there is no
// runtime request to Google, no FOUT, and no 404 path — which is what the
// hand-rolled @font-face version had to work around.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});
const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  weight: "400",
  style: "italic",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Averis — the accountability layer between evidence and decisions",
  description:
    "Specialist agents analyse the same curated Reppo Datanet independently. Their claims are scored, weighted and merged, each one traceable to the evidence behind it.",
};

export const viewport = {
  themeColor: "#000000",
  colorScheme: "dark" as const,
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover" as const,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${inter.variable} ${instrumentSerif.variable} h-full`}
      // Inline so the black is painted before any stylesheet resolves and the
      // page can never flash white.
      style={{ background: "#000", color: "#fff" }}
    >
      <body className="min-h-full" style={{ background: "#000", color: "#fff" }}>
        {children}
      </body>
    </html>
  );
}
