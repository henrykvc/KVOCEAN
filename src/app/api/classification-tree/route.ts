import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAllowedUser, getUserRole } from "@/lib/supabase/access";
import { parseAccountTree } from "@/lib/validation/account-tree";
import { readTreeSheetValues, buildTreeCache, appendPendingRows, type PendingAppendRow } from "@/lib/classification-tree-sync";

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
// body.action === "append-pending"이면 먼저 미분류 pending 행을 시트에 append한 뒤 재동기화.
export async function POST(req: Request) {
  const { supabase, user } = await requireAuthorizedUser();
  if (!user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // 계정트리 동기화·미분류 시트 추가는 관리자 이상만 (분류DB 탭 자체가 관리자
  // 전용이지만 API 직접 호출도 막는다).
  const role = await getUserRole(supabase, user.email).catch(() => "manager" as const);
  if (role !== "admin" && role !== "creator") {
    return NextResponse.json({ ok: false, error: "계정트리 동기화는 관리자 이상만 실행할 수 있습니다." }, { status: 403 });
  }

  let body: { action?: string; rows?: PendingAppendRow[] } | null = null;
  try { body = await req.json(); } catch { body = null; }

  let appendResult: { appended: number; skipped: number; names: string[] } | null = null;
  if (body?.action === "append-pending") {
    if (!Array.isArray(body.rows) || !body.rows.length) {
      return NextResponse.json({ ok: false, error: "추가할 미분류 행이 없습니다." }, { status: 400 });
    }
    try {
      appendResult = await appendPendingRows(body.rows);
    } catch (e) {
      return NextResponse.json({ ok: false, reason: "sheet_write_failed", error: e instanceof Error ? e.message : "시트에 쓰지 못했습니다." }, { status: 502 });
    }
    await supabase.from("change_logs").insert({
      action: "classification_tree_pending_appended",
      target_type: "app_config",
      target_id: "global",
      payload: { appended: appendResult.appended, skipped: appendResult.skipped, names: appendResult.names.slice(0, 200) },
      created_by: user.email
    }).then(() => undefined, () => undefined);
  }

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
    warningCount: tree.warnings.length,
    appended: appendResult?.appended ?? 0,
    appendSkipped: appendResult?.skipped ?? 0
  });
}
