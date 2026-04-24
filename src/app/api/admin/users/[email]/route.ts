import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isActiveAdminUser } from "@/lib/supabase/access";

const CREATOR_EMAIL = "henry@kakaoventures.co.kr";

async function requireAdmin() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) return null;

  const adminClient = createAdminClient();
  if (!adminClient) return null;

  const isAdmin = await isActiveAdminUser(adminClient, user.email).catch(() => false);
  return isAdmin ? adminClient : null;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { email: string } }
) {
  const adminClient = await requireAdmin();
  if (!adminClient) {
    return NextResponse.json({ error: "권한이 없습니다." }, { status: 403 });
  }

  const email = decodeURIComponent(params.email);
  if (email === CREATOR_EMAIL) {
    return NextResponse.json({ error: "제작자 계정은 수정할 수 없습니다." }, { status: 403 });
  }

  const body = await request.json().catch(() => ({})) as { role?: string };
  const safeRole = body.role === "admin" ? "admin" : "manager";

  const { data, error } = await adminClient
    .from("allowed_users")
    .update({ role: safeRole, updated_at: new Date().toISOString() })
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
  const adminClient = await requireAdmin();
  if (!adminClient) {
    return NextResponse.json({ error: "권한이 없습니다." }, { status: 403 });
  }

  const email = decodeURIComponent(params.email);
  if (email === CREATOR_EMAIL) {
    return NextResponse.json({ error: "제작자 계정은 삭제할 수 없습니다." }, { status: 403 });
  }

  const { error } = await adminClient
    .from("allowed_users")
    .delete()
    .eq("email", email);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
