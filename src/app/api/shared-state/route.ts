import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAllowedUser } from "@/lib/supabase/access";
import { deserializeSharedConfig, serializeSharedConfig, type SharedStateResponse } from "@/lib/shared-state";
import type { SavedQuarterSnapshot } from "@/lib/validation/report";

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

  const [{ data: configRow, error: configError }, { data: datasetRows, error: datasetError }] = await Promise.all([
    supabase
      .from("app_config")
      .select("logic_config, company_configs, classification_catalog")
      .eq("id", "global")
      .maybeSingle(),
    supabase
      .from("datasets")
      .select("id, company_name, quarter_key, quarter_label, saved_at, raw_statement_rows, adjusted_statement_rows, source")
      .order("company_name", { ascending: true })
  ]);

  if (configError || datasetError) {
    return NextResponse.json({ error: configError?.message ?? datasetError?.message ?? "Failed to load shared state" }, { status: 500 });
  }

  const response: SharedStateResponse = {
    config: deserializeSharedConfig(configRow),
    datasets: (datasetRows ?? []).map((item) => ({
      id: item.id,
      companyName: item.company_name,
      quarterKey: item.quarter_key,
      quarterLabel: item.quarter_label,
      savedAt: item.saved_at,
      rawStatementRows: Array.isArray(item.raw_statement_rows) ? item.raw_statement_rows : [],
      adjustedStatementRows: Array.isArray(item.adjusted_statement_rows) ? item.adjusted_statement_rows : [],
      source: item.source ?? {}
    })) as SavedQuarterSnapshot[]
  };

  return NextResponse.json(response);
}

export async function PUT(request: Request) {
  const { supabase, user } = await requireAuthorizedUser();
  if (!user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null) as Partial<SharedStateResponse> | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  if (body.config) {
    const serializedConfig = serializeSharedConfig(body.config);
    const { error } = await supabase
      .from("app_config")
      .upsert({
        id: "global",
        ...serializedConfig,
        updated_at: new Date().toISOString(),
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

  if (body.datasets) {
    const datasets = body.datasets;
    const normalizedIds = datasets.map((item) => item.id);
    const { data: existingRows, error: existingError } = await supabase.from("datasets").select("id");
    if (existingError) {
      return NextResponse.json({ error: existingError.message }, { status: 500 });
    }

    const removableIds = (existingRows ?? [])
      .map((item) => item.id)
      .filter((id) => !normalizedIds.includes(id));

    if (removableIds.length) {
      const { error } = await supabase.from("datasets").delete().in("id", removableIds);
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
    }

    if (datasets.length) {
      const rows = datasets.map((item) => ({
        id: item.id,
        company_name: item.companyName,
        quarter_key: item.quarterKey,
        quarter_label: item.quarterLabel,
        saved_at: item.savedAt,
        saved_by: user.email,
        raw_statement_rows: item.rawStatementRows,
        adjusted_statement_rows: item.adjustedStatementRows,
        source: item.source
      }));

      const { error } = await supabase.from("datasets").upsert(rows, { onConflict: "id" });
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
    }

    await supabase.from("change_logs").insert({
      action: "datasets_synced",
      target_type: "datasets",
      payload: {
        count: datasets.length,
        removedCount: removableIds.length
      },
      created_by: user.email
    });
  }

  return NextResponse.json({ ok: true });
}
