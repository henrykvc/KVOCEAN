import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getUserRole, CREATOR_EMAIL } from "@/lib/supabase/access";
import { AdminPanel, type AccessRequest } from "@/components/admin/admin-panel";

type AllowedUser = {
  email: string;
  display_name: string | null;
  is_active: boolean;
  role: "creator" | "admin" | "manager";
  created_at: string;
};

export default async function AdminPage() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user?.email) redirect("/login");

  const userRole = await getUserRole(supabase, user.email).catch(() => "manager" as const);
  if (userRole !== "creator" && userRole !== "admin") redirect("/");

  // Try with role column, fall back without it if column doesn't exist yet
  let users: AllowedUser[] | null = null;
  const { data, error } = await supabase
    .from("allowed_users")
    .select("email, display_name, is_active, role, created_at")
    .order("created_at", { ascending: false });

  if (!error) {
    users = data;
  } else {
    const { data: fallback } = await supabase
      .from("allowed_users")
      .select("email, display_name, is_active, created_at")
      .order("created_at", { ascending: false });
    users = (fallback ?? []).map((u) => ({
      email: u.email as string,
      display_name: u.display_name as string | null,
      is_active: u.is_active as boolean,
      created_at: u.created_at as string,
      role: (u.email === CREATOR_EMAIL ? "creator" : "manager") as AllowedUser["role"],
    }));
  }

  // 대기 중 접근 요청. 테이블이 아직 없으면 마이그레이션 전 → 빈 배열로 fallback.
  let pendingRequests: AccessRequest[] = [];
  const adminClient = createAdminClient();
  if (adminClient) {
    const { data: reqRows, error: reqError } = await adminClient
      .from("access_requests")
      .select("id, email, display_name, reason, status, requested_at")
      .eq("status", "pending")
      .order("requested_at", { ascending: false });
    if (!reqError && reqRows) {
      pendingRequests = reqRows as AccessRequest[];
    }
  }

  return (
    <>
      <div className="workspace-bar">
        <div className="workspace-brand-wrap">
          <div className="workspace-brand-mark">KV</div>
          <div>
            <strong>Kakao Ventures</strong>
            <span>KV OCEAN · 관리자</span>
          </div>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <a href="/" className="ghost-button" style={{ padding: "0.5rem 1rem", textDecoration: "none", borderRadius: 10, fontSize: "0.875rem" }}>
            앱으로 돌아가기
          </a>
          <form action="/auth/logout" method="post">
            <button className="ghost-button" type="submit">로그아웃</button>
          </form>
        </div>
      </div>
      <AdminPanel initialUsers={users ?? []} initialPendingRequests={pendingRequests} />
    </>
  );
}
