import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Voice AI Agent — Patient Registration System",
  description:
    "LLM-powered phone agent that registers patients conversationally, persists them to a database via a validated REST API, and shows live transcripts. Technical assessment submission.",
  keywords: ["Voice AI", "Patient registration", "Conversational AI", "Twilio", "Vapi", "Healthcare"],
  authors: [{ name: "Voice AI Agent Submission" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "Voice AI Agent — Patient Registration System",
    description: "Call, register a patient conversationally, and query them over a REST API.",
    siteName: "Voice AI Patient Registration",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
