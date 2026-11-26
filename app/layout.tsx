import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { TenantProvider } from "./components/shell/TenantContext";
import AppShell from "./components/shell/AppShell";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "星辰跨境企服集团 · WorkBot v4.0",
  description:
    "星辰跨境企服集团 WorkBot v4.0 —— 异常工单协同台（FIN-001 大额审批人工红线）",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" data-tenant="xingchen">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <TenantProvider>
          <AppShell>{children}</AppShell>
        </TenantProvider>
      </body>
    </html>
  );
}
