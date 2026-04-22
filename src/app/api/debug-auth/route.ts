import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  const cookieStore = cookies();
  const savedToken = cookieStore.get("kvocean-google-token")?.value;
  const token = savedToken ?? session?.provider_token;

  // 토큰으로 구글 API 실제 호출 테스트
  let tokenTest: string | null = null;
  if (token) {
    const testRes = await fetch("https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=" + token);
    const testJson = await testRes.json() as { scope?: string; error?: string; expires_in?: number };
    if (testJson.error) {
      tokenTest = "만료됨 또는 유효하지 않음";
    } else {
      const hasSheetScope = testJson.scope?.includes("spreadsheets") ?? false;
      tokenTest = `유효 (${testJson.expires_in}초 남음) / 시트 권한: ${hasSheetScope ? "있음" : "없음"}`;
    }
  }

  const sheetId = request.nextUrl.searchParams.get("sheetId");
  let sheetTest: string | null = null;
  if (token && sheetId) {
    const sheetRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/A1:B2`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const sheetJson = await sheetRes.json() as { error?: { message?: string } };
    sheetTest = sheetRes.ok ? "성공" : (sheetJson.error?.message ?? "실패");
  }

  return NextResponse.json({
    provider: session?.user?.app_metadata?.provider ?? null,
    hasCookieToken: !!savedToken,
    tokenTest,
    sheetTest,
  });
}
