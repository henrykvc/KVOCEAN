import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAllowedUser } from "@/lib/supabase/access";
import { parseAccountTree } from "@/lib/validation/account-tree";
import { readTreeSheetValues, buildTreeCache } from "@/lib/classification-tree-sync";

export const runtime = "nodejs";

async function requireAuthorizedUser() {
  const supabase = createClient();
  const user = await getAllowedUser(supabase).catch(() => null);
  return { supabase, user };
}

// 캐시 메타데이터(가벼운 정보)만 반환. 전체 트리값은 동기화 응답으로 충분.
export async function GET() {
  const { supabase, user } = await requireAuthorizedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("app_config")
    .select("classification_tree, classification_tree_synced_at, classification_tree_synced_by")
    .eq("id", "global")
    .maybeSingle();

  if (error) {
    // 컬럼 없음(마이그레이션 전) → 부드럽게 안내
    if (/classification_tree/i.test(error.message) && /(column|does not exist)/i.test(error.message)) {
      return NextResponse.json({ ok: false, reason: "migration_needed" });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const cache = data?.classification_tree as { values?: string[][]; stats?: unknown; warningCount?: number } | null;
  // 캐시된 시트 스냅샷을 파싱해 표시용 행을 만든다 (4.분류DB 탭 거울).
  const rows = Array.isArray(cache?.values) ? parseAccountTree(cache!.values).rows : [];
  return NextResponse.json({
    ok: true,
    cached: !!cache,
    syncedAt: data?.classification_tree_synced_at ?? null,
    syncedBy: data?.classification_tree_synced_by ?? null,
    stats: cache?.stats ?? null,
    warningCount: cache?.warningCount ?? 0,
    rows,
    values: Array.isArray(cache?.values) ? cache!.values : []
  });
}

// 시트 → 검증 → (통과 시) 캐시 저장.
export async function POST() {
  const { supabase, user } = await requireAuthorizedUser();
  if (!user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let values: string[][];
  try {
    values = await readTreeSheetValues();
  } catch (e) {
    return NextResponse.json({ ok: false, reason: "sheet_read_failed", error: e instanceof Error ? e.message : "시트를 읽지 못했습니다." }, { status: 502 });
  }

  const tree = parseAccountTree(values);

  // 검증 게이트 — 오류가 있으면 캐시에 반영하지 않고 직전 정상본 유지.
  if (tree.errors.length > 0) {
    return NextResponse.json({
      ok: false,
      reason: "validation_failed",
      stats: tree.stats,
      errors: tree.errors.slice(0, 50),
      errorCount: tree.errors.length,
      warningCount: tree.warnings.length
    });
  }

  const syncedAt = new Date().toISOString();
  const cache = buildTreeCache(values, tree, user.email, syncedAt);

  const { error } = await supabase
    .from("app_config")
    .upsert({
      id: "global",
      classification_tree: cache,
      classification_tree_synced_at: syncedAt,
      classification_tree_synced_by: user.email,
      updated_at: syncedAt,
      updated_by: user.email
    }, { onConflict: "id" });

  if (error) {
    if (/classification_tree/i.test(error.message) && /(column|does not exist)/i.test(error.message)) {
      return NextResponse.json({ ok: false, reason: "migration_needed", error: error.message });
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  await supabase.from("change_logs").insert({
    action: "classification_tree_synced",
    target_type: "app_config",
    target_id: "global",
    payload: { stats: tree.stats, warningCount: tree.warnings.length },
    created_by: user.email
  }).then(() => undefined, () => undefined);

  return NextResponse.json({
    ok: true,
    syncedAt,
    stats: tree.stats,
    warnings: tree.warnings.slice(0, 50),
    warningCount: tree.warnings.length
  });
}
