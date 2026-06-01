/**
 * 계정트리 동기화 서버 유틸.
 * 시트 → 검증 → 캐시(app_config.classification_tree) 흐름의 시트 읽기·캐시 직렬화 부분.
 * 검증·조회 로직 자체는 account-tree.ts (parseAccountTree)에 있다.
 */
import { getTreeSheetsConfig } from "@/lib/google-sheets";
import { parseAccountTree, normalizeAccountName, type ParsedAccountTree } from "@/lib/validation/account-tree";

export type ClassificationTreeCache = {
  values: string[][]; // 검증 통과한 시트 스냅샷 (last-good). 앱은 이걸 parseAccountTree로 복원.
  syncedAt: string;
  syncedBy: string | null;
  stats: ParsedAccountTree["stats"];
  warningCount: number;
};

/** 트리 시트(통합 탭) 전체를 읽어 문자열 2차원 배열로 반환. */
export async function readTreeSheetValues(): Promise<string[][]> {
  const config = getTreeSheetsConfig();
  if (!config) {
    throw new Error("구글시트 서비스계정 설정이 없습니다 (GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL / GOOGLE_SHEETS_PRIVATE_KEY).");
  }
  const res = await config.sheets.spreadsheets.values.get({
    spreadsheetId: config.spreadsheetId,
    range: `${config.tabName}!A1:I`
  });
  return (res.data.values ?? []) as string[][];
}

/** 검증 통과한 트리 + 시트값으로 캐시 객체를 만든다. */
export function buildTreeCache(values: string[][], tree: ParsedAccountTree, syncedBy: string | null, syncedAt: string): ClassificationTreeCache {
  return {
    values,
    syncedAt,
    syncedBy,
    stats: tree.stats,
    warningCount: tree.warnings.length
  };
}

/** 캐시(또는 갓 읽은 시트값)에서 조회 가능한 트리를 복원. */
export function treeFromCache(cache: Pick<ClassificationTreeCache, "values">): ParsedAccountTree {
  return parseAccountTree(cache.values);
}

export type PendingAppendRow = {
  l1: string;        // 대분류(B) — 매핑된 가지, 미정이면 "미분류"
  l2: string;        // 중분류(C) — 매핑되면 채움
  accountName: string; // 계정명(F)
  source: string;    // 출처(J) — "회사 YYMM, …"
};

/**
 * 미분류 pending 행을 트리 시트(통합 탭) 맨 밑에 append.
 *  - 코드(A)·소/세분류(D,E)·부호(G)·차대(H)·변동고정(I) 비움 = 분류 대기.
 *  - 계정명은 F열, 출처는 J열(파서는 A~I만 읽어 J 무시).
 *  - 시트에 이미 있는 계정명(leaf든 pending이든)은 dedup으로 skip → 여러 번 돌려도 안전.
 *  - 파서가 forward-fill 안 하고 각 행 자기 l1/l2로 귀속하므로 맨 밑 배치로 충분.
 */
export async function appendPendingRows(rows: PendingAppendRow[]): Promise<{ appended: number; skipped: number; names: string[] }> {
  const config = getTreeSheetsConfig();
  if (!config) {
    throw new Error("구글시트 서비스계정 설정이 없습니다 (GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL / GOOGLE_SHEETS_PRIVATE_KEY).");
  }
  const res = await config.sheets.spreadsheets.values.get({
    spreadsheetId: config.spreadsheetId,
    range: `${config.tabName}!A1:J`
  });
  const values = (res.data.values ?? []) as string[][];

  // 기존 계정명(F=index5) — 정규화 dedup 집합
  const existing = new Set<string>();
  for (let i = 1; i < values.length; i++) {
    const name = (values[i]?.[5] ?? "").trim();
    if (name) existing.add(normalizeAccountName(name));
  }

  const toAppend: string[][] = [];
  const names: string[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const r of rows) {
    const key = normalizeAccountName(r.accountName);
    if (!key || existing.has(key) || seen.has(key)) { skipped++; continue; }
    seen.add(key);
    names.push(r.accountName);
    // A코드, B대분류, C중분류, D소분류, E세분류, F계정명, G부호, H차대, I변동고정, J출처
    toAppend.push(["", r.l1 ?? "", r.l2 ?? "", "", "", r.accountName, "", "", "", r.source ?? ""]);
  }

  if (!toAppend.length) return { appended: 0, skipped, names: [] };

  // J1 출처 헤더가 비어 있으면 한 번 채워 둔다(사람이 시트에서 보기 좋게).
  if (!(values[0]?.[9] ?? "").trim()) {
    await config.sheets.spreadsheets.values.update({
      spreadsheetId: config.spreadsheetId,
      range: `${config.tabName}!J1`,
      valueInputOption: "RAW",
      requestBody: { values: [["출처"]] }
    });
  }

  await config.sheets.spreadsheets.values.append({
    spreadsheetId: config.spreadsheetId,
    range: `${config.tabName}!A:J`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: toAppend }
  });

  return { appended: toAppend.length, skipped, names };
}
