import { NextResponse } from "next/server";
import { isEmailAllowed } from "@/lib/auth/access";

export async function POST(request: Request) {
  const { email } = await request.json().catch(() => ({ email: "" }));
  const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";

  if (!normalizedEmail) {
    return NextResponse.json({ error: "이메일을 입력해 주세요." }, { status: 400 });
  }

  if (!await isEmailAllowed(normalizedEmail)) {
    return NextResponse.json({ error: "허용된 이메일 계정만 접근할 수 있습니다." }, { status: 403 });
  }

  return NextResponse.json({ ok: true });
}
