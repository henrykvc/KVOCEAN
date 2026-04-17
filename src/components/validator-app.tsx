"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_CLASSIFICATION_CATALOG,
  DEFAULT_CLASSIFICATION_GROUPS,
  DEFAULT_COMPANY_CONFIGS,
  DEFAULT_LOGIC_CONFIG,
  MANAGED_CLASSIFICATION_KEYS,
  MANAGED_CLASSIFICATION_KEY_SET,
  classificationCatalogToGroups,
  classificationGroupsToCatalog,
  isSystemFixedClassificationKey,
  mergeDefaultClassificationCatalog,
  sanitizeClassificationAliases,
  sanitizeClassificationGroups,
  type ClassificationCatalogGroup,
  type ClassificationGroups,
  type CompanyConfigs,
  type LogicConfig,
  type SignCode
} from "@/lib/validation/defaults";
import {
  buildCopyText,
  diagnoseDiff,
  formatNumber,
  getDefaultPersistedState,
  parsePersistedState,
  pasteEditKey,
  runValidation,
  safeFloat,
  type ValidationResult,
  type SessionSignFixes
} from "@/lib/validation/engine";
import { type SharedStateResponse } from "@/lib/shared-state";
import {
  buildCompanyReport,
  buildQuarterSnapshots,
  buildReportingModel,
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

type TabKey = "validate" | "data" | "trash" | "report" | "config" | "classify" | "formulas" | "account-db";

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

function parseDatasetApiResponse(raw: DatasetApiResponse) {
  return {
    datasets: sortSavedDatasets(parseSavedDatasets(JSON.stringify(raw.datasets))),
    trashedDatasets: sortSavedDatasets(parseSavedDatasets(JSON.stringify(raw.trashedDatasets)))
  };
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

type PendingInsertedRow = {
  section: string;
  accountName: string;
  value: string;
};

type SectionAccountDbEntry = {
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
  sections: Array<[string, ValidatePreviewItem[]]>;
};

const ACCOUNT_DB_SECTIONS = {
  유동자산: ["유동자산"],
  비유동자산: ["비유동자산"],
  유동부채: ["유동부채"],
  비유동부채: ["비유동부채"],
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
    const grouped = new Map<string, ValidatePreviewItem[]>();

    args.editableNameRow.forEach((accountName, colIndex) => {
      const sectionKey = effectiveSections[colIndex]?.trim() || "기타";
      const items = grouped.get(sectionKey) ?? [];
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
      grouped.set(sectionKey, items);
    });

    return {
      rowIndex,
      rowLabel,
      sections: Array.from(grouped.entries())
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

function cloneClassificationGroups(groups: ClassificationGroups): ClassificationGroups {
  try {
    return structuredClone(groups);
  } catch {
    return structuredClone(DEFAULT_CLASSIFICATION_GROUPS);
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

function buildManagedClassificationLookup(catalog: ClassificationCatalogGroup[]) {
  const lookup = new Map<string, string>();

  const orderedCatalog = [
    ...catalog.filter((group) => group.canonicalKey.trim() !== "변동비"),
    ...catalog.filter((group) => group.canonicalKey.trim() === "변동비")
  ];

  orderedCatalog.forEach((group) => {
    const canonicalKey = group.canonicalKey.trim();
    if (!MANAGED_CLASSIFICATION_KEY_SET.has(canonicalKey)) {
      return;
    }

    lookup.set(normalizeAccountDictionaryKey(canonicalKey), canonicalKey);
    sanitizeClassificationAliases(group.aliases).forEach((alias) => {
      lookup.set(normalizeAccountDictionaryKey(alias), canonicalKey);
    });
  });

  return lookup;
}

function resolveManagedClassification(accountName: string, lookup: Map<string, string>) {
  return lookup.get(normalizeAccountDictionaryKey(accountName)) ?? "";
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

function getDisplayedClassificationAliases(group: ClassificationCatalogGroup) {
  return sanitizeClassificationAliases(group.aliases)
    .filter((alias) => alias.trim() && alias.trim() !== group.canonicalKey.trim());
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

function cloneClassificationCatalog(catalog: ClassificationCatalogGroup[]) {
  try {
    return structuredClone(catalog);
  } catch {
    return structuredClone(DEFAULT_CLASSIFICATION_CATALOG);
  }
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

function getDisplayCompanyName(companyName: string) {
  return companyName.trim() === "로지스팟재무제표" ? "로지스팟" : companyName;
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
          classificationGroups: cloneClassificationGroups(sanitizeClassificationGroups((item.source as { classificationGroups?: ClassificationGroups }).classificationGroups ?? DEFAULT_CLASSIFICATION_GROUPS)),
          sessionSignFixes: cloneSessionSignFixes((item.source as { sessionSignFixes?: SessionSignFixes }).sessionSignFixes ?? {})
        }
      }));
  } catch {
    return [];
  }
}

function configSnapshot(config: {
  logicConfig: LogicConfig;
  companyConfigs: CompanyConfigs;
  classificationCatalog: ClassificationCatalogGroup[];
  classificationGroups: ClassificationGroups;
}) {
  return JSON.stringify({
    logicConfig: config.logicConfig,
    companyConfigs: config.companyConfigs,
    classificationCatalog: config.classificationCatalog,
    classificationGroups: config.classificationGroups
  });
}

function hasCustomConfig(config: {
  logicConfig: LogicConfig;
  companyConfigs: CompanyConfigs;
  classificationCatalog: ClassificationCatalogGroup[];
  classificationGroups: ClassificationGroups;
}) {
  return configSnapshot(config) !== configSnapshot(getDefaultPersistedState());
}

function recoverClassificationConfigFromDatasets(savedDatasets: SavedQuarterSnapshot[]) {
  const mergedGroups = savedDatasets.reduce<ClassificationGroups>((acc, dataset) => {
    const sourceGroups = sanitizeClassificationGroups(dataset.source.classificationGroups ?? {});

    Object.entries(sourceGroups).forEach(([canonicalKey, aliases]) => {
      acc[canonicalKey] = Array.from(new Set([...(acc[canonicalKey] ?? []), canonicalKey, ...aliases]));
    });

    return acc;
  }, {});

  const catalog = classificationGroupsToCatalog(mergedGroups);

  return parsePersistedState(JSON.stringify({
    classificationCatalog: catalog,
    classificationGroups: mergedGroups
  }));
}

function inferManagedClassificationKey(accountName: string, sectionKey: string) {
  const normalizedName = accountName.trim();
  if (!normalizedName) {
    return "";
  }

  const exactManagedKey = MANAGED_CLASSIFICATION_KEYS.find((key) => normalizeAccountDictionaryKey(key) === normalizeAccountDictionaryKey(normalizedName));
  if (exactManagedKey) {
    return exactManagedKey;
  }

  for (const [canonicalKey, aliases] of Object.entries(DEFAULT_CLASSIFICATION_GROUPS)) {
    if (!MANAGED_CLASSIFICATION_KEY_SET.has(canonicalKey)) {
      continue;
    }

    if (aliases.some((alias) => normalizeAccountDictionaryKey(alias) === normalizeAccountDictionaryKey(normalizedName))) {
      return canonicalKey;
    }
  }

  if (["유동자산", "비유동자산"].includes(sectionKey)) {
    if (/매출채권|외상매출금|받을어음/.test(normalizedName)) return "매출채권";
    if (/재고|^상품$|^제품$|^원재료$/.test(normalizedName)) return "재고자산";
    if (/단기대여금/.test(normalizedName)) return "단기대여금";
    if (/선급금/.test(normalizedName)) return "선급금";
    if (/개발비/.test(normalizedName)) return "개발비(자산)";
    if (/현금|예금|예치금|정기예적금|외화예금/.test(normalizedName)) return "현금및현금성자산";
    if (/단기매매증권|매도가능증권|미수금|미수수익|부가세대급금/.test(normalizedName)) return "당좌자산";
  }

  if (["유동부채", "비유동부채"].includes(sectionKey)) {
    if (/퇴직급여충당부채|장기종업원급여부채|연차충당부채/.test(normalizedName)) return "퇴직급여충당부채";
    if (/가수금/.test(normalizedName)) return "가수금";
    if (/가지급금/.test(normalizedName)) return "가지급금";
    if (/차입금|사채|리스부채|전환사채|전환우선주부채|주임종단기채무|주임종장기차입금/.test(normalizedName)) return "차입금";
  }

  if (["영업비용", "판매비와관리비"].includes(sectionKey)) {
    if (/사용권자산.*상각|리스.*감가상각/.test(normalizedName)) return "감가상각비계";
    if (/무형.*상각|판권.*상각/.test(normalizedName)) return "감가상각비계";
    if (/감가상각비/.test(normalizedName)) return "감가상각비계";
    if (/급여|상여|잡급|잡금|인건비|퇴직급여|주식보상비용/.test(normalizedName)) return "인건비";
    if (/연구|개발비/.test(normalizedName)) return "연구개발비";
    if (/접대비|업무추진비/.test(normalizedName)) return "접대비";
    if (/복리후생비/.test(normalizedName)) return "복리후생비";
    if (/광고|선전/.test(normalizedName)) return "광고선전비";
    if (/지급수수료|수수료/.test(normalizedName)) return "지급수수료";
    if (/외주|용역/.test(normalizedName)) return "외주용역비";
    if (/임차료|임대료/.test(normalizedName)) return "임차료";
    if (/배송비|포장비|운반비|차량유지비|수출제비용|여비|교통|출장|통신비|세금과공과|공과금|도서인쇄|인쇄비|소모품|사무용품|대손|판촉|판매촉진|대외협력|행사비|기술이전|경상기술|전산운영|시스템운영|전산비|반품|촬영경비/.test(normalizedName)) return "변동비";
  }

  if (sectionKey === "매출원가") {
    return "매출원가";
  }

  if (sectionKey === "영업외비용") {
    if (/이자비용|금융비용/.test(normalizedName)) return "이자비용";
  }

  return "";
}

function applyManagedAssignmentsFromSavedDatasets(
  config: {
    logicConfig: LogicConfig;
    companyConfigs: CompanyConfigs;
    classificationCatalog: ClassificationCatalogGroup[];
    classificationGroups: ClassificationGroups;
  },
  savedDatasets: SavedQuarterSnapshot[]
) {
  const accountEntries = extractAccountDictionaryEntries(savedDatasets);
  const lookup = buildManagedClassificationLookup(config.classificationCatalog);
  let changed = false;

  const nextCatalog = config.classificationCatalog.map((group) => ({
    ...group,
    aliases: [...group.aliases]
  }));

  accountEntries.forEach((entry) => {
    if (resolveManagedClassification(entry.accountName, lookup)) {
      return;
    }

    const inferredKey = inferManagedClassificationKey(entry.accountName, entry.sectionKey);
    if (!inferredKey) {
      return;
    }

    const targetGroup = nextCatalog.find((group) => group.canonicalKey.trim() === inferredKey);
    if (!targetGroup) {
      return;
    }

    const normalizedEntryKey = normalizeAccountDictionaryKey(entry.accountName);
    const appendAliasToGroup = (groupKey: string) => {
      const group = nextCatalog.find((item) => item.canonicalKey.trim() === groupKey);
      if (!group) {
        return;
      }

      const alreadyIncluded = sanitizeClassificationAliases(group.aliases)
        .some((alias) => normalizeAccountDictionaryKey(alias) === normalizedEntryKey);
      if (alreadyIncluded) {
        return;
      }

      group.aliases = Array.from(new Set([...sanitizeClassificationAliases(group.aliases), entry.accountName]));
      changed = true;
    };

    appendAliasToGroup(inferredKey);

    if (["매출원가", "인건비", "연구개발비", "광고선전비", "접대비", "복리후생비", "지급수수료", "외주용역비", "임차료", "변동비"].includes(inferredKey)) {
      appendAliasToGroup("변동비");
    }
  });

  if (!changed) {
    return {
      nextConfig: config,
      changed: false
    };
  }

  const normalizedCatalog = mergeDefaultClassificationCatalog(nextCatalog);
  return {
    nextConfig: {
      ...config,
      classificationCatalog: normalizedCatalog,
      classificationGroups: classificationCatalogToGroups(normalizedCatalog)
    },
    changed: true
  };
}

export function ValidatorApp() {
  const [topView, setTopView] = useState<TopViewKey>("menu");
  const [activeTab, setActiveTab] = useState<TabKey>("validate");
  const [mounted, setMounted] = useState(false);
  const [workspaceMemo, setWorkspaceMemo] = useState("");
  const [pastedText, setPastedText] = useState("");
  const [tolerance, setTolerance] = useState(1);
  const [selectedCompany, setSelectedCompany] = useState("");
  const [logicConfig, setLogicConfig] = useState<LogicConfig>(cloneLogicConfig(DEFAULT_LOGIC_CONFIG));
  const [companyConfigs, setCompanyConfigs] = useState<CompanyConfigs>(cloneCompanyConfigs(DEFAULT_COMPANY_CONFIGS));
  const [classificationGroups, setClassificationGroups] = useState<ClassificationGroups>(cloneClassificationGroups(DEFAULT_CLASSIFICATION_GROUPS));
  const [classificationCatalog, setClassificationCatalog] = useState<ClassificationCatalogGroup[]>(cloneClassificationCatalog(DEFAULT_CLASSIFICATION_CATALOG));
  const [pasteEdits, setPasteEdits] = useState<Record<string, number>>({});
  const [nameEdits, setNameEdits] = useState<Record<string, string>>({});
  const [sessionSignFixes, setSessionSignFixes] = useState<SessionSignFixes>({});
  const [globalOverrideRows, setGlobalOverrideRows] = useState<OverrideRow[]>(overridesToRows(DEFAULT_LOGIC_CONFIG.sectionSignOverrides));
  const [companyOverrideRows, setCompanyOverrideRows] = useState<OverrideRow[]>([]);
  const [pasteSectionRows, setPasteSectionRows] = useState<MapRow[]>(objectEntriesToRows(DEFAULT_LOGIC_CONFIG.pasteSectToParent));
  const [capitalRuleRows, setCapitalRuleRows] = useState<CapitalRuleRow[]>(capitalRulesToRows(DEFAULT_LOGIC_CONFIG.capitalL1Signs, DEFAULT_LOGIC_CONFIG.capitalL1Parent));
  const [capitalMemoRows, setCapitalMemoRows] = useState<CapitalMemoRow[]>(capitalMemoAccountsToRows(DEFAULT_LOGIC_CONFIG.capitalMemoAccounts));
  const [classificationHistory, setClassificationHistory] = useState<ClassificationCatalogGroup[][]>([]);
  const [resultOpenState, setResultOpenState] = useState<Record<string, boolean>>({});
  const [savedDatasets, setSavedDatasets] = useState<SavedQuarterSnapshot[]>([]);
  const [trashedDatasets, setTrashedDatasets] = useState<SavedQuarterSnapshot[]>([]);
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
  const [classificationSaveState, setClassificationSaveState] = useState<"idle" | "saved">("idle");
  const [datasetActionState, setDatasetActionState] = useState<"idle" | "saving" | "deleting" | "restoring" | "purging">("idle");
  const [configApplyState, setConfigApplyState] = useState<"idle" | "applying" | "applied">("idle");
  const [sharedStateReady, setSharedStateReady] = useState(false);
  const [sharedStateError, setSharedStateError] = useState<string | null>(null);
  const configSyncInitializedRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const savedMemo = window.localStorage.getItem("kvocean-workspace-memo");
    if (savedMemo) {
      setWorkspaceMemo(savedMemo);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem("kvocean-workspace-memo", workspaceMemo);
  }, [workspaceMemo]);

  useEffect(() => {
    let cancelled = false;

    async function loadSharedState() {
      setMounted(true);

      let nextPersisted = getDefaultPersistedState();
      let nextSaved: SavedQuarterSnapshot[] = [];
      let nextTrashed: SavedQuarterSnapshot[] = [];

      try {
        const [configResponse, datasetsResponse] = await Promise.all([
          fetch("/api/shared-state", { cache: "no-store" }),
          fetch("/api/datasets", { cache: "no-store" })
        ]);

        if (!configResponse.ok) {
          throw new Error("공용 데이터를 불러오지 못했습니다.");
        }
        if (!datasetsResponse.ok) {
          throw new Error("검증 저장 데이터를 불러오지 못했습니다.");
        }

        const remote = await configResponse.json() as SharedStateResponse;
        const remoteDatasets = await datasetsResponse.json() as DatasetApiResponse;
        const remotePersisted = parsePersistedState(JSON.stringify(remote.config));
        const parsedDatasetResponse = parseDatasetApiResponse(remoteDatasets);
        const remoteSaved = parsedDatasetResponse.datasets;
        nextTrashed = parsedDatasetResponse.trashedDatasets;
        const recoveredPersisted = recoverClassificationConfigFromDatasets(remoteSaved);
        const shouldRecoverRemoteClassification = !hasCustomConfig(remotePersisted) && hasCustomConfig(recoveredPersisted);
        const { nextConfig: autoAssignedRemotePersisted, changed: autoAssignedChanged } = applyManagedAssignmentsFromSavedDatasets(
          shouldRecoverRemoteClassification
            ? {
                ...remotePersisted,
                classificationCatalog: recoveredPersisted.classificationCatalog,
                classificationGroups: recoveredPersisted.classificationGroups
              }
            : remotePersisted,
          remoteSaved
        );

        if (shouldRecoverRemoteClassification || autoAssignedChanged) {
          const mergedConfig = autoAssignedRemotePersisted;

          const migrationResponse = await fetch("/api/shared-state", {
            method: "PUT",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              config: mergedConfig
            })
          });

          if (!migrationResponse.ok) {
            const payload = await migrationResponse.json().catch(() => null) as { error?: string } | null;
            throw new Error(payload?.error ?? "공용 데이터 마이그레이션에 실패했습니다.");
          }

          setSharedStateError(null);

          nextPersisted = mergedConfig;
          nextSaved = remoteSaved;
        } else {
          nextPersisted = remotePersisted;
          nextSaved = remoteSaved;
        }
      } catch (error) {
        setSharedStateError(error instanceof Error ? error.message : "공용 데이터 연결 중 오류가 발생했습니다.");
      }

      if (cancelled) {
        return;
      }

      setLogicConfig(cloneLogicConfig(nextPersisted.logicConfig));
      setCompanyConfigs(cloneCompanyConfigs(nextPersisted.companyConfigs));
      setClassificationGroups(cloneClassificationGroups(nextPersisted.classificationGroups));
      setClassificationCatalog(cloneClassificationCatalog(nextPersisted.classificationCatalog));
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
          config: { logicConfig, companyConfigs, classificationCatalog, classificationGroups }
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
  }, [mounted, sharedStateReady, logicConfig, companyConfigs, classificationCatalog, classificationGroups]);

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
        sessionSignFixes
      }),
    [pastedText, selectedCompany, tolerance, logicConfig, companyConfigs, pasteEdits, nameEdits, sessionSignFixes]
  );
  const accountDictionaryEntries = useMemo(() => extractAccountDictionaryEntries(savedDatasets), [savedDatasets]);
  const managedClassificationLookup = useMemo(
    () => buildManagedClassificationLookup(classificationCatalog),
    [classificationCatalog]
  );
  const managedClassificationOptions = useMemo(
    () => MANAGED_CLASSIFICATION_KEYS.filter((key) => classificationCatalog.some((group) => group.canonicalKey.trim() === key)),
    [classificationCatalog]
  );
  const reporting = useMemo(
    () => {
      const reportArgs = {
        pastedText,
        selectedCompany: selectedCompany.trim() || null,
        tolerance,
        logicConfig,
        companyConfigs,
        classificationGroups,
        pasteEdits,
        nameEdits,
        sessionSignFixes
      };
      return buildReportingModel(reportArgs);
    },
    [pastedText, selectedCompany, tolerance, logicConfig, companyConfigs, classificationGroups, pasteEdits, nameEdits, sessionSignFixes]
  );
  const accountDictionarySectionGroups = useMemo(
    () => {
      const grouped = accountDictionaryEntries.reduce((acc, entry) => {
        const items = acc.get(entry.sectionKey) ?? [];
        items.push(entry);
        acc.set(entry.sectionKey, items);
        return acc;
      }, new Map<string, SectionAccountDbEntry[]>());

      return Object.keys(ACCOUNT_DB_SECTIONS)
        .map((sectionKey) => [sectionKey, grouped.get(sectionKey) ?? []] as const)
        .filter(([, entries]) => entries.length > 0);
    },
    [accountDictionaryEntries]
  );
  const classifiedAccountDictionaryCount = useMemo(
    () => accountDictionaryEntries.filter((entry) => resolveManagedClassification(entry.accountName, managedClassificationLookup)).length,
    [accountDictionaryEntries, managedClassificationLookup]
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
  const resultReporting = useMemo(
    () => buildCompanyReport(
      selectedDataset
        ? savedDatasets.filter((item) => item.companyName === selectedDataset.companyName)
        : [],
      classificationGroups
    ),
    [selectedDataset, savedDatasets, classificationGroups]
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
        const model = buildCompanyReport(
          savedDatasets.filter((item) => item.companyName === dataset.companyName),
          classificationGroups
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
    [comparisonSelections, savedDatasets, classificationGroups]
  );
  const comparisonCompanyOptions = useMemo(
    () => Array.from(new Set(savedDatasets.map((item) => item.companyName))),
    [savedDatasets]
  );
  const editableClassificationCatalog = useMemo(
    () => classificationCatalog
      .map((group, index) => ({ group, index }))
      .filter(({ group }) => MANAGED_CLASSIFICATION_KEY_SET.has(group.canonicalKey.trim())),
    [classificationCatalog]
  );
  const industryOptions = useMemo(() => Array.from(DEFAULT_INDUSTRY_OPTIONS), []);
  const classificationParentLabels = useMemo(() => {
    const relations = new Map<string, string[]>();

    classificationCatalog.forEach((group) => {
      const parentLabel = group.canonicalKey.trim();
      if (!parentLabel) {
        return;
      }

      sanitizeClassificationAliases(group.aliases).forEach((alias) => {
        const childKey = alias.trim();
        if (!childKey || normalizeAccountDictionaryKey(childKey) === normalizeAccountDictionaryKey(parentLabel)) {
          return;
        }

        const existing = relations.get(normalizeAccountDictionaryKey(childKey)) ?? [];
        if (!existing.includes(parentLabel)) {
          relations.set(normalizeAccountDictionaryKey(childKey), [...existing, parentLabel]);
        }
      });
    });

    return relations;
  }, [classificationCatalog]);

  useEffect(() => {
    const normalizedPasteEdits = normalizePasteEditsForValidation({
      pastedText,
      selectedCompany,
      logicConfig,
      companyConfigs,
      classificationGroups,
      pasteEdits,
      nameEdits,
      sessionSignFixes
    });

    if (JSON.stringify(normalizedPasteEdits) !== JSON.stringify(pasteEdits)) {
      setPasteEdits(normalizedPasteEdits);
    }
  }, [pastedText, selectedCompany, logicConfig, companyConfigs, classificationGroups, pasteEdits, nameEdits, sessionSignFixes]);

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
    setDatasetActionState("saving");
    const snapshotArgs = {
      pastedText,
      selectedCompany: selectedCompany.trim() || null,
      tolerance,
      logicConfig,
      companyConfigs,
      classificationGroups,
      pasteEdits,
      nameEdits,
      sessionSignFixes
    };
    const snapshots = buildQuarterSnapshots(snapshotArgs);

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
    } catch (error) {
      setSharedStateError(error instanceof Error ? error.message : "데이터 저장에 실패했습니다.");
    } finally {
      setDatasetActionState("idle");
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
    const normalizedPasteEdits = normalizePasteEditsForValidation({
      pastedText: dataset.source.pastedText,
      selectedCompany: dataset.companyName,
      logicConfig: dataset.source.logicConfig,
      companyConfigs: dataset.source.companyConfigs,
      classificationGroups: dataset.source.classificationGroups,
      pasteEdits: dataset.source.pasteEdits,
      nameEdits: dataset.source.nameEdits ?? {},
      sessionSignFixes: cloneSessionSignFixes(dataset.source.sessionSignFixes)
    });

    setPastedText(dataset.source.pastedText);
    setTolerance(dataset.source.tolerance);
    setSelectedCompany(dataset.companyName);
    setPasteEdits(normalizedPasteEdits);
    setNameEdits({ ...(dataset.source.nameEdits ?? {}) });
    setSessionSignFixes(cloneSessionSignFixes(dataset.source.sessionSignFixes));
    setPendingInsertedRows({});
    setSelectedDatasetId(dataset.id);
    setActiveTab("validate");
  }

  function openAccountDbSourceDataset(datasetId: string, accountName: string) {
    const dataset = savedDatasets.find((item) => item.id === datasetId);
    if (!dataset) {
      return;
    }

    setActiveAccountDbPreview({ datasetId: dataset.id, accountName });
    setActiveAccountDbSourceKey(null);
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
    const draftKey = `${rowIndex}::${section}`;
    setValidatePreviewDrafts((prev) => ({
      ...prev,
      [draftKey]: {
        accountName: prev[draftKey]?.accountName ?? "",
        value: prev[draftKey]?.value ?? "",
        [field]: value
      }
    }));
  }

  function addValidatePreviewAccount(rowIndex: number, section: string) {
    const draftKey = `${rowIndex}::${section}`;
    const draft = validatePreviewDrafts[draftKey];
    const accountName = draft?.accountName.trim() ?? "";
    const value = safeFloat(draft?.value ?? "");

    if (!accountName || value === null) {
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
      classificationGroups,
      pasteEdits: prev,
      nameEdits,
      sessionSignFixes: nextSessionSignFixes
    }));
  }

  function applyClassificationCatalog(nextCatalog: ClassificationCatalogGroup[], showFeedback = false) {
    const clonedCatalog = mergeDefaultClassificationCatalog(cloneClassificationCatalog(nextCatalog)).map((item) => ({
      ...item,
      groupId: item.groupId.trim(),
      majorCategory: item.majorCategory.trim(),
      middleCategory: item.middleCategory.trim(),
      smallCategory: item.smallCategory.trim(),
      sign: item.sign.trim(),
      canonicalKey: item.canonicalKey.trim(),
      aliases: sanitizeClassificationAliases(item.aliases)
    })).filter((item) => item.canonicalKey);
    const nextGroups = classificationCatalogToGroups(clonedCatalog);
    setClassificationCatalog(clonedCatalog);
    setClassificationGroups(nextGroups);
    setClassificationHistory([]);

    if (showFeedback) {
      setClassificationSaveState("saved");
      window.setTimeout(() => setClassificationSaveState("idle"), 1800);
    }
  }

  function updateClassificationCatalog(updater: (prev: ClassificationCatalogGroup[]) => ClassificationCatalogGroup[]) {
    setClassificationCatalog((prev) => {
      setClassificationHistory((history) => [...history, prev]);
      return updater(prev);
    });
  }

  function undoClassificationEdit() {
    setClassificationHistory((prev) => {
      const last = prev[prev.length - 1];
      if (!last) {
        return prev;
      }
      setClassificationCatalog(last);
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

  function resetConfig() {
    const defaults = getDefaultPersistedState();
    setLogicConfig(cloneLogicConfig(defaults.logicConfig));
    setCompanyConfigs(cloneCompanyConfigs(defaults.companyConfigs));
    setClassificationGroups(cloneClassificationGroups(defaults.classificationGroups));
    setClassificationCatalog(cloneClassificationCatalog(defaults.classificationCatalog));
    setGlobalOverrideRows(overridesToRows(defaults.logicConfig.sectionSignOverrides));
    setPasteSectionRows(objectEntriesToRows(defaults.logicConfig.pasteSectToParent));
    setCapitalRuleRows(capitalRulesToRows(defaults.logicConfig.capitalL1Signs, defaults.logicConfig.capitalL1Parent));
    setCapitalMemoRows(capitalMemoAccountsToRows(defaults.logicConfig.capitalMemoAccounts));
    setClassificationHistory([]);
  }

  function saveConfigEditors() {
    setConfigApplyState("applying");
    setLogicConfig((prev) => ({
      ...prev,
      capitalL1Signs: rowsToCapitalSigns(capitalRuleRows),
      capitalL1Parent: rowsToCapitalParents(capitalRuleRows),
      capitalMemoAccounts: rowsToCapitalMemoAccounts(capitalMemoRows),
      pasteSectToParent: rowsToMap(pasteSectionRows),
      sectionSignOverrides: rowsToOverrides(globalOverrideRows)
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

    applyClassificationCatalog(classificationCatalog);
    window.setTimeout(() => setConfigApplyState("applied"), 250);
    window.setTimeout(() => setConfigApplyState("idle"), 1800);
  }

  function assignAccountDbClassification(accountName: string, nextCanonicalKey: string) {
    const normalizedAccountName = accountName.trim();
    if (!normalizedAccountName) {
      return;
    }

    const nextCatalog = classificationCatalog.map((group) => {
      const canonicalKey = group.canonicalKey.trim();
      if (!MANAGED_CLASSIFICATION_KEY_SET.has(canonicalKey)) {
        return group;
      }

      const aliases = sanitizeClassificationAliases(group.aliases).filter((alias) => normalizeAccountDictionaryKey(alias) !== normalizeAccountDictionaryKey(normalizedAccountName));
      if (canonicalKey !== nextCanonicalKey) {
        return {
          ...group,
          aliases
        };
      }

      return {
        ...group,
        aliases: Array.from(new Set([...aliases, normalizedAccountName]))
      };
    });

    applyClassificationCatalog(nextCatalog, true);
  }

  const configPayload = JSON.stringify({ logicConfig, companyConfigs, classificationCatalog, classificationGroups }, null, 2);

  function buildInputBreakdown(periodKey: string, input: MetricCalculationInput) {
    if (input.components && input.components.length) {
      return input.components;
    }
    return [];
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
                    <span>{ioLabel ? `${ioLabel} · ${input.label}` : input.label}</span>
                    <strong>{formatCalculationInputValue(input.value)}</strong>
                  </div>
                  {!!breakdown.length && (
                    <div className="metric-detail-subinputs">
                      {breakdown.map((item) => (
                        <div className="metric-detail-subinput" key={`${kind}-${input.label}-${item.label}`}>
                          <span>{item.label}</span>
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

  return (
    <main className="workspace-shell">
      <aside className="panel memo-sidebar workspace-memo-rail">
        <div className="memo-card">
          <div className="section-title">
            <div>
              <span className="section-kicker">Memo</span>
            </div>
            <span className="soft-badge">자동 저장</span>
          </div>
          <p className="muted">확인할 계정, 회사별 이슈, 다음 작업을 바로 적어두세요.</p>
          <textarea
            className="textarea memo-textarea"
            value={workspaceMemo}
            onChange={(event) => setWorkspaceMemo(event.target.value)}
            placeholder={"예시\n- 스탠다임 영업비용 구조 재확인\n- 스마트레이더시스템 계정 DB 분류\n- 휴지통 복구 시나리오 점검"}
          />
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
              <button className={`side-nav-item ${activeTab === "validate" ? "active" : ""}`} onClick={() => setActiveTab("validate")}>1. OCR검증</button>
              <button className={`side-nav-item ${activeTab === "config" ? "active" : ""}`} onClick={() => setActiveTab("config")}>1-1. 검증 규칙관리</button>
              <button className={`side-nav-item ${activeTab === "data" ? "active" : ""}`} onClick={() => setActiveTab("data")}>2. 데이터</button>
              <button className={`side-nav-item ${activeTab === "report" ? "active" : ""}`} onClick={() => setActiveTab("report")}>3. 결과물</button>
              <button className={`side-nav-item ${activeTab === "classify" ? "active" : ""}`} onClick={() => setActiveTab("classify")}>3-1. 분류</button>
              <button className={`side-nav-item ${activeTab === "formulas" ? "active" : ""}`} onClick={() => setActiveTab("formulas")}>3-2. 수식</button>
              <button className={`side-nav-item ${activeTab === "account-db" ? "active" : ""}`} onClick={() => setActiveTab("account-db")}>4. 계정 DB</button>
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
                    setSessionSignFixes({});
                  }}
                  placeholder={"행1: 기타\t재무상태표\t유동자산\t...\n행2: 회사명\t날짜\t...\n행3: 에이슬립\t2024-12-31\t..."}
                />
              </label>

              <div className="button-row">
                <button className="button" onClick={() => setActiveTab("validate")}>검증 결과 보기</button>
                <button className="ghost-button" onClick={resetAdjustments}>입력 수정 초기화</button>
              </div>

              <div className="notice input-helper">
                <strong>입력 팁</strong>
                <ul className="helper-list muted">
                  <li>행 1은 섹션명, 행 2는 계정명, 행 3부터 값입니다.</li>
                  <li>회사명은 저장 데이터 구분용으로만 사용하고, 검증은 공통 규칙으로 처리합니다.</li>
                  <li>검증 부호는 이번 검증만 적용하거나, 공통 규칙 또는 회사별 규칙으로 바로 저장할 수 있습니다.</li>
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
                              ? `${selectedDataset ? `${getDisplayCompanyName(selectedDataset.companyName)} ${selectedDataset.quarterLabel}` : "저장된 데이터"} 기준으로 결과물을 생성합니다. 먼저 OCR검증에서 저장하기를 누르세요.`
                            : activeTab === "classify"
                              ? "표준 항목별 분류를 카드 형태로 수정할 수 있습니다. 계정명 추가/삭제 후 저장하면 이후 계산에 바로 반영됩니다."
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
                        <button className={`button ${datasetActionState === "saving" ? "is-loading" : ""}`.trim()} disabled={!canSaveCurrentDataset || datasetActionState === "saving"} onClick={saveCurrentDataset}>{datasetActionState === "saving" ? "저장 중..." : "저장하기"}</button>
                        <button className="tiny-button" onClick={focusFailedResultCards}>실패만 펼치기</button>
                        <button className="tiny-button" onClick={openAllResultCards}>전체 펼치기</button>
                      </div>
                    </div>
                    <div className="metric-grid compact-metrics">
                      <article className="metric-card"><span className="muted">전체 검증</span><strong>{validation.stats.total}</strong></article>
                      <article className="metric-card"><span className="muted">통과</span><strong>{validation.stats.passed}</strong></article>
                      <article className="metric-card"><span className="muted">실패</span><strong>{validation.stats.failed}</strong></article>
                      <article className="metric-card"><span className="muted">통과율</span><strong>{validation.stats.rate.toFixed(1)}%</strong></article>
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
                                      <input
                                        className="mini-input"
                                        type="text"
                                        value={validation.editableNameRow[index] ?? ""}
                                        onChange={(event) => updateEditableName(index, name, event.target.value)}
                                        placeholder={`열${index}`}
                                      />
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
                            const isOpen = resultOpenState[cardKey] ?? (!result.passed || hasPendingAdjustments);
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
                                    <button className="collapse-toggle" onClick={() => toggleResultCard(cardKey, !result.passed || hasPendingAdjustments)} aria-expanded={isOpen}>
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
                                              <tr key={`${detail.계정명}-${index}`}>
                                                <td>
                                                  <div className="result-account-cell">
                                                    <span>{detail.계정명}</span>
                                                    {detail._col !== undefined && (
                                                      <button className="icon-button danger" type="button" aria-label={`${detail.계정명} 삭제`} onClick={() => removeValidationAccount(detail._col!)}>🗑</button>
                                                    )}
                                                  </div>
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

                                  {result.detail.length > 0 && <div className="rule-helper muted">`OCR 수정값`과 계정 삭제/추가는 실제 저장 데이터에 반영됩니다. `검증 부호`는 이번 검증에만 적용하거나 공통/회사 규칙으로 저장할 수 있습니다.</div>}

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
                                      <p className="muted diagnosis-note">차이를 0원으로 만드는 후보를 먼저 보여줍니다. 특히 `음수 OCR + 차감`은 검증 부호보다 `OCR 수정값`을 먼저 바로잡도록 안내합니다.</p>
                                      <div className="list-editor" style={{ marginTop: 12 }}>
                                        {actions.map((action, index) => (
                                          <div key={`${action.text}-${index}`} className="notice">
                                            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                                              <strong>{index === 0 ? "우선 확인" : "다음 후보"}</strong>
                                              {action.badge ? <span className="soft-badge">{action.badge}</span> : null}
                                            </div>
                                            <div className="pre diagnosis-copy">{renderDiagnosisText(action.shortText ?? action.text)}</div>
                                            {action.edit ? <div className="inline-actions" style={{ marginTop: 12 }}><button className="secondary-button" onClick={() => applySuggestedEdit(action.edit!.row, action.edit!.col, action.edit!.value)}>{action.editLabel}</button></div> : null}
                                            {action.fix ? (
                                              <div className="inline-actions" style={{ marginTop: 12 }}>
                                                <button className="secondary-button" onClick={() => applySessionFix(action.fix!.sect, action.fix!.acct, action.fix!.newSign)}>이번 검증만 적용: {action.label}</button>
                                                <button className="ghost-button" onClick={() => saveGlobalFix(action.fix!.sect, action.fix!.acct, action.fix!.newSign)}>검증 규칙에 적용: {action.label}</button>
                                                <button className="ghost-button" disabled={!selectedCompany.trim()} onClick={() => saveCompanyFix(action.fix!.sect, action.fix!.acct, action.fix!.newSign)}>{selectedCompany.trim() ? `회사별 규칙 적용: ${action.label}` : "회사명 입력 필요"}</button>
                                              </div>
                                            ) : null}
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
                        {validatePreviewGroups.map((group) => (
                          <div className="account-db-preview-section" key={`validate-preview-row-${group.rowIndex}`}>
                            <div className="account-db-preview-section-title">{group.rowLabel}</div>
                            <div className="account-db-preview-body validate-preview-row-body">
                              {group.sections.map(([sectionKey, rows]) => {
                                const draftKey = `${group.rowIndex}::${sectionKey}`;
                                const draft = validatePreviewDrafts[draftKey] ?? { accountName: "", value: "" };
                                return (
                                  <div className="account-db-preview-section" key={`validate-preview-row-${group.rowIndex}-${sectionKey}`}>
                                    <div className="account-db-preview-section-title">{sectionKey}</div>
                                    <table className="table account-db-preview-table validate-preview-table">
                                      <thead>
                                        <tr><th>계정명</th><th>수정 반영 값</th><th>삭제</th></tr>
                                      </thead>
                                      <tbody>
                                        {rows.map((row) => (
                                          <tr key={`validate-preview-item-${group.rowIndex}-${sectionKey}-${row.colIndex}`}>
                                            <td>{row.locked ? <span>{row.accountName}</span> : <input className="mini-input" type="text" value={row.accountName} onChange={(event) => updateEditableName(row.colIndex, row.rawName, event.target.value)} />}</td>
                                            <td className="account-db-preview-value">{typeof row.value === "number" ? <input className="mini-input validate-preview-number" type="number" step={1} value={String(row.value)} onChange={(event) => updateEditableValue(row.rowIndex, row.colIndex, row.rawValue, event.target.value)} /> : <span>{row.value ?? ""}</span>}</td>
                                            <td className="validate-preview-action-cell"><button className="icon-button danger" type="button" aria-label={`${row.accountName} 삭제`} onClick={() => removeValidationAccount(row.colIndex)}>🗑</button></td>
                                          </tr>
                                        ))}
                                        <tr>
                                          <td><input className="mini-input" type="text" placeholder="새 계정명" value={draft.accountName} onChange={(event) => updateValidatePreviewDraft(group.rowIndex, sectionKey, "accountName", event.target.value)} /></td>
                                          <td><input className="mini-input validate-preview-number" type="number" step={1} placeholder="값" value={draft.value} onChange={(event) => updateValidatePreviewDraft(group.rowIndex, sectionKey, "value", event.target.value)} /></td>
                                          <td className="validate-preview-action-cell"><button className="ghost-button" type="button" onClick={() => addValidatePreviewAccount(group.rowIndex, sectionKey)}>추가</button></td>
                                        </tr>
                                      </tbody>
                                    </table>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        ))}
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
                  <span className="soft-badge">총 {savedDatasets.length}건</span>
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
                    </div>
                    <div className="data-list grouped-data-list">
                      {groupedSavedDatasets.map(([companyName, datasets]) => {
                        const activeDataset = datasets.find((dataset) => dataset.id === selectedDatasetId) ?? null;
                        const companyIndustry = getCompanyIndustry(companyName);
                        const companyIndustryLabel = companyIndustry || "미분류";
                        const companyIndustryIcon = getIndustryIcon(companyIndustryLabel);
                        const industryEditorOpen = activeIndustryEditor === companyName;
                        return (
                          <article className={`data-company-card ${activeDataset ? "selected" : ""}`} key={`company-group-${companyName}`}>
                            <div className="data-company-row">
                              <div className="data-company-main">
                                <strong>{getDisplayCompanyName(companyName)}</strong>
                                {industryEditorOpen ? (
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
                                ) : (
                                  <div className="industry-badge-wrap">
                                    <span className="industry-icon" aria-hidden="true">{companyIndustryIcon}</span>
                                    <span>{companyIndustryLabel}</span>
                                  </div>
                                )}
                              </div>
                              <div className="data-quarter-chip-list">
                                {datasets.map((dataset) => (
                                  <button
                                    key={dataset.id}
                                    className={`data-quarter-chip ${selectedDatasetId === dataset.id ? "active" : ""}`}
                                    onClick={() => setSelectedDatasetId((prev) => prev === dataset.id ? "" : dataset.id)}
                                  >
                                    {formatCompactQuarterLabel(dataset.quarterLabel)}
                                  </button>
                                ))}
                              </div>
                            </div>
                            {activeDataset && (
                              <div className="data-row-actions">
                                <span className="soft-badge">선택 분기 {formatCompactQuarterLabel(activeDataset.quarterLabel)}</span>
                                <button className="ghost-button" onClick={() => setActiveIndustryEditor((prev) => prev === companyName ? null : companyName)}>
                                  {industryEditorOpen ? "수정 닫기" : "수정하기"}
                                </button>
                                <button className="secondary-button" onClick={() => { setSelectedDatasetId(activeDataset.id); setActiveTab("report"); }}>결과물 보기</button>
                                <button className="ghost-button" onClick={() => loadDatasetIntoValidator(activeDataset)}>검증기로 불러오기</button>
                                 <button className={`danger-button ${datasetActionState === "deleting" ? "is-loading" : ""}`.trim()} disabled={datasetActionState === "deleting"} onClick={() => deleteDataset(activeDataset)}>{datasetActionState === "deleting" ? "이동 중..." : "삭제"}</button>
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
                            <strong>{getDisplayCompanyName(dataset.companyName)}</strong>
                          </div>
                          <div className="data-quarter-chip-list">
                            <span className="data-quarter-chip active">{formatCompactQuarterLabel(dataset.quarterLabel)}</span>
                          </div>
                        </div>
                        <div className="data-row-actions">
                          <span className="soft-badge">삭제됨</span>
                          <button className={`secondary-button ${datasetActionState === "restoring" ? "is-loading" : ""}`.trim()} disabled={datasetActionState === "restoring"} onClick={() => restoreDataset(dataset)}>{datasetActionState === "restoring" ? "복구 중..." : "복구하기"}</button>
                          <button className={`danger-button ${datasetActionState === "purging" ? "is-loading" : ""}`.trim()} disabled={datasetActionState === "purging"} onClick={() => purgeDataset(dataset)}>{datasetActionState === "purging" ? "삭제 중..." : "완전삭제"}</button>
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
              {!resultReporting?.periods.length && <div className="notice">결과물에 보여줄 저장 데이터가 없습니다. 먼저 OCR검증에서 `저장하기`를 누른 뒤 데이터 탭에서 항목을 선택해 주세요.</div>}

              {!!resultReporting?.periods.length && (
                <>
                  <section className="overview-card report-hero-card">
                    <div className="section-title">
                      <div>
                        <span className="section-kicker">3. 보고서</span>
                        <h3>{getDisplayCompanyName(resultReporting.companyName ?? resultReporting.detectedCompany ?? "미지정 회사")} 결과물</h3>
                        <p className="result-meta">엑셀의 `재무제표 → 재무제표_음양반영 → 최종결과물` 흐름을 현재 입력 데이터 기준으로 바로 보여줍니다.</p>
                      </div>
                      <div className="result-actions">
                        {selectedReportPeriod && <span className="soft-badge">{selectedReportPeriod.label}</span>}
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
                  <button className="ghost-button" onClick={resetConfig}>기본값 복원</button>
                  <button className={`button ${configApplyState === "applied" ? "is-saved" : ""} ${configApplyState === "applying" ? "is-loading" : ""}`.trim()} onClick={saveConfigEditors}>{configApplyState === "applying" ? "반영 중..." : configApplyState === "applied" ? "반영 완료" : "편집값 반영"}</button>
                </div>
              </div>

              <div className="two-col">
                <section className="config-card">
                  <h3>부호 키워드</h3>
                  <label className="field">
                    <span>양수 우선 키워드</span>
                    <textarea className="textarea" value={logicConfig.plusOverrideKeywords.join("\n")} onChange={(event) => setLogicConfig((prev) => ({ ...prev, plusOverrideKeywords: parseKeywordList(event.target.value) }))} />
                  </label>
                  <label className="field">
                    <span>차감 키워드</span>
                    <textarea className="textarea" value={logicConfig.minusKeywords.join("\n")} onChange={(event) => setLogicConfig((prev) => ({ ...prev, minusKeywords: parseKeywordList(event.target.value) }))} />
                  </label>
                  <label className="field">
                    <span>비용 가산 키워드</span>
                    <textarea className="textarea" value={logicConfig.plusCostKeywords.join("\n")} onChange={(event) => setLogicConfig((prev) => ({ ...prev, plusCostKeywords: parseKeywordList(event.target.value) }))} />
                  </label>
                </section>

                <section className="config-card">
                  <h3>섹션 검증 범위</h3>
                  <div className="list-editor">
                    {pasteSectionRows.map((row, index) => (
                      <div className="map-row" key={`paste-map-${index}`}>
                        <input className="input" value={row.section} placeholder="섹션명" onChange={(event) => setPasteSectionRows((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, section: event.target.value } : item))} />
                        <input className="input" value={row.parent} placeholder="비교할 합계 계정" onChange={(event) => setPasteSectionRows((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, parent: event.target.value } : item))} />
                        <button className="danger-button" onClick={() => setPasteSectionRows((prev) => prev.filter((_, itemIndex) => itemIndex !== index))}>삭제</button>
                      </div>
                    ))}
                    <button className="ghost-button" onClick={() => setPasteSectionRows((prev) => [...prev, { section: "", parent: "" }])}>섹션 규칙 추가</button>
                  </div>
                </section>

                <section className="config-card">
                  <h3>자본 구성항목 규칙</h3>
                  <p className="muted" style={{ marginTop: 0 }}>자본 검증에서 어떤 계정을 포함하고, 가산/차감과 상위 항목 관계를 어떻게 볼지 설정합니다.</p>
                  <div className="list-editor">
                    {capitalRuleRows.map((row, index) => (
                      <div className="override-row" key={`capital-rule-${index}`}>
                        <input className="input" value={row.account} placeholder="계정명" onChange={(event) => setCapitalRuleRows((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, account: event.target.value } : item))} />
                        <select className="select" value={String(row.sign)} onChange={(event) => setCapitalRuleRows((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, sign: Number(event.target.value) as 0 | 1 } : item))}>
                          <option value="0">가산(+)</option>
                          <option value="1">차감(-)</option>
                        </select>
                        <input className="input" value={row.parent} placeholder="상위 항목이 있으면 제외" onChange={(event) => setCapitalRuleRows((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, parent: event.target.value } : item))} />
                        <button className="danger-button" onClick={() => setCapitalRuleRows((prev) => prev.filter((_, itemIndex) => itemIndex !== index))}>삭제</button>
                      </div>
                    ))}
                    <button className="ghost-button" onClick={() => setCapitalRuleRows((prev) => [...prev, { account: "", sign: 0, parent: "" }])}>자본 규칙 추가</button>
                  </div>
                </section>
              </div>

              <div className="two-col">
                <section className="config-card">
                  <h3>전역 섹션별 부호 재정의</h3>
                  <div className="list-editor">
                    {globalOverrideRows.map((row, index) => (
                      <div className="override-row" key={`global-override-${index}`}>
                        <input className="input" value={row.section} placeholder="섹션명" onChange={(event) => setGlobalOverrideRows((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, section: event.target.value } : item))} />
                        <input className="input" value={row.keyword} placeholder="계정명 / 키워드" onChange={(event) => setGlobalOverrideRows((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, keyword: event.target.value } : item))} />
                        <select className="select" value={String(row.sign)} onChange={(event) => setGlobalOverrideRows((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, sign: Number(event.target.value) as SignCode } : item))}>
                          <option value="0">가산(+)</option>
                          <option value="1">차감(−)</option>
                          <option value="2">제외</option>
                        </select>
                        <button className="danger-button" onClick={() => setGlobalOverrideRows((prev) => prev.filter((_, itemIndex) => itemIndex !== index))}>삭제</button>
                      </div>
                    ))}
                    <button className="ghost-button" onClick={() => setGlobalOverrideRows((prev) => [...prev, { section: "", keyword: "", sign: 0 }])}>전역 규칙 추가</button>
                  </div>
                </section>

                <section className="config-card">
                  <h3>회사별 섹션별 부호 재정의</h3>
                  <p className="muted" style={{ marginTop: 0 }}>{selectedCompany.trim() ? `현재 회사: ${selectedCompany.trim()}` : "검증 탭에서 회사명을 입력하면 회사별 규칙을 편집할 수 있습니다."}</p>
                  <div className="list-editor">
                    {companyOverrideRows.map((row, index) => (
                      <div className="override-row" key={`company-override-${selectedCompany || "empty"}-${index}`}>
                        <input className="input" value={row.section} placeholder="섹션명" disabled={!selectedCompany.trim()} onChange={(event) => setCompanyOverrideRows((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, section: event.target.value } : item))} />
                        <input className="input" value={row.keyword} placeholder="계정명 / 키워드" disabled={!selectedCompany.trim()} onChange={(event) => setCompanyOverrideRows((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, keyword: event.target.value } : item))} />
                        <select className="select" value={String(row.sign)} disabled={!selectedCompany.trim()} onChange={(event) => setCompanyOverrideRows((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, sign: Number(event.target.value) as SignCode } : item))}>
                          <option value="0">가산(+)</option>
                          <option value="1">차감(−)</option>
                          <option value="2">제외</option>
                        </select>
                        <button className="danger-button" disabled={!selectedCompany.trim()} onClick={() => setCompanyOverrideRows((prev) => prev.filter((_, itemIndex) => itemIndex !== index))}>삭제</button>
                      </div>
                    ))}
                    <button className="ghost-button" disabled={!selectedCompany.trim()} onClick={() => setCompanyOverrideRows((prev) => [...prev, { section: "", keyword: "", sign: 0 }])}>회사 규칙 추가</button>
                  </div>
                </section>

                <section className="config-card">
                  <h3>자본 검증 제외 항목</h3>
                  <p className="muted" style={{ marginTop: 0 }}>당기순이익 같은 메모성 항목은 자본 합계 검증에서 제외할 수 있습니다.</p>
                  <div className="list-editor">
                    {capitalMemoRows.map((row, index) => (
                      <div className="map-row" key={`capital-memo-${index}`}>
                        <input className="input" value={row.account} placeholder="제외할 계정명" onChange={(event) => setCapitalMemoRows((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, account: event.target.value } : item))} />
                        <button className="danger-button" onClick={() => setCapitalMemoRows((prev) => prev.filter((_, itemIndex) => itemIndex !== index))}>삭제</button>
                      </div>
                    ))}
                    <button className="ghost-button" onClick={() => setCapitalMemoRows((prev) => [...prev, { account: "" }])}>제외 항목 추가</button>
                  </div>
                </section>

              </div>

              <section className="config-card">
                <h3>현재 설정 JSON</h3>
                <textarea className="textarea" value={configPayload} readOnly />
              </section>
            </>
          )}

          {activeTab === "classify" && (
            <>
              <section className="overview-card report-hero-card">
                <div className="section-title">
                  <div>
                    <span className="section-kicker">분류 기준</span>
                    <h3>번호 묶음 기준 분류</h3>
                    <p className="result-meta">원본 계정은 그대로 두고, 같은 번호로 묶인 계정을 대표 항목 아래로 관리합니다. 표를 붙여넣어 한 번에 수정할 수 있습니다.</p>
                    {classificationSaveState === "saved" && (
                      <p className="save-feedback success">분류를 저장했고, 저장된 결과물도 현재 분류 기준으로 다시 계산했습니다.</p>
                    )}
                  </div>
                  <div className="inline-actions">
                    <button className="ghost-button" disabled={!classificationHistory.length} onClick={undoClassificationEdit}>되돌리기</button>
                    <button className={`button ${classificationSaveState === "saved" ? "is-saved" : ""}`.trim()} onClick={() => applyClassificationCatalog(classificationCatalog, true)}>
                      {classificationSaveState === "saved" ? "분류 저장됨" : "분류 저장"}
                    </button>
                  </div>
                </div>
              </section>

              <section className="config-card">
                <div className="section-title">
                  <div>
                    <h3>분류 항목 편집</h3>
                    <p className="muted">수식에 필요한 대표 항목과 원본 계정 목록만 간단하게 관리합니다. 상위 확정 항목은 시스템 고정값으로 유지하고 여기서 숨깁니다.</p>
                  </div>
                </div>
                <div className="report-table-wrap">
                  <table className="table report-table formula-table classification-table">
                    <thead>
                      <tr>
                        <th>대표항목</th>
                        <th>원본 계정 목록</th>
                        <th>삭제</th>
                      </tr>
                    </thead>
                    <tbody>
                      {editableClassificationCatalog.map(({ group, index }) => (
                        <tr key={`classification-group-${group.groupId}-${index}`}>
                          <td>
                            <div className="classification-key-cell">
                              <input className="input" value={group.canonicalKey} onChange={(event) => updateClassificationCatalog((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, canonicalKey: event.target.value } : item))} />
                              {(() => {
                                const parentLabels = classificationParentLabels.get(normalizeAccountDictionaryKey(group.canonicalKey.trim())) ?? [];
                                if (!parentLabels.length) {
                                  return null;
                                }
                                return (
                                  <p className="classification-parent-note">
                                    {parentLabels.map((label) => `${label}으로 귀속`).join(", ")}
                                  </p>
                                );
                              })()}
                            </div>
                          </td>
                          <td>
                            <textarea
                              className="textarea classification-textarea"
                              value={getDisplayedClassificationAliases(group).join("\n")}
                              onChange={(event) => updateClassificationCatalog((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, aliases: parseKeywordList(event.target.value) } : item))}
                              placeholder="실제 세부 계정이 있으면 줄바꿈으로 입력"
                            />
                          </td>
                          <td><button className="danger-button" onClick={() => updateClassificationCatalog((prev) => prev.filter((_, itemIndex) => itemIndex !== index))}>삭제</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
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
                    <span className="section-kicker">4. 계정 DB</span>
                    <h3>회사별 분기 데이터 기준 계정 DB</h3>
                    <p className="result-meta">지금까지 저장한 회사별 분기 데이터에서 `유동자산`, `비유동자산`, `유동부채`, `비유동부채`, `매출원가`, `판매비와관리비`, `영업외수익`, `영업외비용`, `기타` 아래 실제 하위 계정만 모아 보여줍니다.</p>
                  </div>
                  <div className="inline-actions">
                    <span className="soft-badge">누적 {accountDictionaryEntries.length}건</span>
                    <span className="soft-badge">섹션 {accountDictionarySectionGroups.length}개</span>
                    <span className="soft-badge">분류완료 {classifiedAccountDictionaryCount}건</span>
                  </div>
                </div>
              </section>

              {!accountDictionaryEntries.length && <div className="notice">아직 표시할 손익 계정 DB가 없습니다. `저장하기`로 회사별 분기 데이터를 먼저 쌓아 주세요.</div>}

              {!!accountDictionaryEntries.length && (
                <section className={`account-db-layout ${activeAccountDbPreviewDataset ? "with-preview" : ""}`.trim()}>
                  <section className="config-card">
                    <div className="section-title">
                      <div>
                        <h3>상위 항목별 하위 계정</h3>
                        <p className="muted">새로 쌓이는 하위 계정을 여기서 바로 대표 분류에 연결합니다. 출처 말풍선에서 회사를 누르면 오른쪽에 수정 반영된 3줄 데이터를 새 양식으로 바로 확인할 수 있습니다.</p>
                      </div>
                    </div>
                    <div className="data-list grouped-data-list">
                      {accountDictionarySectionGroups.map(([sectionKey, entries]) => (
                        <article className="data-company-card" key={`account-db-section-${sectionKey}`}>
                          <div className="data-company-row">
                            <strong>{sectionKey}</strong>
                            <span className="soft-badge">{entries.length}건</span>
                          </div>
                          <div className="report-table-wrap">
                            <table className="table report-table formula-table">
                              <thead>
                                <tr>
                                  <th>상위 항목</th>
                                  <th>하위 계정명</th>
                                  <th>출처</th>
                                  <th>현재 분류</th>
                                  <th>분류 지정</th>
                                </tr>
                              </thead>
                              <tbody>
                                {entries.map((entry) => {
                                  const currentClassification = resolveManagedClassification(entry.accountName, managedClassificationLookup);
                                  const isSourceOpen = activeAccountDbSourceKey === entry.entryKey;

                                  return (
                                    <tr key={`account-db-entry-${entry.entryKey}`}>
                                      <td>{entry.sectionKey}</td>
                                      <td>{entry.accountName}</td>
                                      <td>
                                        <div className="account-db-source-wrap" data-account-db-source-wrap="true">
                                          <button
                                            className={`account-db-source-button ${isSourceOpen ? "active" : ""}`.trim()}
                                            type="button"
                                            onClick={() => setActiveAccountDbSourceKey((prev) => prev === entry.entryKey ? null : entry.entryKey)}
                                            aria-label={`${entry.accountName} 출처 보기`}
                                          >
                                            💬
                                          </button>
                                          {isSourceOpen && (
                                            <div className="account-db-source-popover">
                                              <strong>출처 데이터</strong>
                                              <p>{entry.accountName}이(가) 들어온 회사/분기입니다.</p>
                                              <div className="account-db-source-list">
                                                {entry.sources.map((source) => (
                                                  <button
                                                    key={`${entry.entryKey}-${source.datasetId}`}
                                                    className="account-db-source-link"
                                                    type="button"
                                                    onClick={() => openAccountDbSourceDataset(source.datasetId, entry.accountName)}
                                                  >
                                                    <span>{getDisplayCompanyName(source.companyName)}</span>
                                                    <strong>{source.quarterLabel}</strong>
                                                  </button>
                                                ))}
                                              </div>
                                            </div>
                                          )}
                                        </div>
                                      </td>
                                      <td>{currentClassification || <span className="muted">미분류</span>}</td>
                                      <td>
                                        <select
                                          className="select"
                                          value={currentClassification}
                                          onChange={(event) => assignAccountDbClassification(entry.accountName, event.target.value)}
                                        >
                                          <option value="">미분류</option>
                                          {managedClassificationOptions.map((option) => (
                                            <option key={`${entry.entryKey}-${option}`} value={option}>{option}</option>
                                          ))}
                                        </select>
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </article>
                      ))}
                    </div>
                  </section>

                  {activeAccountDbPreviewDataset && (
                    <aside className="panel account-db-preview-panel">
                      <div className="section-title">
                        <div>
                          <span className="section-kicker">출처 3줄 미리보기</span>
                          <h3>{getDisplayCompanyName(activeAccountDbPreviewDataset.companyName)}</h3>
                          <p className="result-meta">{activeAccountDbPreviewDataset.quarterLabel} · {activeAccountDbPreview?.accountName ?? "선택 계정"}</p>
                        </div>
                        <div className="inline-actions">
                          <button className="ghost-button" onClick={() => loadDatasetIntoValidator(activeAccountDbPreviewDataset)}>검증기로 열기</button>
                          <button className="ghost-button" onClick={() => setActiveAccountDbPreview(null)}>닫기</button>
                        </div>
                      </div>

                      <div className="account-db-preview-body">
                        {groupPreviewRowsBySection(activeAccountDbPreviewDataset.adjustedStatementRows).map(([previewSectionKey, previewRows]) => (
                          <div className="account-db-preview-section" key={`preview-${activeAccountDbPreviewDataset.id}-${previewSectionKey}`}>
                            <div className="account-db-preview-section-title">{previewSectionKey}</div>
                            <table className="table account-db-preview-table">
                              <thead>
                                <tr>
                                  <th>계정명</th>
                                  <th>수정 반영 값</th>
                                </tr>
                              </thead>
                              <tbody>
                                {previewRows.map((row, index) => (
                                  <tr key={`preview-row-${activeAccountDbPreviewDataset.id}-${previewSectionKey}-${row.accountName}-${index}`}>
                                    <td>{row.accountName}</td>
                                    <td className="account-db-preview-value">{row.value === null || row.value === undefined ? "-" : formatNumber(row.value)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ))}
                      </div>
                    </aside>
                  )}
                </section>
              )}
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
                                <span className="comparison-company-name">{getDisplayCompanyName(selection.companyName)}</span>
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
                                <option key={`${selection.slotId}-${company}`} value={company}>{`${getIndustryIcon(getCompanyIndustry(company) || "미분류")} ${getCompanyIndustry(company) || "미분류"} · ${getDisplayCompanyName(company)}`}</option>
                              ))}
                            </select>
                            <select
                              className="select"
                              value={selection.datasetId}
                              onChange={(event) => updateComparisonQuarter(selection.slotId, event.target.value)}
                              disabled={!selection.companyName || (sameCompanyMode && index > 0)}
                            >
                              <option value="">분기 선택</option>
                              {quarterOptions.map((dataset) => (
                                <option key={`${selection.slotId}-${dataset.id}`} value={dataset.id}>{formatCompactQuarterLabel(dataset.quarterLabel)}</option>
                              ))}
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
