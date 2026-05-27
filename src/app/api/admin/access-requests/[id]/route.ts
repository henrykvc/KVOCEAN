import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getUserRole, normalizeEmail } from "@/lib/supabase/access";

export const runtime = "nodejs";

async function requireAdminContext() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) return null;

  const role = await getUserRole(supabase, user.email).catch(() => "manager" as const);
  if (role !== "creator" && role !== "admin") return null;

  return { adminClient: createAdminClient(), currentUserEmail: user.email };
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const ctx = await requireAdminContext();
  if (!ctx) return NextResponse.json({ error: "권한이 없습니다." }, { status: 403 });
  if (!ctx.adminClient) return NextResponse.json({ error: "서버 설정 오류: SUPABASE_SERVICE_ROLE_KEY가 없습니다." }, { status: 500 });

  const body = await request.json().catch(() => ({})) as { action?: string };
  if (body.action !== "approve" && body.action !== "reject") {
    return NextResponse.json({ error: "action은 approve 또는 reject 여야 합니다." }, { status: 400 });
  }

  const { data: req, error: fetchError } = await ctx.adminClient
    .from("access_requests")
    .select("id, email, display_name, status")
    .eq("id", params.id)
    .maybeSingle();
  if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 500 });
  if (!req) return NextResponse.json({ error: "요청을 찾을 수 없습니다." }, { status: 404 });
  if (req.status !== "pending") return NextResponse.json({ error: "이미 처리된 요청입니다." }, { status: 409 });

  const email = normalizeEmail(req.email);
  const decidedAt = new Date().toISOString();

  if (body.action === "approve") {
    // 매니저로 추가 + 초대 메일 발송. 둘 다 실패하더라도 access_requests 상태는
    // 'approved'로 마킹해 같은 요청이 다시 표시되지 않도록 한다.
    const { error: upsertError } = await ctx.adminClient
      .from("allowed_users")
      .upsert(
        { email, display_name: req.display_name ?? null, is_active: true, role: "manager" },
        { onConflict: "email" }
      );
    if (upsertError) return NextResponse.json({ error: upsertError.message }, { status: 500 });

    let inviteSent = false;
    try {
      const { error: inviteError } = await ctx.adminClient.auth.admin.inviteUserByEmail(email, {
        data: { display_name: req.display_name ?? null }
      });
      inviteSent = !inviteError;
    } catch {
      inviteSent = false;
    }

    const { error: updateError } = await ctx.adminClient
      .from("access_requests")
      .update({ status: "approved", decided_at: decidedAt, decided_by: ctx.currentUserEmail })
      .eq("id", params.id);
    if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

    return NextResponse.json({ ok: true, action: "approve", inviteSent });
  }

  // reject
  const { error: updateError } = await ctx.adminClient
    .from("access_requests")
    .update({ status: "rejected", decided_at: decidedAt, decided_by: ctx.currentUserEmail })
    .eq("id", params.id);
  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

  return NextResponse.json({ ok: true, action: "reject" });
}
