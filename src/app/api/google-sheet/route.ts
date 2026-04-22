import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const sheetId = request.nextUrl.searchParams.get("sheetId");
  if (!sheetId) {
    return NextResponse.json({ error: "sheetId가 필요합니다." }, { status: 400 });
  }

  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  // provider_token은 세션보다 별도 쿠키에서 더 안정적으로 읽힘
  const cookieStore = cookies();
  const providerToken = cookieStore.get("kvocean-google-token")?.value
    ?? (await supabase.auth.getSession()).data.session?.provider_token;

  if (!providerToken) {
    return NextResponse.json({ error: "no_provider_token" }, { status: 401 });
  }

  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/A:Z`,
    { headers: { Authorization: `Bearer ${providerToken}` } }
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: { message?: string } };
    return NextResponse.json(
      { error: err?.error?.message ?? "구글 시트를 불러오지 못했습니다." },
      { status: res.status }
    );
  }

  const data = await res.json();
  return NextResponse.json(data);
}
