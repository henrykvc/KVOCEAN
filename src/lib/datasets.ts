import type { SupabaseClient } from "@supabase/supabase-js";
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

/**
 * Strip legacy fields (logicConfig/companyConfigs/classificationGroups/
 * sessionSignFixes) off any incoming source. 분류DB is now the live source of
 * truth — older rows still carry these in Supabase, but we drop them on the
 * way in so nothing downstream is tempted to use stale rules. Once a dataset
 * is re-saved (manually or via the boot-time sync) the row in Supabase loses
 * those fields permanently.
 */
function sanitizeSource(raw: unknown): SavedQuarterSnapshot["source"] {
  const obj = (raw && typeof raw === "object") ? raw as Record<string, unknown> : {};
  return {
    pastedText: typeof obj.pastedText === "string" ? obj.pastedText : "",
    tolerance: typeof obj.tolerance === "number" ? obj.tolerance : 1,
    pasteEdits: (obj.pasteEdits && typeof obj.pasteEdits === "object") ? obj.pasteEdits as Record<string, number> : {},
    nameEdits: (obj.nameEdits && typeof obj.nameEdits === "object") ? obj.nameEdits as Record<string, string> : {},
    statementType: typeof obj.statementType === "string" ? obj.statementType : undefined
  };
}

export function mapDatasetRow(item: DatasetRow): SavedQuarterSnapshot {
  return {
    id: item.id,
    companyName: item.company_name,
    quarterKey: item.quarter_key,
    quarterLabel: item.quarter_label,
    savedAt: item.saved_at,
    rawStatementRows: Array.isArray(item.raw_statement_rows) ? item.raw_statement_rows as SavedQuarterSnapshot["rawStatementRows"] : [],
    adjustedStatementRows: Array.isArray(item.adjusted_statement_rows) ? item.adjusted_statement_rows as SavedQuarterSnapshot["adjustedStatementRows"] : [],
    source: sanitizeSource(item.source)
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
