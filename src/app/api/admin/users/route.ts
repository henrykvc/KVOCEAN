import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isActiveAdminUser, normalizeEmail } from "@/lib/supabase/access";

async function requireAdmin() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) return null;

  const adminClient = createAdminClient();
  if (!adminClient) return null;

  const isAdmin = await isActiveAdminUser(adminClient, user.email).catch(() => false);
  return isAdmin ? adminClient : null;
}

export async function GET() {
  const adminClient = await requireAdmin();
  if (!adminClient) {
    return NextResponse.json({ error: "권한이 없습니다." }, { status: 403 });
  }

  const { data, error } = await adminClient
    .from("allowed_users")
    .select("email, display_name, is_active, created_at")
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(request: Request) {
  const adminClient = await requireAdmin();
  if (!adminClient) {
    return NextResponse.json({ error: "권한이 없습니다." }, { status: 403 });
  }

  const { email, display_name } = await request.json().catch(() => ({})) as { email?: string; display_name?: string };
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return NextResponse.json({ error: "이메일을 입력해 주세요." }, { status: 400 });
  }

  const { data, error } = await adminClient
    .from("allowed_users")
    .upsert({ email: normalizedEmail, display_name: display_name?.trim() || null, is_active: true }, { onConflict: "email" })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}
