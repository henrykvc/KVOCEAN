import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAllowedUser } from "@/lib/supabase/access";

export const runtime = "nodejs";

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = createClient();
  const user = await getAllowedUser(supabase).catch(() => null);
  if (!user) return NextResponse.json({ error: "권한이 없습니다." }, { status: 403 });

  const id = decodeURIComponent(params.id);
  const body = await request.json().catch(() => ({})) as { statementType?: string };
  const statementType = body.statementType === "연결" ? "연결" : "별도";

  // Read current source, merge statementType
  const { data: existing, error: fetchError } = await supabase
    .from("datasets")
    .select("source")
    .eq("id", id)
    .single();

  if (fetchError || !existing) {
    return NextResponse.json({ error: "데이터를 찾을 수 없습니다." }, { status: 404 });
  }

  const updatedSource = { ...(existing.source as Record<string, unknown>), statementType };

  const { error } = await supabase
    .from("datasets")
    .update({ source: updatedSource })
    .eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
