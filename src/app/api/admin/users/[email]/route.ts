import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getUserRole, CREATOR_EMAIL } from "@/lib/supabase/access";

async function requireAdminContext() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) return null;

  const role = await getUserRole(supabase, user.email).catch(() => "manager" as const);
  if (role !== "creator" && role !== "admin") return null;

  return { adminClient: createAdminClient() };
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { email: string } }
) {
  const ctx = await requireAdminContext();
  if (!ctx) return NextResponse.json({ error: "권한이 없습니다." }, { status: 403 });
  if (!ctx.adminClient) return NextResponse.json({ error: "서버 설정 오류: SUPABASE_SERVICE_ROLE_KEY가 없습니다." }, { status: 500 });

  const email = decodeURIComponent(params.email);
  if (email === CREATOR_EMAIL) {
    return NextResponse.json({ error: "제작자 계정은 수정할 수 없습니다." }, { status: 403 });
  }

  const body = await request.json().catch(() => ({})) as { role?: string };
  const safeRole = body.role === "admin" ? "admin" : "manager";

  const { data, error } = await ctx.adminClient
    .from("allowed_users")
    .update({ role: safeRole })
    .eq("email", email)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { email: string } }
) {
  const ctx = await requireAdminContext();
  if (!ctx) return NextResponse.json({ error: "권한이 없습니다." }, { status: 403 });
  if (!ctx.adminClient) return NextResponse.json({ error: "서버 설정 오류: SUPABASE_SERVICE_ROLE_KEY가 없습니다." }, { status: 500 });

  const email = decodeURIComponent(params.email);
  if (email === CREATOR_EMAIL) {
    return NextResponse.json({ error: "제작자 계정은 삭제할 수 없습니다." }, { status: 403 });
  }

  const { error } = await ctx.adminClient
    .from("allowed_users")
    .delete()
    .eq("email", email);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
