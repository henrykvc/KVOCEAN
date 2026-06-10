import { NextResponse } from "next/server";
import type { sheets_v4 } from "googleapis";
import { createClient } from "@/lib/supabase/server";
import { getAllowedUser } from "@/lib/supabase/access";
import { getSheetsConfig, getSheetsEnvDiagnostics, type SheetsConfig } from "@/lib/google-sheets";
import type { SheetCellValue } from "@/lib/sheets-export";

export const runtime = "nodejs";

async function requireAuthorizedUser() {
  const supabase = createClient();
  const user = await getAllowedUser(supabase).catch(() => null);
  if (!user) return { supabase, user: null };
  return { supabase, user };
}

type QuarterTab = {
  tabName: string;
  headers: string[];
  rows: SheetCellValue[][];
};

type SyncBody = {
  quarterTabs?: QuarterTab[];
};

async function ensureSheetTabs(config: SheetsConfig, requiredTabNames: string[]) {
  const meta = await config.sheets.spreadsheets.get({
    spreadsheetId: config.spreadsheetId,
    fields: "sheets.properties(sheetId,title)"
  });
  const existingTitles = new Set<string>(
    (meta.data.sheets ?? [])
      .map((s) => s.properties?.title)
      .filter((t): t is string => typeof t === "string")
  );

  const toCreate = requiredTabNames.filter((name) => !existingTitles.has(name));
  if (!toCreate.length) return;

  const requests: sheets_v4.Schema$Request[] = toCreate.map((title) => ({
    addSheet: { properties: { title } }
  }));
  await config.sheets.spreadsheets.batchUpdate({
    spreadsheetId: config.spreadsheetId,
    requestBody: { requests }
  });
}

async function writeQuarterTab(
  config: SheetsConfig,
  tab: QuarterTab
) {
  await config.sheets.spreadsheets.values.clear({
    spreadsheetId: config.spreadsheetId,
    range: `${tab.tabName}!A1:ZZ`
  });

  const values: SheetCellValue[][] = [tab.headers, ...tab.rows];
  if (!values.length) return;

  await config.sheets.spreadsheets.values.update({
    spreadsheetId: config.spreadsheetId,
    range: `${tab.tabName}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: values.map((row) => row.map((cell) => (cell === null ? "" : cell)))
    }
  });
}

// 결과물 동기화 대상 구글시트 링크를 클라이언트에 알려준다(버튼 옆 링크용).
export async function GET() {
  const { user } = await requireAuthorizedUser();
  if (!user?.email) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const config = getSheetsConfig();
  if (!config) {
    return NextResponse.json({ ok: false, reason: "disabled" });
  }
  return NextResponse.json({
    ok: true,
    spreadsheetId: config.spreadsheetId,
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${config.spreadsheetId}/edit`
  });
}

export async function POST(request: Request) {
  const { user } = await requireAuthorizedUser();
  if (!user?.email) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null) as SyncBody | null;
  const quarterTabs = body?.quarterTabs ?? [];

  if (!Array.isArray(quarterTabs) || !quarterTabs.length) {
    return NextResponse.json({ ok: false, error: "보낼 분기 데이터가 없습니다." }, { status: 400 });
  }

  const config = getSheetsConfig();
  if (!config) {
    return NextResponse.json({ ok: false, reason: "disabled", env: getSheetsEnvDiagnostics() });
  }

  try {
    await ensureSheetTabs(config, quarterTabs.map((t) => t.tabName));

    let totalRows = 0;
    for (const tab of quarterTabs) {
      await writeQuarterTab(config, tab);
      totalRows += tab.rows.length;
    }

    return NextResponse.json({
      ok: true,
      tabsWritten: quarterTabs.length,
      rowsTotal: totalRows
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "구글시트 동기화에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message });
  }
}
