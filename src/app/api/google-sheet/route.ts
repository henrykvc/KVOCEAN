import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const sheetId = request.nextUrl.searchParams.get("sheetId");
  if (!sheetId) {
    return NextResponse.json({ error: "sheetId가 필요합니다." }, { status: 400 });
  }

  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();

  if (!session) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  if (!session.provider_token) {
    return NextResponse.json({ error: "no_provider_token" }, { status: 401 });
  }

  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/A:Z`,
    { headers: { Authorization: `Bearer ${session.provider_token}` } }
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
