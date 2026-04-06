import { redirect } from "next/navigation";
import { ValidatorApp } from "@/components/validator-app";
import { isEmailAllowed } from "@/lib/auth/access";
import { createClient } from "@/lib/supabase/server";

export default async function Page() {
  const supabase = createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  if (!await isEmailAllowed(user.email)) {
    await supabase.auth.signOut();
    redirect("/login?error=unauthorized");
  }

  return (
    <>
      <div className="workspace-bar">
        <div>
          <strong>공용 작업공간</strong>
          <span>{user.email}</span>
        </div>
        <form action="/auth/logout" method="post">
          <button className="ghost-button" type="submit">로그아웃</button>
        </form>
      </div>
      <ValidatorApp />
    </>
  );
}
