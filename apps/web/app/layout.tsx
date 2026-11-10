import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";

const name = process.env.NEXT_PUBLIC_APP_NAME ?? "Asteroid Protocol";
const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(site),
  title: { default: `${name} — The final minute pays`, template: `%s · ${name}` },
  description: "Every five minutes, eligible creator fees are allocated to on-chain payouts for the most recent unique buyers and randomly drawn holders. Payouts are based on verified creator fee allocations. Transparent, verifiable, Solana-native.",
  icons: { icon: [{ url: "/icon.svg", type: "image/svg+xml" }, { url: "/favicon.ico", sizes: "any" }], apple: "/apple-touch-icon.png" },
  applicationName: name,
  openGraph: { siteName: name, title: `${name} — The final minute pays`, description: "Eligible creator fees are allocated to payouts for the last buyers and randomly drawn holders of every round.", images: ["/og-image.png"], type: "website" },
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
