import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "KV OCEAN",
  description: "보호된 재무 검증 및 데이터 관리 워크스페이스"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
