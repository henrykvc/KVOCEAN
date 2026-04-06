import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isEmailAllowed } from "@/lib/auth/access";

function renderHashBridgeHtml(nextPath: string) {
  const escapedNextPath = JSON.stringify(nextPath);

  return `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>로그인 확인 중...</title>
  </head>
  <body style="font-family: sans-serif; padding: 24px;">
    <p>로그인 정보를 확인하는 중입니다...</p>
    <script>
      (function () {
        var hash = new URLSearchParams(window.location.hash.slice(1));
        var query = new URLSearchParams(window.location.search);
        var target = new URL(window.location.origin + "/auth/callback");
        var nextPath = ${escapedNextPath};

        if (nextPath && nextPath !== "/") {
          target.searchParams.set("next", nextPath);
        }

        ["code", "token_hash", "type", "access_token", "refresh_token"].forEach(function (key) {
          var value = query.get(key) || hash.get(key);
          if (value) {
            target.searchParams.set(key, value);
          }
        });

        if (["code", "token_hash", "access_token"].some(function (key) { return target.searchParams.get(key); })) {
          window.location.replace(target.toString());
          return;
        }

        window.location.replace(window.location.origin + "/login?error=missing_code");
      })();
    </script>
  </body>
</html>`;
}

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

    return new Response(renderHashBridgeHtml(nextPath), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      }
    });
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
