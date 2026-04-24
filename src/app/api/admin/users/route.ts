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
    .select("email, display_name, is_active, role, created_at")
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(request: Request) {
  const adminClient = await requireAdmin();
  if (!adminClient) {
    return NextResponse.json({ error: "권한이 없습니다." }, { status: 403 });
  }

  const { email, display_name, role } = await request.json().catch(() => ({})) as {
    email?: string;
    display_name?: string;
    role?: string;
  };
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return NextResponse.json({ error: "이메일을 입력해 주세요." }, { status: 400 });
  }

  const safeRole = role === "admin" ? "admin" : "manager";

  // Upsert into allowed_users
  const { data, error } = await adminClient
    .from("allowed_users")
    .upsert(
      { email: normalizedEmail, display_name: display_name?.trim() || null, is_active: true, role: safeRole },
      { onConflict: "email" }
    )
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Send invite email via Supabase Auth
  const { error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(normalizedEmail, {
    data: { display_name: display_name?.trim() || null }
  });
  // Invite errors are non-fatal (user may already exist)
  const inviteSent = !inviteError;

  return NextResponse.json({ ...data, inviteSent }, { status: 201 });
}
