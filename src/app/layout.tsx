import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OCR 검증 프로그램",
  description: "3줄 OCR 재무 검증용 Vercel 앱"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
