import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAllowedUser } from "@/lib/supabase/access";
import { deserializeSharedConfig, serializeSharedConfig, type SharedStateResponse } from "@/lib/shared-state";

async function requireAuthorizedUser() {
  const supabase = createClient();
  const user = await getAllowedUser(supabase).catch(() => null);

  if (!user) {
    return { supabase, user: null };
  }

  return { supabase, user };
}

export async function GET() {
  const { supabase, user } = await requireAuthorizedUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: configRow, error: configError } = await supabase
    .from("app_config")
    .select("logic_config, company_configs")
    .eq("id", "global")
    .maybeSingle();

  if (configError) {
    return NextResponse.json({ error: configError.message ?? "Failed to load shared state" }, { status: 500 });
  }

  let memoRow: { workspace_memo?: string | null; workspace_memo_updated_at?: string | null; workspace_memo_updated_by?: string | null } | null = null;
  const { data: memoData, error: memoError } = await supabase
    .from("app_config")
    .select("workspace_memo, workspace_memo_updated_at, workspace_memo_updated_by")
    .eq("id", "global")
    .maybeSingle();
  if (!memoError && memoData) {
    memoRow = memoData;
  }

  // Loaded separately so a missing column (pre-migration deploys) degrades
  // gracefully to localStorage-based sync instead of failing the whole GET.
  let signatureRow: { last_synced_catalog_signature?: string | null } | null = null;
  const { data: signatureData, error: signatureError } = await supabase
    .from("app_config")
    .select("last_synced_catalog_signature")
    .eq("id", "global")
    .maybeSingle();
  if (!signatureError && signatureData) {
    signatureRow = signatureData;
  }

  // 패밀리사 명단 — 마이그레이션 008 전이면(컬럼 없음) 조용히 생략하고
  // 클라이언트는 코드 내장 기본 명단으로 동작한다.
  let familyRow: { family_companies?: unknown; family_companies_updated_at?: string | null; family_companies_updated_by?: string | null } | null = null;
  const { data: familyData, error: familyError } = await supabase
    .from("app_config")
    .select("family_companies, family_companies_updated_at, family_companies_updated_by")
    .eq("id", "global")
    .maybeSingle();
  if (!familyError && familyData) {
    familyRow = familyData;
  }

  const response: SharedStateResponse = {
    config: deserializeSharedConfig({ ...(configRow ?? {}), ...(memoRow ?? {}), ...(signatureRow ?? {}), ...(familyRow ?? {}) }),
    datasets: []
  };

  return NextResponse.json(response);
}

type SharedStatePutBody = {
  config?: Partial<SharedStateResponse["config"]>;
  memo?: { value: string };
  syncSignature?: { value: string };
  familyCompanies?: { value: string[] };
};

export async function PUT(request: Request) {
  const { supabase, user } = await requireAuthorizedUser();
  if (!user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null) as SharedStatePutBody | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const hasConfigUpdate = !!body.config
    && (body.config.logicConfig !== undefined
      || body.config.companyConfigs !== undefined);

  const hasMemoUpdate = !!body.memo && typeof body.memo.value === "string";

  const hasSignatureUpdate = !!body.syncSignature && typeof body.syncSignature.value === "string";

  const hasFamilyUpdate = !!body.familyCompanies
    && Array.isArray(body.familyCompanies.value)
    && body.familyCompanies.value.every((v) => typeof v === "string");

  if (!hasConfigUpdate && !hasMemoUpdate && !hasSignatureUpdate && !hasFamilyUpdate) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const nowIso = new Date().toISOString();

  if (hasConfigUpdate) {
    const serializedConfig = serializeSharedConfig(body.config as SharedStateResponse["config"]);
    const { error } = await supabase
      .from("app_config")
      .upsert({
        id: "global",
        ...serializedConfig,
        updated_at: nowIso,
        updated_by: user.email
      }, { onConflict: "id" });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    await supabase.from("change_logs").insert({
      action: "config_updated",
      target_type: "app_config",
      target_id: "global",
      payload: {},
      created_by: user.email
    });
  }

  if (hasMemoUpdate) {
    const memoValue = body.memo!.value;
    const { error } = await supabase
      .from("app_config")
      .upsert({
        id: "global",
        workspace_memo: memoValue,
        workspace_memo_updated_at: nowIso,
        workspace_memo_updated_by: user.email,
        updated_at: nowIso,
        updated_by: user.email
      }, { onConflict: "id" });

    if (error) {
      const message = error.message ?? "";
      const columnMissing = /workspace_memo/i.test(message) && /(does not exist|column)/i.test(message);
      if (columnMissing) {
        return NextResponse.json({ ok: false, reason: "memo_columns_missing", error: message });
      }
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  if (hasSignatureUpdate) {
    const { error } = await supabase
      .from("app_config")
      .upsert({
        id: "global",
        last_synced_catalog_signature: body.syncSignature!.value,
        updated_at: nowIso,
        updated_by: user.email
      }, { onConflict: "id" });

    if (error) {
      const message = error.message ?? "";
      const columnMissing = /last_synced_catalog_signature/i.test(message) && /(does not exist|column)/i.test(message);
      if (columnMissing) {
        return NextResponse.json({ ok: false, reason: "signature_column_missing", error: message });
      }
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  if (hasFamilyUpdate) {
    const familyValue = body.familyCompanies!.value.map((v) => v.trim()).filter(Boolean);
    const { error } = await supabase
      .from("app_config")
      .upsert({
        id: "global",
        family_companies: familyValue,
        family_companies_updated_at: nowIso,
        family_companies_updated_by: user.email,
        updated_at: nowIso,
        updated_by: user.email
      }, { onConflict: "id" });

    if (error) {
      const message = error.message ?? "";
      const columnMissing = /family_companies/i.test(message) && /(does not exist|column)/i.test(message);
      if (columnMissing) {
        return NextResponse.json({ ok: false, reason: "family_columns_missing", error: message });
      }
      return NextResponse.json({ error: message }, { status: 500 });
    }

    await supabase.from("change_logs").insert({
      action: "family_companies_updated",
      target_type: "app_config",
      target_id: "global",
      payload: { count: familyValue.length },
      created_by: user.email
    });
  }

  return NextResponse.json({ ok: true, updatedAt: nowIso, updatedBy: user.email });
}
