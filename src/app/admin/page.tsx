import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isActiveAdminUser } from "@/lib/supabase/access";
import { AdminPanel } from "@/components/admin/admin-panel";

export default async function AdminPage() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user?.email) redirect("/login");

  const isAdmin = await isActiveAdminUser(supabase, user.email).catch(() => false);
  if (!isAdmin) redirect("/");

  const { data: users } = await supabase
    .from("allowed_users")
    .select("email, display_name, is_active, role, created_at")
    .order("created_at", { ascending: false });

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
      <AdminPanel initialUsers={users ?? []} />
    </>
  );
}
