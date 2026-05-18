import { NextResponse } from "next/server";
import type { sheets_v4 } from "googleapis";
import { createClient } from "@/lib/supabase/server";
import { getAllowedUser } from "@/lib/supabase/access";
import { loadDatasets } from "@/lib/datasets";
import { buildCompanyReport, type ReportingModel, type SavedQuarterSnapshot } from "@/lib/validation/report";
import { getSheetsConfig, type SheetsConfig } from "@/lib/google-sheets";
import {
  buildHeaderRow,
  buildQuarterRows,
  collectDistinctQuarters,
  toSheetTabName,
  type SheetCellValue
} from "@/lib/sheets-export";

export const runtime = "nodejs";

async function requireAuthorizedUser() {
  const supabase = createClient();
  const user = await getAllowedUser(supabase).catch(() => null);
  if (!user) return { supabase, user: null };
  return { supabase, user };
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

async function ensureSheetTabs(config: SheetsConfig, requiredTabNames: string[]): Promise<Set<string>> {
  const meta = await config.sheets.spreadsheets.get({
    spreadsheetId: config.spreadsheetId,
    fields: "sheets.properties(sheetId,title)"
  });
  const existingTitles = new Set<string>(
    (meta.data.sheets ?? [])
      .map((s) => s.properties?.title)
      .filter((t): t is string => typeof t === "string")
  );

  const tabsToCreate = requiredTabNames.filter((name) => !existingTitles.has(name));
  if (tabsToCreate.length) {
    const requests: sheets_v4.Schema$Request[] = tabsToCreate.map((title) => ({
      addSheet: { properties: { title } }
    }));
    await config.sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.spreadsheetId,
      requestBody: { requests }
    });
    tabsToCreate.forEach((t) => existingTitles.add(t));
  }
  return existingTitles;
}

async function writeQuarterTab(
  config: SheetsConfig,
  tabName: string,
  headers: string[],
  rows: SheetCellValue[][]
) {
  // Clear the tab first to avoid stale rows when a company is removed.
  await config.sheets.spreadsheets.values.clear({
    spreadsheetId: config.spreadsheetId,
    range: `${tabName}!A1:ZZ`
  });

  const values: SheetCellValue[][] = [headers, ...rows];
  if (!values.length) return;

  await config.sheets.spreadsheets.values.update({
    spreadsheetId: config.spreadsheetId,
    range: `${tabName}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: values.map((row) => row.map((cell) => (cell === null ? "" : cell)))
    }
  });
}

export async function POST(request: Request) {
  const { supabase, user } = await requireAuthorizedUser();
  if (!user?.email) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  // We always do full bulk sync now (single-company partial syncs no longer make
  // sense with the per-quarter tab structure — each tab spans all companies).
  await request.json().catch(() => null);

  const config = getSheetsConfig();
  if (!config) {
    return NextResponse.json({ ok: false, reason: "disabled" });
  }

  try {
    const { datasets } = await loadDatasets(supabase);
    const byCompany = groupByCompany(datasets);
    if (!byCompany.size) {
      return NextResponse.json({ ok: false, error: "동기화할 회사 데이터가 없습니다." }, { status: 404 });
    }

    // Build per-company reports.
    const companyReports = new Map<string, ReportingModel>();
    for (const [companyName, snapshots] of byCompany.entries()) {
      companyReports.set(companyName, buildCompanyReport(snapshots));
    }

    // Distinct quarters across all companies.
    const quarters = collectDistinctQuarters(Array.from(companyReports.values()));
    if (!quarters.length) {
      return NextResponse.json({ ok: false, error: "분기 데이터가 없습니다." }, { status: 404 });
    }

    const headers = buildHeaderRow();

    // Ensure all required tabs exist.
    const requiredTabs = quarters.map((q) => toSheetTabName(q.key));
    await ensureSheetTabs(config, requiredTabs);

    // Write each quarter's tab.
    let totalRows = 0;
    const writtenTabs: Array<{ tab: string; rows: number }> = [];
    for (const quarter of quarters) {
      const tabName = toSheetTabName(quarter.key);
      const rows = buildQuarterRows({
        quarterKey: quarter.key,
        companyReports
      });
      await writeQuarterTab(config, tabName, headers, rows);
      totalRows += rows.length;
      writtenTabs.push({ tab: tabName, rows: rows.length });
    }

    return NextResponse.json({
      ok: true,
      tabsWritten: writtenTabs.length,
      companies: byCompany.size,
      rowsTotal: totalRows,
      details: writtenTabs
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "구글시트 동기화에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message });
  }
}
