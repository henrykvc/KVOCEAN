import { redirect } from "next/navigation";
import { ValidatorApp } from "@/components/validator-app";
import { createClient } from "@/lib/supabase/server";

export default async function Page() {
  const supabase = createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

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
        <form action="/auth/logout" method="post">
          <button className="ghost-button" type="submit">로그아웃</button>
        </form>
      </div>
      <ValidatorApp />
    </>
  );
}
