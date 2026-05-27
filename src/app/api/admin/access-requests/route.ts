import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getUserRole } from "@/lib/supabase/access";

export const runtime = "nodejs";

async function requireAdminContext() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) return null;

  const role = await getUserRole(supabase, user.email).catch(() => "manager" as const);
  if (role !== "creator" && role !== "admin") return null;

  return { adminClient: createAdminClient(), currentUserEmail: user.email };
}

export async function GET() {
  const ctx = await requireAdminContext();
  if (!ctx) return NextResponse.json({ error: "권한이 없습니다." }, { status: 403 });
  if (!ctx.adminClient) return NextResponse.json({ error: "서버 설정 오류: SUPABASE_SERVICE_ROLE_KEY가 없습니다." }, { status: 500 });

  // pending 우선, 그 뒤 최근 결정된 50개까지.
  const { data: pending, error: pendingError } = await ctx.adminClient
    .from("access_requests")
    .select("id, email, display_name, reason, status, requested_at, decided_at, decided_by")
    .eq("status", "pending")
    .order("requested_at", { ascending: false });

  if (pendingError) return NextResponse.json({ error: pendingError.message }, { status: 500 });

  const { data: decided } = await ctx.adminClient
    .from("access_requests")
    .select("id, email, display_name, reason, status, requested_at, decided_at, decided_by")
    .in("status", ["approved", "rejected"])
    .order("decided_at", { ascending: false })
    .limit(50);

  return NextResponse.json({ pending: pending ?? [], decided: decided ?? [] });
}
