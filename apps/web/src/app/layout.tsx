import type { Metadata, Viewport } from "next";
import { SessionProvider } from "@/lib/session";
import "./globals.css";

export const metadata: Metadata = { title: "사장님 먼저받기 · 시연", description: "매출채권 조기정산 로컬 시연 (가상 데이터·모의 토큰)" };
export const viewport: Viewport = { width: "device-width", initialScale: 1 };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="ko"><body><SessionProvider>{children}</SessionProvider></body></html>;
}
