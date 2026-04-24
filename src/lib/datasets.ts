import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_CLASSIFICATION_GROUPS, DEFAULT_COMPANY_CONFIGS, DEFAULT_LOGIC_CONFIG } from "@/lib/validation/defaults";
import type { SavedQuarterSnapshot } from "@/lib/validation/report";

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

export type DatasetApiResponse = {
  datasets: SavedQuarterSnapshot[];
  trashedDatasets: SavedQuarterSnapshot[];
};

export function mapDatasetRow(item: DatasetRow): SavedQuarterSnapshot {
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
    rawStatementRows: Array.isArray(item.raw_statement_rows) ? item.raw_statement_rows as SavedQuarterSnapshot["rawStatementRows"] : [],
    adjustedStatementRows: Array.isArray(item.adjusted_statement_rows) ? item.adjusted_statement_rows as SavedQuarterSnapshot["adjustedStatementRows"] : [],
    source
  };
}

export async function loadDatasets(supabase: SupabaseClient): Promise<DatasetApiResponse> {
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

  return { datasets: active, trashedDatasets: trashed };
}
