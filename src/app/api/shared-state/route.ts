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
    .select("logic_config, company_configs, classification_catalog")
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

  const response: SharedStateResponse = {
    config: deserializeSharedConfig({ ...(configRow ?? {}), ...(memoRow ?? {}) }),
    datasets: []
  };

  return NextResponse.json(response);
}

type SharedStatePutBody = {
  config?: Partial<SharedStateResponse["config"]>;
  memo?: { value: string };
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
      || body.config.companyConfigs !== undefined
      || body.config.classificationCatalog !== undefined
      || body.config.classificationGroups !== undefined);

  const hasMemoUpdate = !!body.memo && typeof body.memo.value === "string";

  if (!hasConfigUpdate && !hasMemoUpdate) {
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
      payload: {
        classificationCatalogCount: serializedConfig.classification_catalog.length
      },
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

  return NextResponse.json({ ok: true, updatedAt: nowIso, updatedBy: user.email });
}
