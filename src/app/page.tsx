import { redirect } from "next/navigation";
import { ValidatorApp } from "@/components/validator-app";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/supabase/access";
import { loadDatasets } from "@/lib/datasets";

export default async function Page() {
  const supabase = createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const userRole = user.email
    ? await getUserRole(supabase, user.email).catch(() => "manager" as const)
    : "manager" as const;
  const canManageAccounts = userRole === "creator" || userRole === "admin";

  const initialDatasetPayload = await loadDatasets(supabase).catch(() => null);

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
          {canManageAccounts && (
            <a href="/admin" className="ghost-button" style={{ padding: "0.5rem 1rem", textDecoration: "none", borderRadius: 10, fontSize: "0.875rem" }}>
              계정 관리
            </a>
          )}
          <form action="/auth/logout" method="post">
            <button className="ghost-button" type="submit">로그아웃</button>
          </form>
        </div>
      </div>
      <ValidatorApp
        userRole={userRole}
        initialDatasets={initialDatasetPayload?.datasets}
        initialTrashedDatasets={initialDatasetPayload?.trashedDatasets}
      />
    </>
  );
}
