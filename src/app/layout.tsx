import type { Metadata } from "next";
import { Gabarito, Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const gabarito = Gabarito({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

export const metadata: Metadata = {
  title: "DeepWe深蓝｜让两个人，更懂彼此",
  description: "让两个人先各自把故事说完整，再一起看清关系里真正发生了什么。",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className={`${inter.variable} ${gabarito.variable}`} suppressHydrationWarning>
      <body className="min-h-screen bg-bg text-slate-800 antialiased">
        {children}
      </body>
    </html>
  );
}
