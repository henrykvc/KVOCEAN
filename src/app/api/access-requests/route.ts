import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isActiveAllowedUser, normalizeEmail } from "@/lib/supabase/access";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const email = normalizeEmail(user?.email);
  if (!user || !email) {
    return NextResponse.json({ error: "Google 로그인 세션이 필요합니다." }, { status: 401 });
  }

  const adminClient = createAdminClient();
  if (!adminClient) {
    return NextResponse.json({ error: "서버 설정 오류: SUPABASE_SERVICE_ROLE_KEY가 없습니다." }, { status: 500 });
  }

  // 이미 승인된 계정인데 어쩌다 이 엔드포인트에 도달한 경우 — 그냥 통과시켜 다시 /로 보내게 한다.
  if (await isActiveAllowedUser(adminClient, email).catch(() => false)) {
    await supabase.auth.signOut();
    return NextResponse.json({ alreadyAllowed: true });
  }

  const body = await request.json().catch(() => ({})) as { reason?: string };
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : null;
  const displayName = (user.user_metadata?.full_name || user.user_metadata?.name || null) as string | null;

  // 동일 이메일의 pending이 있으면 그 row를 업데이트, 없으면 새로 insert.
  const { data: existing } = await adminClient
    .from("access_requests")
    .select("id")
    .eq("email", email)
    .eq("status", "pending")
    .maybeSingle();

  if (existing) {
    const { error } = await adminClient
      .from("access_requests")
      .update({
        display_name: displayName,
        reason,
        requested_at: new Date().toISOString()
      })
      .eq("id", existing.id);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  } else {
    const { error } = await adminClient
      .from("access_requests")
      .insert({ email, display_name: displayName, reason, status: "pending" });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  // 요청 제출 직후 세션 종료 — 미승인 상태로 더 머무를 이유 없음.
  await supabase.auth.signOut();
  return NextResponse.json({ ok: true });
}
