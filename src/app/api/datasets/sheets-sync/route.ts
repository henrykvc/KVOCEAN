import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { getAllowedUser } from "@/lib/supabase/access";
import { loadDatasets } from "@/lib/datasets";
import { buildCompanyReport, type SavedQuarterSnapshot } from "@/lib/validation/report";
import { getSheetsConfig, type SheetsConfig } from "@/lib/google-sheets";
import {
  buildCompanyDataRows,
  buildMetricColumns,
  mergeSheetState,
  parseExistingSheet,
  type ExistingSheetState,
  type SheetCellValue
} from "@/lib/sheets-export";

export const runtime = "nodejs";

async function requireAuthorizedUser() {
  const supabase = createClient();
  const user = await getAllowedUser(supabase).catch(() => null);
  if (!user) return { supabase, user: null };
  return { supabase, user };
}

async function readExistingSheet(config: SheetsConfig): Promise<ExistingSheetState> {
  const range = `${config.sheetName}!A1:ZZ`;
  try {
    const existing = await config.sheets.spreadsheets.values.get({
      spreadsheetId: config.spreadsheetId,
      range,
      valueRenderOption: "UNFORMATTED_VALUE"
    });
    const values = (existing.data.values as unknown[][] | undefined) ?? undefined;
    return parseExistingSheet(values);
  } catch (err: unknown) {
    const status = (err as { code?: number; status?: number; response?: { status?: number } } | null)?.code
      ?? (err as { status?: number } | null)?.status
      ?? (err as { response?: { status?: number } } | null)?.response?.status;
    if (status !== 400) {
      throw err;
    }
    try {
      await config.sheets.spreadsheets.batchUpdate({
        spreadsheetId: config.spreadsheetId,
        requestBody: {
          requests: [{ addSheet: { properties: { title: config.sheetName } } }]
        }
      });
    } catch {
      // sheet may already exist if race; ignore
    }
    return parseExistingSheet(undefined);
  }
}

async function writeFinalSheet(config: SheetsConfig, headers: string[], rows: SheetCellValue[][]) {
  await config.sheets.spreadsheets.values.clear({
    spreadsheetId: config.spreadsheetId,
    range: `${config.sheetName}!A1:ZZ`
  });

  const values: SheetCellValue[][] = [headers, ...rows];
  if (!values.length) return;

  await config.sheets.spreadsheets.values.update({
    spreadsheetId: config.spreadsheetId,
    range: `${config.sheetName}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: values.map((row) => row.map((cell) => (cell === null ? "" : cell)))
    }
  });
}

function mergeOneCompany(
  existing: ExistingSheetState,
  companyName: string,
  companySnapshots: SavedQuarterSnapshot[]
): { state: ExistingSheetState; rowCount: number } {
  const report = buildCompanyReport(companySnapshots);
  const metricColumns = buildMetricColumns(report);
  const newDataRows = buildCompanyDataRows(report, metricColumns);
  const merged = mergeSheetState({
    existing,
    companyName,
    newMetricColumns: metricColumns,
    newDataRows
  });
  return { state: { headers: merged.headers, rows: merged.rows }, rowCount: newDataRows.length };
}

async function loadAndFilterDatasets(supabase: SupabaseClient, companyName?: string) {
  const { datasets } = await loadDatasets(supabase);
  if (!companyName) return { datasets, byCompany: groupByCompany(datasets) };
  const filtered = datasets.filter((d) => d.companyName === companyName);
  return { datasets: filtered, byCompany: new Map([[companyName, filtered]]) };
}

function groupByCompany(datasets: SavedQuarterSnapshot[]) {
  const map = new Map<string, SavedQuarterSnapshot[]>();
  for (const d of datasets) {
    const name = (d.companyName ?? "").trim();
    if (!name) continue;
    const existing = map.get(name) ?? [];
    existing.push(d);
    map.set(name, existing);
  }
  return map;
}

export async function POST(request: Request) {
  const { supabase, user } = await requireAuthorizedUser();
  if (!user?.email) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null) as { companyName?: string; all?: boolean } | null;
  const requestedCompany = body?.companyName?.trim();
  const bulkAll = body?.all === true;

  if (!bulkAll && !requestedCompany) {
    return NextResponse.json({ ok: false, error: "companyName 또는 all:true가 필요합니다." }, { status: 400 });
  }

  const config = getSheetsConfig();
  if (!config) {
    return NextResponse.json({ ok: false, reason: "disabled" });
  }

  try {
    const { byCompany } = await loadAndFilterDatasets(supabase, bulkAll ? undefined : requestedCompany);
    if (!byCompany.size) {
      return NextResponse.json({ ok: false, error: "동기화할 회사 데이터가 없습니다." }, { status: 404 });
    }

    let state = await readExistingSheet(config);
    let totalRowCount = 0;
    const syncedCompanies: string[] = [];

    for (const [companyName, companySnapshots] of byCompany.entries()) {
      const { state: nextState, rowCount } = mergeOneCompany(state, companyName, companySnapshots);
      state = nextState;
      totalRowCount += rowCount;
      syncedCompanies.push(companyName);
    }

    await writeFinalSheet(config, state.headers, state.rows);

    return NextResponse.json({
      ok: true,
      mode: bulkAll ? "bulk" : "single",
      companies: syncedCompanies,
      companyCount: syncedCompanies.length,
      rowCount: totalRowCount,
      headerCount: state.headers.length
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "구글시트 동기화에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message });
  }
}
