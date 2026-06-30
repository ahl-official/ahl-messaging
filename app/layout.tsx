import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AHL Messaging",
  description: "Internal WhatsApp dashboard for American Hairline and Alchemane",
  // Internal staff app — block search engines from indexing or previewing.
  robots: { index: false, follow: false, nocache: true },
  icons: {
    icon: "/logo.png",
    shortcut: "/logo.png",
    apple: "/logo.png",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link
          rel="stylesheet"
          href="https://rsms.me/inter/inter.css"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
