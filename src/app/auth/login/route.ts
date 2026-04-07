import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isActiveAllowedUser, normalizeEmail } from "@/lib/supabase/access";

export async function POST(request: Request) {
  const { email } = await request.json().catch(() => ({ email: "" }));
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail) {
    return NextResponse.json({ error: "이메일을 입력해 주세요." }, { status: 400 });
  }

  const adminClient = createAdminClient();
  if (adminClient) {
    const isAllowed = await isActiveAllowedUser(adminClient, normalizedEmail).catch(() => false);
    if (!isAllowed) {
      return NextResponse.json({ error: "허용된 사용자만 로그인할 수 있습니다." }, { status: 403 });
    }
  }

  return NextResponse.json({ ok: true });
}
