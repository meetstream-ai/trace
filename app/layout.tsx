import type { Metadata } from "next";
import "./globals.css";
import "./workspace-refinement.css";

export const metadata: Metadata = {
  title: "Trace · Engineering Discussion Agent",
  description:
    "From engineering conversations to discussions, owned work and a clear next step.",
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
      <body className="antialiased">{children}</body>
    </html>
  );
}
