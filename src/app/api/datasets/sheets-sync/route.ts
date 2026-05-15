import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAllowedUser } from "@/lib/supabase/access";
import { loadDatasets } from "@/lib/datasets";
import { buildCompanyReport } from "@/lib/validation/report";
import { getSheetsConfig } from "@/lib/google-sheets";
import {
  buildCompanyDataRows,
  buildMetricColumns,
  mergeSheetState,
  parseExistingSheet,
  type SheetCellValue
} from "@/lib/sheets-export";

export const runtime = "nodejs";

async function requireAuthorizedUser() {
  const supabase = createClient();
  const user = await getAllowedUser(supabase).catch(() => null);
  if (!user) return { supabase, user: null };
  return { supabase, user };
}

export async function POST(request: Request) {
  const { supabase, user } = await requireAuthorizedUser();
  if (!user?.email) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null) as { companyName?: string } | null;
  const companyName = body?.companyName?.trim();
  if (!companyName) {
    return NextResponse.json({ ok: false, error: "companyName이 필요합니다." }, { status: 400 });
  }

  const config = getSheetsConfig();
  if (!config) {
    return NextResponse.json({ ok: false, reason: "disabled" });
  }

  try {
    const { datasets } = await loadDatasets(supabase);
    const companySnapshots = datasets.filter((d) => d.companyName === companyName);
    if (!companySnapshots.length) {
      return NextResponse.json({ ok: false, error: "해당 회사의 저장 데이터가 없습니다." }, { status: 404 });
    }

    const report = buildCompanyReport(companySnapshots);
    const metricColumns = buildMetricColumns(report);
    const newDataRows = buildCompanyDataRows(report, metricColumns);

    const range = `${config.sheetName}!A1:ZZ`;
    let existingValues: unknown[][] | undefined;
    try {
      const existing = await config.sheets.spreadsheets.values.get({
        spreadsheetId: config.spreadsheetId,
        range,
        valueRenderOption: "UNFORMATTED_VALUE"
      });
      existingValues = (existing.data.values as unknown[][] | undefined) ?? undefined;
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
      existingValues = undefined;
    }

    const merged = mergeSheetState({
      existing: parseExistingSheet(existingValues),
      companyName,
      newMetricColumns: metricColumns,
      newDataRows
    });

    const values: SheetCellValue[][] = [merged.headers, ...merged.rows];

    await config.sheets.spreadsheets.values.clear({
      spreadsheetId: config.spreadsheetId,
      range: `${config.sheetName}!A1:ZZ`
    });

    if (values.length) {
      await config.sheets.spreadsheets.values.update({
        spreadsheetId: config.spreadsheetId,
        range: `${config.sheetName}!A1`,
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: values.map((row) => row.map((cell) => (cell === null ? "" : cell)))
        }
      });
    }

    return NextResponse.json({
      ok: true,
      companyName,
      rowCount: newDataRows.length,
      headerCount: merged.headers.length
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "구글시트 동기화에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message });
  }
}

