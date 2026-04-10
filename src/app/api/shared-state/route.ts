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

  const response: SharedStateResponse = {
    config: deserializeSharedConfig(configRow),
    datasets: []
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

  return NextResponse.json({ ok: true });
}
