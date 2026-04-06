import { NextResponse } from "next/server";
import { isEmailAllowed } from "@/lib/auth/access";
import { createPublicServerClient } from "@/lib/supabase/service";

export async function POST(request: Request) {
  const { email, next } = await request.json().catch(() => ({ email: "", next: "/" }));
  const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  const nextPath = typeof next === "string" && next.startsWith("/") ? next : "/";

  if (!normalizedEmail) {
    return NextResponse.json({ error: "이메일을 입력해 주세요." }, { status: 400 });
  }

  if (!await isEmailAllowed(normalizedEmail)) {
    return NextResponse.json({ error: "허용된 이메일 계정만 접근할 수 있습니다." }, { status: 403 });
  }

  const supabase = createPublicServerClient();
  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL ?? new URL(request.url).origin;
  const redirectUrl = new URL("/auth/callback", baseUrl);
  if (nextPath !== "/") {
    redirectUrl.searchParams.set("next", nextPath);
  }

  const { error } = await supabase.auth.signInWithOtp({
    email: normalizedEmail,
    options: {
      emailRedirectTo: redirectUrl.toString(),
      shouldCreateUser: false
    }
  });

  if (error) {
    return NextResponse.json(
      {
        error: error.message || "매직링크를 보내지 못했습니다. Supabase 사용자 초대 상태를 확인해 주세요."
      },
      { status: 400 }
    );
  }

  return NextResponse.json({
    message: "매직링크를 보냈습니다. 받은 편지함과 스팸함을 확인해 주세요."
  });
}
