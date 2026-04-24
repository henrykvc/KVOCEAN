import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getUserRole, normalizeEmail, CREATOR_EMAIL } from "@/lib/supabase/access";

async function requireAdminContext() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) return null;

  const role = await getUserRole(supabase, user.email).catch(() => "manager" as const);
  if (role !== "creator" && role !== "admin") return null;

  return { supabase, adminClient: createAdminClient() };
}

async function ensureCreatorExists(adminClient: NonNullable<ReturnType<typeof createAdminClient>>) {
  // Try with role column first, then without
  const { error } = await adminClient
    .from("allowed_users")
    .upsert({ email: CREATOR_EMAIL, display_name: "Henry", is_active: true, role: "creator" }, { onConflict: "email", ignoreDuplicates: true });

  if (error) {
    await adminClient
      .from("allowed_users")
      .upsert({ email: CREATOR_EMAIL, display_name: "Henry", is_active: true }, { onConflict: "email", ignoreDuplicates: true });
  }
}

export async function GET() {
  const ctx = await requireAdminContext();
  if (!ctx) return NextResponse.json({ error: "권한이 없습니다." }, { status: 403 });

  // Auto-ensure creator is in the table
  if (ctx.adminClient) {
    await ensureCreatorExists(ctx.adminClient).catch(() => {});
  }

  // Try selecting with role column
  const { data, error } = await ctx.supabase
    .from("allowed_users")
    .select("email, display_name, is_active, role, created_at")
    .order("created_at", { ascending: false });

  if (!error) return NextResponse.json(data);

  // role column doesn't exist yet — fallback without it
  const { data: fallbackData, error: fallbackError } = await ctx.supabase
    .from("allowed_users")
    .select("email, display_name, is_active, created_at")
    .order("created_at", { ascending: false });

  if (fallbackError) return NextResponse.json({ error: fallbackError.message }, { status: 500 });

  const enriched = (fallbackData ?? []).map((u: Record<string, unknown>) => ({
    ...u,
    role: u.email === CREATOR_EMAIL ? "creator" : "manager",
  }));
  return NextResponse.json(enriched);
}

export async function POST(request: Request) {
  const ctx = await requireAdminContext();
  if (!ctx) return NextResponse.json({ error: "권한이 없습니다." }, { status: 403 });
  if (!ctx.adminClient) return NextResponse.json({ error: "서버 설정 오류: SUPABASE_SERVICE_ROLE_KEY가 없습니다." }, { status: 500 });

  const { email, display_name, role } = await request.json().catch(() => ({})) as {
    email?: string; display_name?: string; role?: string;
  };
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return NextResponse.json({ error: "이메일을 입력해 주세요." }, { status: 400 });

  const safeRole = role === "admin" ? "admin" : "manager";

  // Try upsert with role column
  let { data, error } = await ctx.adminClient
    .from("allowed_users")
    .upsert(
      { email: normalizedEmail, display_name: display_name?.trim() || null, is_active: true, role: safeRole },
      { onConflict: "email" }
    )
    .select()
    .single();

  // If role column doesn't exist, retry without it
  if (error) {
    const result = await ctx.adminClient
      .from("allowed_users")
      .upsert(
        { email: normalizedEmail, display_name: display_name?.trim() || null, is_active: true },
        { onConflict: "email" }
      )
      .select()
      .single();
    data = result.data ? { ...result.data, role: safeRole } : null;
    error = result.error;
  }

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { error: inviteError } = await ctx.adminClient.auth.admin.inviteUserByEmail(normalizedEmail, {
    data: { display_name: display_name?.trim() || null }
  });

  return NextResponse.json({ ...data, inviteSent: !inviteError }, { status: 201 });
}
