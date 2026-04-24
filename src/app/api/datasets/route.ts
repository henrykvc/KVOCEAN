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

  if (!user) {
    return { supabase, user: null };
  }

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

function toDatasetRow(snapshot: SavedQuarterSnapshot, savedBy?: string | null) {
  return {
    id: snapshot.id,
    company_name: snapshot.companyName,
    quarter_key: snapshot.quarterKey,
    quarter_label: snapshot.quarterLabel,
    saved_at: snapshot.savedAt,
    saved_by: savedBy ?? null,
    raw_statement_rows: snapshot.rawStatementRows,
    adjusted_statement_rows: snapshot.adjustedStatementRows,
    source: snapshot.source,
    is_deleted: false,
    deleted_at: null,
    deleted_by: null
  };
}

export async function loadDatasets(supabase: ReturnType<typeof createClient>) {
  const { data, error } = await supabase
    .from("datasets")
    .select("id, company_name, quarter_key, quarter_label, saved_at, raw_statement_rows, adjusted_statement_rows, source, is_deleted")
    .order("company_name", { ascending: true })
    .order("quarter_key", { ascending: false });

  if (error) throw error;

  const active: SavedQuarterSnapshot[] = [];
  const trashed: SavedQuarterSnapshot[] = [];

  for (const item of (data ?? []) as DatasetRow[]) {
    const mapped = mapDatasetRow(item);
    if (item.is_deleted) {
      trashed.push(mapped);
    } else {
      active.push(mapped);
    }
  }

  return { datasets: active, trashedDatasets: trashed } satisfies DatasetApiResponse;
}

export async function GET() {
  const { supabase, user } = await requireAuthorizedUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    return NextResponse.json(await loadDatasets(supabase));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "저장 데이터를 불러오지 못했습니다." }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const { supabase, user } = await requireAuthorizedUser();
  if (!user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null) as { snapshots?: SavedQuarterSnapshot[]; validatedText?: string } | null;
  const snapshots = body?.snapshots ?? [];
  const validatedText = body?.validatedText ?? "";

  if (!Array.isArray(snapshots) || !snapshots.length) {
    return NextResponse.json({ error: "저장할 데이터가 없습니다." }, { status: 400 });
  }

  try {
    const rows = snapshots
      .map((snapshot) => normalizeSavedQuarterSnapshot(snapshot))
      .map((snapshot) => toDatasetRow(snapshot, user.email));

    const { error } = await supabase.from("datasets").upsert(rows, { onConflict: "id" });
    if (error) {
      throw error;
    }

    await supabase.from("change_logs").insert({
      action: "dataset_saved",
      target_type: "datasets",
      target_id: snapshots[0].id,
      payload: {
        companyName: snapshots[0].companyName,
        quarterKey: snapshots[0].quarterKey,
        snapshotCount: snapshots.length,
        validatedTextLength: validatedText.length
      },
      created_by: user.email
    });

    return NextResponse.json(await loadDatasets(supabase));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "데이터 저장에 실패했습니다." }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const { supabase, user } = await requireAuthorizedUser();
  if (!user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null) as Pick<SavedQuarterSnapshot, "id" | "companyName" | "quarterKey"> | null;
  if (!body?.id || !body?.companyName || !body?.quarterKey) {
    return NextResponse.json({ error: "삭제할 대상 정보가 없습니다." }, { status: 400 });
  }

  try {
    const { error } = await supabase
      .from("datasets")
      .update({
        is_deleted: true,
        deleted_at: new Date().toISOString(),
        deleted_by: user.email
      })
      .eq("id", body.id);

    if (error) {
      throw error;
    }

    await supabase.from("change_logs").insert({
      action: "dataset_soft_deleted",
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
    return NextResponse.json({ error: error instanceof Error ? error.message : "데이터 삭제에 실패했습니다." }, { status: 500 });
  }
}
