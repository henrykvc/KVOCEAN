"use client";

import { Fragment, memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_COMPANY_CONFIGS,
  DEFAULT_LOGIC_CONFIG,
  isSystemFixedClassificationKey,
  type CompanyConfigs,
  type LogicConfig,
  type SignCode
} from "@/lib/validation/defaults";
import {
  buildCopyText,
  diagnoseDiff,
  expectedMajorCategories,
  formatNumber,
  getDefaultPersistedState,
  parsePersistedState,
  pasteEditKey,
  resolveAccountClassification,
  runValidation,
  safeFloat,
  type ValidationResult,
  type SessionSignFixes
} from "@/lib/validation/engine";
import { suggestTypoCandidates, type TypoCandidate, type VocabEntry } from "@/lib/validation/name-suggest";
import { type SharedStateResponse } from "@/lib/shared-state";
import { AccountTreeMirror } from "@/components/account-tree-mirror";
import { HenryFishingLoader, HenryLoadingDots } from "@/components/henry-fishing-loader";
import { DEFAULT_FAMILY_COMPANIES, computeFamilyCoverage } from "@/lib/family-companies";
import { buildTreeCatalogLookupFromRows, buildTreeKeywordCodeSets, buildTreeKeywordPrefixes } from "@/lib/validation/account-tree-adapter";
import { parseAccountTree, normalizeAccountName, type AccountTreeRow } from "@/lib/validation/account-tree";
import {
  buildHeaderRow as buildSheetsHeaderRow,
  buildQuarterRows as buildSheetsQuarterRows,
  collectDistinctQuarters as collectSheetsQuarters,
  collectReportMetrics as collectSheetsMetrics,
  toSheetTabName,
  type SheetCellValue,
  type AccountSource
} from "@/lib/sheets-export";
import {
  buildCompanyReport,
  buildQuarterSnapshots,
  buildReportingModel,
  rebuildSnapshotsWithTree,
  setReportKeywordCodeSets,
  formatMetricRatio,
  formatMetricValue,
  isTurnoverMetricLabel,
  normalizePasteEditsForValidation,
  type MetricCalculationInput,
  type FinalMetricRow,
  type MetricCalculationDetail,
  type ReportingModel,
  type SavedQuarterSnapshot,
  type StatementMatrixRow
} from "@/lib/validation/report";

type TabKey = "validate" | "data" | "trash" | "report" | "config" | "formulas" | "account-db";

// OCR 섹션 이름이 트리 가지 이름과 달라 매핑이 빗나갈 때 이어주는 별칭.
// (미분류 대분류·중분류 추정 + ③ 시트 append 가지 결정에 함께 쓰임)
// 예: OCR "영업비용" → 트리 "판매비와관리비", OCR "매출액" → 트리 "영업수익".
const SECTION_BRANCH_ALIASES: Record<string, string> = {
  [normalizeAccountName("영업비용")]: normalizeAccountName("판매비와관리비"),
  [normalizeAccountName("판관비")]: normalizeAccountName("판매비와관리비"),
  [normalizeAccountName("판매관리비")]: normalizeAccountName("판매비와관리비"),
  [normalizeAccountName("매출액")]: normalizeAccountName("영업수익"),
  [normalizeAccountName("매출")]: normalizeAccountName("영업수익")
};

type OverrideRow = {
  section: string;
  keyword: string;
  sign: SignCode;
};

type CapitalRuleRow = {
  account: string;
  sign: 0 | 1;
  parent: string;
};

type CapitalMemoRow = {
  account: string;
};

type DatasetApiResponse = {
  datasets: SavedQuarterSnapshot[];
  trashedDatasets: SavedQuarterSnapshot[];
};

function formatMemoTimestamp(iso: string | null | undefined) {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diffMs = Date.now() - t;
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return "방금 전";
  if (diffMin < 60) return `${diffMin}분 전`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}시간 전`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 7) return `${diffDay}일 전`;
  return new Date(iso).toLocaleDateString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" });
}

function parseDatasetApiResponse(raw: DatasetApiResponse) {
  return {
    datasets: sortSavedDatasets(parseSavedDatasets(JSON.stringify(raw.datasets))),
    trashedDatasets: sortSavedDatasets(parseSavedDatasets(JSON.stringify(raw.trashedDatasets)))
  };
}

/**
 * Build the per-quarter tabs payload from client state. Server just writes it
 * verbatim — so what goes into the sheet matches what the user sees on screen.
 */
function buildSheetsSyncPayload(
  savedDatasets: SavedQuarterSnapshot[],
  // 계정트리 로드 시 시트도 화면과 동일하게 read-time 재분류한다(① 컷오버).
  treeCtx?: Parameters<typeof rebuildSnapshotsWithTree>[1]
): { quarterTabs: Array<{ tabName: string; headers: string[]; rows: SheetCellValue[][] }> } {
  const byCompany = new Map<string, SavedQuarterSnapshot[]>();
  for (const d of savedDatasets) {
    const name = (d.companyName ?? "").trim();
    if (!name) continue;
    const existing = byCompany.get(name) ?? [];
    existing.push(d);
    byCompany.set(name, existing);
  }

  const companyReports = new Map<string, ReportingModel>();
  for (const [name, snaps] of byCompany.entries()) {
    const reportSnaps = treeCtx ? rebuildSnapshotsWithTree(snaps, treeCtx) : snaps;
    companyReports.set(name, buildCompanyReport(reportSnaps));
  }

  const reportsArr = Array.from(companyReports.values());
  const quarters = collectSheetsQuarters(reportsArr);
  const metrics = collectSheetsMetrics(reportsArr);
  const headers = buildSheetsHeaderRow(metrics);

  const quarterTabs = quarters.map((q) => ({
    tabName: toSheetTabName(q.key),
    headers,
    rows: buildSheetsQuarterRows({ quarterKey: q.key, companyReports, metrics })
  }));

  return { quarterTabs };
}

type ComparisonColumn = {
  slotId: string;
  datasetId: string;
  companyName: string;
  quarterLabel: string;
  periodKey: string;
  finalSections: ReportingModel["finalSections"];
};

type ComparisonSelection = {
  slotId: string;
  companyName: string;
  datasetId: string;
};

type TopViewKey = "menu" | "final-output";

const DEFAULT_INDUSTRY_OPTIONS = ["서비스", "게임", "기술", "헬스케어", "크립토"] as const;
const DEFAULT_ACCOUNTING_STANDARDS = ["K-GAAP", "IFRS"] as const;

// 3줄 OCR 데이터가 들어오는 원본 구글시트(OCR검토용 — 코드연결용시트/보정 탭). OCR검증 입력 패널 바로가기용.
const OCR_SOURCE_SHEET_URL = "https://docs.google.com/spreadsheets/d/1sKbhatzVFQKABl2dh1xaRZwbzFYARiPJLZ2MYMtVG2Y/edit";

type AccountingStandard = (typeof DEFAULT_ACCOUNTING_STANDARDS)[number];

type PendingInsertedRow = {
  section: string;
  accountName: string;
  value: string;
};

export type SectionAccountDbEntry = {
  entryKey: string;
  section: string;
  sectionKey: string;
  accountName: string;
  sampleCompany: string;
  sampleQuarter: string;
  occurrences: number;
  sources: Array<{
    datasetId: string;
    companyName: string;
    quarterLabel: string;
  }>;
};

type ValidatePreviewDraft = {
  section: string;
  accountName: string;
  value: string;
};

type ValidatePreviewItem = {
  sectionKey: string;
  accountName: string;
  colIndex: number;
  rowIndex: number;
  value: string | number | null;
  rawName: string;
  rawValue: number;
  locked: boolean;
};

type ValidatePreviewGroup = {
  rowIndex: number;
  rowLabel: string;
  items: ValidatePreviewItem[];
};

const ACCOUNT_DB_SECTIONS = {
  유동자산: ["유동자산"],
  비유동자산: ["비유동자산"],
  유동부채: ["유동부채"],
  비유동부채: ["비유동부채"],
  매출액: ["매출액", "수익", "영업수익"],
  매출원가: ["매출원가"],
  판매비와관리비: ["판매비와관리비", "판관비", "영업비용", "판매관리비", "판매비및관리비", "판매비와관리비합계"],
  영업외수익: ["영업외수익", "기타수익", "영업외수익합계", "금융수익"],
  영업외비용: ["영업외비용", "기타비용", "영업외비용합계", "금융비용"],
  기타: []
} as const;

const RATIO_ONLY_SECTION_TITLES = new Set(["안정성 비율", "수익성 비율", "성장성 비율"]);

const DETAIL_DEPRECIATION_ALIASES = ["감가상각비계"];
const DETAIL_VARIABLE_COST_ALIASES = [
  "매출원가",
  "외주용역비",
  "외주비",
  "지급수수료",
  "광고선전비",
  "배송비",
  "운반비",
  "수출제비용",
  "인건비",
  "복리후생비",
  "접대비",
  "연구개발비",
  "여비교통비",
  "통신비",
  "세금과공과금",
  "도서인쇄비",
  "소모품비",
  "대손상각비",
  "판매촉진비",
  "대외협력비",
  "행사비",
  "기술이전료",
  "경상기술료",
  "전산운영비",
  "반품비용",
  "기타변동비"
];
const DETAIL_BORROWING_ALIASES = ["차입금", "단기차입금", "장기차입금", "유동성장기차입금", "사채"];
const DETAIL_INTEREST_ALIASES = ["총이자비용", "이자비용", "금융비용"];
function renderDiagnosisText(text: string) {
  const parts = text.split("**");
  return parts.map((part, index) =>
    index % 2 === 1 ? <strong key={`${part}-${index}`}>{part}</strong> : <span key={`${part}-${index}`}>{part}</span>
  );
}

function buildReportMetricKey(sectionTitle: string, rowLabel: string) {
  return `${sectionTitle}::${rowLabel}`;
}

function formatCalculationInputValue(value: number | null) {
  if (value === null || value === undefined) {
    return "-";
  }

  return new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2 }).format(value);
}

function formatCalculationResult(kind: "amount" | "ratio" | "growthRate", row: FinalMetricRow, detail: MetricCalculationDetail) {
  if (detail.result === null || detail.result === undefined) {
    return "-";
  }

  if (kind === "amount") {
    return formatMetricValue(row, detail.result);
  }

  return `${detail.result.toFixed(1)}%`;
}

function groupPreviewRowsBySection(rows: SavedQuarterSnapshot["adjustedStatementRows"]) {
  const grouped = new Map<string, SavedQuarterSnapshot["adjustedStatementRows"]>();

  rows.forEach((row) => {
    const sectionKey = row.sectionKey.trim() || row.section.trim() || "기타";
    const current = grouped.get(sectionKey) ?? [];
    current.push(row);
    grouped.set(sectionKey, current);
  });

  return Array.from(grouped.entries());
}

function buildValidatePreviewGroups(args: {
  catRow: string[];
  nameRow: string[];
  editableNameRow: string[];
  dataRows: Array<Array<string | number | null>>;
}) {
  const effectiveSections = buildEffectiveSections(args.catRow, args.editableNameRow.length);
  const dateIndex = args.nameRow.findIndex((name) => ["날짜", "date", "Date"].includes(name));

  return args.dataRows.map((row, rowIndex) => {
    const labelCell = dateIndex >= 0 ? row[dateIndex] : null;
    const rowLabel = labelCell ? String(labelCell) : `데이터${rowIndex + 1}`;
    const items: ValidatePreviewItem[] = [];

    args.editableNameRow.forEach((accountName, colIndex) => {
      const sectionKey = effectiveSections[colIndex]?.trim() || "기타";
      const rawCell = args.dataRows[rowIndex]?.[colIndex];
      items.push({
        sectionKey,
        accountName,
        colIndex,
        rowIndex,
        value: row[colIndex],
        rawName: args.nameRow[colIndex] ?? accountName,
        rawValue: typeof rawCell === "number" ? rawCell : 0,
        locked: isLockedPreviewNameCell(args.nameRow[colIndex] ?? accountName)
      });
    });

    return {
      rowIndex,
      rowLabel,
      items
    } satisfies ValidatePreviewGroup;
  });
}

function normalizeMetricLabel(value: string) {
  return value.replace(/\s+/g, "").trim();
}

function stripMetricPrefix(value: string) {
  return value.replace(/^(당기|전기|전분기|비교전분기|차감:)\s*/g, "").trim();
}

function getInputAliasCandidates(label: string) {
  const normalized = normalizeMetricLabel(stripMetricPrefix(label));

  const aliasMap: Record<string, string[]> = {
    "자본총계": ["자본총계", "자본", "총자본"],
    "자산": ["자산", "자산총계", "총자산"],
    "부채": ["부채", "부채총계", "총부채"],
    "유동자산": ["유동자산"],
    "유동부채": ["유동부채"],
    "영업이익": ["영업이익", "영업이익(손실)"],
    "계속사업당기순이익": ["계속사업당기순이익", "당기순이익", "당기순손실"],
    "감가상각비계": DETAIL_DEPRECIATION_ALIASES,
    "변동비합계": DETAIL_VARIABLE_COST_ALIASES,
    "순차입금": DETAIL_BORROWING_ALIASES,
    "이자비용": DETAIL_INTEREST_ALIASES,
    "총이자비용": DETAIL_INTEREST_ALIASES,
    "당좌자산": ["당좌자산"],
    "매출채권": ["매출채권"],
    "재고자산": ["재고자산"]
  };

  return (aliasMap[normalized] ?? [stripMetricPrefix(label)]).map(normalizeMetricLabel);
}

type MapRow = {
  section: string;
  parent: string;
};

type ConfigRulesSnapshot = {
  logicConfig: LogicConfig;
  globalOverrideRows: OverrideRow[];
  pasteSectionRows: MapRow[];
  capitalRuleRows: CapitalRuleRow[];
  capitalMemoRows: CapitalMemoRow[];
  companyOverrideRows: OverrideRow[];
};

type PreviewGroup = {
  label: string;
  start: number;
  span: number;
  tone: number;
};

function cloneLogicConfig(config: LogicConfig): LogicConfig {
  try {
    return structuredClone(config);
  } catch {
    return structuredClone(DEFAULT_LOGIC_CONFIG);
  }
}

function cloneCompanyConfigs(configs: CompanyConfigs): CompanyConfigs {
  try {
    return structuredClone(configs);
  } catch {
    return structuredClone(DEFAULT_COMPANY_CONFIGS);
  }
}

function cloneSessionSignFixes(fixes: SessionSignFixes): SessionSignFixes {
  try {
    return structuredClone(fixes);
  } catch {
    return {};
  }
}

function parseKeywordList(value: string) {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeAccountDictionaryKey(value: string) {
  return value.trim().replace(/\s+/g, "").toLowerCase();
}

function isLockedPreviewNameCell(value: string) {
  return ["회사명", "회사", "법인명", "날짜", "date", "Date"].includes(value.trim());
}

function resolveAccountDbSection(sectionKey: string) {
  const normalizedSectionKey = normalizeAccountDictionaryKey(sectionKey);

  for (const [parentSection, aliases] of Object.entries(ACCOUNT_DB_SECTIONS)) {
    if (parentSection === "기타") {
      continue;
    }
    if (aliases.some((alias) => normalizeAccountDictionaryKey(alias) === normalizedSectionKey)) {
      return parentSection;
    }
  }

  return "기타";
}

function shouldCollectAccountDictionaryRow(row: SavedQuarterSnapshot["adjustedStatementRows"][number]) {
  const accountName = row.accountName.trim();
  const sectionKey = row.sectionKey.trim();
  const matchedSection = resolveAccountDbSection(sectionKey);
  const canonicalKey = row.canonicalKey.trim();

  if (!accountName || row.value === null || row.value === undefined) {
    return false;
  }

  if (!matchedSection) {
    return false;
  }

  if (normalizeAccountDictionaryKey(accountName) === normalizeAccountDictionaryKey(sectionKey)) {
    return false;
  }

  if (matchedSection === "기타" && (isSystemFixedClassificationKey(accountName) || isSystemFixedClassificationKey(canonicalKey))) {
    return false;
  }

  return true;
}

function extractAccountDictionaryEntries(savedDatasets: SavedQuarterSnapshot[]) {
  const entries = new Map<string, SectionAccountDbEntry>();

  savedDatasets.forEach((dataset) => {
    dataset.adjustedStatementRows.forEach((row) => {
      if (!shouldCollectAccountDictionaryRow(row)) {
        return;
      }

      const matchedSection = resolveAccountDbSection(row.sectionKey);
      if (!matchedSection) {
        return;
      }

      const entryKey = `${normalizeAccountDictionaryKey(matchedSection)}::${normalizeAccountDictionaryKey(row.accountName)}`;
      const existing = entries.get(entryKey);

      if (existing) {
        const nextSources = existing.sources.some((source) => source.datasetId === dataset.id)
          ? existing.sources
          : [...existing.sources, {
              datasetId: dataset.id,
              companyName: dataset.companyName,
              quarterLabel: dataset.quarterLabel
            }];
        entries.set(entryKey, {
          ...existing,
          occurrences: existing.occurrences + 1,
          sources: nextSources
        });
        return;
      }

      entries.set(entryKey, {
        entryKey,
        section: row.section,
        sectionKey: matchedSection,
        accountName: row.accountName,
        sampleCompany: dataset.companyName,
        sampleQuarter: dataset.quarterLabel,
        occurrences: 1,
        sources: [{
          datasetId: dataset.id,
          companyName: dataset.companyName,
          quarterLabel: dataset.quarterLabel
        }]
      });
    });
  });

  return Array.from(entries.values()).sort((a, b) => a.sectionKey.localeCompare(b.sectionKey, "ko") || a.accountName.localeCompare(b.accountName, "ko"));
}

function objectEntriesToRows(record: Record<string, string>): MapRow[] {
  return Object.entries(record).map(([section, parent]) => ({ section, parent }));
}

function overridesToRows(record: Record<string, Record<string, SignCode>>): OverrideRow[] {
  return Object.entries(record).flatMap(([section, items]) =>
    Object.entries(items).map(([keyword, sign]) => ({ section, keyword, sign }))
  );
}

function capitalRulesToRows(signs: Record<string, boolean>, parents: Record<string, string>): CapitalRuleRow[] {
  return Object.entries(signs).map(([account, isPositive]) => ({
    account,
    sign: isPositive ? 0 : 1,
    parent: parents[account] ?? ""
  }));
}

function capitalMemoAccountsToRows(accounts: string[]): CapitalMemoRow[] {
  return accounts.map((account) => ({ account }));
}

function rowsToMap(rows: MapRow[]) {
  return rows.reduce<Record<string, string>>((acc, row) => {
    if (row.section.trim() && row.parent.trim()) {
      acc[row.section.trim()] = row.parent.trim();
    }
    return acc;
  }, {});
}

function rowsToOverrides(rows: OverrideRow[]) {
  return rows.reduce<Record<string, Record<string, SignCode>>>((acc, row) => {
    const section = row.section.trim();
    const keyword = row.keyword.trim();
    if (!section || !keyword) {
      return acc;
    }
    acc[section] ??= {};
    acc[section][keyword] = row.sign;
    return acc;
  }, {});
}

function rowsToCapitalSigns(rows: CapitalRuleRow[]) {
  return rows.reduce<Record<string, boolean>>((acc, row) => {
    const account = row.account.trim();
    if (!account) {
      return acc;
    }
    acc[account] = row.sign === 0;
    return acc;
  }, {});
}

function rowsToCapitalParents(rows: CapitalRuleRow[]) {
  return rows.reduce<Record<string, string>>((acc, row) => {
    const account = row.account.trim();
    const parent = row.parent.trim();
    if (!account || !parent) {
      return acc;
    }
    acc[account] = parent;
    return acc;
  }, {});
}

function rowsToCapitalMemoAccounts(rows: CapitalMemoRow[]) {
  return rows
    .map((row) => row.account.trim())
    .filter(Boolean);
}

function upsertOverrideRow(rows: OverrideRow[], nextRow: OverrideRow) {
  const section = nextRow.section.trim();
  const keyword = nextRow.keyword.trim();

  if (!section || !keyword) {
    return rows;
  }

  const index = rows.findIndex((row) => row.section.trim() === section && row.keyword.trim() === keyword);
  if (index === -1) {
    return [...rows, { section, keyword, sign: nextRow.sign }];
  }

  return rows.map((row, rowIndex) => (rowIndex === index ? { section, keyword, sign: nextRow.sign } : row));
}

function sortSavedDatasets(items: SavedQuarterSnapshot[]) {
  return [...items].sort((a, b) => (a.companyName === b.companyName
    ? b.quarterLabel.localeCompare(a.quarterLabel)
    : a.companyName.localeCompare(b.companyName, "ko")));
}

function signLabel(sign: SignCode) {
  return sign === 0 ? "가산(+)" : sign === 1 ? "차감(−)" : "제외";
}

function displayedSignToCode(sign: string): SignCode {
  if (sign === "−") {
    return 1;
  }
  if (sign === "제외") {
    return 2;
  }
  return 0;
}

function countSessionFixes(sessionSignFixes: SessionSignFixes) {
  return Object.values(sessionSignFixes).reduce((count, items) => count + Object.keys(items).length, 0);
}

function buildPreviewGroups(catRow: string[], nameRow: string[]): { groups: PreviewGroup[]; tones: number[] } {
  const length = Math.max(catRow.length, nameRow.length);
  const tones = Array.from({ length }, () => 0);
  const groups: PreviewGroup[] = [];
  let currentLabel = "기타";
  let toneIndex = -1;

  for (let index = 0; index < length; index += 1) {
    const nextLabel = catRow[index]?.trim();
    if (nextLabel) {
      currentLabel = nextLabel;
    }

    const lastGroup = groups[groups.length - 1];
    if (!lastGroup || lastGroup.label !== currentLabel) {
      toneIndex += 1;
      groups.push({ label: currentLabel, start: index, span: 1, tone: toneIndex % 6 });
    } else {
      lastGroup.span += 1;
    }

    tones[index] = groups[groups.length - 1].tone;
  }

  return { groups, tones };
}

function buildStatementSheetRows(rows: StatementMatrixRow[], periods: ReportingModel["periods"]) {
  return rows.map((row) => ({
    양음: row.signFlag,
    섹션: row.section,
    계정명: row.accountName,
    ...Object.fromEntries(periods.map((period) => [period.label, row.values[period.key]]))
  }));
}

function buildFormulaGuideRows() {
  return [
    { 항목: "런웨이(E)", 계산식: "현금및현금성자산 * 경과월수 / (매출원가 + 판관비 - 감가/상각비)" },
    { 항목: "EBITDA", 계산식: "매출액 - 매출원가 - 판관비 + 감가상각비계" },
    { 항목: "유동비율", 계산식: "유동자산 / 유동부채 * 100" },
    { 항목: "당좌비율", 계산식: "(유동자산 - 재고자산) / 유동부채 * 100" },
    { 항목: "부채비율", 계산식: "부채 / 자본 * 100" },
    { 항목: "영업이익률", 계산식: "영업이익 / 매출액 * 100" },
    { 항목: "매출액 증가율(QoQ)", 계산식: "(당기 매출액 - 직전 분기 매출액) / |직전 분기 매출액| * 100" },
    { 항목: "매출액 증가율(YoY)", 계산식: "(당기 매출액 - 전년도 동일분기 매출액) / |전년도 동일분기 매출액| * 100" }
  ];
}

function buildRequestedFormulaRows() {
  return [
    { 항목: "유동비율", 수식: "(유동자산/유동부채) * 100" },
    { 항목: "당좌비율", 수식: "(당좌자산/유동부채) * 100" },
    { 항목: "부채비율", 수식: "(부채/자본) * 100" },
    { 항목: "차입금 의존도", 수식: "(차입금/자산) * 100" },
    { 항목: "이자보상비율", 수식: "영업이익(손실)/이자비용" },
    { 항목: "매출액순이익률", 수식: "(계속사업당기순이익/매출액) * 100" },
    { 항목: "총자산이익률(ROA)", 수식: "(계속사업당기순이익/자산) * 100" },
    { 항목: "자기자본이익률(ROE)", 수식: "(계속사업당기순이익/자본) * 100" },
    { 항목: "영업이익률", 수식: "(영업이익(손실)/매출액) * 100" },
    { 항목: "공헌이익률", 수식: "(매출액 - 변동비)/매출액 * 100" },
    { 항목: "인건비", 수식: "(인건비/(매출원가+판매비와관리비+영업외비용)) * 100" },
    { 항목: "연구개발비", 수식: "(연구비/(매출원가+판매비와관리비+영업외비용)) * 100" },
    { 항목: "접대비", 수식: "(접대비/(매출원가+판매비와관리비+영업외비용)) * 100" },
    { 항목: "복리후생비", 수식: "(복리후생비/(매출원가+판매비와관리비+영업외비용)) * 100" },
    { 항목: "광고선전비", 수식: "(광고선전비/(매출원가+판매비와관리비+영업외비용)) * 100" },
    { 항목: "지급수수료", 수식: "(지급수수료/(매출원가+판매비와관리비+영업외비용)) * 100" },
    { 항목: "외주용역비", 수식: "(외주용역비/(매출원가+판매비와관리비+영업외비용)) * 100" },
    { 항목: "임차료", 수식: "(임차료/(매출원가+판매비와관리비+영업외비용)) * 100" },
    { 항목: "이자비용", 수식: "(총이자비용/(매출원가+판매비와관리비+영업외비용)) * 100" },
    { 항목: "현금및현금성자산", 수식: "(현금및현금성자산/자산) * 100" },
    { 항목: "단기대여금", 수식: "(단기대여금/자산) * 100" },
    { 항목: "개발비(자산)", 수식: "(개발비(자산)/자산) * 100" },
    { 항목: "선급금", 수식: "(선급금/자산) * 100" },
    { 항목: "가수금", 수식: "(가수금/부채) * 100" },
    { 항목: "가지급금", 수식: "(가지급금/자산) * 100" },
    { 항목: "퇴직급여충당부채", 수식: "((퇴직급여충당부채_양수 + 퇴직급여충당부채_음수)/부채) * 100" },
    { 항목: "총자산회전율", 수식: "매출액 / ((해당연도 1분기 자산 + 현재 분기 자산) / 2)" },
    { 항목: "매출채권회전율", 수식: "매출액 / ((해당연도 1분기 매출채권 + 현재 분기 매출채권) / 2)" },
    { 항목: "매출채권회전기간", 수식: "365일 / 매출채권회전율" },
    { 항목: "재고자산회전율", 수식: "매출원가 / ((해당연도 1분기 재고자산 + 현재 분기 재고자산) / 2)" },
    { 항목: "재고자산회전기간", 수식: "365일 / 재고자산회전율" },
    { 항목: "정상영업순환주기", 수식: "매출채권회전기간 + 재고자산회전기간" },
    { 항목: "매출액 증가율(QoQ)", 수식: "(당기 매출액 - 직전 분기 매출액) / |직전 분기 매출액| * 100" },
    { 항목: "매출액 증가율(YoY)", 수식: "(당기 매출액 - 전년도 동일분기 매출액) / |전년도 동일분기 매출액| * 100" },
    { 항목: "영업이익 증가율(QoQ)", 수식: "(당기 영업이익 - 직전 분기 영업이익) / |직전 분기 영업이익| * 100" },
    { 항목: "영업이익 증가율(YoY)", 수식: "(당기 영업이익 - 전년도 동일분기 영업이익) / |전년도 동일분기 영업이익| * 100" },
    { 항목: "매도가능증권", 수식: "(매도가능증권/자산) * 100" },
    { 항목: "런웨이(E)", 수식: "현금및현금성자산 / 월 평균 지출액" },
    { 항목: "EBITDA", 수식: "영업이익(손실) + 감가상각비계" },
    { 항목: "월 평균 지출액", 수식: "(매출액 - 영업이익(손실) - 감가상각비계) / 경과월수" }
  ];
}

const REPORT_METRIC_HELP_TEXT = {
  자산: "자산총계입니다.",
  유동자산: "1년 이내 현금화되거나 사용될 자산입니다.",
  비유동자산: "1년을 초과해 보유하는 자산입니다.",
  부채: "부채총계입니다.",
  유동부채: "1년 이내 상환해야 하는 부채입니다.",
  비유동부채: "1년을 초과해 상환하는 부채입니다.",
  자본: "자본총계입니다.",
  매출액: "회사의 영업활동으로 인식한 매출 총액입니다.",
  매출원가: "매출을 만들기 위해 직접 발생한 원가입니다.",
  판매비와관리비: "매출원가를 제외한 주요 영업비용입니다.",
  영업이익: "매출액 - 매출원가 - 판매비와관리비입니다.",
  영업외수익: "본업 외에서 발생한 수익입니다.",
  영업외비용: "본업 외에서 발생한 비용입니다.",
  월평균지출액: "(매출액 - 영업이익 - 감가상각비계) / 경과월수입니다.",
  정상영업순환주기: "매출채권회전기간 + 재고자산회전기간입니다."
} satisfies Record<string, string>;

const REQUESTED_FORMULA_HELP_TEXT = buildRequestedFormulaRows().reduce<Record<string, string>>((acc, row) => {
  acc[normalizeMetricLabel(row.항목)] = `${row.항목} = ${row.수식}`;
  return acc;
}, {});

function getReportMetricHelpText(label: string) {
  return REQUESTED_FORMULA_HELP_TEXT[normalizeMetricLabel(label)]
    ?? REPORT_METRIC_HELP_TEXT[normalizeMetricLabel(label) as keyof typeof REPORT_METRIC_HELP_TEXT]
    ?? null;
}

function normalizeIndustryLabel(value: string) {
  return value.trim();
}

function getIndustryIcon(industry: string) {
  const normalized = normalizeIndustryLabel(industry);

  if (normalized === "서비스") return "💼";
  if (normalized === "게임") return "🎮";
  if (normalized === "기술") return "⚙️";
  if (normalized === "헬스케어") return "🩺";
  if (normalized === "크립토") return "₿";
  if (!normalized || normalized === "미분류") return "🏷️";
  return "🧩";
}

function formatCompactQuarterLabel(value: string) {
  const match = value.trim().match(/^(\d{4})-(\d{2})/);
  if (match) {
    return `${match[1].slice(2)}${match[2]}`;
  }

  const digits = value.replace(/\D/g, "");
  if (digits.length >= 6) {
    return `${digits.slice(2, 4)}${digits.slice(4, 6)}`;
  }

  return value;
}

function buildPastedTextFromMatrix(catRow: string[], nameRow: string[], dataRows: Array<Array<string | number | null>>) {
  const rows = [catRow, nameRow, ...dataRows].map((row) => row.map((cell) => cell ?? "").join("\t"));
  return rows.join("\n");
}

function buildEffectiveDataRows(dataRows: Array<Array<string | number | null>>, pasteEdits: Record<string, number>) {
  return dataRows.map((row, rowIndex) => row.map((value, colIndex) => {
    const edited = pasteEdits[pasteEditKey(rowIndex, colIndex)];
    return edited !== undefined ? edited : value;
  }));
}

function buildEffectiveSections(catRow: string[], length: number) {
  let current = "";
  return Array.from({ length }, (_, index) => {
    const next = catRow[index]?.trim() ?? "";
    if (next) {
      current = next;
    }
    return current;
  });
}

function removeColumnFromMatrix(catRow: string[], nameRow: string[], dataRows: Array<Array<string | number | null>>, colIndex: number) {
  const nextCatRow = [...catRow];
  const removedSectionLabel = nextCatRow[colIndex]?.trim() ?? "";
  nextCatRow.splice(colIndex, 1);
  if (removedSectionLabel && colIndex < nextCatRow.length && !(nextCatRow[colIndex]?.trim())) {
    nextCatRow[colIndex] = removedSectionLabel;
  }

  return {
    catRow: nextCatRow,
    nameRow: nameRow.filter((_, index) => index !== colIndex),
    dataRows: dataRows.map((row) => row.filter((_, index) => index !== colIndex))
  };
}

function insertColumnIntoMatrix(
  catRow: string[],
  nameRow: string[],
  dataRows: Array<Array<string | number | null>>,
  insertIndex: number,
  section: string,
  accountName: string,
  value: number,
  targetRowIndex: number
) {
  const nextCatRow = [...catRow];
  const nextNameRow = [...nameRow];
  const nextDataRows = dataRows.map((row) => [...row]);
  const previousSection = insertIndex > 0 ? buildEffectiveSections(catRow, nameRow.length)[insertIndex - 1] : "";
  const catCellValue = previousSection === section ? "" : section;

  nextCatRow.splice(insertIndex, 0, catCellValue);
  nextNameRow.splice(insertIndex, 0, accountName);
  nextDataRows.forEach((row, rowIndex) => {
    row.splice(insertIndex, 0, rowIndex === targetRowIndex ? value : "");
  });

  return {
    catRow: nextCatRow,
    nameRow: nextNameRow,
    dataRows: nextDataRows
  };
}

function buildInitialComparisonSelections(items: SavedQuarterSnapshot[]): ComparisonSelection[] {
  return Array.from({ length: 4 }, (_, index) => {
    const dataset = items[index];
    return {
      slotId: `slot-${index + 1}`,
      companyName: dataset?.companyName ?? "",
      datasetId: dataset?.id ?? ""
    };
  });
}

function isSavedQuarterSnapshot(value: unknown): value is SavedQuarterSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }

  const item = value as Partial<SavedQuarterSnapshot>;
  return typeof item.id === "string"
    && typeof item.companyName === "string"
    && typeof item.quarterKey === "string"
    && typeof item.quarterLabel === "string"
    && Array.isArray(item.rawStatementRows)
    && Array.isArray(item.adjustedStatementRows)
    && !!item.source
    && typeof item.source === "object";
}

function parseSavedDatasets(raw: string | null): SavedQuarterSnapshot[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isSavedQuarterSnapshot).map((item) => ({
      ...item,
        source: {
          ...item.source,
          pasteEdits: { ...((item.source as { pasteEdits?: Record<string, number> }).pasteEdits ?? {}) },
          nameEdits: { ...((item.source as { nameEdits?: Record<string, string> }).nameEdits ?? {}) },
          logicConfig: cloneLogicConfig((item.source as { logicConfig?: LogicConfig }).logicConfig ?? DEFAULT_LOGIC_CONFIG),
          companyConfigs: cloneCompanyConfigs((item.source as { companyConfigs?: CompanyConfigs }).companyConfigs ?? DEFAULT_COMPANY_CONFIGS),
          sessionSignFixes: cloneSessionSignFixes((item.source as { sessionSignFixes?: SessionSignFixes }).sessionSignFixes ?? {})
        }
      }));
  } catch {
    return [];
  }
}

type UserRole = "creator" | "admin" | "manager";

export function ValidatorApp({ userRole = "manager", initialDatasets, initialTrashedDatasets }: { userRole?: UserRole; initialDatasets?: SavedQuarterSnapshot[]; initialTrashedDatasets?: SavedQuarterSnapshot[] }) {
  const canEditConfig = userRole === "creator" || userRole === "admin";
  const canDeleteData = userRole === "creator";
  const [topView, setTopView] = useState<TopViewKey>("menu");
  const [activeTab, setActiveTab] = useState<TabKey>("validate");
  const [mounted, setMounted] = useState(false);
  const [workspaceMemo, setWorkspaceMemo] = useState("");
  const [workspaceMemoMeta, setWorkspaceMemoMeta] = useState<{ updatedAt: string | null; updatedBy: string | null }>({ updatedAt: null, updatedBy: null });
  const memoSyncInitializedRef = useRef(false);
  // 패밀리사 명단 — null이면 DB 미설정(기본 명단 사용). 데이터 탭 "패밀리 N/M" 칩의 분모.
  const [familyCompanies, setFamilyCompanies] = useState<string[] | null>(null);
  const [familyMeta, setFamilyMeta] = useState<{ updatedAt: string | null; updatedBy: string | null }>({ updatedAt: null, updatedBy: null });
  const [familyPanelOpen, setFamilyPanelOpen] = useState(false);
  const [familyDraft, setFamilyDraft] = useState<string | null>(null);
  const [familySaveState, setFamilySaveState] = useState<{ status: "idle" | "saving" | "ok" | "error"; message?: string }>({ status: "idle" });
  const [familyCopied, setFamilyCopied] = useState(false);
  const [sheetsSyncState, setSheetsSyncState] = useState<{ status: "idle" | "syncing" | "ok" | "error" | "disabled"; message?: string }>({ status: "idle" });
  // 결과물 동기화 대상 구글시트 링크 — 마운트 시 1회 조회해 동기화 버튼 옆에 표시.
  const [sheetUrl, setSheetUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/datasets/sheets-sync")
      .then((res) => res.ok ? res.json() : null)
      .then((data) => { if (!cancelled && data?.ok && data.spreadsheetUrl) setSheetUrl(data.spreadsheetUrl as string); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  // 계정트리 캐시 → 매칭용 lookup. 있으면 검증/점검이 옛 분류 대신 트리로 돈다.
  const [accountTreeLookup, setAccountTreeLookup] = useState<ReturnType<typeof buildTreeCatalogLookupFromRows> | null>(null);
  // 트리 모든 노드 이름(leaf+구조노드) — OCR 섹션 총계줄(자산/매출액 등)을 미분류에서 거르는 용도.
  const [accountTreeNodeNames, setAccountTreeNodeNames] = useState<Set<string>>(() => new Set());
  // 섹션/구조노드 이름 → {대분류,중분류} — 미분류를 어느 가지에 넣을지(③) 매핑용.
  const [structToBranch, setStructToBranch] = useState<Map<string, { l1: string; l2: string }>>(() => new Map());
  // 13자리 코드 → 트리 경로(대분류>중분류>…>계정). 계산 근거에서 "이 값이 트리 어디서 왔는지" 표시.
  const [codeToPath, setCodeToPath] = useState<Map<number, string>>(() => new Map());
  // 묶음 키워드(현금및현금성자산·인건비 …) → 코드 범위(노드 prefix). 묶음 줄에 "1001001001000~" 식 범위 표시.
  const [keywordPrefixes, setKeywordPrefixes] = useState<Record<string, string[]>>({});
  // 부팅 로딩 화면을 트리 로드가 끝날 때까지 유지(트리 도착 시 무거운 재계산이
  // 입장 직후 화면을 멈추는 문제). 실패해도 true — 트리 없는 모드로 입장한다.
  const [treeBootDone, setTreeBootDone] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/classification-tree")
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (!data?.ok || !Array.isArray(data.rows)) { setTreeBootDone(true); return; }
        setAccountTreeLookup(buildTreeCatalogLookupFromRows(data.rows as AccountTreeRow[]));
        const names = new Set<string>();
        const branchMap = new Map<string, { l1: string; l2: string }>();
        const pathMap = new Map<number, string>();
        for (const r of (data.rows as AccountTreeRow[])) {
          for (const label of [r.l1, r.l2, r.l3, r.l4, r.l5]) {
            if (label) names.add(normalizeAccountName(label));
          }
          if (r.code) {
            const codeNum = Number(r.code);
            if (Number.isFinite(codeNum) && !pathMap.has(codeNum)) {
              pathMap.set(codeNum, [r.l1, r.l2, r.l3, r.l4, r.l5].filter(Boolean).join(" > "));
            }
          }
          if (!r.l5 && r.code) {
            // 구조노드 — 가장 깊은 라벨로 가지 매핑
            const labels = [r.l1, r.l2, r.l3, r.l4].filter(Boolean);
            const deepest = labels[labels.length - 1] ?? "";
            if (deepest) {
              const k = normalizeAccountName(deepest);
              if (!branchMap.has(k)) branchMap.set(k, { l1: r.l1, l2: r.l2 });
            }
          } else if (r.l5 && r.l2) {
            // leaf의 중분류도 섹션 매핑 단서로 (유동자산 등)
            const k2 = normalizeAccountName(r.l2);
            if (!branchMap.has(k2)) branchMap.set(k2, { l1: r.l1, l2: r.l2 });
          }
        }
        setAccountTreeNodeNames(names);
        setStructToBranch(branchMap);
        setCodeToPath(pathMap);
        // 묶음(변동비/인건비/차입금 …) 코드셋도 트리(13자리)로 교체 = 컷오버.
        // 이게 없으면 스냅샷은 트리코드인데 묶음셋은 레거시(7자리)라 묶음 합산이 0.
        if (Array.isArray(data.values) && data.values.length) {
          try {
            const tree = parseAccountTree(data.values as string[][]);
            setReportKeywordCodeSets(buildTreeKeywordCodeSets(tree));
            setKeywordPrefixes(buildTreeKeywordPrefixes(tree));
          } catch {
            /* 파싱 실패 시 레거시 묶음셋 유지 */
          }
        }
        setTreeBootDone(true);
      })
      .catch(() => { if (!cancelled) setTreeBootDone(true); });
    return () => { cancelled = true; };
  }, []);
  const sheetsAutoSyncInitializedRef = useRef(false);
  const [pastedText, setPastedText] = useState("");
  const [tolerance, setTolerance] = useState(1);
  const [selectedCompany, setSelectedCompany] = useState("");
  const [logicConfig, setLogicConfig] = useState<LogicConfig>(cloneLogicConfig(DEFAULT_LOGIC_CONFIG));
  const [companyConfigs, setCompanyConfigs] = useState<CompanyConfigs>(cloneCompanyConfigs(DEFAULT_COMPANY_CONFIGS));
  const [pasteEdits, setPasteEdits] = useState<Record<string, number>>({});
  const [nameEdits, setNameEdits] = useState<Record<string, string>>({});
  // 계정명 오타 제안에서 "신규 유지"로 닫은 이름(정규화 키). 새 붙여넣기마다 초기화.
  const [dismissedTypoNames, setDismissedTypoNames] = useState<Set<string>>(() => new Set());
  const [sessionSignFixes, setSessionSignFixes] = useState<SessionSignFixes>({});
  const [globalOverrideRows, setGlobalOverrideRows] = useState<OverrideRow[]>(overridesToRows(DEFAULT_LOGIC_CONFIG.sectionSignOverrides));
  const [companyOverrideRows, setCompanyOverrideRows] = useState<OverrideRow[]>([]);
  const [pasteSectionRows, setPasteSectionRows] = useState<MapRow[]>(objectEntriesToRows(DEFAULT_LOGIC_CONFIG.pasteSectToParent));
  const [capitalRuleRows, setCapitalRuleRows] = useState<CapitalRuleRow[]>(capitalRulesToRows(DEFAULT_LOGIC_CONFIG.capitalL1Signs, DEFAULT_LOGIC_CONFIG.capitalL1Parent));
  const [capitalMemoRows, setCapitalMemoRows] = useState<CapitalMemoRow[]>(capitalMemoAccountsToRows(DEFAULT_LOGIC_CONFIG.capitalMemoAccounts));
  const [parentAliasRows, setParentAliasRows] = useState<Array<{ parent: string; aliases: string }>>(
    () => Object.entries(DEFAULT_LOGIC_CONFIG.parentAliases ?? {}).map(([parent, aliases]) => ({
      parent,
      aliases: aliases.filter((a) => a !== parent).join(", ")
    }))
  );
  const [configRulesHistory, setConfigRulesHistory] = useState<ConfigRulesSnapshot[]>([]);
  const configRulesSnapshotPendingRef = useRef(false);
  const [resultOpenState, setResultOpenState] = useState<Record<string, boolean>>({});
  const [savedDatasets, setSavedDatasets] = useState<SavedQuarterSnapshot[]>(initialDatasets ?? []);
  const [consistencyResults, setConsistencyResults] = useState<Array<{
    datasetId: string;
    companyName: string;
    quarterLabel: string;
    totalChecks: number;
    failedChecks: Array<{ rule: string; parent: string; expected: number; actual: number; diff: number }>;
  }> | null>(null);
  const [consistencyChecking, setConsistencyChecking] = useState(false);
  const [consistencyMessage, setConsistencyMessage] = useState<string | null>(null);
  const [trashedDatasets, setTrashedDatasets] = useState<SavedQuarterSnapshot[]>(initialTrashedDatasets ?? []);
  const [activeAccountDbSourceKey, setActiveAccountDbSourceKey] = useState<string | null>(null);
  const [activeAccountDbPreview, setActiveAccountDbPreview] = useState<{ datasetId: string; accountName: string } | null>(null);
  const [selectedDatasetId, setSelectedDatasetId] = useState<string>("");
  const [comparisonSelections, setComparisonSelections] = useState<ComparisonSelection[]>(buildInitialComparisonSelections([]));
  const [sameCompanyMode, setSameCompanyMode] = useState(false);
  const [showReportValidation, setShowReportValidation] = useState(false);
  const [expandedReportMetrics, setExpandedReportMetrics] = useState<Record<string, boolean>>({});
  const [activeMetricHelpKey, setActiveMetricHelpKey] = useState<string | null>(null);
  const [pendingInsertedRows, setPendingInsertedRows] = useState<Record<string, PendingInsertedRow>>({});
  const [validatePreviewDrafts, setValidatePreviewDrafts] = useState<Record<string, ValidatePreviewDraft>>({});
  const [activeIndustryEditor, setActiveIndustryEditor] = useState<string | null>(null);
  const [dataEditMode, setDataEditMode] = useState(false);
  // 데이터 탭 검색/필터: 회사명 검색 + 분기 + 산업.
  const [dataSearch, setDataSearch] = useState("");
  const [dataQuarterFilter, setDataQuarterFilter] = useState("");
  const [dataIndustryFilter, setDataIndustryFilter] = useState("");
  const [statementType, setStatementType] = useState<"별도" | "연결">("별도");
  const [datasetActionState, setDatasetActionState] = useState<"idle" | "saving" | "deleting" | "restoring" | "purging">("idle");
  const [configApplyState, setConfigApplyState] = useState<"idle" | "applying" | "applied">("idle");
  const [sharedStateReady, setSharedStateReady] = useState(false);
  const [sharedStateError, setSharedStateError] = useState<string | null>(null);
  const [lastEditedCell, setLastEditedCell] = useState<string | null>(null);
  const [activeAccountDbHighlightKey, setActiveAccountDbHighlightKey] = useState<string | null>(null);
  const configSyncInitializedRef = useRef(false);
  const previewRowRefsRef = useRef<Map<string, HTMLElement>>(new Map());
  const accountDbRowRefsRef = useRef<Map<string, HTMLElement>>(new Map());

  useEffect(() => {
    let cancelled = false;

    async function loadSharedState() {
      setMounted(true);

      let nextPersisted = getDefaultPersistedState();
      let nextSaved: SavedQuarterSnapshot[] = [];
      let nextTrashed: SavedQuarterSnapshot[] = [];

      try {
        // datasets pre-loaded server-side when available; only fetch if not provided
        const fetchPromises: [Promise<Response>, Promise<Response> | null] = [
          fetch("/api/shared-state", { cache: "no-store" }),
          initialDatasets ? null : fetch("/api/datasets", { cache: "no-store" })
        ];
        const [configResponse, datasetsResponse] = await Promise.all(fetchPromises);

        if (!configResponse.ok) {
          throw new Error("공용 데이터를 불러오지 못했습니다.");
        }

        let remoteSaved: SavedQuarterSnapshot[];
        if (initialDatasets) {
          remoteSaved = initialDatasets;
          nextTrashed = initialTrashedDatasets ?? [];
        } else {
          if (!datasetsResponse?.ok) throw new Error("검증 저장 데이터를 불러오지 못했습니다.");
          const parsedDatasetResponse = parseDatasetApiResponse(await datasetsResponse.json() as DatasetApiResponse);
          remoteSaved = parsedDatasetResponse.datasets;
          nextTrashed = parsedDatasetResponse.trashedDatasets;
        }

        const remote = await configResponse.json() as SharedStateResponse;
        const remoteMemo = typeof remote.config.workspaceMemo === "string" ? remote.config.workspaceMemo : "";
        const legacyMemo = typeof window !== "undefined" ? window.localStorage.getItem("kvocean-workspace-memo") : null;
        const shouldMigrateLegacy = !!legacyMemo && !remoteMemo;
        const initialMemo = shouldMigrateLegacy ? legacyMemo! : remoteMemo;
        setWorkspaceMemo(initialMemo);
        setWorkspaceMemoMeta({
          updatedAt: remote.config.workspaceMemoUpdatedAt ?? null,
          updatedBy: remote.config.workspaceMemoUpdatedBy ?? null
        });
        if (typeof window !== "undefined" && legacyMemo !== null) {
          window.localStorage.removeItem("kvocean-workspace-memo");
        }
        if (shouldMigrateLegacy) {
          fetch("/api/shared-state", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ memo: { value: initialMemo } })
          })
            .then(async (res) => {
              if (!res.ok) return;
              const payload = await res.json().catch(() => null) as { updatedAt?: string; updatedBy?: string } | null;
              if (payload?.updatedAt || payload?.updatedBy) {
                setWorkspaceMemoMeta({
                  updatedAt: payload.updatedAt ?? new Date().toISOString(),
                  updatedBy: payload.updatedBy ?? null
                });
              }
            })
            .catch(() => {});
        }
        setFamilyCompanies(remote.config.familyCompanies ?? null);
        setFamilyMeta({
          updatedAt: remote.config.familyCompaniesUpdatedAt ?? null,
          updatedBy: remote.config.familyCompaniesUpdatedBy ?? null
        });
        const remotePersisted = parsePersistedState(JSON.stringify(remote.config));
        nextPersisted = remotePersisted;
        nextSaved = remoteSaved;
      } catch (error) {
        setSharedStateError(error instanceof Error ? error.message : "공용 데이터 연결 중 오류가 발생했습니다.");
      }

      if (cancelled) {
        return;
      }

      setLogicConfig(cloneLogicConfig(nextPersisted.logicConfig));
      setCompanyConfigs(cloneCompanyConfigs(nextPersisted.companyConfigs));
      setGlobalOverrideRows(overridesToRows(nextPersisted.logicConfig.sectionSignOverrides));
      setPasteSectionRows(objectEntriesToRows(nextPersisted.logicConfig.pasteSectToParent));
      setCapitalRuleRows(capitalRulesToRows(nextPersisted.logicConfig.capitalL1Signs, nextPersisted.logicConfig.capitalL1Parent));
      setCapitalMemoRows(capitalMemoAccountsToRows(nextPersisted.logicConfig.capitalMemoAccounts));
      const sortedDatasets = sortSavedDatasets(nextSaved);
      setSavedDatasets(sortedDatasets);
      setTrashedDatasets(nextTrashed);
      setSelectedDatasetId(sortedDatasets[0]?.id ?? "");
      setComparisonSelections(buildInitialComparisonSelections(sortedDatasets));
      setSharedStateReady(true);
    }

    loadSharedState();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!mounted || !sharedStateReady) {
      return;
    }

    if (!configSyncInitializedRef.current) {
      configSyncInitializedRef.current = true;
      return;
    }

    const timeout = window.setTimeout(() => {
      fetch("/api/shared-state", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          config: { logicConfig, companyConfigs }
        })
      })
        .then(async (response) => {
          if (!response.ok) {
            const payload = await response.json().catch(() => null) as { error?: string } | null;
            throw new Error(payload?.error ?? "공용 설정 저장에 실패했습니다. 새로고침 후 다시 시도해 주세요.");
          }

          setSharedStateError(null);
        })
        .catch((error) => setSharedStateError(error instanceof Error ? error.message : "공용 설정 저장에 실패했습니다. 새로고침 후 다시 시도해 주세요."));
    }, 600);

    return () => window.clearTimeout(timeout);
  }, [mounted, sharedStateReady, logicConfig, companyConfigs]);

  useEffect(() => {
    if (!mounted || !sharedStateReady) {
      return;
    }

    // First load: fire once after a short delay so the initial sheet snapshot is fresh.
    // Subsequent edits do NOT auto-sync — that path pushes 2.4K rows and was the
    // main cause of UI lag after every save. Use "전체 회사 시트 동기화" button
    // (or saveDataset already triggers a focused sync) when an explicit push is needed.
    if (sheetsAutoSyncInitializedRef.current) return;
    sheetsAutoSyncInitializedRef.current = true;

    const timeout = window.setTimeout(() => {
      const payload = buildSheetsSyncPayload(savedDatasets, accountTreeLookup ? { logicConfig, companyConfigs, accountTreeLookup } : undefined);
      if (!payload.quarterTabs.length) return;
      setSheetsSyncState({ status: "syncing", message: "페이지 로드 → 시트 자동 동기화 중..." });
      postSheetsSync(payload)
        .then((data) => {
          if (data?.ok) {
            setSheetsSyncState({ status: "ok", message: `자동 동기화 완료 (탭 ${data.tabsWritten ?? payload.quarterTabs.length} · 행 ${data.rowsTotal ?? 0})` });
            window.setTimeout(() => setSheetsSyncState((prev) => prev.status === "ok" ? { status: "idle" } : prev), 4000);
          } else if (data?.reason === "disabled") {
            setSheetsSyncState({ status: "idle" });
          } else {
            setSheetsSyncState({ status: "error", message: describeSheetsError(data) });
          }
        })
        .catch(() => setSheetsSyncState({ status: "idle" }));
    }, 3000);

    return () => window.clearTimeout(timeout);
  }, [mounted, sharedStateReady]);

  useEffect(() => {
    if (!mounted || !sharedStateReady) {
      return;
    }

    if (!memoSyncInitializedRef.current) {
      memoSyncInitializedRef.current = true;
      return;
    }

    const timeout = window.setTimeout(() => {
      fetch("/api/shared-state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memo: { value: workspaceMemo } })
      })
        .then(async (response) => {
          if (!response.ok) {
            const payload = await response.json().catch(() => null) as { error?: string } | null;
            throw new Error(payload?.error ?? "메모 저장에 실패했습니다.");
          }
          const payload = await response.json().catch(() => null) as { updatedAt?: string; updatedBy?: string } | null;
          if (payload?.updatedAt || payload?.updatedBy) {
            setWorkspaceMemoMeta({
              updatedAt: payload.updatedAt ?? new Date().toISOString(),
              updatedBy: payload.updatedBy ?? null
            });
          }
        })
        .catch((error) => setSharedStateError(error instanceof Error ? error.message : "메모 저장에 실패했습니다."));
    }, 700);

    return () => window.clearTimeout(timeout);
  }, [mounted, sharedStateReady, workspaceMemo]);

  // 부팅 시 저장 데이터 자동 동기화는 제거됨. 매 부팅마다 전체 데이터셋을
  // 재계산·PUT하느라 탭이 멈추고, 큰 PUT은 413으로 실패해 무한 반복됐다.
  // 분류DB를 편집·저장할 때만 syncStoredDatasetsToClassificationDB가 돈다.

  useEffect(() => {
    const company = selectedCompany.trim();
    const rows = overridesToRows(companyConfigs[company]?.sectionSignOverrides ?? {});
    setCompanyOverrideRows(rows);
  }, [selectedCompany, companyConfigs]);

  useEffect(() => {
    if (!activeAccountDbSourceKey) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      if (target.closest("[data-account-db-source-wrap='true']")) {
        return;
      }

      setActiveAccountDbSourceKey(null);
    }

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [activeAccountDbSourceKey]);

  useEffect(() => {
    if (!lastEditedCell) {
      return;
    }
    const el = previewRowRefsRef.current.get(lastEditedCell);
    if (!el) {
      return;
    }
    const target = el;
    target.scrollIntoView({ behavior: "smooth", block: "nearest" });
    target.classList.remove("highlight-pulse");
    void target.offsetHeight;
    target.classList.add("highlight-pulse");
    function handleAnimationEnd() {
      target.classList.remove("highlight-pulse");
      target.removeEventListener("animationend", handleAnimationEnd);
    }
    target.addEventListener("animationend", handleAnimationEnd);
    return () => {
      target.classList.remove("highlight-pulse");
      target.removeEventListener("animationend", handleAnimationEnd);
    };
  }, [lastEditedCell]);

  useEffect(() => {
    if (!activeAccountDbHighlightKey) {
      return;
    }
    const el = accountDbRowRefsRef.current.get(activeAccountDbHighlightKey);
    el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [activeAccountDbHighlightKey]);

  useEffect(() => {
    setComparisonSelections((prev) => {
      const fallback = buildInitialComparisonSelections(savedDatasets);
      return fallback.map((item, index) => {
        const previous = prev[index];
        if (!previous) {
          return item;
        }
        const companyDatasets = savedDatasets.filter((dataset) => dataset.companyName === previous.companyName);
        const matchedDataset = savedDatasets.find((dataset) => dataset.id === previous.datasetId);
        return {
          slotId: item.slotId,
          companyName: matchedDataset?.companyName ?? companyDatasets[0]?.companyName ?? item.companyName,
          datasetId: matchedDataset?.id ?? companyDatasets[0]?.id ?? item.datasetId
        };
      });
    });
  }, [savedDatasets]);

  useEffect(() => {
    const autoCompany = runValidation({
      pastedText,
        selectedCompany: selectedCompany || null,
        tolerance,
        logicConfig,
        companyConfigs,
        pasteEdits,
        nameEdits,
        sessionSignFixes
      }).detectedCompany;

    if (autoCompany && autoCompany !== selectedCompany.trim()) {
      setSelectedCompany(autoCompany);
    }
  }, [pastedText, tolerance, logicConfig, companyConfigs, pasteEdits, nameEdits, sessionSignFixes, selectedCompany]);

  const validation = useMemo(
    () =>
      runValidation({
        pastedText,
        selectedCompany: selectedCompany.trim() || null,
        tolerance,
        logicConfig,
        companyConfigs,
        pasteEdits,
        nameEdits,
        sessionSignFixes,
        accountTreeLookup: accountTreeLookup ?? undefined
      }),
    [pastedText, selectedCompany, tolerance, logicConfig, companyConfigs, pasteEdits, nameEdits, sessionSignFixes, accountTreeLookup]
  );
  const accountDictionaryEntries = useMemo(() => extractAccountDictionaryEntries(savedDatasets), [savedDatasets]);
  // 4.분류DB 탭 출처·미분류: 저장 OCR 계정을 계정트리에 대조한다.
  //  - sourcesByCode: 트리 코드별로 어느 회사·분기에서 그 계정이 나왔나(출처)
  //  - unclassified : 트리 leaf에 이름이 없는 OCR 계정 = 미분류 (출처 동반)
  const treeSourceData = useMemo(() => {
    const sourcesByCode = new Map<string, AccountSource[]>();
    const unclassified: Array<{ l1: string; l2: string; accountName: string; sources: AccountSource[] }> = [];
    const pendingRows: Array<{ l1: string; l2: string; accountName: string; source: string }> = [];
    if (!accountTreeLookup) return { sourcesByCode, unclassified, pendingRows };

    // 한 번 순회: 계정명 → 출처(회사·분기) + 섹션 등장수
    const sectionNames = new Set<string>();
    const agg = new Map<string, { accountName: string; sources: AccountSource[]; sections: Map<string, number> }>();
    for (const ds of savedDatasets) {
      for (const row of ds.adjustedStatementRows) {
        const sec = (row.sectionKey ?? "").trim();
        if (sec) sectionNames.add(normalizeAccountName(sec));
        const name = (row.accountName ?? "").trim();
        if (!name) continue;
        const e = agg.get(name) ?? { accountName: name, sources: [], sections: new Map<string, number>() };
        if (!e.sources.some((s) => s.companyName === ds.companyName && s.quarterLabel === ds.quarterLabel)) {
          e.sources.push({ companyName: ds.companyName, quarterLabel: ds.quarterLabel });
        }
        if (sec) { const sk = normalizeAccountName(sec); e.sections.set(sk, (e.sections.get(sk) ?? 0) + 1); }
        agg.set(name, e);
      }
    }

    const pushSources = (code: string, sources: AccountSource[]) => {
      const list = sourcesByCode.get(code) ?? [];
      for (const s of sources) {
        if (!list.some((x) => x.companyName === s.companyName && x.quarterLabel === s.quarterLabel)) list.push(s);
      }
      sourcesByCode.set(code, list);
    };
    const yymm = (label: string) => { const m = /^(\d{4})-(\d{2})/.exec((label ?? "").trim()); return m ? `${m[1].slice(2)}${m[2]}` : (label ?? "").trim(); };

    for (const e of agg.values()) {
      const key = normalizeAccountName(e.accountName);
      const rawMatches = accountTreeLookup.get(key);
      // 섹션 대분류 게이트: 계정이 등장한 섹션의 대분류 안에서만 매칭을 인정한다.
      // 동명이계정(예: 비유동부채의 '보증금_현재가치할인차금'이 자산 쪽 동명 leaf에
      // 붙는 오매칭)을 막아 미분류로 떨군다. 섹션 정보가 없거나 제한 없는 섹션이면
      // 종전대로 전부 인정. 엔진(resolveAccountClassification)과 동일 규칙 재사용.
      let matches = rawMatches;
      if (rawMatches && rawMatches.length && e.sections.size) {
        const allowed = new Set<string>();
        let unrestricted = false;
        for (const sec of e.sections.keys()) {
          const set = expectedMajorCategories(sec);
          if (!set) { unrestricted = true; break; }
          set.forEach((c) => allowed.add(c));
        }
        if (!unrestricted) matches = rawMatches.filter((m) => allowed.has(m.majorCategory));
      }
      if (matches && matches.length) {
        for (const m of matches) pushSources(m.groupId, e.sources);
        continue;
      }
      if (accountTreeNodeNames.has(key) || sectionNames.has(key)) continue; // 구조노드/섹션 총계
      // 미분류 — 뷰용 + 시트 append용 행(가지 매핑)
      const topSec = [...e.sections.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
      const branch = structToBranch.get(topSec)
        ?? (SECTION_BRANCH_ALIASES[topSec] ? structToBranch.get(SECTION_BRANCH_ALIASES[topSec]) : undefined);
      const l1 = branch?.l1 ?? "미분류";
      const l2 = branch?.l2 ?? "";
      unclassified.push({ l1, l2, accountName: e.accountName, sources: e.sources });
      const source = e.sources.slice(0, 20).map((s) => `${s.companyName} ${yymm(s.quarterLabel)}`).join(", ");
      pendingRows.push({ l1, l2, accountName: e.accountName, source });
    }
    unclassified.sort((a, b) => b.sources.length - a.sources.length);
    pendingRows.sort((a, b) => a.accountName.localeCompare(b.accountName));
    return { sourcesByCode, unclassified, pendingRows };
  }, [savedDatasets, accountTreeLookup, accountTreeNodeNames, structToBranch]);

  // 출처(회사·분기) 클릭 → 그 데이터셋을 OCR검증 탭에 로드(미분류 계정 직접 수정용).
  function openSourceInValidator(companyName: string, quarterLabel: string) {
    const ds = savedDatasets.find((d) => d.companyName === companyName && d.quarterLabel === quarterLabel)
      ?? savedDatasets.find((d) => d.companyName === companyName);
    if (ds) {
      loadDatasetIntoValidator(ds);
      setActiveTab("validate");
    }
  }

  // 미분류 행의 🗑 → 출처 데이터셋들에서 그 계정 열을 지우고 해당 분기만 재저장.
  // OCR검증에서 열 🗑 후 저장하는 수작업과 같은 결과를 내되, 검증 탭을 거치지
  // 않는다. 원문(pastedText)에서 열을 제거해야 다음 로드 때 부활하지 않는다.
  // 삭제 후 합계 검증이 깨지는 분기는 건너뛴다(합산에 실제로 쓰이는 계정 보호).
  async function deleteUnclassifiedAccount(
    accountName: string,
    sources: AccountSource[]
  ): Promise<{ ok: boolean; message: string } | null> {
    const targetKey = normalizeAccountName(accountName);
    const labels = sources.map((s) => `${s.companyName} ${s.quarterLabel}`).join(", ");
    const confirmed = window.confirm(
      `미분류 계정 '${accountName}'을(를) 저장 데이터에서 삭제합니다.\n\n대상: ${labels}\n\n` +
      `· 각 데이터의 원문에서 이 계정 열을 제거하고 그 분기를 재저장합니다(OCR검증 🗑 후 저장과 동일).\n` +
      `· 결과물 구글시트도 함께 갱신됩니다.\n` +
      `· 삭제 후 합계 검증이 실패하는 분기는 건너뜁니다(OCR검증에서 직접 처리).\n\n진행할까요?`
    );
    if (!confirmed) return null;

    const okLabels: string[] = [];
    const failLabels: string[] = [];
    let datasetsNow = savedDatasets;

    for (const src of sources) {
      const matches = datasetsNow.filter((d) =>
        d.companyName === src.companyName
        && d.quarterLabel === src.quarterLabel
        && d.adjustedStatementRows.some((row) => normalizeAccountName(row.accountName ?? "") === targetKey)
      );
      if (!matches.length) {
        failLabels.push(`${src.companyName} ${src.quarterLabel} (계정 없음 — 이미 처리됐을 수 있음)`);
        continue;
      }

      for (const ds of matches) {
        const label = `${ds.companyName} ${ds.quarterLabel}`;
        // loadDatasetIntoValidator와 동일: 현재 분류DB 기준으로 edits 재정규화.
        const normalizedPasteEdits = normalizePasteEditsForValidation({
          pastedText: ds.source.pastedText,
          selectedCompany: ds.companyName,
          logicConfig,
          companyConfigs,
          accountTreeLookup: accountTreeLookup ?? undefined,
          pasteEdits: ds.source.pasteEdits,
          nameEdits: ds.source.nameEdits ?? {},
          sessionSignFixes: {}
        });
        const current = runValidation({
          pastedText: ds.source.pastedText,
          selectedCompany: ds.companyName,
          tolerance: ds.source.tolerance,
          logicConfig,
          companyConfigs,
          pasteEdits: normalizedPasteEdits,
          nameEdits: ds.source.nameEdits ?? {},
          sessionSignFixes: {},
          accountTreeLookup: accountTreeLookup ?? undefined
        });
        if (current.parsed.error) {
          failLabels.push(`${label} (원문 파싱 실패)`);
          continue;
        }

        const colIndexes = current.editableNameRow
          .map((name, index) => (normalizeAccountName(name ?? "") === targetKey ? index : -1))
          .filter((index) => index >= 0);
        if (!colIndexes.length) {
          failLabels.push(`${label} (원문에서 계정 열을 찾지 못함)`);
          continue;
        }

        // 수정값·이름수정을 행렬에 구워 넣은 뒤 열 제거(removeValidationAccount와 동일).
        let matrix = {
          catRow: current.parsed.catRow,
          nameRow: current.editableNameRow,
          dataRows: buildEffectiveDataRows(current.parsed.dataRows, normalizedPasteEdits)
        };
        for (const colIndex of [...colIndexes].sort((a, b) => b - a)) {
          matrix = removeColumnFromMatrix(matrix.catRow, matrix.nameRow, matrix.dataRows, colIndex);
        }
        const nextText = buildPastedTextFromMatrix(matrix.catRow, matrix.nameRow, matrix.dataRows);

        const recheckArgs = {
          pastedText: nextText,
          selectedCompany: ds.companyName,
          tolerance: ds.source.tolerance,
          logicConfig,
          companyConfigs,
          pasteEdits: {},
          nameEdits: {},
          sessionSignFixes: {},
          accountTreeLookup: accountTreeLookup ?? undefined
        };
        const recheck = runValidation(recheckArgs);
        if (recheck.parsed.error || recheck.stats.total === 0 || recheck.stats.failed > 0) {
          failLabels.push(`${label} (삭제 후 검증 실패 ${recheck.stats.failed}건 — OCR검증에서 직접 처리)`);
          continue;
        }

        // 같은 원문이 여러 분기를 낳으므로, 지금 다루는 분기 스냅샷만 골라 저장한다
        // (다른 분기 데이터셋을 옛 원문으로 덮어쓰지 않도록). id는 기존 행 유지.
        const snapshots = buildQuarterSnapshots({ ...recheckArgs, statementType: ds.source.statementType })
          .filter((s) => s.quarterKey === ds.quarterKey)
          .map((s) => ({ ...s, id: ds.id }));
        if (!snapshots.length) {
          failLabels.push(`${label} (분기 스냅샷 생성 실패)`);
          continue;
        }

        try {
          const response = await fetch("/api/datasets", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ snapshots, validatedText: recheck.copyText })
          });
          if (!response.ok) {
            const payload = await response.json().catch(() => null) as { error?: string } | null;
            throw new Error(payload?.error ?? "저장 실패");
          }
          const payload = parseDatasetApiResponse(await response.json() as DatasetApiResponse);
          datasetsNow = payload.datasets;
          setSavedDatasets(payload.datasets);
          setTrashedDatasets(payload.trashedDatasets);
          okLabels.push(label);
        } catch (error) {
          failLabels.push(`${label} (${error instanceof Error ? error.message : "저장 실패"})`);
        }
      }
    }

    // 저장 데이터가 바뀌었으면 결과물 시트도 화면과 같게 갱신(저장 흐름과 동일).
    if (okLabels.length) {
      const sheetsPayload = buildSheetsSyncPayload(datasetsNow, accountTreeLookup ? { logicConfig, companyConfigs, accountTreeLookup } : undefined);
      if (sheetsPayload.quarterTabs.length) {
        setSheetsSyncState({ status: "syncing", message: "삭제 후 시트 동기화 중..." });
        postSheetsSync(sheetsPayload)
          .then((data) => {
            if (data?.ok) {
              setSheetsSyncState({ status: "ok", message: `시트 동기화 완료 (탭 ${data.tabsWritten ?? sheetsPayload.quarterTabs.length})` });
              window.setTimeout(() => setSheetsSyncState((prev) => prev.status === "ok" ? { status: "idle" } : prev), 4000);
            } else if (data?.reason === "disabled") {
              setSheetsSyncState({ status: "idle" });
            } else {
              setSheetsSyncState({ status: "error", message: describeSheetsError(data) });
            }
          })
          .catch((err) => {
            setSheetsSyncState({ status: "error", message: err instanceof Error ? err.message : "구글시트 동기화 실패" });
          });
      }
    }

    if (!failLabels.length) {
      return { ok: true, message: `'${accountName}' 삭제 완료 — ${okLabels.join(", ")}` };
    }
    return {
      ok: okLabels.length > 0,
      message: `'${accountName}' ${okLabels.length ? `삭제 ${okLabels.length}건 완료` : "삭제 실패"} · 건너뜀: ${failLabels.join(" / ")}`
    };
  }
  const reporting = useMemo(
    () => {
      const reportArgs = {
        pastedText,
        selectedCompany: selectedCompany.trim() || null,
        tolerance,
        logicConfig,
        companyConfigs,
        pasteEdits,
        nameEdits,
        sessionSignFixes,
        accountTreeLookup: accountTreeLookup ?? undefined
      };
      return buildReportingModel(reportArgs);
    },
    [pastedText, selectedCompany, tolerance, logicConfig, companyConfigs, pasteEdits, nameEdits, sessionSignFixes, accountTreeLookup]
  );
  const activeAccountDbPreviewDataset = useMemo(
    () => savedDatasets.find((item) => item.id === activeAccountDbPreview?.datasetId) ?? null,
    [activeAccountDbPreview, savedDatasets]
  );

  const companyKnown = Boolean(selectedCompany.trim() && companyConfigs[selectedCompany.trim()]);
  const sessionFixCount = countSessionFixes(sessionSignFixes);
  const editedValueCount = Object.keys(pasteEdits).length;
  const editedNameCount = Object.keys(nameEdits).length;
  const canSaveCurrentDataset = Boolean(reporting.periods.length) && validation.stats.total > 0 && validation.stats.failed === 0;
  const previewGroups = useMemo(
    () => buildPreviewGroups(validation.parsed.catRow, validation.parsed.nameRow),
    [validation.parsed.catRow, validation.parsed.nameRow]
  );
  const validatePreviewGroups = useMemo(
    () => buildValidatePreviewGroups({
      catRow: validation.parsed.catRow,
      nameRow: validation.parsed.nameRow,
      editableNameRow: validation.editableNameRow,
      dataRows: buildEffectiveDataRows(validation.parsed.dataRows, pasteEdits)
    }),
    [validation.parsed.catRow, validation.parsed.nameRow, validation.editableNameRow, validation.parsed.dataRows, pasteEdits]
  );
  // 오타 추론용 사전: 지금 선택한 회사가 과거 분기에 실제로 쓴 계정명 모음.
  // 같은 회사는 계정명을 분기마다 재사용하므로, 이번에 트리 매칭 안 된 이름을
  // 이 사전과 자모 편집거리로 비교해 OCR 오타 후보를 띄운다.
  const companyVocab = useMemo<VocabEntry[]>(() => {
    const company = selectedCompany.trim();
    if (!company) return [];
    const acc = new Map<string, { name: string; quarters: Set<string>; inTree: boolean }>();
    for (const dataset of savedDatasets) {
      if (dataset.companyName !== company) continue;
      for (const row of dataset.adjustedStatementRows) {
        const name = row.accountName?.trim();
        if (!name) continue;
        const key = normalizeAccountName(name);
        if (!key) continue;
        const inTree = row.code != null && row.code > 0;
        const existing = acc.get(key);
        if (existing) {
          existing.quarters.add(dataset.quarterKey);
          existing.inTree = existing.inTree || inTree;
        } else {
          acc.set(key, { name, quarters: new Set([dataset.quarterKey]), inTree });
        }
      }
    }
    return Array.from(acc.values()).map((v) => ({ name: v.name, quarters: v.quarters.size, inTree: v.inTree }));
  }, [selectedCompany, savedDatasets]);

  // 전체 사전: 계정트리의 모든 leaf 이름(L5). 회사 과거 데이터가 없거나 거기서
  // 오타 후보를 못 찾았을 때의 폴백. 회사 이력보다 약한 신호라 더 엄격하게 본다.
  const globalVocab = useMemo<VocabEntry[]>(() => {
    if (!accountTreeLookup) return [];
    const acc = new Map<string, string>();
    for (const matches of accountTreeLookup.values()) {
      for (const m of matches) {
        const name = m.canonicalKey?.trim();
        if (!name) continue;
        const key = normalizeAccountName(name);
        if (key && !acc.has(key)) acc.set(key, name);
      }
    }
    return Array.from(acc.values()).map((name) => ({ name, quarters: 0, inTree: true }));
  }, [accountTreeLookup]);

  // 붙여넣은 계정명 중 트리에 매칭 안 된(미분류) 계정은 **무조건** 표시한다:
  //  - candidates 있음 → 오타 보정 후보(🔤). 그 회사 과거 사전 먼저, 없으면 전체 사전.
  //  - candidates 없음 → 신규 계정일 수 있음(🆕). 보정할 근거가 없을 뿐 미분류는 항상 노출.
  //  - fromGlobal: 후보가 회사 이력이 아니라 전체 사전에서 나왔는지(표시 문구 구분).
  const nameSuggestions = useMemo(() => {
    const map = new Map<number, { candidates: TypoCandidate[]; isNew: boolean; fromGlobal: boolean }>();
    if (!accountTreeLookup) return map;
    // 전체 사전은 후보가 많아 오탐이 늘기 쉬우므로 회사 사전보다 빡빡하게.
    const GLOBAL_OPTS = { nearDistance: 1, highSimilarity: 0.9, maxDistance: 3 };
    const names = validation.editableNameRow;
    const sections = buildEffectiveSections(validation.parsed.catRow, names.length);
    // 엔진이 실제로 매긴 매칭 신호를 모은다(내 자체 트리 검사와 어긋나지 않게).
    //  - 매출액처럼 트리 leaf명은 "영업수익"이라도 영업이익 규칙의 인식된
    //    구성요소면 엔진이 unmatched로 안 본다 → 미분류로 띄우면 안 됨.
    const matchedCols = new Set<number>();
    const unmatchedCols = new Set<number>();
    for (const result of validation.allResults) {
      if (result.parent_col !== undefined) matchedCols.add(result.parent_col);
      for (const d of result.detail) {
        if (d._col === undefined) continue;
        if (d.unmatched) unmatchedCols.add(d._col);
        else matchedCols.add(d._col);
      }
    }
    names.forEach((name, colIndex) => {
      const trimmed = (name ?? "").trim();
      if (!trimmed) return;
      const rawName = validation.parsed.nameRow[colIndex] ?? trimmed;
      if (isLockedPreviewNameCell(rawName)) return; // 회사명/날짜 열
      const key = normalizeAccountName(trimmed);
      if (accountTreeNodeNames.has(key)) return; // 섹션 총계/구조노드는 계정 아님
      const section = sections[colIndex]?.trim() || "기타";
      // 엔진이 인식한 열이면 미분류 아님. 엔진이 안 다룬 열만 트리 검사로 폴백.
      const recognized = matchedCols.has(colIndex)
        ? true
        : unmatchedCols.has(colIndex)
          ? false
          : resolveAccountClassification(trimmed, section, accountTreeLookup, true) !== null;
      if (recognized) return; // 이미 인식됨 → 표시 불필요
      let candidates = suggestTypoCandidates(trimmed, companyVocab);
      let fromGlobal = false;
      if (candidates.length === 0) {
        const global = suggestTypoCandidates(trimmed, globalVocab, GLOBAL_OPTS);
        if (global.length > 0) {
          candidates = global;
          fromGlobal = true;
        }
      }
      // 후보가 없어도(보정 근거 없음) 미분류 자체는 항상 띄운다 → 🆕 신규 계정.
      map.set(colIndex, { candidates, isNew: candidates.length === 0, fromGlobal });
    });
    return map;
  }, [validation.editableNameRow, validation.parsed.catRow, validation.parsed.nameRow, validation.allResults, accountTreeLookup, accountTreeNodeNames, companyVocab, globalVocab]);

  const selectedDataset = useMemo(
    () => savedDatasets.find((item) => item.id === selectedDatasetId) ?? null,
    [savedDatasets, selectedDatasetId]
  );
  const groupedSavedDatasets = useMemo(
    () => Array.from(savedDatasets.reduce((acc, dataset) => {
      const bucket = acc.get(dataset.companyName) ?? [];
      bucket.push(dataset);
      acc.set(dataset.companyName, bucket);
      return acc;
    }, new Map<string, SavedQuarterSnapshot[]>()).entries()),
    [savedDatasets]
  );
  // 데이터 탭 분기 필터 옵션 — 저장 데이터의 고유 분기(최신순).
  const dataQuarterOptions = useMemo(
    () => Array.from(new Set(savedDatasets.map((d) => d.quarterLabel))).sort((a, b) => b.localeCompare(a)),
    [savedDatasets]
  );
  // 패밀리사 수집 현황 — 분기 필터를 따라가고, "전체 분기"면 최신 분기 기준.
  const effectiveFamilyList = familyCompanies?.length ? familyCompanies : DEFAULT_FAMILY_COMPANIES;
  const familyTargetQuarter = dataQuarterFilter || dataQuarterOptions[0] || null;
  const familyCoverage = useMemo(
    () => familyTargetQuarter ? computeFamilyCoverage(effectiveFamilyList, savedDatasets, familyTargetQuarter) : null,
    [effectiveFamilyList, savedDatasets, familyTargetQuarter]
  );

  // 패밀리 명단 저장 — app_config.family_companies. 컬럼이 없으면(마이그레이션 008 전)
  // 에러 메시지로 안내하고, 그 전까지는 코드 내장 기본 명단으로 동작한다.
  async function saveFamilyCompanies() {
    const lines = (familyDraft ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!lines.length) {
      setFamilySaveState({ status: "error", message: "명단이 비어 있습니다. 한 줄에 한 회사씩 적어 주세요." });
      return;
    }
    setFamilySaveState({ status: "saving" });
    try {
      const res = await fetch("/api/shared-state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ familyCompanies: { value: lines } })
      });
      const data = await res.json().catch(() => null) as { ok?: boolean; reason?: string; error?: string; updatedAt?: string; updatedBy?: string } | null;
      if (data?.ok) {
        setFamilyCompanies(lines);
        setFamilyMeta({ updatedAt: data.updatedAt ?? new Date().toISOString(), updatedBy: data.updatedBy ?? null });
        setFamilyDraft(null);
        setFamilySaveState({ status: "ok", message: `명단 ${lines.length}개사 저장 완료` });
        window.setTimeout(() => setFamilySaveState((prev) => prev.status === "ok" ? { status: "idle" } : prev), 4000);
      } else if (data?.reason === "family_columns_missing") {
        setFamilySaveState({ status: "error", message: "DB 컬럼이 아직 없습니다 — supabase/008_family_companies.sql을 먼저 실행하세요. 그 전까지는 기본 명단으로 동작합니다." });
      } else {
        setFamilySaveState({ status: "error", message: data?.error ?? "명단 저장에 실패했습니다." });
      }
    } catch (error) {
      setFamilySaveState({ status: "error", message: error instanceof Error ? error.message : "명단 저장에 실패했습니다." });
    }
  }

  function copyFamilyMissing() {
    if (!familyCoverage?.missing.length) return;
    void navigator.clipboard.writeText(familyCoverage.missing.join("\n")).then(() => {
      setFamilyCopied(true);
      window.setTimeout(() => setFamilyCopied(false), 2500);
    }).catch(() => undefined);
  }
  // 검색(회사명) + 분기 + 산업 필터를 적용한 회사 그룹.
  const filteredGroupedDatasets = useMemo(() => {
    const q = dataSearch.trim().toLowerCase();
    return groupedSavedDatasets.filter(([companyName, datasets]) => {
      if (q && !companyName.toLowerCase().includes(q)) return false;
      if (dataQuarterFilter && !datasets.some((d) => d.quarterLabel === dataQuarterFilter)) return false;
      if (dataIndustryFilter) {
        const ind = normalizeIndustryLabel(companyConfigs[companyName]?.industry ?? "") || "미분류";
        if (ind !== dataIndustryFilter) return false;
      }
      return true;
    });
  }, [groupedSavedDatasets, dataSearch, dataQuarterFilter, dataIndustryFilter, companyConfigs]);
  const resultReporting = useMemo(
    () => {
      const snaps = selectedDataset
        ? savedDatasets.filter((item) => item.companyName === selectedDataset.companyName)
        : [];
      const reportSnaps = accountTreeLookup
        ? rebuildSnapshotsWithTree(snaps, { logicConfig, companyConfigs, accountTreeLookup })
        : snaps;
      return buildCompanyReport(reportSnaps);
    },
    [selectedDataset, savedDatasets, accountTreeLookup, logicConfig, companyConfigs]
  );
  const selectedReportPeriod = useMemo(
    () => selectedDataset
      ? resultReporting.periods.find((period) => period.key === selectedDataset.quarterKey) ?? null
      : null,
    [selectedDataset, resultReporting.periods]
  );
  const comparisonColumns = useMemo<ComparisonColumn[]>(
    () => comparisonSelections
      .map((selection) => {
        const dataset = savedDatasets.find((item) => item.id === selection.datasetId);
        if (!dataset) {
          return null;
        }
        const companySnaps = savedDatasets.filter((item) => item.companyName === dataset.companyName);
        const model = buildCompanyReport(
          accountTreeLookup
            ? rebuildSnapshotsWithTree(companySnaps, { logicConfig, companyConfigs, accountTreeLookup })
            : companySnaps
        );
        return {
          slotId: selection.slotId,
          datasetId: dataset.id,
          companyName: dataset.companyName,
          quarterLabel: dataset.quarterLabel,
          periodKey: dataset.quarterKey,
          finalSections: model.finalSections
        } satisfies ComparisonColumn;
      })
      .filter((item): item is ComparisonColumn => item !== null),
    [comparisonSelections, savedDatasets, accountTreeLookup, logicConfig, companyConfigs]
  );
  const comparisonCompanyOptions = useMemo(
    () => Array.from(new Set(savedDatasets.map((item) => item.companyName))),
    [savedDatasets]
  );
  const industryOptions = useMemo(() => Array.from(DEFAULT_INDUSTRY_OPTIONS), []);

  // pasteEdits를 의존성에 넣고 setPasteEdits를 호출하면, normalize 결과가
  // 입력과 미세하게라도 달라지는 순간 무한 리렌더에 빠진다(매 루프마다 거대
  // 카탈로그를 풀스캔 → 메인 스레드 영구 점유 → 클릭 불가). 함수형 업데이트로
  // prev를 직접 받고, 결과가 같으면 prev를 그대로 반환해 리렌더를 끊는다.
  useEffect(() => {
    setPasteEdits((prev) => {
      const normalized = normalizePasteEditsForValidation({
        pastedText,
        selectedCompany,
        logicConfig,
        companyConfigs,
        accountTreeLookup: accountTreeLookup ?? undefined,
        pasteEdits: prev,
        nameEdits,
        sessionSignFixes
      });
      return JSON.stringify(normalized) !== JSON.stringify(prev) ? normalized : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pastedText, selectedCompany, logicConfig, companyConfigs, nameEdits, sessionSignFixes, accountTreeLookup]);

  function resetAdjustments() {
    setPasteEdits({});
    setNameEdits({});
    setSessionSignFixes({});
    setPendingInsertedRows({});
  }

  async function saveCurrentDataset() {
    if (validation.parsed.error || !canSaveCurrentDataset) {
      return;
    }
    const snapshotArgs = {
      pastedText,
      selectedCompany: selectedCompany.trim() || null,
      tolerance,
      logicConfig,
      companyConfigs,
      accountTreeLookup: accountTreeLookup ?? undefined,
      pasteEdits,
      nameEdits,
      sessionSignFixes,
      statementType
    };
    const snapshots = buildQuarterSnapshots(snapshotArgs);

    const duplicates = snapshots.filter((s) => savedDatasets.some((d) => d.id === s.id));
    if (duplicates.length > 0) {
      const labels = duplicates.map((s) => s.quarterLabel).join(", ");
      if (!confirm(`이미 저장된 분기 데이터가 있습니다 (${labels}).\n덮어쓰시겠습니까?`)) return;
    }

    setDatasetActionState("saving");

    try {
      const response = await fetch("/api/datasets", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          snapshots,
          validatedText: validation.copyText
        })
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error ?? "데이터 저장에 실패했습니다.");
      }

      const payload = parseDatasetApiResponse(await response.json() as DatasetApiResponse);
      const nextSaved = payload.datasets;
      setSavedDatasets(nextSaved);
      setTrashedDatasets(payload.trashedDatasets);
      setSelectedDatasetId(snapshots[0]?.id ?? "");
      setComparisonSelections(buildInitialComparisonSelections(nextSaved));
      setSharedStateError(null);
      setActiveTab("data");

      // Use freshly-saved data (nextSaved) — React state may not have propagated yet.
      const sheetsPayload = buildSheetsSyncPayload(nextSaved, accountTreeLookup ? { logicConfig, companyConfigs, accountTreeLookup } : undefined);
      if (sheetsPayload.quarterTabs.length) {
        setSheetsSyncState({ status: "syncing", message: "저장 후 시트 동기화 중..." });
        postSheetsSync(sheetsPayload)
          .then((data) => {
            if (data?.ok) {
              setSheetsSyncState({ status: "ok", message: `시트 동기화 완료 (탭 ${data.tabsWritten ?? sheetsPayload.quarterTabs.length})` });
              window.setTimeout(() => setSheetsSyncState((prev) => prev.status === "ok" ? { status: "idle" } : prev), 4000);
            } else if (data?.reason === "disabled") {
              setSheetsSyncState({ status: "idle" });
            } else {
              setSheetsSyncState({ status: "error", message: describeSheetsError(data) });
            }
          })
          .catch((err) => {
            setSheetsSyncState({ status: "error", message: err instanceof Error ? err.message : "구글시트 동기화 실패" });
          });
      }
    } catch (error) {
      setSharedStateError(error instanceof Error ? error.message : "데이터 저장에 실패했습니다.");
    } finally {
      setDatasetActionState("idle");
    }
  }

  async function postSheetsSync(payload: ReturnType<typeof buildSheetsSyncPayload>) {
    const res = await fetch("/api/datasets/sheets-sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    return await res.json().catch(() => null) as {
      ok?: boolean;
      reason?: string;
      error?: string;
      tabsWritten?: number;
      rowsTotal?: number;
      env?: Record<string, { present: boolean; length: number }>;
    } | null;
  }

  function describeSheetsError(data: { reason?: string; error?: string; env?: Record<string, { present: boolean; length: number }> } | null) {
    if (data?.reason === "disabled") {
      const env = data.env ?? {};
      const missing = Object.entries(env).filter(([, v]) => !v.present).map(([k]) => k);
      const detail = missing.length
        ? `누락: ${missing.join(", ")}`
        : `값 길이: ${Object.entries(env).map(([k, v]) => `${k.replace("GOOGLE_SHEETS_", "")}=${v.length}`).join(", ")}`;
      return `Vercel 환경변수 문제 — ${detail}`;
    }
    return data?.error ?? "구글시트 동기화 실패";
  }

  async function bulkSyncSheets() {
    setSheetsSyncState({ status: "syncing", message: "전체 동기화 중..." });
    try {
      const payload = buildSheetsSyncPayload(savedDatasets, accountTreeLookup ? { logicConfig, companyConfigs, accountTreeLookup } : undefined);
      if (!payload.quarterTabs.length) {
        setSheetsSyncState({ status: "error", message: "저장된 분기 데이터가 없습니다." });
        return;
      }
      const data = await postSheetsSync(payload);
      if (data?.ok) {
        const tabs = data.tabsWritten ?? payload.quarterTabs.length;
        const rows = data.rowsTotal ?? 0;
        setSheetsSyncState({ status: "ok", message: `동기화 완료 (탭 ${tabs} · 행 ${rows})` });
        window.setTimeout(() => setSheetsSyncState((prev) => prev.status === "ok" ? { status: "idle" } : prev), 6000);
      } else {
        setSheetsSyncState({ status: "error", message: describeSheetsError(data) });
      }
    } catch (err) {
      setSheetsSyncState({ status: "error", message: err instanceof Error ? err.message : "구글시트 동기화 실패" });
    }
  }

  async function patchDatasetStatementType(datasetId: string, newType: string) {
    const res = await fetch(`/api/datasets/${encodeURIComponent(datasetId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ statementType: newType }),
    });
    if (res.ok) {
      setSavedDatasets((prev) =>
        prev.map((d) =>
          d.id === datasetId ? { ...d, source: { ...d.source, statementType: newType } } : d
        )
      );
    }
  }

  function isRatioOnlySection(title: string) {
    return RATIO_ONLY_SECTION_TITLES.has(title);
  }

  function isPeriodMetricLabel(label: string) {
    return label.includes("기간") || label === "정상영업순환주기" || label === "런웨이(E)";
  }

  function hasMetricAmount(row: FinalMetricRow, periodKey: string) {
    return row.amounts[periodKey] !== null && row.amounts[periodKey] !== undefined;
  }

  function hasMetricRatio(row: FinalMetricRow, periodKey: string) {
    return row.ratios[periodKey] !== null && row.ratios[periodKey] !== undefined;
  }

  function loadDatasetIntoValidator(dataset: SavedQuarterSnapshot) {
    // Re-normalize paste edits against the *current* 분류DB/logicConfig — using
    // dataset.source.* (the snapshot's frozen view of the rules) re-applies
    // stale sign-driven absolute-value normalization that no longer matches
    // the live catalog, which is what made loaded datasets fail validation
    // even though a fresh paste of the same text passed.
    //
    // sessionSignFixes is dropped so the validator re-decides signs from the
    // current 분류DB. nameEdits are kept because they are OCR name corrections,
    // not sign overrides.
    const normalizedPasteEdits = normalizePasteEditsForValidation({
      pastedText: dataset.source.pastedText,
      selectedCompany: dataset.companyName,
      logicConfig,
      companyConfigs,
      accountTreeLookup: accountTreeLookup ?? undefined,
      pasteEdits: dataset.source.pasteEdits,
      nameEdits: dataset.source.nameEdits ?? {},
      sessionSignFixes: {}
    });

    setPastedText(dataset.source.pastedText);
    setTolerance(dataset.source.tolerance);
    setSelectedCompany(dataset.companyName);
    setPasteEdits(normalizedPasteEdits);
    setNameEdits({ ...(dataset.source.nameEdits ?? {}) });
    setSessionSignFixes({});
    setPendingInsertedRows({});
    setSelectedDatasetId(dataset.id);
    setActiveTab("validate");
  }

  function openAccountDbSourceDataset(datasetId: string, accountName: string, entryKey: string) {
    const dataset = savedDatasets.find((item) => item.id === datasetId);
    if (!dataset) {
      return;
    }

    setActiveAccountDbPreview({ datasetId: dataset.id, accountName });
    setActiveAccountDbSourceKey(null);
    setActiveAccountDbHighlightKey(entryKey);
  }

  async function deleteDataset(dataset: SavedQuarterSnapshot) {
    setDatasetActionState("deleting");
    try {
      const response = await fetch("/api/datasets", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          id: dataset.id,
          companyName: dataset.companyName,
          quarterKey: dataset.quarterKey
        })
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error ?? "데이터 삭제에 실패했습니다.");
      }

      const payload = parseDatasetApiResponse(await response.json() as DatasetApiResponse);
      const next = payload.datasets;
      setSavedDatasets(next);
      setTrashedDatasets(payload.trashedDatasets);
      if (selectedDatasetId === dataset.id) {
        setSelectedDatasetId(next[0]?.id ?? "");
      }
      setComparisonSelections(buildInitialComparisonSelections(next));
      setSharedStateError(null);
    } catch (error) {
      setSharedStateError(error instanceof Error ? error.message : "데이터 삭제에 실패했습니다.");
    } finally {
      setDatasetActionState("idle");
    }
  }

  async function restoreDataset(dataset: SavedQuarterSnapshot) {
    setDatasetActionState("restoring");
    try {
      const response = await fetch("/api/datasets/restore", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          id: dataset.id,
          companyName: dataset.companyName,
          quarterKey: dataset.quarterKey
        })
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error ?? "데이터 복구에 실패했습니다.");
      }

      const payload = parseDatasetApiResponse(await response.json() as DatasetApiResponse);
      setSavedDatasets(payload.datasets);
      setTrashedDatasets(payload.trashedDatasets);
      setSelectedDatasetId(dataset.id);
      setComparisonSelections(buildInitialComparisonSelections(payload.datasets));
      setSharedStateError(null);
    } catch (error) {
      setSharedStateError(error instanceof Error ? error.message : "데이터 복구에 실패했습니다.");
    } finally {
      setDatasetActionState("idle");
    }
  }

  async function purgeDataset(dataset: SavedQuarterSnapshot) {
    const confirmed = window.confirm(`${dataset.companyName} ${dataset.quarterLabel} 데이터를 완전삭제할까요? 이 작업은 되돌릴 수 없습니다.`);
    if (!confirmed) {
      return;
    }

    setDatasetActionState("purging");
    try {
      const response = await fetch("/api/datasets/purge", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          id: dataset.id,
          companyName: dataset.companyName,
          quarterKey: dataset.quarterKey
        })
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error ?? "데이터 완전삭제에 실패했습니다.");
      }

      const payload = parseDatasetApiResponse(await response.json() as DatasetApiResponse);
      setSavedDatasets(payload.datasets);
      setTrashedDatasets(payload.trashedDatasets);
      setComparisonSelections(buildInitialComparisonSelections(payload.datasets));
      setSharedStateError(null);
    } catch (error) {
      setSharedStateError(error instanceof Error ? error.message : "데이터 완전삭제에 실패했습니다.");
    } finally {
      setDatasetActionState("idle");
    }
  }

  function updateComparisonCompany(slotId: string, companyName: string) {
    if (sameCompanyMode && slotId === "slot-1") {
      const firstDataset = savedDatasets.find((item) => item.companyName === companyName) ?? null;
      applySameCompanySelections(companyName, firstDataset?.id ?? "");
      return;
    }

    const nextDataset = savedDatasets.find((item) => item.companyName === companyName) ?? null;
    setComparisonSelections((prev) => prev.map((selection) => selection.slotId === slotId
      ? {
          ...selection,
          companyName,
          datasetId: nextDataset?.id ?? ""
        }
      : selection));
  }

  function updateComparisonQuarter(slotId: string, datasetId: string) {
    if (sameCompanyMode && slotId === "slot-1") {
      const firstDataset = savedDatasets.find((item) => item.id === datasetId) ?? null;
      applySameCompanySelections(firstDataset?.companyName ?? "", datasetId);
      return;
    }

    setComparisonSelections((prev) => prev.map((selection) => selection.slotId === slotId
      ? {
          ...selection,
          datasetId
        }
      : selection));
  }

  function applySameCompanySelections(companyName: string, startDatasetId: string) {
    if (!companyName) {
      return;
    }

    const sameCompanyDatasets = savedDatasets.filter((item) => item.companyName === companyName);
    const startIndex = Math.max(0, sameCompanyDatasets.findIndex((item) => item.id === startDatasetId));
    const orderedDatasets = (startIndex >= 0 ? sameCompanyDatasets.slice(startIndex, startIndex + 4) : sameCompanyDatasets.slice(0, 4));

    setComparisonSelections((prev) => prev.map((selection, index) => ({
      ...selection,
      companyName: orderedDatasets[index]?.companyName ?? companyName,
      datasetId: orderedDatasets[index]?.id ?? ""
    })));
  }

  function toggleSameCompanyMode() {
    setSameCompanyMode((prev) => {
      const next = !prev;
      if (!prev) {
        const firstSelection = comparisonSelections[0];
        const firstDataset = savedDatasets.find((item) => item.id === firstSelection?.datasetId) ?? null;
        const companyName = firstSelection?.companyName || firstDataset?.companyName || "";
        const datasetId = firstSelection?.datasetId || firstDataset?.id || "";
        if (companyName) {
          applySameCompanySelections(companyName, datasetId);
        }
      }
      return next;
    });
  }

  function findComparisonMetric(sectionTitle: string, rowLabel: string, slotId: string) {
    const column = comparisonColumns.find((item) => item.slotId === slotId);
    const section = column?.finalSections.find((item) => item.title === sectionTitle);
    const row = section?.rows.find((item) => item.label === rowLabel);
    if (!row) {
      return null;
    }
    const periodKey = Object.keys(row.amounts)[0] ?? "";
    const targetPeriodKey = column?.periodKey ?? periodKey;
    if (!targetPeriodKey) {
      return null;
    }
    return {
      row,
      amount: row.amounts[targetPeriodKey],
      ratio: row.ratios[targetPeriodKey],
      growthRate: row.growthRates[targetPeriodKey]
    };
  }

  function updateEditableValue(rowIndex: number, colIndex: number, rawValue: number, nextValue: string) {
    const parsed = safeFloat(nextValue);
    setPasteEdits((prev) => {
      const next = { ...prev };
      const key = pasteEditKey(rowIndex, colIndex);
      if (parsed === null || Math.abs(parsed - rawValue) < 0.5) {
        delete next[key];
      } else {
        next[key] = parsed;
      }
      return next;
    });
    setLastEditedCell(`${rowIndex}_${colIndex}`);
  }

  function updateEditableName(colIndex: number, rawName: string, nextName: string) {
    const normalized = nextName.trim();
    setNameEdits((prev) => {
      const next = { ...prev };
      const key = pasteEditKey(0, colIndex);
      if (!normalized || normalized === rawName.trim()) {
        delete next[key];
      } else {
        next[key] = normalized;
      }
      return next;
    });
    setLastEditedCell(`0_${colIndex}`);
  }

  // 계정명 셀 아래 오타/신규 제안 칩. nameSuggestions(트리 미매칭 열)에 한해 렌더.
  function renderNameSuggestion(colIndex: number, rawName: string) {
    const sug = nameSuggestions.get(colIndex);
    if (!sug) return null;
    const currentName = validation.editableNameRow[colIndex] ?? "";
    const dismissKey = normalizeAccountName(currentName);
    if (dismissedTypoNames.has(dismissKey)) return null;
    if (sug.candidates.length === 0) {
      // 후보 없음 = 이 회사 과거 분기에 없던 신규 계정.
      return (
        <div className="name-suggest">
          <span className="name-suggest-chip is-new" title="분류DB(계정트리)에 없는 계정입니다. 비슷한 이름이 없어 오타 보정 후보가 없으니, 신규 계정이면 트리에 추가해 분류하세요.">🆕 미분류 · 신규일 수 있음</span>
        </div>
      );
    }
    return (
      <div className="name-suggest">
        {sug.candidates.map((candidate) => (
          <button
            key={candidate.name}
            type="button"
            className="name-suggest-chip is-typo"
            title={sug.fromGlobal
              ? `계정트리에 있는 비슷한 계정명 · 유사도 ${(candidate.similarity * 100).toFixed(0)}% (이 회사 과거 분기엔 없어 전체 사전에서 찾음)`
              : `다른 분기에서 ${candidate.quarters}회 사용${candidate.inTree ? " · 분류됨" : ""} · 유사도 ${(candidate.similarity * 100).toFixed(0)}%`}
            onClick={() => updateEditableName(colIndex, rawName, candidate.name)}
          >
            🔤 오타? <strong>{candidate.name}</strong>
          </button>
        ))}
        <button
          type="button"
          className="name-suggest-chip is-keep"
          title="오타가 아니라 새 계정입니다. 제안을 닫고 입력값을 그대로 둡니다."
          onClick={() => setDismissedTypoNames((prev) => new Set(prev).add(dismissKey))}
        >
          ➕ 신규 유지
        </button>
      </div>
    );
  }

  function applySuggestedEdit(rowIndex: number, colIndex: number, nextValue: number) {
    const rawCell = validation.parsed.dataRows[rowIndex]?.[colIndex];
    const rawValue = typeof rawCell === "number" ? rawCell : 0;
    updateEditableValue(rowIndex, colIndex, rawValue, String(nextValue));
  }

  function removeValidationAccount(colIndex: number) {
    if (!validation.parsed.nameRow[colIndex]) {
      return;
    }

    const nextMatrix = removeColumnFromMatrix(
      validation.parsed.catRow,
      validation.editableNameRow,
      buildEffectiveDataRows(validation.parsed.dataRows, pasteEdits),
      colIndex
    );

    setPastedText(buildPastedTextFromMatrix(nextMatrix.catRow, nextMatrix.nameRow, nextMatrix.dataRows));
    setPasteEdits({});
    setNameEdits({});
    setSessionSignFixes((prev) => {
      const accountName = validation.editableNameRow[colIndex] ?? validation.parsed.nameRow[colIndex] ?? "";
      const next = Object.fromEntries(Object.entries(prev).map(([section, items]) => {
        const filtered = Object.fromEntries(Object.entries(items).filter(([name]) => name !== accountName));
        return [section, filtered];
      }).filter(([, items]) => Object.keys(items).length));
      return next;
    });
  }

  function updatePendingInsertedRow(cardKey: string, field: keyof PendingInsertedRow, value: string) {
    setPendingInsertedRows((prev) => ({
      ...prev,
      [cardKey]: {
        section: prev[cardKey]?.section ?? "",
        accountName: prev[cardKey]?.accountName ?? "",
        value: prev[cardKey]?.value ?? "",
        [field]: value
      }
    }));
  }

  function openPendingInsertedRow(cardKey: string, section: string) {
    setPendingInsertedRows((prev) => ({
      ...prev,
      [cardKey]: prev[cardKey] ?? {
        section,
        accountName: "",
        value: ""
      }
    }));
  }

  function closePendingInsertedRow(cardKey: string) {
    setPendingInsertedRows((prev) => {
      const next = { ...prev };
      delete next[cardKey];
      return next;
    });
  }

  function addValidationAccount(cardKey: string, rowIndex: number, defaultSection: string) {
    const draft = pendingInsertedRows[cardKey];
    const section = draft?.section.trim() || defaultSection.trim();
    const accountName = draft?.accountName.trim() ?? "";
    const value = safeFloat(draft?.value ?? "");

    if (!section || !accountName || value === null) {
      return;
    }

    const effectiveSections = buildEffectiveSections(validation.parsed.catRow, validation.editableNameRow.length);
    const lastSectionIndex = effectiveSections.reduce((acc, item, index) => item === section ? index : acc, -1);
    const insertIndex = lastSectionIndex >= 0 ? lastSectionIndex + 1 : validation.editableNameRow.length;
    const nextMatrix = insertColumnIntoMatrix(
      validation.parsed.catRow,
      validation.editableNameRow,
      buildEffectiveDataRows(validation.parsed.dataRows, pasteEdits),
      insertIndex,
      section,
      accountName,
      value,
      rowIndex
    );

    setPastedText(buildPastedTextFromMatrix(nextMatrix.catRow, nextMatrix.nameRow, nextMatrix.dataRows));
    setPasteEdits({});
    setNameEdits({});
    closePendingInsertedRow(cardKey);
  }

  function updateValidatePreviewDraft(rowIndex: number, section: string, field: keyof ValidatePreviewDraft, value: string) {
    const draftKey = String(rowIndex);
    setValidatePreviewDrafts((prev) => ({
      ...prev,
      [draftKey]: {
        section: prev[draftKey]?.section ?? section,
        accountName: prev[draftKey]?.accountName ?? "",
        value: prev[draftKey]?.value ?? "",
        [field]: value
      }
    }));
  }

  function addValidatePreviewAccount(rowIndex: number) {
    const draftKey = String(rowIndex);
    const draft = validatePreviewDrafts[draftKey];
    const section = draft?.section.trim() ?? "";
    const accountName = draft?.accountName.trim() ?? "";
    const value = safeFloat(draft?.value ?? "");

    if (!section || !accountName || value === null) {
      return;
    }

    const effectiveSections = buildEffectiveSections(validation.parsed.catRow, validation.editableNameRow.length);
    const lastSectionIndex = effectiveSections.reduce((acc, item, index) => item === section ? index : acc, -1);
    const insertIndex = lastSectionIndex >= 0 ? lastSectionIndex + 1 : validation.editableNameRow.length;
    const nextMatrix = insertColumnIntoMatrix(
      validation.parsed.catRow,
      validation.editableNameRow,
      buildEffectiveDataRows(validation.parsed.dataRows, pasteEdits),
      insertIndex,
      section,
      accountName,
      value,
      rowIndex
    );

    setPastedText(buildPastedTextFromMatrix(nextMatrix.catRow, nextMatrix.nameRow, nextMatrix.dataRows));
    setPasteEdits({});
    setNameEdits({});
    setValidatePreviewDrafts((prev) => {
      const next = { ...prev };
      delete next[draftKey];
      return next;
    });
  }

  function hasPendingResultAdjustments(result: ValidationResult) {
    const resultSection = result.sect ?? result.parent;
    const hasParentEdit = result.parent_row !== undefined
      && result.parent_col !== undefined
      && pasteEdits[pasteEditKey(result.parent_row, result.parent_col)] !== undefined;

    if (hasParentEdit) {
      return true;
    }

    return result.detail.some((detail) => {
      const hasValueEdit = detail._row !== undefined
        && detail._col !== undefined
        && pasteEdits[pasteEditKey(detail._row, detail._col)] !== undefined;
      const hasSignEdit = sessionSignFixes[resultSection]?.[detail.계정명] !== undefined;
      return hasValueEdit || hasSignEdit;
    });
  }

  function getResultStatus(result: ValidationResult) {
    if (!result.passed) {
      return { label: "실패", className: "status-fail" };
    }

    if (hasPendingResultAdjustments(result)) {
      return { label: "수정 완료", className: "status-pass" };
    }

    return { label: "통과", className: "status-pass" };
  }

  function applySessionFix(sect: string, acct: string, newSign: SignCode) {
    setSessionSignFixes((prev) => ({
      ...prev,
      [sect]: {
        ...(prev[sect] ?? {}),
        [acct]: newSign
      }
    }));
  }

  function saveGlobalFix(sect: string, acct: string, newSign: SignCode) {
    setLogicConfig((prev) => ({
      ...prev,
      sectionSignOverrides: {
        ...prev.sectionSignOverrides,
        [sect]: {
          ...(prev.sectionSignOverrides[sect] ?? {}),
          [acct]: newSign
        }
      }
    }));
    setGlobalOverrideRows((prev) => upsertOverrideRow(prev, { section: sect, keyword: acct, sign: newSign }));
    applySessionFix(sect, acct, newSign);
  }

  function saveCompanyFix(sect: string, acct: string, newSign: SignCode) {
    const company = selectedCompany.trim();
    if (!company) {
      return;
    }

    setCompanyConfigs((prev) => ({
      ...prev,
      [company]: {
        ...(prev[company] ?? {}),
        sectionSignOverrides: {
          ...(prev[company]?.sectionSignOverrides ?? {}),
          [sect]: {
            ...(prev[company]?.sectionSignOverrides?.[sect] ?? {}),
            [acct]: newSign
          }
        }
      }
    }));
    setCompanyOverrideRows((prev) => upsertOverrideRow(prev, { section: sect, keyword: acct, sign: newSign }));
    applySessionFix(sect, acct, newSign);
  }

  function updateDetailSign(sect: string, acct: string, nextSign: SignCode) {
    const nextSessionSignFixes = {
      ...sessionSignFixes,
      [sect]: {
        ...(sessionSignFixes[sect] ?? {}),
        [acct]: nextSign
      }
    };

    setSessionSignFixes(nextSessionSignFixes);
    setPasteEdits((prev) => normalizePasteEditsForValidation({
      pastedText,
      selectedCompany,
      logicConfig,
      companyConfigs,
      accountTreeLookup: accountTreeLookup ?? undefined,
      pasteEdits: prev,
      nameEdits,
      sessionSignFixes: nextSessionSignFixes
    }));
    // 분류는 구글시트(계정트리)에서만 한다 — 부호 세션 수정은 현재 검증에만
    // 반영되고, 영구 반영은 트리 편집 후 「시트에서 동기화」로 처리한다.
  }

  async function runConsistencyCheck() {
    setConsistencyChecking(true);
    setConsistencyMessage(null);
    try {
      const results: Array<{
        datasetId: string;
        companyName: string;
        quarterLabel: string;
        totalChecks: number;
        failedChecks: Array<{ rule: string; parent: string; expected: number; actual: number; diff: number }>;
      }> = [];

      const total = savedDatasets.length;
      // Chunk + yield so the main thread stays responsive while we re-validate
      // each dataset (each call re-parses the paste + re-normalizes edits
      // against the current 분류DB — heavy when many datasets are saved).
      const CHUNK = 5;
      const yieldToMain = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));

      for (let i = 0; i < total; i += CHUNK) {
        const slice = savedDatasets.slice(i, i + CHUNK);
        for (const dataset of slice) {
          // Re-normalize stored pasteEdits against the current 분류DB so the
          // check matches what the user would see in a fresh paste.
          const reNormalizedPasteEdits = normalizePasteEditsForValidation({
            pastedText: dataset.source.pastedText,
            selectedCompany: dataset.companyName,
            logicConfig,
            companyConfigs,
            accountTreeLookup: accountTreeLookup ?? undefined,
            pasteEdits: dataset.source.pasteEdits ?? {},
            nameEdits: dataset.source.nameEdits ?? {},
            sessionSignFixes: {}
          });
          const result = runValidation({
            pastedText: dataset.source.pastedText,
            selectedCompany: dataset.companyName,
            tolerance: dataset.source.tolerance ?? 0,
            logicConfig,
            companyConfigs,
            pasteEdits: reNormalizedPasteEdits,
            nameEdits: dataset.source.nameEdits ?? {},
            // Drop stored sessionSignFixes — this check answers "does the data
            // pass under the *current* 분류DB(계정트리)?". Historical overrides would
            // hide that.
            sessionSignFixes: {},
            accountTreeLookup: accountTreeLookup ?? undefined
          });

          const failed: Array<{ rule: string; parent: string; expected: number; actual: number; diff: number }> = [];
          for (const r of result.allResults) {
            if (!r.passed) {
              failed.push({
                rule: r.rule,
                parent: r.parent,
                expected: r.parent_val,
                actual: r.computed,
                diff: r.diff
              });
            }
          }
          if (failed.length) {
            results.push({
              datasetId: dataset.id,
              companyName: dataset.companyName,
              quarterLabel: dataset.quarterLabel,
              totalChecks: result.stats.total,
              failedChecks: failed
            });
          }
        }
        const done = Math.min(i + CHUNK, total);
        setConsistencyMessage(`정합성 점검 진행 중... ${done} / ${total}`);
        // Yield so React can flush the progress update and clicks register.
        await yieldToMain();
      }

      setConsistencyResults(results);
      const totalFailed = results.reduce((a, r) => a + r.failedChecks.length, 0);
      setConsistencyMessage(results.length
        ? `⚠️ ${results.length}건 데이터에서 ${totalFailed}개 검증 항목이 지금 기준으로 통과하지 못합니다. 아래 목록의 회사·분기를 검증기로 다시 불러와 확인해 주세요.`
        : "✅ 모든 저장 데이터가 현재 기준으로 검증 통과합니다.");
    } finally {
      setConsistencyChecking(false);
    }
  }


  function pushConfigRulesSnapshot() {
    if (configRulesSnapshotPendingRef.current) {
      return;
    }
    configRulesSnapshotPendingRef.current = true;
    const snapshot: ConfigRulesSnapshot = {
      logicConfig: cloneLogicConfig(logicConfig),
      globalOverrideRows: globalOverrideRows.map((row) => ({ ...row })),
      pasteSectionRows: pasteSectionRows.map((row) => ({ ...row })),
      capitalRuleRows: capitalRuleRows.map((row) => ({ ...row })),
      capitalMemoRows: capitalMemoRows.map((row) => ({ ...row })),
      companyOverrideRows: companyOverrideRows.map((row) => ({ ...row }))
    };
    setConfigRulesHistory((prev) => [...prev.slice(-49), snapshot]);
    window.setTimeout(() => {
      configRulesSnapshotPendingRef.current = false;
    }, 500);
  }

  function undoConfigRulesEdit() {
    setConfigRulesHistory((prev) => {
      const last = prev[prev.length - 1];
      if (!last) {
        return prev;
      }
      setLogicConfig(cloneLogicConfig(last.logicConfig));
      setGlobalOverrideRows(last.globalOverrideRows.map((row) => ({ ...row })));
      setPasteSectionRows(last.pasteSectionRows.map((row) => ({ ...row })));
      setCapitalRuleRows(last.capitalRuleRows.map((row) => ({ ...row })));
      setCapitalMemoRows(last.capitalMemoRows.map((row) => ({ ...row })));
      setCompanyOverrideRows(last.companyOverrideRows.map((row) => ({ ...row })));
      return prev.slice(0, -1);
    });
  }

  function toggleResultCard(cardKey: string, defaultOpen: boolean) {
    setResultOpenState((prev) => ({
      ...prev,
      [cardKey]: !(prev[cardKey] ?? defaultOpen)
    }));
  }

  function openAllResultCards() {
    const next: Record<string, boolean> = {};
    for (const [dateLabel, results] of Object.entries(validation.resultsByDate)) {
      results.forEach((result, index) => {
        next[`${dateLabel}-${result.rule}-${index}`] = true;
      });
    }
    setResultOpenState(next);
  }

  function focusFailedResultCards() {
    setResultOpenState({});
  }

  function copyModifiedText() {
    const text = buildCopyText(
      validation.parsed.catRow,
      validation.parsed.nameRow,
      validation.parsed.dataRows,
      pasteEdits,
      nameEdits
    );
    navigator.clipboard.writeText(text).catch(() => undefined);
  }

  function toggleReportMetric(metricKey: string) {
    setExpandedReportMetrics((prev) => ({
      ...prev,
      [metricKey]: !prev[metricKey]
    }));
  }

  function toggleMetricHelp(metricKey: string) {
    setActiveMetricHelpKey((prev) => (prev === metricKey ? null : metricKey));
  }

  function getCompanyIndustry(companyName: string) {
    return normalizeIndustryLabel(companyConfigs[companyName]?.industry ?? "");
  }

  function setCompanyIndustry(companyName: string, industry: string) {
    const normalizedIndustry = normalizeIndustryLabel(industry);
    setCompanyConfigs((prev) => ({
      ...prev,
      [companyName]: {
        ...(prev[companyName] ?? {}),
        industry: normalizedIndustry || undefined
      }
    }));
    setActiveIndustryEditor(null);
  }

  function getCompanyAccountingStandard(companyName: string) {
    return companyConfigs[companyName]?.accountingStandard ?? "K-GAAP";
  }

  function setCompanyAccountingStandard(companyName: string, standard: string) {
    setCompanyConfigs((prev) => ({
      ...prev,
      [companyName]: {
        ...(prev[companyName] ?? {}),
        accountingStandard: standard || undefined
      }
    }));
  }

  function saveConfigEditors() {
    pushConfigRulesSnapshot();
    setConfigApplyState("applying");
    const nextParentAliases: Record<string, string[]> = {};
    for (const row of parentAliasRows) {
      const parent = row.parent.trim();
      if (!parent) continue;
      const aliases = row.aliases
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean);
      // 부모 본인 이름은 항상 포함
      nextParentAliases[parent] = Array.from(new Set([parent, ...aliases]));
    }
    setLogicConfig((prev) => ({
      ...prev,
      capitalL1Signs: rowsToCapitalSigns(capitalRuleRows),
      capitalL1Parent: rowsToCapitalParents(capitalRuleRows),
      capitalMemoAccounts: rowsToCapitalMemoAccounts(capitalMemoRows),
      pasteSectToParent: rowsToMap(pasteSectionRows),
      sectionSignOverrides: rowsToOverrides(globalOverrideRows),
      parentAliases: nextParentAliases
    }));

    const company = selectedCompany.trim();
    if (company) {
      const nextOverrides = rowsToOverrides(companyOverrideRows);
      setCompanyConfigs((prev) => {
        const next = { ...prev };

        if (Object.keys(nextOverrides).length === 0) {
          delete next[company];
          return next;
        }

        next[company] = {
          ...(next[company] ?? {}),
          sectionSignOverrides: nextOverrides
        };
        return next;
      });
    }

    window.setTimeout(() => setConfigApplyState("applied"), 250);
    window.setTimeout(() => setConfigApplyState("idle"), 1800);
  }

  const configPayload = JSON.stringify({ logicConfig, companyConfigs }, null, 2);

  function buildInputBreakdown(periodKey: string, input: MetricCalculationInput) {
    if (input.components && input.components.length) {
      return input.components;
    }
    return [];
  }

  // 계산 근거에서 계정명 옆에 트리 코드를 표시하는 작은 회색 mono 뱃지.
  function codeBadge(text: string, title: string) {
    return (
      <span
        className="metric-detail-treecode"
        title={title}
        style={{ marginLeft: 6, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11, fontWeight: 400, color: "#94a3b8" }}
      >
        {text}
      </span>
    );
  }

  // leaf 계정: 정확한 13자리 코드 (호버 시 트리 경로).
  function renderTreeCode(code?: number | null) {
    if (code == null) return null;
    const path = codeToPath.get(code);
    return codeBadge(String(code), path ? `트리 경로: ${path}` : `코드 ${code}`);
  }

  // 계산 근거 입력 줄: leaf면 정확 코드, 묶음이면 코드 범위(노드 prefix, 예: 1001001001000~).
  function renderInputCode(input: MetricCalculationInput) {
    if (input.code != null) return renderTreeCode(input.code);
    const prefixes = keywordPrefixes[input.label];
    if (prefixes && prefixes.length) {
      // 원시 prefix → 시작(0채움) ~ 끝(9채움) 범위.
      const ranges = prefixes.map((p) => `${p.padEnd(13, "0")} ~ ${p.padEnd(13, "9")}`);
      const shown = ranges.slice(0, 2).join("  /  ") + (ranges.length > 2 ? ` 외 ${ranges.length - 2}` : "");
      return codeBadge(shown, `코드 범위(이 묶음 아래 전체): ${ranges.join(", ")}`);
    }
    return null;
  }

  function renderMetricCalculationCard(
    label: string,
    kind: "amount" | "ratio" | "growthRate",
    row: FinalMetricRow,
    periodKey: string,
    detail?: MetricCalculationDetail
  ) {
    if (!detail) {
      return null;
    }

    return (
      <div className="metric-detail-block" key={`${row.label}-${kind}`}>
        <div className="metric-detail-head">
          <span>{label}</span>
          <strong>{formatCalculationResult(kind, row, detail)}</strong>
        </div>
        <p className="metric-detail-formula">{detail.formula}</p>
        {!!detail.inputs.length && (
          <div className="metric-detail-inputs">
            {detail.inputs.map((input, inputIndex) => {
              const breakdown = buildInputBreakdown(periodKey, input);
              const ioLabel = kind === "ratio"
                ? inputIndex === 0
                  ? "분자"
                  : inputIndex === 1
                    ? "분모"
                    : null
                : null;
              return (
                <div className="metric-detail-input-wrap" key={`${kind}-${input.label}`}>
                  <div className="metric-detail-input">
                    <span>{ioLabel ? `${ioLabel} · ${input.label}` : input.label}{renderInputCode(input)}</span>
                    <strong>{formatCalculationInputValue(input.value)}</strong>
                  </div>
                  {!!breakdown.length && (
                    <div className="metric-detail-subinputs">
                      {breakdown.map((item) => (
                        <div className="metric-detail-subinput" key={`${kind}-${input.label}-${item.label}`}>
                          <span>{item.label}{renderTreeCode(item.code)}</span>
                          <strong>{formatCalculationInputValue(item.value)}</strong>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {detail.note ? <p className="metric-detail-note">{detail.note}</p> : null}
      </div>
    );
  }

  // Block the full app until Supabase has handed us the shared catalog +
  // saved datasets — otherwise the user briefly sees an empty/half-built
  // workspace before things pop in.
  // 트리(분류DB)까지 받아야 부팅 완료 — 입장 후 트리 도착 시 재계산으로 화면이
  // 잠깐 멈추던 것을 로딩 화면 뒤로 숨긴다. 트리 로드 실패 시에도 입장은 된다.
  if (!mounted || !sharedStateReady || !treeBootDone) {
    return (
      <main className="workspace-shell" style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "60vh" }}>
        <div style={{ textAlign: "center", maxWidth: 560, padding: 24 }}>
          <span className="hero-eyebrow">KVOCEAN OCR Validator</span>
          <HenryFishingLoader />
          <h1 style={{ marginTop: 12, marginBottom: 12 }}>앙리가 데이터 가져오는 <span style={{ whiteSpace: "nowrap" }}>중<HenryLoadingDots /></span></h1>
          <p className="muted">
            {sharedStateError
              ? sharedStateError
              : !sharedStateReady
                ? "공용 Supabase 저장소에서 저장 데이터를 받아오고 있어요. 잠시만 기다려 주세요."
                : "분류DB(계정트리)를 펼치는 중이에요. 거의 다 됐어요."}
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="workspace-shell">
      <aside className="panel memo-sidebar workspace-memo-rail">
        <div className="memo-card">
          <div className="section-title">
            <div>
              <span className="section-kicker">Memo</span>
            </div>
            <span className="soft-badge">팀 공유 · 자동 저장</span>
          </div>
          <p className="muted">확인할 계정, 회사별 이슈, 다음 작업을 바로 적어두세요. 팀 전체와 공유됩니다.</p>
          <textarea
            className="textarea memo-textarea"
            value={workspaceMemo}
            onChange={(event) => setWorkspaceMemo(event.target.value)}
            placeholder={"예시\n- 스탠다임 영업비용 구조 재확인\n- 스마트레이더시스템 계정 DB 분류\n- 휴지통 복구 시나리오 점검"}
          />
          {(workspaceMemoMeta.updatedBy || workspaceMemoMeta.updatedAt) && (
            <p className="muted memo-meta">
              마지막 수정: {workspaceMemoMeta.updatedBy ?? "-"}
              {workspaceMemoMeta.updatedAt ? ` · ${formatMemoTimestamp(workspaceMemoMeta.updatedAt)}` : ""}
            </p>
          )}
        </div>
      </aside>

      <section className="page-shell">
        <section className="hero">
        <span className="hero-eyebrow">KVOCEAN OCR Validator</span>
        <h1>Challenge the Status Quo</h1>
        <p>{sharedStateReady ? "공용 Supabase 저장소와 동기화된 상태로 작업합니다." : "공용 Supabase 저장소를 불러오는 중입니다..."}</p>
        <div className="hero-meta">
          <span className="pill">1. 텍스트 붙여넣기</span>
          <span className="pill">2. 실패 항목 확인</span>
          <span className="pill">3. 값/부호 바로 수정</span>
        </div>
        {sharedStateError ? <p className="save-feedback warning">{sharedStateError}</p> : null}
      </section>

      <section className="summary-strip">
        <button
          className={`summary-card summary-switch-card ${topView === "menu" ? "active" : ""}`}
          onClick={() => setTopView("menu")}
        >
          <div className="section-title">
            <div>
              <span className="summary-label">작업 메뉴</span>
              <strong className="summary-title">작업 메뉴</strong>
            </div>
            <span className="soft-badge">7개 단계</span>
          </div>
        </button>
        <button
          className={`summary-card summary-switch-card ${topView === "final-output" ? "active" : ""}`}
          onClick={() => setTopView("final-output")}
        >
          <div className="section-title">
            <div>
              <span className="summary-label">최종결과물</span>
              <strong className="summary-title">결과물 비교</strong>
            </div>
            <span className="soft-badge">항목 + 4개 결과물</span>
          </div>
        </button>
      </section>

        {topView === "menu" && <section className="layout-grid">
        <aside className="panel sidebar">
          <div className="sidebar-brand-block">
            <div className="sidebar-brand-mark">KV</div>
            <div>
              <strong>Kakao Ventures</strong>
              <p>KV OCEAN Workspace</p>
            </div>
          </div>
          <div className="side-nav-card">
            <span className="section-kicker">Workspace</span>
            <div className="side-nav-list">
              <button className={`side-nav-item tab-highlighted ${activeTab === "validate" ? "active" : ""}`} onClick={() => setActiveTab("validate")}>1. OCR검증</button>
              <button className={`side-nav-item ${activeTab === "config" ? "active" : ""} ${!canEditConfig ? "is-locked" : ""}`} onClick={() => canEditConfig && setActiveTab("config")} disabled={!canEditConfig} title={!canEditConfig ? "관리자만 수정 가능합니다" : undefined}>1-1. 검증 규칙관리</button>
              <button className={`side-nav-item tab-highlighted ${activeTab === "data" ? "active" : ""}`} onClick={() => setActiveTab("data")}>2. 데이터</button>
              <button className={`side-nav-item tab-highlighted ${activeTab === "report" ? "active" : ""}`} onClick={() => setActiveTab("report")}>3. 결과물</button>
              <button className={`side-nav-item ${activeTab === "formulas" ? "active" : ""} ${!canEditConfig ? "is-locked" : ""}`} onClick={() => canEditConfig && setActiveTab("formulas")} disabled={!canEditConfig} title={!canEditConfig ? "관리자만 수정 가능합니다" : undefined}>3-1. 수식</button>
              <button className={`side-nav-item tab-highlighted ${activeTab === "account-db" ? "active" : ""} ${!canEditConfig ? "is-locked" : ""}`} onClick={() => canEditConfig && setActiveTab("account-db")} disabled={!canEditConfig} title={!canEditConfig ? "관리자만 수정 가능합니다" : undefined}>4. 분류DB</button>
            </div>
            <div className="side-nav-divider" />
            <div className="side-nav-utils">
              <button className={`side-nav-item side-nav-item-trash ${activeTab === "trash" ? "active" : ""}`} onClick={() => setActiveTab("trash")}>🗑️ 휴지통</button>
            </div>
          </div>

          {activeTab === "validate" ? (
            <>
              <div className="section-title panel-title-wrap">
                <div>
                  <span className="section-kicker">1. 입력</span>
                  <h2>검증할 데이터를 넣어 주세요</h2>
                  <p className="panel-desc">회사명과 허용 오차를 확인한 뒤 OCR 3행 텍스트를 그대로 붙여넣으면 됩니다.</p>
                </div>
                <span className={`tag ${companyKnown ? "pass" : ""}`}>{companyKnown ? "회사 규칙 적용 중" : "공통 규칙 사용"}</span>
              </div>

              <div className="field-grid">
                <label className="field">
                  <span>허용 오차 (원)</span>
                  <input className="number-input" type="number" min={0} step={1} value={tolerance} onChange={(event) => setTolerance(Number(event.target.value) || 0)} />
                </label>
                <label className="field">
                  <span>회사명</span>
                  <input className="input" value={selectedCompany} onChange={(event) => setSelectedCompany(event.target.value)} placeholder="예) 소셜빈" />
                </label>
              </div>

              <label className="field">
                <span>3행 OCR 텍스트</span>
                <textarea
                  className="textarea"
                  value={pastedText}
                  onChange={(event) => {
                    setPastedText(event.target.value);
                    setPasteEdits({});
                    setNameEdits({});
                    setDismissedTypoNames(new Set());
                    setSessionSignFixes({});
                  }}
                  placeholder={"행1: 기타\t재무상태표\t유동자산\t...\n행2: 회사명\t날짜\t...\n행3: 에이슬립\t2024-12-31\t..."}
                />
              </label>

              <div className="button-row">
                <button className="button" onClick={() => setActiveTab("validate")}>검증 결과 보기</button>
                <button className="ghost-button" onClick={resetAdjustments}>입력 수정 초기화</button>
                <a className="ghost-button" href={OCR_SOURCE_SHEET_URL} target="_blank" rel="noopener noreferrer" title="3줄 데이터가 들어오는 구글시트 열기 (코드연결용시트/보정)" style={{ textDecoration: "none" }}>
                  구글시트 ↗
                </a>
              </div>

              <div className="notice input-helper">
                <strong>입력 팁</strong>
                <ul className="helper-list muted">
                  <li>행 1은 섹션명, 행 2는 계정명, 행 3부터 값입니다.</li>
                  <li>회사명은 저장 데이터 구분용으로만 사용하고, 검증은 공통 규칙으로 처리합니다.</li>
                  <li>부호 문제는 `분류DB에 영구 반영`으로 한 번 박아두면 다음 검증부터 자동 적용됩니다.</li>
                </ul>
              </div>
            </>
          ) : (
            <div className="notice input-helper">
                      <strong>{activeTab === "data" ? "데이터 안내" : activeTab === "trash" ? "휴지통 안내" : activeTab === "report" ? "결과물 안내" : "보조 기능"}</strong>
                      <p className="muted" style={{ marginTop: 8 }}>
                        {activeTab === "data"
                          ? `저장된 검증 데이터 ${savedDatasets.length}건이 누적되어 있습니다. 필요한 항목을 선택해 다시 불러오거나 결과물로 보낼 수 있습니다.`
                          : activeTab === "trash"
                            ? `삭제된 데이터 ${trashedDatasets.length}건이 휴지통에 있습니다. 필요하면 복구하고, 정말 필요 없을 때만 완전삭제하세요.`
                          : activeTab === "report"
                              ? `${selectedDataset ? `${selectedDataset.companyName} ${selectedDataset.quarterLabel}` : "저장된 데이터"} 기준으로 결과물을 생성합니다. 먼저 OCR검증에서 저장하기를 누르세요.`
                    : activeTab === "formulas"
                      ? "결과물 계산에 쓰는 기준 수식을 그대로 정리했습니다."
                      : activeTab === "account-db"
                        ? `저장된 회사별 분기 데이터에서 유동자산 · 비유동자산 · 유동부채 · 비유동부채 · 매출원가 · 판매비와관리비 · 영업외수익 · 영업외비용 · 기타 하위 계정 ${accountDictionaryEntries.length}건을 모아 봅니다.`
                     : "규칙 관리와 내보내기는 검증 흐름을 지원하는 보조 기능입니다."}
              </p>
            </div>
          )}
        </aside>

        <section className="panel main-panel">
          {activeTab === "validate" && (
            <>
              {!accountTreeLookup && <div className="notice">분류DB(계정트리) 로딩 중… 분류·부호 판정은 트리 로드 후 표시됩니다.</div>}
              {!pastedText.trim() && <div className="notice input-helper">OCR 3행 텍스트를 왼쪽 입력창에 붙여넣으면 검증 결과가 나타납니다.</div>}
              {validation.parsed.error && pastedText.trim() && <div className="notice">{validation.parsed.error}</div>}

              {!validation.parsed.error && validation.parsed.nameRow.length > 0 && (
                <>
                  <section className="overview-card">
                    <div className="section-title">
                      <div>
                        <span className="section-kicker">2. 검증</span>
                        <h3>한눈에 결과 보기</h3>
                      </div>
                      <div className="result-actions">
                        <span className="soft-badge">수정값 {editedValueCount}</span>
                        <span className="soft-badge">계정명 수정 {editedNameCount}</span>
                        <span className="soft-badge">부호 변경 {sessionFixCount}</span>
                        <select
                          value={statementType}
                          onChange={(e) => setStatementType(e.target.value as "별도" | "연결")}
                          style={{ padding: "0.35rem 0.6rem", border: "1px solid var(--line-strong)", borderRadius: 8, fontSize: "0.8rem", background: "white" }}
                        >
                          <option value="별도">별도</option>
                          <option value="연결">연결</option>
                        </select>
                        <button className={`button ${datasetActionState === "saving" ? "is-loading" : ""}`.trim()} disabled={!canSaveCurrentDataset || datasetActionState === "saving"} onClick={saveCurrentDataset}>{datasetActionState === "saving" ? "저장 중..." : "저장하기"}</button>
                        <button className="tiny-button" onClick={focusFailedResultCards}>실패만 펼치기</button>
                        <button className="tiny-button" onClick={openAllResultCards}>전체 펼치기</button>
                        {sheetsSyncState.status !== "idle" && sheetsSyncState.status !== "disabled" && (
                          <span className={`sheets-sync-status sheets-sync-${sheetsSyncState.status}`}>
                            {sheetsSyncState.status === "syncing" && "구글시트 동기화 중..."}
                            {sheetsSyncState.status === "ok" && (sheetsSyncState.message ?? "구글시트 동기화 완료")}
                            {sheetsSyncState.status === "error" && (sheetsSyncState.message ?? "구글시트 동기화 실패")}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="metric-grid compact-metrics">
                      <article className="metric-card"><span className="muted">전체 검증</span><strong>{validation.stats.total}</strong></article>
                      <article className="metric-card"><span className="muted">통과</span><strong>{validation.stats.passed}</strong></article>
                      <article className="metric-card"><span className="muted">실패</span><strong>{validation.stats.failed}</strong></article>
                      <article className="metric-card"><span className="muted">통과율</span><strong>{validation.stats.rate.toFixed(1)}%</strong></article>
                      <article className="metric-card"><span className="muted">미분류 계정</span><strong style={nameSuggestions.size > 0 ? { color: "#c2410c" } : undefined}>{nameSuggestions.size}</strong></article>
                    </div>
                    {validation.stats.failed > 0 && <div className="notice">통과율이 100%가 될 때만 저장할 수 있습니다. 실패 항목의 OCR 수정값과 검증 부호를 먼저 정리해 주세요.</div>}
                  </section>

                  <section className="validate-workspace with-preview">
                    <div className="validate-main-stack">
                      <div className="preview-table-wrap">
                        <div className="section-title">
                          <div>
                            <h3>붙여넣기 미리보기</h3>
                            <p className="result-meta">계정 {validation.parsed.nameRow.length}개 / 데이터 {validation.parsed.dataRows.length}행</p>
                          </div>
                          <span className="preview-scroll-chip">좌우로 넘겨서 전체 열 보기</span>
                        </div>
                        <div className="preview-scroll-wrap">
                          <div className="preview-scroll-shadow left" aria-hidden="true" />
                          <div className="preview-scroll-shadow right" aria-hidden="true" />
                          <div className="preview-scroll" role="region" aria-label="붙여넣기 미리보기 가로 스크롤 영역">
                            <table className="preview-grid-table">
                            <tbody>
                              <tr>
                                <th className="preview-row-label">분류</th>
                                {previewGroups.groups.map((group) => (
                                  <th key={`group-${group.start}`} colSpan={group.span} className={`preview-group-cell tone-${group.tone}`}>
                                    {group.label}
                                  </th>
                                ))}
                              </tr>
                              <tr>
                                <th className="preview-row-label">계정명</th>
                                {validation.parsed.nameRow.map((name, index) => (
                                  <td key={`${name}-${index}`} className={`preview-name-cell tone-${previewGroups.tones[index] ?? 0}`}>
                                    {isLockedPreviewNameCell(name) ? (
                                      validation.editableNameRow[index] || `열${index}`
                                    ) : (
                                      <>
                                        <input
                                          className="mini-input"
                                          type="text"
                                          value={validation.editableNameRow[index] ?? ""}
                                          onChange={(event) => updateEditableName(index, name, event.target.value)}
                                          placeholder={`열${index}`}
                                        />
                                        {renderNameSuggestion(index, name)}
                                      </>
                                    )}
                                  </td>
                                ))}
                              </tr>
                              <tr>
                                <th className="preview-row-label">값</th>
                                {validation.editableRow.map((value, index) => (
                                  <td key={`val-${index}`} className={`preview-value-cell tone-${previewGroups.tones[index] ?? 0}`}>
                                    {typeof value === "number" ? formatNumber(value) : value ?? ""}
                                  </td>
                                ))}
                              </tr>
                            </tbody>
                            </table>
                          </div>
                        </div>
                        <div className="preview-scroll-note muted">모바일이나 트랙패드에서는 표를 좌우로 밀어서 나머지 계정 열을 확인할 수 있습니다.</div>
                      </div>

                      {validation.stats.total === 0 && <div className="notice">검증 결과가 없습니다. 섹션명 1행이 `유동자산`, `판관비` 같은 검증 대상 형식인지 확인해 주세요.</div>}

                      {Object.entries(validation.resultsByDate).map(([dateLabel, results]) => (
                        <section className="result-group" key={dateLabel}>
                          <div className="section-title">
                            <div>
                              <h3>{dateLabel}</h3>
                              <p className="muted result-meta">검증 {results.length}건</p>
                            </div>
                            <span className={`tag ${results.some((item) => !item.passed) ? "fail" : "pass"}`}>{results.some((item) => !item.passed) ? "실패 항목 포함" : "전부 통과"}</span>
                          </div>

                          {results.map((result, resultIndex) => {
                            const actions = result.passed ? [] : diagnoseDiff(result);
                            const resultSection = result.sect ?? result.parent;
                            const cardKey = `${dateLabel}-${result.rule}-${resultIndex}`;
                            const resultStatus = getResultStatus(result);
                            const hasPendingAdjustments = hasPendingResultAdjustments(result);
                            // 오타/신규(미분류) 칩이 달린 계정이 있으면 카드를 자동으로 펼친다.
                            const hasNameSuggestion = result.detail.some((d) => d._col !== undefined && nameSuggestions.has(d._col));
                            const autoOpen = !result.passed || hasPendingAdjustments || hasNameSuggestion;
                            const isOpen = resultOpenState[cardKey] ?? autoOpen;
                            const pendingInsertedRow = pendingInsertedRows[cardKey];
                            const targetRowIndex = result.parent_row ?? result.detail[0]?._row ?? 0;
                            const currentParentValue = result.parent_row !== undefined && result.parent_col !== undefined && pasteEdits[pasteEditKey(result.parent_row, result.parent_col)] !== undefined
                              ? pasteEdits[pasteEditKey(result.parent_row, result.parent_col)]
                              : result.parent_val;
                            return (
                              <article className={`result-card ${isOpen ? "" : "collapsed"}`} key={cardKey}>
                                <div className="result-header">
                                  <div>
                                    <div className={resultStatus.className}>{resultStatus.label}</div>
                                    <strong>{result.rule}</strong>
                                  </div>
                                  <div className="result-header-actions">
                                    <div className="muted">차이</div>
                                    <strong className={result.passed ? "status-pass" : "status-fail"}>{formatNumber(result.diff)}원</strong>
                                    <button className="collapse-toggle" onClick={() => toggleResultCard(cardKey, autoOpen)} aria-expanded={isOpen}>
                                      {isOpen ? "접기" : "펼치기"}
                                    </button>
                                  </div>
                                </div>
                                {isOpen && <div className="result-body">
                                  <div className="result-inline-actions">
                                    <button className="ghost-button" type="button" onClick={() => openPendingInsertedRow(cardKey, resultSection)}>
                                      행 추가
                                    </button>
                                  </div>
                                  {pendingInsertedRow && (
                                    <div className="insert-row-panel">
                                      <input className="mini-input" type="text" value={pendingInsertedRow.section} onChange={(event) => updatePendingInsertedRow(cardKey, "section", event.target.value)} placeholder="섹션" />
                                      <input className="mini-input insert-name-input" type="text" value={pendingInsertedRow.accountName} onChange={(event) => updatePendingInsertedRow(cardKey, "accountName", event.target.value)} placeholder="계정명" />
                                      <input className="mini-input" type="number" step={1} value={pendingInsertedRow.value} onChange={(event) => updatePendingInsertedRow(cardKey, "value", event.target.value)} placeholder="값" />
                                      <button className="secondary-button" type="button" onClick={() => addValidationAccount(cardKey, targetRowIndex, resultSection)}>추가</button>
                                      <button className="ghost-button" type="button" onClick={() => closePendingInsertedRow(cardKey)}>닫기</button>
                                    </div>
                                  )}
                                  {result.detail.length > 0 ? (
                                    <div style={{ overflowX: "auto" }}>
                                      <table className="table">
                                        <thead>
                                          <tr><th>계정명</th><th>원본값</th><th>OCR 수정값</th><th>검증 부호</th><th>적용값</th></tr>
                                        </thead>
                                        <tbody>
                                          {result.detail.map((detail, index) => {
                                            const currentEditKey = detail._row !== undefined && detail._col !== undefined ? pasteEditKey(detail._row, detail._col) : null;
                                            const currentValue = currentEditKey && pasteEdits[currentEditKey] !== undefined ? pasteEdits[currentEditKey] : detail.원본값;
                                            const currentSign = displayedSignToCode(detail.부호);
                                            return (
                                              <tr key={detail._col !== undefined ? `col-${detail._col}` : `${detail.계정명}-${index}`}>
                                                <td>
                                                  <div className="result-account-cell">
                                                    {detail._col !== undefined ? (
                                                      <input
                                                        className="mini-input"
                                                        type="text"
                                                        value={validation.editableNameRow[detail._col] ?? detail.계정명}
                                                        onChange={(event) => updateEditableName(detail._col!, validation.parsed.nameRow[detail._col!] ?? detail.계정명, event.target.value)}
                                                        aria-label={`${detail.계정명} 계정명 수정`}
                                                      />
                                                    ) : (
                                                      <span>{detail.계정명}</span>
                                                    )}
                                                    {detail._col !== undefined && (
                                                      <button className="icon-button danger" type="button" aria-label={`${detail.계정명} 삭제`} onClick={() => removeValidationAccount(detail._col!)}>🗑</button>
                                                    )}
                                                  </div>
                                                  {detail._col !== undefined && renderNameSuggestion(detail._col, validation.parsed.nameRow[detail._col] ?? detail.계정명)}
                                                </td>
                                                <td>{formatNumber(detail.원본값)}</td>
                                                <td>{detail._row !== undefined && detail._col !== undefined ? <input className="mini-input" type="number" step={1} value={String(currentValue)} onChange={(event) => updateEditableValue(detail._row!, detail._col!, detail.원본값, event.target.value)} /> : <span className="muted">자동 계산</span>}</td>
                                                <td>
                                                  <div className="sign-editor">
                                                    <select className="mini-select" value={String(currentSign)} onChange={(event) => updateDetailSign(resultSection, detail.계정명, Number(event.target.value) as SignCode)}>
                                                      <option value="0">가산(+)</option><option value="1">차감(−)</option><option value="2">제외</option>
                                                    </select>
                                                  </div>
                                                </td>
                                                <td>{formatNumber(detail.적용값)}</td>
                                              </tr>
                                            );
                                          })}
                                        </tbody>
                                      </table>
                                    </div>
                                  ) : null}

                                  {result.detail.length > 0 && <div className="rule-helper muted">`OCR 수정값`과 계정 삭제/추가는 실제 저장 데이터에 반영됩니다. 부호 변경은 `분류DB에 영구 반영`이 권장됩니다 (모든 회사·분기 적용).</div>}

                                  <div className="two-col">
                                    <div className="diagnosis-card">
                                      <strong>합계 비교</strong>
                                      <p className="muted">OCR 합산 {formatNumber(result.computed)}원 / 재무제표 값 {formatNumber(currentParentValue)}원</p>
                                      {result.parent_row !== undefined && result.parent_col !== undefined && (
                                        <div className="inline-actions" style={{ marginTop: 12 }}>
                                          <input className="mini-input" type="number" step={1} value={String(currentParentValue)} onChange={(event) => updateEditableValue(result.parent_row!, result.parent_col!, result.parent_val, event.target.value)} />
                                          <span className="muted">재무제표 값 수정</span>
                                        </div>
                                      )}
                                    </div>
                                    <div className="diagnosis-card"><strong>누락 계정</strong><p className="muted">{result.missing.length ? result.missing.join(", ") : "없음"}</p></div>
                                  </div>

                                  {!result.passed && actions.length > 0 && (
                                    <div className="diagnosis-card">
                                      <strong>원인 추정과 처리 방향</strong>
                                      <p className="muted diagnosis-note">차이를 0원으로 만드는 후보를 먼저 보여줍니다. 부호 문제면 `분류DB에 영구 반영`이 가장 깨끗합니다 — 한 번 박아두면 모든 회사·분기에 자동 적용됩니다.</p>
                                      <div className="list-editor" style={{ marginTop: 12 }}>
                                        {actions.map((action, index) => (
                                          <div key={`${action.text}-${index}`} className="notice">
                                            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                                              <strong>{index === 0 ? "우선 확인" : "다음 후보"}</strong>
                                              {action.badge ? <span className="soft-badge">{action.badge}</span> : null}
                                            </div>
                                            <div className="pre diagnosis-copy">{renderDiagnosisText(action.shortText ?? action.text)}</div>
                                            {action.edit ? <div className="inline-actions" style={{ marginTop: 12 }}><button className="secondary-button" onClick={() => applySuggestedEdit(action.edit!.row, action.edit!.col, action.edit!.value)}>{action.editLabel}</button></div> : null}
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                </div>}
                              </article>
                            );
                          })}
                        </section>
                      ))}

                      <div className="export-card">
                        <div className="section-title">
                          <h3>수정된 OCR 데이터 복사</h3>
                          <button className="secondary-button" onClick={copyModifiedText}>클립보드 복사</button>
                        </div>
                        <textarea className="textarea" value={validation.copyText} readOnly style={{ minHeight: 140, marginTop: 12 }} />
                      </div>
                    </div>

                    <aside className="panel account-db-preview-panel validate-preview-panel">
                      <div className="section-title">
                        <div>
                          <span className="section-kicker">출처 3줄 미리보기</span>
                          <h3>OCR 정리본</h3>
                          <p className="result-meta">섹션별로 계정명과 값을 바로 수정하고 행을 추가/삭제할 수 있습니다.</p>
                        </div>
                      </div>

                      <div className="account-db-preview-body">
                        {validatePreviewGroups.map((group) => {
                          const draftKey = String(group.rowIndex);
                          const draft = validatePreviewDrafts[draftKey] ?? { section: group.items[0]?.sectionKey ?? "", accountName: "", value: "" };
                          return (
                            <div className="account-db-preview-section" key={`validate-preview-row-${group.rowIndex}`}>
                              <div className="account-db-preview-section-title">{group.rowLabel}</div>
                              <table className="table account-db-preview-table validate-preview-table validate-preview-ordered-table">
                                <thead>
                                  <tr><th>분류</th><th>계정명</th><th>수정 반영 값</th><th>삭제</th></tr>
                                </thead>
                                <tbody>
                                  {group.items.map((row) => (
                                    <tr
                                      key={`validate-preview-item-${group.rowIndex}-${row.colIndex}`}
                                      ref={(el) => {
                                        const refKey = `${row.rowIndex}_${row.colIndex}`;
                                        if (el) previewRowRefsRef.current.set(refKey, el);
                                        else previewRowRefsRef.current.delete(refKey);
                                      }}
                                      data-highlight={lastEditedCell === `${row.rowIndex}_${row.colIndex}` ? "true" : undefined}
                                      style={lastEditedCell === `${row.rowIndex}_${row.colIndex}` ? { backgroundColor: "rgba(234,179,8,0.13)" } : undefined}
                                    >
                                      <td>{row.sectionKey}</td>
                                      <td>{row.locked ? <span>{row.accountName}</span> : <input className="mini-input" type="text" value={row.accountName} onChange={(event) => updateEditableName(row.colIndex, row.rawName, event.target.value)} />}</td>
                                      <td className="account-db-preview-value">{typeof row.value === "number" ? <input className="mini-input validate-preview-number" type="number" step={1} value={String(row.value)} onChange={(event) => updateEditableValue(row.rowIndex, row.colIndex, row.rawValue, event.target.value)} /> : <span>{row.value ?? ""}</span>}</td>
                                      <td className="validate-preview-action-cell"><button className="icon-button danger" type="button" aria-label={`${row.accountName} 삭제`} onClick={() => removeValidationAccount(row.colIndex)}>🗑</button></td>
                                    </tr>
                                  ))}
                                  <tr>
                                    <td><input className="mini-input" type="text" placeholder="분류" value={draft.section} onChange={(event) => updateValidatePreviewDraft(group.rowIndex, draft.section, "section", event.target.value)} /></td>
                                    <td><input className="mini-input" type="text" placeholder="새 계정명" value={draft.accountName} onChange={(event) => updateValidatePreviewDraft(group.rowIndex, draft.section, "accountName", event.target.value)} /></td>
                                    <td><input className="mini-input validate-preview-number" type="number" step={1} placeholder="값" value={draft.value} onChange={(event) => updateValidatePreviewDraft(group.rowIndex, draft.section, "value", event.target.value)} /></td>
                                    <td className="validate-preview-action-cell"><button className="ghost-button" type="button" onClick={() => addValidatePreviewAccount(group.rowIndex)}>추가</button></td>
                                  </tr>
                                </tbody>
                              </table>
                            </div>
                          );
                        })}
                      </div>
                    </aside>
                  </section>
                </>
              )}
            </>
          )}

          {activeTab === "data" && (
            <>
              <section className="overview-card report-hero-card">
                <div className="section-title">
                  <div>
                    <span className="section-kicker">2. 데이터</span>
                    <h3>저장된 검증 데이터</h3>
                    <p className="result-meta">검증 완료 후 `저장하기`를 누른 데이터가 여기에 누적됩니다. 선택한 데이터는 결과물 탭에서 바로 사용합니다.</p>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <button
                      className={`ghost-button ${dataEditMode ? "is-selected" : ""}`}
                      style={{ padding: "0.4rem 0.6rem", fontSize: "0.85rem", borderRadius: 8 }}
                      onClick={() => setDataEditMode((prev) => !prev)}
                      title={dataEditMode ? "수정모드 끄기" : "수정모드 켜기"}
                    >✏️</button>
                    <span className="soft-badge">총 {savedDatasets.length}건</span>
                  </div>
                </div>
              </section>

              {!savedDatasets.length && <div className="notice">저장된 데이터가 없습니다. OCR검증에서 값을 확인한 뒤 `저장하기`를 눌러 주세요.</div>}

              {!!savedDatasets.length && (
                <>
                  <section className="config-card">
                    <div className="section-title">
                      <div>
                        <h3>회사/분기 누적 데이터</h3>
                        <p className="result-meta">같은 회사와 같은 분기는 새로 추가되지 않고 최신 검증 결과로 갱신됩니다.</p>
                      </div>
                      <span className="soft-badge">{filteredGroupedDatasets.length} / {groupedSavedDatasets.length}개사</span>
                    </div>
                    <div className="data-filter-bar" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center", marginBottom: "0.75rem" }}>
                      <input
                        type="text"
                        value={dataSearch}
                        onChange={(event) => setDataSearch(event.target.value)}
                        placeholder="회사명 검색"
                        style={{ flex: "1 1 180px", minWidth: 140, padding: "0.4rem 0.6rem", borderRadius: 8, border: "1px solid var(--border, #ddd)", fontSize: "0.9rem" }}
                      />
                      <select className="mini-select" value={dataQuarterFilter} onChange={(event) => setDataQuarterFilter(event.target.value)}>
                        <option value="">전체 분기</option>
                        {dataQuarterOptions.map((quarter) => (
                          <option key={quarter} value={quarter}>{formatCompactQuarterLabel(quarter)}</option>
                        ))}
                      </select>
                      <select className="mini-select" value={dataIndustryFilter} onChange={(event) => setDataIndustryFilter(event.target.value)}>
                        <option value="">전체 산업</option>
                        <option value="미분류">🏷️ 미분류</option>
                        {industryOptions.map((option) => (
                          <option key={option} value={option}>{`${getIndustryIcon(option)} ${option}`}</option>
                        ))}
                      </select>
                      {familyCoverage && (
                        <button
                          type="button"
                          className={`ghost-button ${familyPanelOpen ? "is-selected" : ""}`}
                          style={{
                            padding: "0.35rem 0.7rem",
                            fontSize: "0.85rem",
                            borderRadius: 999,
                            fontWeight: 600,
                            color: familyCoverage.missing.length ? "#b91c1c" : "#15803d",
                            borderColor: familyCoverage.missing.length ? "#fca5a5" : "#86efac",
                            background: familyCoverage.missing.length ? "#fef2f2" : "#f0fdf4"
                          }}
                          onClick={() => setFamilyPanelOpen((prev) => !prev)}
                          title={`${formatCompactQuarterLabel(familyTargetQuarter ?? "")} 기준 패밀리사 수집 현황 — 클릭해서 미저장 명단 보기`}
                        >패밀리 {familyCoverage.saved.length} / {familyCoverage.total} {familyPanelOpen ? "▴" : "▾"}</button>
                      )}
                      {(dataSearch || dataQuarterFilter || dataIndustryFilter) && (
                        <button className="ghost-button" style={{ padding: "0.35rem 0.6rem", fontSize: "0.85rem" }} onClick={() => { setDataSearch(""); setDataQuarterFilter(""); setDataIndustryFilter(""); }}>초기화</button>
                      )}
                    </div>
                    {familyPanelOpen && familyCoverage && familyTargetQuarter && (
                      <div className="notice" style={{ marginBottom: 12, textAlign: "left" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
                          <strong>{formatCompactQuarterLabel(familyTargetQuarter)} 분기 — 패밀리 {familyCoverage.total}개사 중 {familyCoverage.saved.length}개사 저장됨 · 미저장 {familyCoverage.missing.length}</strong>
                          {!dataQuarterFilter && <span className="muted" style={{ fontSize: 12 }}>(분기 필터가 &quot;전체&quot;라 최신 분기 기준)</span>}
                          {familyCoverage.missing.length > 0 && (
                            <button className="ghost-button button-tiny" style={{ marginLeft: "auto" }} onClick={copyFamilyMissing}>
                              {familyCopied ? "✓ 복사됨" : "📋 미저장 명단 복사"}
                            </button>
                          )}
                        </div>
                        <div style={{ height: 6, borderRadius: 3, background: "#dbeafe", margin: "10px 0 12px", overflow: "hidden" }}>
                          <div style={{ width: `${familyCoverage.total ? Math.round((familyCoverage.saved.length / familyCoverage.total) * 100) : 0}%`, height: "100%", background: familyCoverage.missing.length ? "#3b82f6" : "#22c55e" }} />
                        </div>
                        {familyCoverage.missing.length > 0 ? (
                          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                            {familyCoverage.missing.map((name) => (
                              <span key={name} style={{ fontSize: 12, border: "1px solid #fca5a5", color: "#b91c1c", background: "#fef2f2", borderRadius: 999, padding: "2px 10px" }}>{name}</span>
                            ))}
                          </div>
                        ) : (
                          <p className="muted" style={{ margin: 0 }}>이 분기 패밀리 데이터가 모두 저장됐습니다. 🎉</p>
                        )}
                        <div style={{ marginTop: 12, display: "flex", gap: "1rem", flexWrap: "wrap", alignItems: "flex-start" }}>
                          {familyCoverage.extras.length > 0 && (
                            <details style={{ fontSize: 12 }}>
                              <summary className="muted" style={{ cursor: "pointer" }}>명단 외 저장 회사 {familyCoverage.extras.length}개사 (정리된 옛 패밀리 등)</summary>
                              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                                {familyCoverage.extras.map((name) => (
                                  <span key={name} style={{ fontSize: 12, border: "1px solid var(--border, #ddd)", borderRadius: 999, padding: "2px 10px", color: "#666" }}>{name}</span>
                                ))}
                              </div>
                            </details>
                          )}
                          <details style={{ fontSize: 12 }} onToggle={(event) => { if ((event.target as HTMLDetailsElement).open && familyDraft === null) setFamilyDraft(effectiveFamilyList.join("\n")); }}>
                            <summary className="muted" style={{ cursor: "pointer" }}>
                              명단 편집 ({effectiveFamilyList.length}개사{familyCompanies === null ? " · 기본 명단" : ""}{familyMeta.updatedAt ? ` · 마지막 수정 ${formatMemoTimestamp(familyMeta.updatedAt)}${familyMeta.updatedBy ? ` · ${familyMeta.updatedBy}` : ""}` : ""})
                            </summary>
                            <div style={{ marginTop: 8 }}>
                              <p className="muted" style={{ margin: "0 0 6px" }}>한 줄에 한 회사. 괄호는 별칭으로 인식합니다 — 예: <code>청연 (구 생활연구소)</code>는 저장명이 &quot;생활연구소&quot;여도 같은 회사로 셉니다.</p>
                              <textarea
                                className="textarea"
                                style={{ width: "100%", minHeight: 220, fontSize: 13 }}
                                value={familyDraft ?? ""}
                                onChange={(event) => setFamilyDraft(event.target.value)}
                              />
                              <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginTop: 6 }}>
                                <button className="button button-tiny" disabled={familySaveState.status === "saving"} onClick={() => void saveFamilyCompanies()}>
                                  {familySaveState.status === "saving" ? "저장 중..." : "명단 저장"}
                                </button>
                                {familySaveState.message && familySaveState.status !== "saving" && (
                                  <span style={{ fontSize: 12, color: familySaveState.status === "error" ? "#b91c1c" : "#15803d" }}>{familySaveState.message}</span>
                                )}
                              </div>
                            </div>
                          </details>
                        </div>
                      </div>
                    )}
                    {!filteredGroupedDatasets.length && (
                      <div className="notice">검색·필터 조건에 맞는 회사가 없습니다.</div>
                    )}
                    <div className="data-list grouped-data-list">
                      {filteredGroupedDatasets.map(([companyName, datasets]) => {
                        const activeDataset = datasets.find((dataset) => dataset.id === selectedDatasetId) ?? null;
                        const companyIndustry = getCompanyIndustry(companyName);
                        const companyIndustryLabel = companyIndustry || "미분류";
                        const companyIndustryIcon = getIndustryIcon(companyIndustryLabel);
                        const companyAccStd = getCompanyAccountingStandard(companyName);
                        return (
                          <article className={`data-company-card ${activeDataset ? "selected" : ""}`} key={`company-group-${companyName}`}>
                            <div className="data-company-row">
                              <div className="data-company-main">
                                <strong>{companyName}</strong>
                                <div className="industry-badge-wrap">
                                  <span className="industry-icon" aria-hidden="true">{companyIndustryIcon}</span>
                                  <span>{companyIndustryLabel}</span>
                                  <span style={{ color: "var(--muted)", fontSize: "0.75rem", marginLeft: 2 }}>· {companyAccStd}</span>
                                </div>
                              </div>
                              <div className="data-quarter-chip-list">
                                {datasets.map((dataset) => {
                                  const isConsolidated = dataset.source.statementType === "연결";
                                  return (
                                    <button
                                      key={dataset.id}
                                      className={`data-quarter-chip ${selectedDatasetId === dataset.id ? "active" : ""} ${isConsolidated ? "consolidated" : ""}`}
                                      onClick={() => setSelectedDatasetId((prev) => prev === dataset.id ? "" : dataset.id)}
                                    >
                                      {formatCompactQuarterLabel(dataset.quarterLabel)}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                            {dataEditMode && (
                              <div className="edit-config-inline" style={{ paddingTop: "0.5rem" }}>
                                <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                                  <span style={{ fontSize: "12px", color: "#666" }}>산업</span>
                                  <select
                                    className="mini-select"
                                    value={companyIndustry || ""}
                                    onChange={(event) => setCompanyIndustry(companyName, event.target.value)}
                                  >
                                    <option value="">🏷️ 미분류</option>
                                    {industryOptions.map((option) => (
                                      <option key={`${companyName}-${option}`} value={option}>{`${getIndustryIcon(option)} ${option}`}</option>
                                    ))}
                                  </select>
                                </label>
                                <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                                  <span style={{ fontSize: "12px", color: "#666" }}>회계기준</span>
                                  <select
                                    className="mini-select"
                                    value={companyAccStd}
                                    onChange={(event) => setCompanyAccountingStandard(companyName, event.target.value)}
                                  >
                                    {DEFAULT_ACCOUNTING_STANDARDS.map((std) => (
                                      <option key={std} value={std}>{std}</option>
                                    ))}
                                  </select>
                                </label>
                                {activeDataset && datasets.some((d) => d.id === activeDataset.id) && (
                                  <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                                    <span style={{ fontSize: "12px", color: "#666" }}>재무제표 <span style={{ color: "var(--muted)" }}>(선택 분기)</span></span>
                                    <select
                                      className="mini-select"
                                      value={activeDataset.source.statementType ?? "별도"}
                                      onChange={(event) => patchDatasetStatementType(activeDataset.id, event.target.value)}
                                    >
                                      <option value="별도">별도</option>
                                      <option value="연결">연결</option>
                                    </select>
                                  </label>
                                )}
                              </div>
                            )}
                            {activeDataset && (
                              <div className="data-row-actions">
                                <span className="soft-badge">선택 분기 {formatCompactQuarterLabel(activeDataset.quarterLabel)}</span>
                                <button className="secondary-button" onClick={() => { setSelectedDatasetId(activeDataset.id); setActiveTab("report"); }}>결과물 보기</button>
                                <button className="ghost-button" onClick={() => loadDatasetIntoValidator(activeDataset)}>검증기로 불러오기</button>
                                {canDeleteData && (
                                  <button className={`danger-button ${datasetActionState === "deleting" ? "is-loading" : ""}`.trim()} disabled={datasetActionState === "deleting"} onClick={() => deleteDataset(activeDataset)}>{datasetActionState === "deleting" ? "이동 중..." : "삭제"}</button>
                                )}
                              </div>
                            )}
                          </article>
                        );
                      })}
                    </div>
                  </section>
                </>
              )}
            </>
          )}

          {activeTab === "trash" && (
            <>
              <section className="overview-card report-hero-card">
                    <div className="section-title">
                      <div>
                        <span className="section-kicker">휴지통</span>
                        <h3>삭제된 검증 데이터</h3>
                    <p className="result-meta">삭제된 데이터는 여기서 복구하거나, 완전히 지울 수 있습니다.</p>
                  </div>
                  <span className="soft-badge">총 {trashedDatasets.length}건</span>
                </div>
              </section>

              {!trashedDatasets.length && <div className="notice">휴지통이 비어 있습니다.</div>}

              {!!trashedDatasets.length && (
                <section className="config-card">
                  <div className="section-title">
                    <div>
                      <h3>휴지통 목록</h3>
                      <p className="result-meta">복구하면 데이터 탭으로 돌아가고, 완전삭제하면 되돌릴 수 없습니다.</p>
                    </div>
                  </div>
                  <div className="data-list grouped-data-list">
                    {trashedDatasets.map((dataset) => (
                      <article className="data-company-card" key={`trash-${dataset.id}`}>
                        <div className="data-company-row">
                          <div className="data-company-main">
                            <div className="industry-badge-wrap">
                              <span className="industry-icon" aria-hidden="true">{getIndustryIcon(getCompanyIndustry(dataset.companyName) || "미분류")}</span>
                              <span>{getCompanyIndustry(dataset.companyName) || "미분류"}</span>
                            </div>
                            <strong>{dataset.companyName}</strong>
                          </div>
                          <div className="data-quarter-chip-list">
                            <span className="data-quarter-chip active">{formatCompactQuarterLabel(dataset.quarterLabel)}</span>
                          </div>
                        </div>
                        <div className="data-row-actions">
                          <span className="soft-badge">삭제됨</span>
                          {canDeleteData ? (
                            <>
                              <button className={`secondary-button ${datasetActionState === "restoring" ? "is-loading" : ""}`.trim()} disabled={datasetActionState === "restoring"} onClick={() => restoreDataset(dataset)}>{datasetActionState === "restoring" ? "복구 중..." : "복구하기"}</button>
                              <button className={`danger-button ${datasetActionState === "purging" ? "is-loading" : ""}`.trim()} disabled={datasetActionState === "purging"} onClick={() => purgeDataset(dataset)}>{datasetActionState === "purging" ? "삭제 중..." : "완전삭제"}</button>
                            </>
                          ) : (
                            <span className="soft-badge" style={{ color: "var(--muted)" }}>제작자만 삭제 가능</span>
                          )}
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}

          {activeTab === "report" && (
            <>
              {!accountTreeLookup && <div className="notice">분류DB(계정트리) 로딩 중… 묶음·분류 기반 결과물은 트리 로드 후 표시됩니다.</div>}
              {!resultReporting?.periods.length && <div className="notice">결과물에 보여줄 저장 데이터가 없습니다. 먼저 OCR검증에서 `저장하기`를 누른 뒤 데이터 탭에서 항목을 선택해 주세요.</div>}

              {!!resultReporting?.periods.length && (
                <>
                  <section className="overview-card report-hero-card">
                    <div className="section-title">
                      <div>
                        <span className="section-kicker">3. 보고서</span>
                        <h3>{resultReporting.companyName ?? resultReporting.detectedCompany ?? "미지정 회사"} 결과물</h3>
                        <p className="result-meta">엑셀의 `재무제표 → 재무제표_음양반영 → 최종결과물` 흐름을 현재 입력 데이터 기준으로 바로 보여줍니다.</p>
                      </div>
                      <div className="result-actions">
                        {selectedReportPeriod && <span className="soft-badge">{selectedReportPeriod.label}</span>}
                        <button
                          className="ghost-button"
                          onClick={bulkSyncSheets}
                          disabled={sheetsSyncState.status === "syncing"}
                          title="저장된 모든 회사의 최종결과물을 구글시트에 한 번에 push"
                        >
                          {sheetsSyncState.status === "syncing" ? "동기화 중..." : "전체 회사 시트 동기화"}
                        </button>
                        {sheetUrl && (
                          <a className="ghost-button" href={sheetUrl} target="_blank" rel="noopener noreferrer" title="동기화 대상 구글시트 열기" style={{ textDecoration: "none" }}>
                            구글시트 ↗
                          </a>
                        )}
                        {sheetsSyncState.status !== "idle" && sheetsSyncState.status !== "syncing" && (
                          <span className={`sheets-sync-status sheets-sync-${sheetsSyncState.status}`}>
                            {sheetsSyncState.status === "ok" && (sheetsSyncState.message ?? "동기화 완료")}
                            {sheetsSyncState.status === "error" && (sheetsSyncState.message ?? "동기화 실패")}
                          </span>
                        )}
                      </div>
                    </div>
                  </section>

                  <section className="overview-card final-output-card">
                    <div className="section-title">
                      <div>
                        <h3>최종결과물</h3>
                        <p className="result-meta">엑셀 최종결과물처럼 지표 블록을 위에서 아래로 이어서 보여줍니다.</p>
                      </div>
                      <div className="inline-actions">
                        <button className="ghost-button" onClick={() => setShowReportValidation((prev) => !prev)}>
                          {showReportValidation ? "계산 검증 숨기기" : "계산 검증 보기"}
                        </button>
                      </div>
                    </div>
                  </section>

                  {resultReporting.finalSections.map((section) => (
                    <section className="config-card final-section-card" key={section.title}>
                      <div className="section-title">
                        <div>
                          <h3>{section.title}</h3>
                          <p className="result-meta">분기별 값과 전분기 증감율을 엑셀 흐름처럼 한 블록으로 정리했습니다.</p>
                        </div>
                      </div>
                      <div className="report-table-wrap">
                        <table className="table report-table final-report-table">
                          <thead>
                            <tr>
                              <th>항목</th>
                              {(selectedReportPeriod ? [selectedReportPeriod] : []).map((period) => (
                                <th key={`${section.title}-${period.key}`}>
                                  <div className="final-period-head">
                                    <span>{period.label}</span>
                                    <small>금액 / 증감율</small>
                                  </div>
                                </th>
                              ))}
                            </tr>
                          </thead>
                            <tbody>
                              {section.rows.map((row: FinalMetricRow) => (
                                <Fragment key={`${section.title}-${row.label}`}>
                                  {(() => {
                                    const metricKey = buildReportMetricKey(section.title, row.label);
                                    const metricExpanded = expandedReportMetrics[metricKey] ?? false;
                                    const ratioOnlySection = isRatioOnlySection(section.title);
                                    return (
                                      <>
                                <tr key={`${section.title}-${row.label}-value`} className="final-value-row separated-row">
                                  <td className="final-metric-label">
                                    <div className="final-metric-heading">
                                      <span>{row.label}</span>
                                      {showReportValidation && (
                                        <button className="tiny-button final-detail-toggle" onClick={() => toggleReportMetric(metricKey)}>
                                          {metricExpanded ? "계산 접기" : "계산 보기"}
                                        </button>
                                      )}
                                    </div>
                                  </td>
                                  {(selectedReportPeriod ? [selectedReportPeriod] : []).map((period) => (
                                    <td key={`${row.label}-${period.key}-value`}>
                                      <div className="final-metric-cell">
                                        {(!ratioOnlySection && !isTurnoverMetricLabel(row.label) || isPeriodMetricLabel(row.label)) && (
                                          <strong>{isPeriodMetricLabel(row.label) ? "기간" : "금액"} {formatMetricValue(row, row.amounts[period.key])}</strong>
                                        )}
                                        {(ratioOnlySection || isTurnoverMetricLabel(row.label) || hasMetricRatio(row, period.key)) && !isPeriodMetricLabel(row.label) && (
                                          <span className={`ratio-value ${(ratioOnlySection || isTurnoverMetricLabel(row.label)) ? "ratio-only" : ""} ${row.ratios[period.key] === null || row.ratios[period.key] === undefined ? "" : row.ratios[period.key]! < 0 ? "negative" : row.ratios[period.key]! > 0 ? "positive" : ""}`.trim()}>
                                            {isTurnoverMetricLabel(row.label) ? "회전율" : "비율"} {formatMetricRatio(row.ratios[period.key], row.label)}
                                          </span>
                                        )}
                                        <span className="growth-value">
                                          {row.growthRates[period.key] === null || row.growthRates[period.key] === undefined ? "-" : `전분기 ${row.growthRates[period.key]!.toFixed(1)}%`}
                                        </span>
                                      </div>
                                    </td>
                                  ))}
                                </tr>
                                {showReportValidation && metricExpanded && (
                                  <tr className="final-detail-row">
                                    <td colSpan={(selectedReportPeriod ? 1 : 0) + 1}>
                                      <div className="final-detail-grid">
                                        {(selectedReportPeriod ? [selectedReportPeriod] : []).map((period) => {
                                          const detail = row.details[period.key] ?? {};
                                          return (
                                            <article className="final-detail-card" key={`${metricKey}-${period.key}`}>
                                              <div className="final-detail-card-head">
                                                <strong>{period.label}</strong>
                                                <span className="soft-badge">계산 근거</span>
                                              </div>
                                              {renderMetricCalculationCard("금액", "amount", row, period.key, detail.amount)}
                                              {renderMetricCalculationCard("비율", "ratio", row, period.key, detail.ratio)}
                                            </article>
                                          );
                                        })}
                                      </div>
                                    </td>
                                  </tr>
                                )}
                                      </>
                                    );
                                  })()}
                                </Fragment>
                              ))}
                            </tbody>
                        </table>
                      </div>
                    </section>
                  ))}
                </>
              )}
            </>
          )}

          {activeTab === "config" && (
            <>
              <div className="footer-actions">
                <div>
                  <h3 style={{ margin: 0 }}>규칙 관리</h3>
                  <p className="muted" style={{ margin: "6px 0 0" }}>붙여넣기 검증에 실제 쓰는 키워드/섹션/회사 규칙만 남겼습니다.</p>
                </div>
                <div className="inline-actions">
                  <button className="ghost-button" disabled={!configRulesHistory.length} onClick={undoConfigRulesEdit}>되돌리기</button>
                  <button className={`button ${configApplyState === "applied" ? "is-saved" : ""} ${configApplyState === "applying" ? "is-loading" : ""}`.trim()} onClick={saveConfigEditors}>{configApplyState === "applying" ? "반영 중..." : configApplyState === "applied" ? "반영 완료" : "편집값 반영"}</button>
                </div>
              </div>

              <div className="notice" style={{ marginBottom: 12 }}>
                ℹ️ 부호·매칭 규칙은 이제 <strong>4. 분류DB</strong> 가 단일 소스로 처리합니다. 검증 실패 시 진단 카드의 <strong>분류DB에 영구 반영</strong> 버튼으로 한 번에 박을 수 있습니다. 이 탭에는 자본 합계 검증 보조 규칙만 남겨 두었습니다.
              </div>

              <div className="two-col">
                <section className="config-card">
                  <h3>자본 구성항목 규칙</h3>
                  <p className="muted" style={{ marginTop: 0 }}>자본 검증에서 어떤 계정을 포함하고, 가산/차감과 상위 항목 관계를 어떻게 볼지 설정합니다.</p>
                  <div className="list-editor">
                    {capitalRuleRows.map((row, index) => (
                      <div className="override-row" key={`capital-rule-${index}`}>
                        <input className="input" value={row.account} placeholder="계정명" onChange={(event) => { pushConfigRulesSnapshot(); setCapitalRuleRows((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, account: event.target.value } : item)); }} />
                        <select className="select" value={String(row.sign)} onChange={(event) => { pushConfigRulesSnapshot(); setCapitalRuleRows((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, sign: Number(event.target.value) as 0 | 1 } : item)); }}>
                          <option value="0">가산(+)</option>
                          <option value="1">차감(-)</option>
                        </select>
                        <input className="input" value={row.parent} placeholder="상위 항목이 있으면 제외" onChange={(event) => { pushConfigRulesSnapshot(); setCapitalRuleRows((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, parent: event.target.value } : item)); }} />
                        <button className="danger-button" onClick={() => { pushConfigRulesSnapshot(); setCapitalRuleRows((prev) => prev.filter((_, itemIndex) => itemIndex !== index)); }}>삭제</button>
                      </div>
                    ))}
                    <button className="ghost-button" onClick={() => { pushConfigRulesSnapshot(); setCapitalRuleRows((prev) => [...prev, { account: "", sign: 0, parent: "" }]); }}>자본 규칙 추가</button>
                  </div>
                </section>

                <section className="config-card">
                  <h3>자본 검증 제외 항목</h3>
                  <p className="muted" style={{ marginTop: 0 }}>당기순이익 같은 메모성 항목은 자본 합계 검증에서 제외할 수 있습니다.</p>
                  <div className="list-editor">
                    {capitalMemoRows.map((row, index) => (
                      <div className="map-row" key={`capital-memo-${index}`}>
                        <input className="input" value={row.account} placeholder="제외할 계정명" onChange={(event) => { pushConfigRulesSnapshot(); setCapitalMemoRows((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, account: event.target.value } : item)); }} />
                        <button className="danger-button" onClick={() => { pushConfigRulesSnapshot(); setCapitalMemoRows((prev) => prev.filter((_, itemIndex) => itemIndex !== index)); }}>삭제</button>
                      </div>
                    ))}
                    <button className="ghost-button" onClick={() => { pushConfigRulesSnapshot(); setCapitalMemoRows((prev) => [...prev, { account: "" }]); }}>제외 항목 추가</button>
                  </div>
                </section>
              </div>

              <section className="config-card">
                <h3>부모 항목 별칭</h3>
                <p className="muted" style={{ marginTop: 0 }}>
                  검증 합산 규칙(자산 = 부채 + 자본 등)에서 paste의 부모 항목을 인식할 때 쓰는 다른 이름들. 예: paste에 &quot;자본총계&quot;라 적혀있어도 &quot;자본&quot;으로 인식하려면 별칭에 추가. 자기 이름은 자동으로 포함되니 다른 이름만 쉼표로 구분해 적으세요.
                </p>
                <div className="list-editor">
                  {parentAliasRows.map((row, index) => (
                    <div className="map-row" key={`parent-alias-${index}`}>
                      <input
                        className="input"
                        value={row.parent}
                        placeholder="부모 항목명 (예: 자본)"
                        onChange={(event) => {
                          pushConfigRulesSnapshot();
                          setParentAliasRows((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, parent: event.target.value } : item));
                        }}
                      />
                      <input
                        className="input"
                        value={row.aliases}
                        placeholder="다른 이름 (예: 자본총계, 총자본)"
                        onChange={(event) => {
                          pushConfigRulesSnapshot();
                          setParentAliasRows((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, aliases: event.target.value } : item));
                        }}
                      />
                      <button className="danger-button" onClick={() => {
                        pushConfigRulesSnapshot();
                        setParentAliasRows((prev) => prev.filter((_, itemIndex) => itemIndex !== index));
                      }}>삭제</button>
                    </div>
                  ))}
                  <button className="ghost-button" onClick={() => {
                    pushConfigRulesSnapshot();
                    setParentAliasRows((prev) => [...prev, { parent: "", aliases: "" }]);
                  }}>부모 별칭 추가</button>
                </div>
              </section>

              <section className="config-card">
                <h3>현재 설정 JSON</h3>
                <textarea className="textarea" value={configPayload} readOnly />
              </section>
            </>
          )}

          {activeTab === "formulas" && (
            <>
              <section className="overview-card report-hero-card">
                <div className="section-title">
                  <div>
                    <span className="section-kicker">수식 기준</span>
                    <h3>최종결과물 계산 수식</h3>
                    <p className="result-meta">지금 결과물 탭에서 맞추고 있는 기준 수식입니다. 이후 계산 수정도 이 목록을 기준으로 진행합니다.</p>
                  </div>
                </div>
              </section>

              <section className="config-card">
                <div className="report-table-wrap">
                  <table className="table report-table formula-table">
                    <thead>
                      <tr>
                        <th>항목</th>
                        <th>수식</th>
                      </tr>
                    </thead>
                    <tbody>
                      {buildRequestedFormulaRows().map((row) => (
                        <tr key={row.항목}>
                          <td className="formula-label-cell">{row.항목}</td>
                          <td className="pre formula-cell">{row.수식}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}

          {activeTab === "account-db" && (
            <>
              <section className="overview-card report-hero-card">
                <div className="section-title">
                  <div>
                    <span className="section-kicker">4. 분류DB</span>
                    <h3>계정트리 + 미분류 처리</h3>
                    <p className="result-meta">구글시트에서 동기화한 계정트리를 보고, 저장 데이터에서 나온 OCR 계정 중 트리에 없는 것(미분류)을 출처와 함께 확인합니다. 아래 트리 표에서 `미분류` 보기로 전환하면 손볼 항목만 빨간색으로 추려 보고, 시트에 추가해 분류하세요. 분류는 구글시트에서 하고 「시트에서 동기화」로 반영됩니다.</p>
                  </div>
                </div>
              </section>

              <section className="config-card">
                <div className="section-title">
                  <div>
                    <h3>저장 데이터 정합성 점검</h3>
                    <p className="muted" style={{ marginTop: 4 }}>지금 시드·규칙으로 저장된 데이터를 다시 검증합니다. 합산이 안 맞는 회사·분기가 있으면 아래에 표시되니, 해당 데이터를 검증기로 다시 불러와 확인하세요.</p>
                  </div>
                  <div className="inline-actions">
                    <button type="button" className="ghost-button" onClick={runConsistencyCheck} disabled={!savedDatasets.length || consistencyChecking}>
                      {consistencyChecking ? "점검 중..." : "점검 실행"}
                    </button>
                  </div>
                </div>
                {consistencyMessage && (
                  <div className="notice" style={{ marginTop: 12 }}>{consistencyMessage}</div>
                )}
                {consistencyResults && consistencyResults.length > 0 && (
                  <div className="report-table-wrap" style={{ marginTop: 12, maxHeight: 360, overflow: "auto" }}>
                    <table className="table report-table" style={{ fontSize: 12 }}>
                      <thead>
                        <tr>
                          <th>회사</th>
                          <th>분기</th>
                          <th>실패한 검증</th>
                          <th>합계 항목</th>
                          <th style={{ textAlign: "right" }}>기대값(OCR)</th>
                          <th style={{ textAlign: "right" }}>계산값</th>
                          <th style={{ textAlign: "right" }}>차이</th>
                          <th>처리</th>
                        </tr>
                      </thead>
                      <tbody>
                        {consistencyResults.flatMap((r) =>
                          r.failedChecks.map((f, i) => (
                            <tr key={`${r.datasetId}-${i}`}>
                              <td><strong>{r.companyName}</strong></td>
                              <td>{r.quarterLabel}</td>
                              <td>{f.rule}</td>
                              <td>{f.parent}</td>
                              <td style={{ textAlign: "right" }}>{formatNumber(f.expected)}</td>
                              <td style={{ textAlign: "right" }}>{formatNumber(f.actual)}</td>
                              <td style={{ textAlign: "right", color: "#b91c1c" }}><strong>{formatNumber(f.diff)}</strong></td>
                              <td>
                                {i === 0 && (() => {
                                  const ds = savedDatasets.find((d) => d.id === r.datasetId);
                                  return ds ? (
                                    <button type="button" className="ghost-button button-tiny" onClick={() => { loadDatasetIntoValidator(ds); setActiveTab("validate"); }}>검증기로 열기</button>
                                  ) : null;
                                })()}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <section className="config-card">
                <AccountTreeMirror sourcesByCode={treeSourceData.sourcesByCode} unclassified={treeSourceData.unclassified} pendingRows={treeSourceData.pendingRows} onOpenSource={openSourceInValidator} onDeleteUnclassified={deleteUnclassifiedAccount} />
              </section>
            </>
          )}

        </section>
      </section>}

      {topView === "final-output" && (
        <section className="panel final-output-compare-panel">
          <div className="section-title">
            <div>
              <span className="section-kicker">최종결과물 비교</span>
              <h2>기업별 · 분기별 4개 결과물 비교</h2>
              <p className="panel-desc">왼쪽은 항목, 오른쪽 4개 열은 각각 다른 기업과 분기를 선택해 채우는 구조입니다.</p>
            </div>
            <div className="inline-actions">
              <button className={`ghost-button ${sameCompanyMode ? "is-selected" : ""}`.trim()} onClick={toggleSameCompanyMode}>
                동일 회사 {sameCompanyMode ? "켜짐" : "꺼짐"}
              </button>
              <button
                className="ghost-button"
                onClick={bulkSyncSheets}
                disabled={sheetsSyncState.status === "syncing"}
                title="저장된 모든 회사의 최종결과물을 구글시트에 한 번에 push"
              >
                {sheetsSyncState.status === "syncing" ? "동기화 중..." : "전체 회사 시트 동기화"}
              </button>
              {sheetUrl && (
                <a className="ghost-button" href={sheetUrl} target="_blank" rel="noopener noreferrer" title="동기화 대상 구글시트 열기" style={{ textDecoration: "none" }}>
                  구글시트 ↗
                </a>
              )}
              {sheetsSyncState.status !== "idle" && sheetsSyncState.status !== "syncing" && (
                <span className={`sheets-sync-status sheets-sync-${sheetsSyncState.status}`}>
                  {sheetsSyncState.status === "ok" && (sheetsSyncState.message ?? "동기화 완료")}
                  {sheetsSyncState.status === "error" && (sheetsSyncState.message ?? "동기화 실패")}
                </span>
              )}
            </div>
          </div>

          {!savedDatasets.length && <div className="notice">저장된 결과물이 없습니다. 먼저 `OCR검증`에서 데이터를 저장해 주세요.</div>}

          {!!savedDatasets.length && (
            <div className="report-table-wrap summary-compare-wrap">
              <table className="table report-table comparison-table fixed-comparison-table">
                <thead>
                  <tr>
                    <th>항목</th>
                    {comparisonSelections.map((selection, index) => {
                      const quarterOptions = savedDatasets.filter((item) => item.companyName === selection.companyName);
                      const selectedIndustry = getCompanyIndustry(selection.companyName);
                      const selectedIndustryLabel = selectedIndustry || "미분류";
                      return (
                        <th key={`compare-head-${selection.slotId}`}>
                          <div className="comparison-head-cell">
                            <strong>{`결과물 ${index + 1}`}</strong>
                            {selection.companyName && (
                              <div className="comparison-company-meta">
                                <span className="industry-badge-wrap compact">
                                  <span className="industry-icon" aria-hidden="true">{getIndustryIcon(selectedIndustryLabel)}</span>
                                  <span>{selectedIndustryLabel}</span>
                                </span>
                                <span className="comparison-company-name">{selection.companyName}</span>
                              </div>
                            )}
                            <select
                              className="select"
                              value={selection.companyName}
                              onChange={(event) => updateComparisonCompany(selection.slotId, event.target.value)}
                              disabled={sameCompanyMode && index > 0}
                            >
                              <option value="">기업 선택</option>
                              {comparisonCompanyOptions.map((company) => (
                                <option key={`${selection.slotId}-${company}`} value={company}>{`${getIndustryIcon(getCompanyIndustry(company) || "미분류")} ${getCompanyIndustry(company) || "미분류"} · ${company}`}</option>
                              ))}
                            </select>
                            <select
                              className="select"
                              value={selection.datasetId}
                              onChange={(event) => updateComparisonQuarter(selection.slotId, event.target.value)}
                              disabled={!selection.companyName || (sameCompanyMode && index > 0)}
                            >
                              <option value="">분기 선택</option>
                              {quarterOptions.map((dataset) => {
                                const stmtType = dataset.source.statementType ?? "별도";
                                const label = stmtType === "연결"
                                  ? `${formatCompactQuarterLabel(dataset.quarterLabel)}-연결`
                                  : formatCompactQuarterLabel(dataset.quarterLabel);
                                return (
                                  <option key={`${selection.slotId}-${dataset.id}`} value={dataset.id}>{label}</option>
                                );
                              })}
                            </select>
                          </div>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {(resultReporting.finalSections.length ? resultReporting.finalSections : comparisonColumns[0]?.finalSections ?? []).map((section) => (
                    <Fragment key={`summary-section-${section.title}`}>
                      <tr className="comparison-section-row">
                        <td colSpan={comparisonSelections.length + 1}>{section.title}</td>
                      </tr>
                      {section.rows.map((row) => (
                        <tr key={`summary-row-${section.title}-${row.label}`}>
                          <td className="formula-label-cell comparison-item-cell">
                            {(() => {
                              const metricKey = `compare::${buildReportMetricKey(section.title, row.label)}`;
                              const metricHelpText = getReportMetricHelpText(row.label);
                              const metricHelpOpen = activeMetricHelpKey === metricKey;

                              return (
                                <div className="metric-help-wrap">
                                  <span>{row.label}</span>
                                  {metricHelpText && (
                                    <div className="metric-help-anchor">
                                      <button
                                        type="button"
                                        className={`metric-help-button ${metricHelpOpen ? "active" : ""}`.trim()}
                                        aria-label={`${row.label} 설명 보기`}
                                        aria-expanded={metricHelpOpen}
                                        onClick={() => toggleMetricHelp(metricKey)}
                                      >
                                        ?
                                      </button>
                                      {metricHelpOpen && (
                                        <div className="metric-help-popover" role="note">
                                          {metricHelpText}
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              );
                            })()}
                          </td>
                          {comparisonSelections.map((selection) => {
                            const metric = findComparisonMetric(section.title, row.label, selection.slotId);
                            const ratioOnlySection = isRatioOnlySection(section.title);
                            return (
                              <td key={`summary-value-${selection.slotId}-${section.title}-${row.label}`}>
                                <div className="comparison-value-cell">
                                  {((!ratioOnlySection && !isTurnoverMetricLabel(row.label)) || isPeriodMetricLabel(row.label)) && (
                                    <strong>{metric ? formatMetricValue(metric.row, metric.amount) : "-"}</strong>
                                  )}
                                  {(ratioOnlySection || isTurnoverMetricLabel(row.label) || metric?.ratio !== null && metric?.ratio !== undefined) && !isPeriodMetricLabel(row.label) && (
                                    <span className={`ratio-value ${(ratioOnlySection || isTurnoverMetricLabel(row.label)) ? "ratio-only" : ""} ${metric?.ratio === null || metric?.ratio === undefined ? "" : metric.ratio < 0 ? "negative" : metric.ratio > 0 ? "positive" : ""}`.trim()}>
                                      {isTurnoverMetricLabel(row.label) ? "회전율" : "비율"} {metric ? formatMetricRatio(metric.ratio, row.label) : "-"}
                                    </span>
                                  )}
                                  <span className="growth-value">전분기 {metric?.growthRate === null || metric?.growthRate === undefined ? "-" : `${metric.growthRate.toFixed(1)}%`}</span>
                                </div>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        )}
      </section>
    </main>
  );
}
