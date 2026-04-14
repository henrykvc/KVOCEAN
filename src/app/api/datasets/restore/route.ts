import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAllowedUser } from "@/lib/supabase/access";
import { DEFAULT_CLASSIFICATION_GROUPS, DEFAULT_COMPANY_CONFIGS, DEFAULT_LOGIC_CONFIG } from "@/lib/validation/defaults";
import { normalizeSavedQuarterSnapshot, type SavedQuarterSnapshot } from "@/lib/validation/report";

export const runtime = "nodejs";

type DatasetApiResponse = {
  datasets: SavedQuarterSnapshot[];
  trashedDatasets: SavedQuarterSnapshot[];
};

type DatasetRow = {
  id: string;
  company_name: string;
  quarter_key: string;
  quarter_label: string;
  saved_at: string;
  raw_statement_rows: unknown;
  adjusted_statement_rows: unknown;
  source: unknown;
  is_deleted: boolean | null;
};

async function requireAuthorizedUser() {
  const supabase = createClient();
  const user = await getAllowedUser(supabase).catch(() => null);
  return { supabase, user };
}

function mapDatasetRow(item: DatasetRow) {
  const source = (item.source && typeof item.source === "object") ? item.source as SavedQuarterSnapshot["source"] : {
    pastedText: "",
    tolerance: 1,
    pasteEdits: {},
    nameEdits: {},
    sessionSignFixes: {},
    logicConfig: structuredClone(DEFAULT_LOGIC_CONFIG),
    companyConfigs: structuredClone(DEFAULT_COMPANY_CONFIGS),
    classificationGroups: structuredClone(DEFAULT_CLASSIFICATION_GROUPS)
  };
  return {
    id: item.id,
    companyName: item.company_name,
    quarterKey: item.quarter_key,
    quarterLabel: item.quarter_label,
    savedAt: item.saved_at,
    rawStatementRows: Array.isArray(item.raw_statement_rows) ? item.raw_statement_rows : [],
    adjustedStatementRows: Array.isArray(item.adjusted_statement_rows) ? item.adjusted_statement_rows : [],
    source
  } satisfies SavedQuarterSnapshot;
}

async function loadDatasets(supabase: ReturnType<typeof createClient>) {
  const { data, error } = await supabase
    .from("datasets")
    .select("id, company_name, quarter_key, quarter_label, saved_at, raw_statement_rows, adjusted_statement_rows, source, is_deleted")
    .order("company_name", { ascending: true })
    .order("quarter_key", { ascending: false });

  if (error) {
    throw error;
  }

  const datasets: SavedQuarterSnapshot[] = [];
  const trashedDatasets: SavedQuarterSnapshot[] = [];

  for (const item of (data ?? []) as DatasetRow[]) {
    const mapped = normalizeSavedQuarterSnapshot(mapDatasetRow(item));
    if (item.is_deleted) {
      trashedDatasets.push(mapped);
    } else {
      datasets.push(mapped);
    }
  }

  return { datasets, trashedDatasets } satisfies DatasetApiResponse;
}

export async function POST(request: Request) {
  const { supabase, user } = await requireAuthorizedUser();
  if (!user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null) as Pick<SavedQuarterSnapshot, "id" | "companyName" | "quarterKey"> | null;
  if (!body?.id || !body?.companyName || !body?.quarterKey) {
    return NextResponse.json({ error: "복구할 대상 정보가 없습니다." }, { status: 400 });
  }

  try {
    const { error } = await supabase
      .from("datasets")
      .update({
        is_deleted: false,
        deleted_at: null,
        deleted_by: null
      })
      .eq("id", body.id);

    if (error) {
      throw error;
    }

    await supabase.from("change_logs").insert({
      action: "dataset_restored",
      target_type: "datasets",
      target_id: body.id,
      payload: {
        companyName: body.companyName,
        quarterKey: body.quarterKey
      },
      created_by: user.email
    });

    return NextResponse.json(await loadDatasets(supabase));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "데이터 복구에 실패했습니다." }, { status: 500 });
  }
}
