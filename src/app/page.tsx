import { redirect } from "next/navigation";
import { ValidatorApp } from "@/components/validator-app";
import { createClient } from "@/lib/supabase/server";
import { isActiveAdminUser, getUserRole } from "@/lib/supabase/access";

export default async function Page() {
  const supabase = createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const [isAdmin, userRole] = await Promise.all([
    user.email ? isActiveAdminUser(supabase, user.email).catch(() => false) : false,
    user.email ? getUserRole(supabase, user.email).catch(() => "manager" as const) : "manager" as const,
  ]);

  return (
    <>
      <div className="workspace-bar">
        <div className="workspace-brand-wrap">
          <div className="workspace-brand-mark">KV</div>
          <div>
            <strong>Kakao Ventures</strong>
            <span>KV OCEAN · {user.email}</span>
          </div>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          {isAdmin && (
            <a href="/admin" className="ghost-button" style={{ padding: "0.5rem 1rem", textDecoration: "none", borderRadius: 10, fontSize: "0.875rem" }}>
              계정 관리
            </a>
          )}
          <form action="/auth/logout" method="post">
            <button className="ghost-button" type="submit">로그아웃</button>
          </form>
        </div>
      </div>
      <ValidatorApp userRole={userRole} />
    </>
  );
}
