import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isEmailAllowed } from "@/lib/auth/access";

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  const tokenHash = requestUrl.searchParams.get("token_hash");
  const accessToken = requestUrl.searchParams.get("access_token");
  const refreshToken = requestUrl.searchParams.get("refresh_token");
  const type = requestUrl.searchParams.get("type");
  const nextPath = requestUrl.searchParams.get("next") || "/";

  const supabase = createClient();

  let error: Error | null = null;

  if (code) {
    const result = await supabase.auth.exchangeCodeForSession(code);
    error = result.error;
  } else if (tokenHash) {
    const result = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: type === "recovery" ? "recovery" : "email"
    });
    error = result.error;
  } else if (accessToken && refreshToken) {
    const result = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken
    });
    error = result.error;
  } else {
    const {
      data: { user: existingUser }
    } = await supabase.auth.getUser();

    if (existingUser?.email) {
      return NextResponse.redirect(new URL(nextPath, request.url));
    }

    return NextResponse.redirect(new URL("/login?error=missing_code", request.url));
  }

  if (error) {
    return NextResponse.redirect(new URL("/login?error=callback", request.url));
  }

  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!await isEmailAllowed(user?.email)) {
    await supabase.auth.signOut();
    return NextResponse.redirect(new URL("/login?error=unauthorized", request.url));
  }

  return NextResponse.redirect(new URL(nextPath, request.url));
}
