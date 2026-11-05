import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";

const name = process.env.NEXT_PUBLIC_APP_NAME ?? "LAST60";
const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(site),
  title: { default: `${name} — The final minute pays`, template: `%s · ${name}` },
  description: "Every five minutes, 75% of eligible trading fees are paid on-chain to the most recent unique buyers. Transparent, verifiable, Solana-native.",
  icons: { icon: [{ url: "/icon.svg", type: "image/svg+xml" }, { url: "/favicon.ico", sizes: "any" }], apple: "/apple-touch-icon.png" },
  openGraph: { title: `${name} — The final minute pays`, description: "75% of trading fees to the last five buyers, every five minutes.", images: ["/og-image.png"], type: "website" },
  twitter: { card: "summary_large_image", images: ["/og-image.png"] },
};

export const viewport: Viewport = { themeColor: "#07080C", colorScheme: "dark", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
