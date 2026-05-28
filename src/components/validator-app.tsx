"use client";

import { Fragment, memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  CLASSIFICATION_ENTRIES,
  DEFAULT_CLASSIFICATION_CATALOG,
  DEFAULT_CLASSIFICATION_GROUPS,
  DEFAULT_COMPANY_CONFIGS,
  DEFAULT_LOGIC_CONFIG,
  MANAGED_CLASSIFICATION_KEYS,
  MANAGED_CLASSIFICATION_KEY_SET,
  applyAliasOverridesToCatalog,
  classificationCatalogToGroups,
  classificationGroupsToCatalog,
  findEntryByAlias,
  findEntryByCode,
  isSystemFixedClassificationKey,
  mergeDefaultClassificationCatalog,
  sanitizeClassificationAliases,
  sanitizeClassificationGroups,
  type ClassificationCatalogGroup,
  type ClassificationEntry,
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
import { RESULT_CLASSIFICATION, RESULT_BY_GROUP } from "@/lib/validation/result-classification";
import { type SharedStateResponse } from "@/lib/shared-state";
import {
  buildHeaderRow as buildSheetsHeaderRow,
  buildQuarterRows as buildSheetsQuarterRows,
  collectDistinctQuarters as collectSheetsQuarters,
  toSheetTabName,
  buildClassificationDbTab,
  type SheetCellValue,
  type AccountOccurrence
} from "@/lib/sheets-export";
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

type TabKey = "validate" | "data" | "trash" | "report" | "config" | "classify" | "formulas" | "account-db" | "result-db";

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
  classificationGroups: ClassificationGroups
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
    companyReports.set(name, buildCompanyReport(snaps, classificationGroups));
  }

  const quarters = collectSheetsQuarters(Array.from(companyReports.values()));
  const headers = buildSheetsHeaderRow();

  // 분류DB 탭 — collect OCR account occurrences across all saved datasets.
  const accountOccurrences = collectAccountOccurrences(savedDatasets);
  const classificationDbTab = buildClassificationDbTab(accountOccurrences);

  const quarterTabs = quarters.map((q) => ({
    tabName: toSheetTabName(q.key),
    headers,
    rows: buildSheetsQuarterRows({ quarterKey: q.key, companyReports })
  }));

  // Prepend 분류DB so it's the first/visible tab when users open the sheet.
  return {
    quarterTabs: [classificationDbTab, ...quarterTabs]
  };
}

/**
 * Walk every saved snapshot and collect (accountName, source) pairs.
 * Used to render the 출처 column in the 분류DB sheet tab.
 */
function collectAccountOccurrences(savedDatasets: SavedQuarterSnapshot[]): AccountOccurrence[] {
  const byName = new Map<string, AccountOccurrence>();
  for (const dataset of savedDatasets) {
    for (const row of dataset.adjustedStatementRows) {
      const name = (row.accountName ?? "").trim();
      if (!name) continue;
      const existing = byName.get(name);
      const source = {
        companyName: dataset.companyName,
        quarterLabel: dataset.quarterLabel
      };
      if (existing) {
        const dup = existing.sources.some(
          (s) => s.companyName === source.companyName && s.quarterLabel === source.quarterLabel
        );
        if (!dup) existing.sources.push(source);
      } else {
        byName.set(name, { accountName: name, sources: [source] });
      }
    }
  }
  return Array.from(byName.values());
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

// ===========================================================================
// 5-level classification tree — builds a 대 > 중 > 소 > 세 hierarchy from the
// seed catalog, attaching live OCR-encountered accounts (occurrences). Used by
// the 3-1 분류 탭 to give the user a navigable tree instead of a flat list.
// ===========================================================================

type ClassificationLeafOccurrence = {
  accountName: string;
  occurrences: number;
  sources: Array<{ companyName: string; quarterLabel: string }>;
};

type ClassificationTreeLeaf = {
  kind: "leaf";
  nodeId: string;
  code: number;
  sign: 0 | 1;
  세분류: string;
  aliases: string[];
  encountered: ClassificationLeafOccurrence[]; // OCR-seen alias forms
  encounteredCount: number;
};

type ClassificationTreeBranch = {
  kind: "branch";
  nodeId: string;
  level: "대분류" | "중분류" | "소분류";
  name: string;
  isUnclassified: boolean;
  children: ClassificationTreeNode[];
  leafCount: number;
  encounteredCount: number;
};

type ClassificationTreeNode = ClassificationTreeLeaf | ClassificationTreeBranch;

const UNCLASSIFIED_LABEL = "미분류";

// Same rule as normalizeLookupKey in defaults.ts — keeps OCR-side dedup
// (occurrences, 미분류 detection) in sync with the validator's matching.
function normalizeAliasKey(value: string): string {
  return (value ?? "").replace(/[\s_\-.\/\\()\[\]·•'"]+/g, "").toLowerCase();
}

function buildClassificationTree(
  accountEntries: SectionAccountDbEntry[]
): ClassificationTreeNode[] {
  // Map alias → leaf occurrences (from saved OCR data)
  const aliasOccurrences = new Map<string, { entry: ClassificationEntry; account: SectionAccountDbEntry }[]>();
  const unclassifiedAccounts: SectionAccountDbEntry[] = [];

  for (const acct of accountEntries) {
    const matched = findEntryByAlias(acct.accountName, acct.sectionKey || acct.section);
    if (matched) {
      // Find which alias matched (case-insensitive)
      const target = normalizeAliasKey(acct.accountName);
      const aliasHit = matched.aliases.find((a) => normalizeAliasKey(a) === target) ?? matched.세분류;
      const key = `${matched.code}::${normalizeAliasKey(aliasHit)}`;
      const list = aliasOccurrences.get(key) ?? [];
      list.push({ entry: matched, account: acct });
      aliasOccurrences.set(key, list);
    } else {
      unclassifiedAccounts.push(acct);
    }
  }

  // Group entries by 대 > 중 > 소
  type AccumNode = Map<string, { node: ClassificationTreeBranch; subgroups?: AccumNode; leaves?: ClassificationTreeLeaf[] }>;
  const root: AccumNode = new Map();

  function ensureBranch(map: AccumNode, level: ClassificationTreeBranch["level"], name: string, idPrefix: string): { node: ClassificationTreeBranch; subgroups: AccumNode; leaves: ClassificationTreeLeaf[] } {
    const displayName = name?.trim() || UNCLASSIFIED_LABEL;
    const existing = map.get(displayName);
    if (existing) {
      if (!existing.subgroups) existing.subgroups = new Map();
      if (!existing.leaves) existing.leaves = [];
      return { node: existing.node, subgroups: existing.subgroups, leaves: existing.leaves };
    }
    const node: ClassificationTreeBranch = {
      kind: "branch",
      nodeId: `${idPrefix}::${displayName}`,
      level,
      name: displayName,
      isUnclassified: displayName === UNCLASSIFIED_LABEL,
      children: [],
      leafCount: 0,
      encounteredCount: 0
    };
    const slot = { node, subgroups: new Map() as AccumNode, leaves: [] as ClassificationTreeLeaf[] };
    map.set(displayName, slot);
    return slot;
  }

  for (const entry of CLASSIFICATION_ENTRIES) {
    const 대 = ensureBranch(root, "대분류", entry.대분류, "L1");
    const 중 = ensureBranch(대.subgroups, "중분류", entry.중분류, 대.node.nodeId);
    const 소 = ensureBranch(중.subgroups, "소분류", entry.소분류, 중.node.nodeId);

    const encountered: ClassificationLeafOccurrence[] = [];
    for (const alias of entry.aliases) {
      const key = `${entry.code}::${normalizeAliasKey(alias)}`;
      const hits = aliasOccurrences.get(key) ?? [];
      if (!hits.length) continue;
      const sources: Array<{ companyName: string; quarterLabel: string }> = [];
      let totalOccurrences = 0;
      for (const hit of hits) {
        totalOccurrences += hit.account.occurrences;
        for (const src of hit.account.sources) {
          if (!sources.some((s) => s.companyName === src.companyName && s.quarterLabel === src.quarterLabel)) {
            sources.push({ companyName: src.companyName, quarterLabel: src.quarterLabel });
          }
        }
      }
      encountered.push({ accountName: alias, occurrences: totalOccurrences, sources });
    }
    const encounteredCount = encountered.reduce((acc, e) => acc + e.occurrences, 0);

    const leaf: ClassificationTreeLeaf = {
      kind: "leaf",
      nodeId: `leaf::${entry.code}`,
      code: entry.code,
      sign: entry.sign,
      세분류: entry.세분류,
      aliases: entry.aliases,
      encountered,
      encounteredCount
    };
    소.leaves.push(leaf);
    소.node.leafCount += 1;
    소.node.encounteredCount += encounteredCount;
    중.node.leafCount += 1;
    중.node.encounteredCount += encounteredCount;
    대.node.leafCount += 1;
    대.node.encounteredCount += encounteredCount;
  }

  // Attach 미분류 accounts at the top level — they have no 대분류 to anchor to.
  if (unclassifiedAccounts.length) {
    const unc = ensureBranch(root, "대분류", UNCLASSIFIED_LABEL, "L1");
    // Group accounts as fake leaves with just OCR data
    for (const acct of unclassifiedAccounts) {
      const leaf: ClassificationTreeLeaf = {
        kind: "leaf",
        nodeId: `unclassified::${acct.entryKey}`,
        code: 9999999,
        sign: 0,
        세분류: acct.accountName,
        aliases: [acct.accountName],
        encountered: [{
          accountName: acct.accountName,
          occurrences: acct.occurrences,
          sources: acct.sources.map((s) => ({ companyName: s.companyName, quarterLabel: s.quarterLabel }))
        }],
        encounteredCount: acct.occurrences
      };
      unc.leaves.push(leaf);
      unc.node.leafCount += 1;
      unc.node.encounteredCount += acct.occurrences;
    }
  }

  // Walk the accumulator to assemble children arrays, with "미분류" branches always last
  function finalize(map: AccumNode): ClassificationTreeNode[] {
    const result: (ClassificationTreeBranch | ClassificationTreeLeaf)[] = [];
    for (const slot of map.values()) {
      const childBranches = slot.subgroups ? finalize(slot.subgroups) : [];
      const childLeaves = (slot.leaves ?? []).slice().sort((a, b) => a.code - b.code);
      slot.node.children = [...childBranches, ...childLeaves];
      result.push(slot.node);
    }
    // 미분류는 항상 맨 밑
    result.sort((a, b) => {
      const aUnc = a.kind === "branch" && a.isUnclassified;
      const bUnc = b.kind === "branch" && b.isUnclassified;
      if (aUnc && !bUnc) return 1;
      if (!aUnc && bUnc) return -1;
      // Leaves: sort by code; branches: sort by name (Korean)
      if (a.kind === "leaf" && b.kind === "leaf") return a.code - b.code;
      if (a.kind === "branch" && b.kind === "branch") return a.name.localeCompare(b.name, "ko");
      return a.kind === "branch" ? -1 : 1;
    });
    return result;
  }

  return finalize(root);
}

// Render a single tree node (branch or leaf) recursively.
function ClassificationTreeNodeView({
  node,
  expanded,
  onToggle,
  depth = 0
}: {
  node: ClassificationTreeNode;
  expanded: Set<string>;
  onToggle: (nodeId: string) => void;
  depth?: number;
}) {
  const isOpen = expanded.has(node.nodeId);
  const indentStyle = { paddingLeft: 8 + depth * 16 } as const;

  if (node.kind === "leaf") {
    const signLabel = node.code === 9999999 ? "" : node.sign === 1 ? "−" : "+";
    const signClass = node.code === 9999999 ? "" : node.sign === 1 ? "tree-sign tree-sign-minus" : "tree-sign tree-sign-plus";
    return (
      <li className={`tree-leaf${node.code === 9999999 ? " tree-leaf-unclassified" : ""}`}>
        <div className="tree-row" style={indentStyle}>
          <button
            type="button"
            className="tree-toggle"
            onClick={() => onToggle(node.nodeId)}
            aria-label={isOpen ? "접기" : "펼치기"}
          >{isOpen ? "▼" : "▶"}</button>
          <span className="tree-code">{node.code === 9999999 ? "—" : node.code}</span>
          <span className="tree-leaf-name">{node.세분류}</span>
          {signLabel && <span className={signClass}>{signLabel}</span>}
          <span className="tree-count-badge" title="실제 OCR 등장 항목 수">
            {node.encountered.length}/{node.aliases.length}
          </span>
        </div>
        {isOpen && (
          <ul className="tree-leaf-aliases">
            {node.aliases.map((alias) => {
              const occ = node.encountered.find((e) => e.accountName === alias);
              return (
                <li key={`${node.nodeId}-${alias}`} className={`tree-alias${occ ? " tree-alias-seen" : ""}`} style={{ paddingLeft: 8 + (depth + 1) * 16 }}>
                  <span className="tree-alias-dot">•</span>
                  <span className="tree-alias-name">{alias}</span>
                  {occ && (
                    <>
                      <span className="tree-alias-count">×{occ.occurrences}</span>
                      <span className="tree-alias-sources">{occ.sources.slice(0, 3).map((s) => `${s.companyName}${s.quarterLabel}`).join(", ")}{occ.sources.length > 3 ? ` 외 ${occ.sources.length - 3}건` : ""}</span>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </li>
    );
  }

  // Branch
  const levelClass = `tree-branch tree-branch-${node.level}${node.isUnclassified ? " tree-branch-unclassified" : ""}`;
  return (
    <li className={levelClass}>
      <div className="tree-row" style={indentStyle}>
        <button
          type="button"
          className="tree-toggle"
          onClick={() => onToggle(node.nodeId)}
          aria-label={isOpen ? "접기" : "펼치기"}
        >{isOpen ? "▼" : "▶"}</button>
        <span className={`tree-level-tag tree-level-${node.level}`}>{node.level}</span>
        <span className="tree-branch-name">{node.name}</span>
        <span className="tree-count-badge">세분류 {node.leafCount}{node.encounteredCount ? ` · 등장 ${node.encounteredCount}` : ""}</span>
      </div>
      {isOpen && (
        <ul className="tree-children">
          {node.children.map((child) => (
            <ClassificationTreeNodeView
              key={child.nodeId}
              node={child}
              expanded={expanded}
              onToggle={onToggle}
              depth={depth + 1}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

// ===========================================================================
// 분류DB 표 — 엑셀 양식과 동일한 평탄 표. 코드 ASC 정렬 + 검색 + 페이지네이션.
// 한 행 = 한 (코드, alias) 페어. 미분류는 코드 9999999로 맨 아래.
// ===========================================================================

type ClassificationTableRow = {
  rowKey: string;
  code: number;
  대분류: string;
  중분류: string;
  소분류: string;
  세분류: string;
  항목명: string;
  sign: 0 | 1;
  occurrences: number;
  sources: Array<{ companyName: string; quarterLabel: string }>;
  isUnclassified: boolean;
};

const UNCLASSIFIED_ROW_CODE = 9999999;

function buildClassificationTableRows(
  accountEntries: SectionAccountDbEntry[],
  catalog: ClassificationCatalogGroup[]
): ClassificationTableRow[] {
  // Build occurrence lookup from current saved data.
  const occByName = new Map<string, { occurrences: number; sources: Array<{ companyName: string; quarterLabel: string }> }>();
  for (const acct of accountEntries) {
    const key = normalizeAliasKey(acct.accountName);
    if (!key) continue;
    const existing = occByName.get(key);
    const newSources = acct.sources.map((s) => ({ companyName: s.companyName, quarterLabel: s.quarterLabel }));
    if (existing) {
      existing.occurrences += acct.occurrences;
      for (const src of newSources) {
        if (!existing.sources.some((s) => s.companyName === src.companyName && s.quarterLabel === src.quarterLabel)) {
          existing.sources.push(src);
        }
      }
    } else {
      occByName.set(key, { occurrences: acct.occurrences, sources: newSources });
    }
  }

  // Rows are derived from the runtime catalog (the source of truth) rather than
  // the static seed file — otherwise user-added aliases (e.g. classifying a
  // 미분류 OCR row) wouldn't appear after save, and that row would keep
  // showing up as 미분류 on every refresh. Seed provides the 대/중/소/세/sign
  // metadata via groupId/code lookup.
  const matchedAliasKeys = new Set<string>();
  const rows: ClassificationTableRow[] = [];
  const seenRowKeys = new Set<string>();
  for (const group of catalog) {
    const code = parseInt(group.groupId, 10);
    if (!Number.isFinite(code)) continue;
    const seed = findEntryByCode(code);
    if (!seed) continue;
    // classificationGroupsToCatalog strips canonicalKey (= seed.세분류) out of
    // group.aliases, so prepend the seed 세분류 itself to keep its row visible.
    const aliasList: string[] = [seed.세분류, ...group.aliases];
    for (const alias of aliasList) {
      const normKey = normalizeAliasKey(alias);
      if (!normKey) continue;
      // Seed wins for OCR matching — if this alias has a different seed home
      // (e.g. "매출채권_대손충당금" belongs to 1001100 but the persisted catalog
      // mistakenly also has it in 1001000), don't render a duplicate row here.
      const seedHome = findEntryByAlias(alias);
      if (seedHome && seedHome.code !== seed.code) continue;
      const rowKey = `catalog::${code}::${normKey}`;
      if (seenRowKeys.has(rowKey)) continue;
      seenRowKeys.add(rowKey);
      matchedAliasKeys.add(normKey);
      const occ = occByName.get(normKey);
      rows.push({
        rowKey,
        code: seed.code,
        대분류: seed.대분류,
        중분류: seed.중분류,
        소분류: seed.소분류,
        세분류: seed.세분류,
        항목명: alias,
        sign: seed.sign,
        occurrences: occ?.occurrences ?? 0,
        sources: occ?.sources ?? [],
        isUnclassified: false
      });
    }
  }

  // 미분류 — OCR 항목 중 매칭 안 된 것.
  // Pre-fill 대/중분류 from the OCR section so the user only has to pick
  // 소/세분류 + 부호 in the editor (e.g. OCR section "유동자산" → 자산/유동자산).
  for (const acct of accountEntries) {
    const aliasKey = normalizeAliasKey(acct.accountName);
    if (matchedAliasKeys.has(aliasKey)) continue;
    const { 대분류, 중분류 } = inferUnclassifiedHierarchy(acct.sectionKey || acct.section);
    rows.push({
      rowKey: `unclassified::${acct.entryKey}`,
      code: UNCLASSIFIED_ROW_CODE,
      대분류,
      중분류,
      소분류: "",
      세분류: "",
      항목명: acct.accountName,
      sign: 0,
      occurrences: acct.occurrences,
      sources: acct.sources.map((s) => ({ companyName: s.companyName, quarterLabel: s.quarterLabel })),
      isUnclassified: true
    });
  }

  return rows;
}

/**
 * Map an OCR section label (e.g. "유동자산", "영업외비용") to the seed's
 * 대분류/중분류 so an unclassified row already shows where it came from.
 * Looks up the first seed entry whose 중분류 (then 대분류) matches.
 */
function inferUnclassifiedHierarchy(sectionLabel: string): { 대분류: string; 중분류: string } {
  const trimmed = (sectionLabel ?? "").trim();
  // "기타" is an ACCOUNT_DB_SECTIONS catch-all bucket, not a real OCR section —
  // skip it so we don't accidentally inherit 자본/기타 from a seed match.
  if (!trimmed || trimmed === "기타") return { 대분류: "", 중분류: "" };
  const byMiddle = CLASSIFICATION_ENTRIES.find((e) => e.중분류 === trimmed);
  if (byMiddle) return { 대분류: byMiddle.대분류, 중분류: byMiddle.중분류 };
  const byMajor = CLASSIFICATION_ENTRIES.find((e) => e.대분류 === trimmed);
  if (byMajor) return { 대분류: byMajor.대분류, 중분류: byMajor.중분류 };
  return { 대분류: "", 중분류: "" };
}

function formatRowSources(sources: ClassificationTableRow["sources"]): string {
  if (!sources.length) return "";
  const fmt = (s: { companyName: string; quarterLabel: string }) => {
    const m = /^(\d{4})-(\d{2})/.exec(s.quarterLabel ?? "");
    const yymm = m ? `${m[1].slice(2)}${m[2]}` : (s.quarterLabel ?? "");
    return `${s.companyName}${yymm}`;
  };
  const first = sources.slice(0, 3).map(fmt).join(", ");
  return sources.length > 3 ? `${first} 외 ${sources.length - 3}건` : first;
}

type SortField = "code" | "대분류" | "중분류" | "소분류" | "세분류" | "항목명" | "occurrences";
type SortDir = "asc" | "desc";

type EditableDraft = {
  대분류: string;
  중분류: string;
  소분류: string;
  세분류: string;
  sign: 0 | 1;
};

// Build dropdown options derived from the seed catalog
type ClassificationOptions = {
  대분류_OPTIONS: string[];
  중분류_BY_대: Map<string, string[]>;
  소분류_BY_대중: Map<string, string[]>;
  세분류_BY_대중소: Map<string, Array<{ 세분류: string; code: number; sign: 0 | 1 }>>;
};

// Build once at module load — seed data is immutable per build.
let _cachedOptions: ClassificationOptions | null = null;
function getClassificationOptions(): ClassificationOptions {
  if (!_cachedOptions) _cachedOptions = buildClassificationOptions();
  return _cachedOptions;
}

// Same idea for the seed-only portion of table rows (everything except live OCR occurrences).
// We cache the seed rows and only attach occurrences per render.
function buildClassificationOptions(): ClassificationOptions {
  const 대Set = new Set<string>();
  const 중Map = new Map<string, Set<string>>();
  const 소Map = new Map<string, Set<string>>();
  const 세Map = new Map<string, Array<{ 세분류: string; code: number; sign: 0 | 1 }>>();

  for (const e of CLASSIFICATION_ENTRIES) {
    if (!e.대분류) continue;
    대Set.add(e.대분류);
    const k중 = e.대분류;
    if (!중Map.has(k중)) 중Map.set(k중, new Set());
    if (e.중분류) 중Map.get(k중)!.add(e.중분류);

    const k소 = `${e.대분류}|${e.중분류}`;
    if (!소Map.has(k소)) 소Map.set(k소, new Set());
    if (e.소분류) 소Map.get(k소)!.add(e.소분류);

    const k세 = `${e.대분류}|${e.중분류}|${e.소분류}`;
    if (!세Map.has(k세)) 세Map.set(k세, []);
    세Map.get(k세)!.push({ 세분류: e.세분류, code: e.code, sign: e.sign });
  }

  return {
    대분류_OPTIONS: Array.from(대Set).sort((a, b) => a.localeCompare(b, "ko")),
    중분류_BY_대: new Map(Array.from(중Map.entries()).map(([k, v]) => [k, Array.from(v).sort((a, b) => a.localeCompare(b, "ko"))])),
    소분류_BY_대중: new Map(Array.from(소Map.entries()).map(([k, v]) => [k, Array.from(v).sort((a, b) => a.localeCompare(b, "ko"))])),
    세분류_BY_대중소: new Map(Array.from(세Map.entries()).map(([k, v]) => [k, v.slice().sort((a, b) => a.code - b.code)]))
  };
}

// Validate a draft against the seed tree.
// Returns the matched ClassificationEntry (code+sign), or an error message.
function validateDraft(draft: EditableDraft, options: ClassificationOptions): { entry: { code: number; sign: 0 | 1 } | null; error: string | null } {
  if (!draft.대분류) return { entry: null, error: "대분류를 선택하세요" };
  if (!options.대분류_OPTIONS.includes(draft.대분류)) return { entry: null, error: "유효하지 않은 대분류" };

  if (!draft.중분류) return { entry: null, error: "중분류를 선택하세요" };
  const 중List = options.중분류_BY_대.get(draft.대분류) ?? [];
  if (!중List.includes(draft.중분류)) return { entry: null, error: `${draft.대분류} 안에 없는 중분류` };

  if (!draft.소분류) return { entry: null, error: "소분류를 선택하세요" };
  const 소List = options.소분류_BY_대중.get(`${draft.대분류}|${draft.중분류}`) ?? [];
  if (!소List.includes(draft.소분류)) return { entry: null, error: `${draft.대분류} > ${draft.중분류} 안에 없는 소분류` };

  if (!draft.세분류) return { entry: null, error: "세분류를 선택하세요" };
  const 세List = options.세분류_BY_대중소.get(`${draft.대분류}|${draft.중분류}|${draft.소분류}`) ?? [];
  // Match by 세분류 name AND sign — same name can exist with both + and − (e.g. 매출채권 / 매출채권_대손충당금)
  const matched = 세List.find((e) => e.세분류 === draft.세분류 && e.sign === draft.sign);
  if (!matched) {
    const available = 세List.find((e) => e.세분류 === draft.세분류);
    if (available) return { entry: null, error: `세분류 부호 불일치 (선택한 부호 ${draft.sign === 1 ? "−" : "+"})` };
    return { entry: null, error: `${draft.소분류} 안에 없는 세분류` };
  }
  return { entry: matched, error: null };
}

function compareRows(a: ClassificationTableRow, b: ClassificationTableRow, field: SortField, dir: SortDir): number {
  const sign = dir === "asc" ? 1 : -1;
  if (field === "code" || field === "occurrences") {
    return ((a[field] as number) - (b[field] as number)) * sign;
  }
  return String(a[field] ?? "").localeCompare(String(b[field] ?? ""), "ko") * sign;
}

type AliasOverride = {
  // Destination seed entry (validated)
  code: number;
  대분류: string;
  중분류: string;
  소분류: string;
  세분류: string;
  sign: 0 | 1;
};

function ClassificationTableViewInner({
  accountEntries,
  catalog,
  onOverridesChange,
  initialFilters
}: {
  accountEntries: SectionAccountDbEntry[];
  catalog: ClassificationCatalogGroup[];
  onOverridesChange?: (overrides: Map<string, AliasOverride>) => void;
  initialFilters?: { showOnlyUnclassified?: boolean; showOnlyEncountered?: boolean };
}) {
  const baseRows = useMemo(() => buildClassificationTableRows(accountEntries, catalog), [accountEntries, catalog]);
  const options = useMemo(() => getClassificationOptions(), []);
  const [overrides, setOverrides] = useState<Map<string, AliasOverride>>(new Map());

  // Apply overrides on top of baseRows
  const allRows = useMemo(() => {
    if (!overrides.size) return baseRows;
    return baseRows.map((row) => {
      const ov = overrides.get(row.항목명);
      if (!ov) return row;
      return {
        ...row,
        code: ov.code,
        대분류: ov.대분류,
        중분류: ov.중분류,
        소분류: ov.소분류,
        세분류: ov.세분류,
        sign: ov.sign,
        isUnclassified: false
      };
    });
  }, [baseRows, overrides]);

  const [search, setSearch] = useState("");
  const [sortField, setSortField] = useState<SortField>("code");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [pageSize, setPageSize] = useState(50);
  const [page, setPage] = useState(0);
  const [showOnlyUnclassified, setShowOnlyUnclassified] = useState(initialFilters?.showOnlyUnclassified ?? false);
  const [showOnlyEncountered, setShowOnlyEncountered] = useState(initialFilters?.showOnlyEncountered ?? false);

  // Bulk-edit mode: 토글로 편집 활성화 → 여러 행 수정 → 일괄 저장/취소.
  // drafts holds the in-progress edits keyed by rowKey; rows not in the map
  // render their saved values. A row is "dirty" iff its draft differs from
  // its current saved/seed value.
  const [editMode, setEditMode] = useState(false);
  const [drafts, setDrafts] = useState<Map<string, EditableDraft>>(new Map());

  function rowToDraft(row: ClassificationTableRow): EditableDraft {
    return {
      대분류: row.대분류,
      중분류: row.중분류,
      소분류: row.소분류,
      세분류: row.세분류,
      sign: row.sign
    };
  }
  function getDraft(row: ClassificationTableRow): EditableDraft {
    return drafts.get(row.rowKey) ?? rowToDraft(row);
  }
  function isDirty(row: ClassificationTableRow): boolean {
    const d = drafts.get(row.rowKey);
    if (!d) return false;
    return (
      d.대분류 !== row.대분류
      || d.중분류 !== row.중분류
      || d.소분류 !== row.소분류
      || d.세분류 !== row.세분류
      || d.sign !== row.sign
    );
  }
  function updateDraft(row: ClassificationTableRow, partial: Partial<EditableDraft>) {
    setDrafts((prev) => {
      const next = new Map(prev);
      const current = next.get(row.rowKey) ?? rowToDraft(row);
      next.set(row.rowKey, { ...current, ...partial });
      return next;
    });
  }
  function discardRowDraft(rowKey: string) {
    setDrafts((prev) => {
      if (!prev.has(rowKey)) return prev;
      const next = new Map(prev);
      next.delete(rowKey);
      return next;
    });
  }
  function enterEditMode() {
    setEditMode(true);
    setDrafts(new Map());
  }
  function exitEditMode() {
    setEditMode(false);
    setDrafts(new Map());
  }
  function saveAllDrafts() {
    const next = new Map(overrides);
    let saved = 0;
    const failures: Array<{ name: string; error: string }> = [];
    for (const [rowKey, draft] of drafts.entries()) {
      const row = allRows.find((r) => r.rowKey === rowKey);
      if (!row) continue;
      // skip rows whose draft equals the saved value (no actual change)
      if (!isDirty(row)) continue;
      const result = validateDraft(draft, options);
      if (!result.entry) {
        failures.push({ name: row.항목명, error: result.error ?? "유효하지 않은 분류" });
        continue;
      }
      next.set(row.항목명, {
        code: result.entry.code,
        대분류: draft.대분류,
        중분류: draft.중분류,
        소분류: draft.소분류,
        세분류: draft.세분류,
        sign: result.entry.sign
      });
      saved++;
    }
    if (saved > 0) {
      setOverrides(next);
      onOverridesChange?.(next);
    }
    // Stay in edit mode if anything failed so the user can finish the
    // incomplete row(s) — otherwise the partial pick is silently lost.
    if (failures.length > 0) {
      const shown = failures.slice(0, 10).map((f) => `• ${f.name}: ${f.error}`).join("\n");
      const extra = failures.length > 10 ? `\n...외 ${failures.length - 10}건` : "";
      const savedNote = saved > 0 ? `\n\n${saved}개 행은 정상 저장되었습니다.` : "";
      window.alert(`${failures.length}개 행이 분류 미완성으로 저장되지 않았습니다 (대/중/소/세 모두 선택 필요):\n${shown}${extra}${savedNote}`);
      return;
    }
    setEditMode(false);
    setDrafts(new Map());
  }
  function revertOverride(itemName: string) {
    if (!overrides.has(itemName)) return;
    const next = new Map(overrides);
    next.delete(itemName);
    setOverrides(next);
    onOverridesChange?.(next);
  }

  // Defer heavy filtering until typing pauses so the input stays responsive.
  const deferredSearch = useDeferredValue(search);
  const deferredShowOnlyUnclassified = useDeferredValue(showOnlyUnclassified);
  const deferredShowOnlyEncountered = useDeferredValue(showOnlyEncountered);

  const filtered = useMemo(() => {
    const q = deferredSearch.trim().toLowerCase();
    return allRows.filter((row) => {
      if (deferredShowOnlyUnclassified && !row.isUnclassified) return false;
      if (deferredShowOnlyEncountered && row.occurrences === 0) return false;
      if (!q) return true;
      return (
        String(row.code).includes(q)
        || row.대분류.toLowerCase().includes(q)
        || row.중분류.toLowerCase().includes(q)
        || row.소분류.toLowerCase().includes(q)
        || row.세분류.toLowerCase().includes(q)
        || row.항목명.toLowerCase().includes(q)
      );
    });
  }, [allRows, deferredSearch, deferredShowOnlyUnclassified, deferredShowOnlyEncountered]);

  const sorted = useMemo(() => {
    return filtered.slice().sort((a, b) => compareRows(a, b, sortField, sortDir));
  }, [filtered, sortField, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = sorted.slice(safePage * pageSize, (safePage + 1) * pageSize);

  function toggleSort(field: SortField) {
    if (sortField === field) {
      setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir(field === "occurrences" ? "desc" : "asc");
    }
    setPage(0);
  }

  function arrow(field: SortField): string {
    if (sortField !== field) return "";
    return sortDir === "asc" ? " ▲" : " ▼";
  }

  const unclassifiedCount = allRows.filter((r) => r.isUnclassified).length;
  const encounteredCount = allRows.filter((r) => r.occurrences > 0 && !r.isUnclassified).length;
  const dirtyCount = useMemo(() => {
    if (!editMode || !drafts.size) return 0;
    let n = 0;
    for (const row of allRows) {
      if (isDirty(row)) n++;
    }
    return n;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRows, drafts, editMode]);

  return (
    <div className="classification-table-view">
      <div className="classification-table-toolbar">
        <input
          className="input"
          placeholder="코드/이름/항목명 검색"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(0); }}
          style={{ minWidth: 240, flex: "0 1 320px" }}
        />
        <label className="filter-chip">
          <input type="checkbox" checked={showOnlyEncountered} onChange={(e) => { setShowOnlyEncountered(e.target.checked); setPage(0); }} />
          OCR ({encounteredCount})
        </label>
        <label className="filter-chip">
          <input type="checkbox" checked={showOnlyUnclassified} onChange={(e) => { setShowOnlyUnclassified(e.target.checked); setPage(0); }} />
          미분류만 ({unclassifiedCount})
        </label>
        <span className="muted" style={{ marginLeft: "auto", fontSize: 12 }}>
          전체 {allRows.length.toLocaleString()} · 필터 후 {sorted.length.toLocaleString()}
        </span>
        {editMode ? (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span className="muted" style={{ fontSize: 12 }}>
              {dirtyCount > 0 ? `${dirtyCount}개 행 수정됨` : "수정사항 없음"}
            </span>
            <button type="button" className="ghost-button" onClick={exitEditMode}>변경사항 취소</button>
            <button type="button" className="button" disabled={dirtyCount === 0} onClick={saveAllDrafts}>
              수정사항 업데이트{dirtyCount > 0 ? ` (${dirtyCount})` : ""}
            </button>
          </div>
        ) : (
          <button type="button" className="ghost-button" onClick={enterEditMode}>편집모드</button>
        )}
      </div>
      {editMode && (
        <div className="muted" style={{ fontSize: 12, padding: "6px 12px", background: "#fffbeb", borderRadius: 6 }}>
          편집모드입니다. 셀의 드롭다운을 바꾸면 행이 노란색으로 강조됩니다. 변경 후 「수정사항 업데이트」를 눌러야 분류DB에 저장됩니다.
        </div>
      )}

      <div className="classification-table-scroll">
        <table className="table report-table classification-flat-table">
          <thead>
            <tr>
              <th onClick={() => toggleSort("code")} className="sortable">코드{arrow("code")}</th>
              <th onClick={() => toggleSort("대분류")} className="sortable">대분류{arrow("대분류")}</th>
              <th onClick={() => toggleSort("중분류")} className="sortable">중분류{arrow("중분류")}</th>
              <th onClick={() => toggleSort("소분류")} className="sortable">소분류{arrow("소분류")}</th>
              <th onClick={() => toggleSort("세분류")} className="sortable">세분류{arrow("세분류")}</th>
              <th onClick={() => toggleSort("항목명")} className="sortable">항목명{arrow("항목명")}</th>
              <th>부호</th>
              <th>출처</th>
              <th>편집</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row) => {
              const hasOverride = overrides.has(row.항목명);
              const dirty = editMode && isDirty(row);
              const rowClass = `${row.isUnclassified ? "row-unclassified" : ""}${row.occurrences > 0 && !row.isUnclassified ? " row-encountered" : ""}${hasOverride ? " row-override" : ""}${dirty ? " row-modified" : ""}`.trim();

              if (editMode) {
                const draft = getDraft(row);
                const validation = validateDraft(draft, options);
                const 중Options = options.중분류_BY_대.get(draft.대분류) ?? [];
                const 소Options = options.소분류_BY_대중.get(`${draft.대분류}|${draft.중분류}`) ?? [];
                const 세Options = options.세분류_BY_대중소.get(`${draft.대분류}|${draft.중분류}|${draft.소분류}`) ?? [];
                const 세Names = Array.from(new Set(세Options.map((x) => x.세분류))).sort((a, b) => a.localeCompare(b, "ko"));
                const dirtyStyle = dirty ? { background: "#fef3c7" } : undefined;
                return (
                  <Fragment key={row.rowKey}>
                    <tr className={rowClass} style={dirtyStyle}>
                      <td className="cell-code">{validation.entry ? validation.entry.code : (row.code === UNCLASSIFIED_ROW_CODE ? "—" : row.code)}</td>
                      <td>
                        <select className="select cell-select" value={draft.대분류} onChange={(e) => updateDraft(row, { 대분류: e.target.value, 중분류: "", 소분류: "", 세분류: "", sign: 0 })}>
                          <option value="">선택</option>
                          {options.대분류_OPTIONS.map((x) => <option key={x} value={x}>{x}</option>)}
                        </select>
                      </td>
                      <td>
                        <select className="select cell-select" value={draft.중분류} disabled={!draft.대분류} onChange={(e) => updateDraft(row, { 중분류: e.target.value, 소분류: "", 세분류: "" })}>
                          <option value="">선택</option>
                          {중Options.map((x) => <option key={x} value={x}>{x}</option>)}
                        </select>
                      </td>
                      <td>
                        <select className="select cell-select" value={draft.소분류} disabled={!draft.중분류} onChange={(e) => updateDraft(row, { 소분류: e.target.value, 세분류: "" })}>
                          <option value="">선택</option>
                          {소Options.map((x) => <option key={x} value={x}>{x}</option>)}
                        </select>
                      </td>
                      <td>
                        <select className="select cell-select" value={draft.세분류} disabled={!draft.소분류} onChange={(e) => {
                          const name = e.target.value;
                          const first = 세Options.find((x) => x.세분류 === name);
                          updateDraft(row, { 세분류: name, sign: first ? first.sign : draft.sign });
                        }}>
                          <option value="">선택</option>
                          {세Names.map((x) => <option key={x} value={x}>{x}</option>)}
                        </select>
                      </td>
                      <td className="cell-name">{row.항목명}{hasOverride && <span className="override-tag">수정됨</span>}</td>
                      <td>
                        <select className="select cell-select-narrow" value={String(draft.sign)} onChange={(e) => updateDraft(row, { sign: Number(e.target.value) as 0 | 1 })}>
                          <option value="0">+</option>
                          <option value="1">−</option>
                        </select>
                      </td>
                      <td className="cell-source">{formatRowSources(row.sources)}</td>
                      <td className="cell-actions">
                        {dirty && <button type="button" className="ghost-button button-tiny" onClick={() => discardRowDraft(row.rowKey)} title="이 행 변경 취소">↺</button>}
                      </td>
                    </tr>
                    {dirty && validation.error && (
                      <tr className="row-validation-error">
                        <td colSpan={9} className="validation-error-cell">⚠️ {validation.error}</td>
                      </tr>
                    )}
                  </Fragment>
                );
              }

              return (
                <tr key={row.rowKey} className={rowClass}>
                  <td className="cell-code">{row.code === UNCLASSIFIED_ROW_CODE ? "—" : row.code}</td>
                  <td>{row.대분류}</td>
                  <td>{row.중분류}</td>
                  <td>{row.소분류 || (row.isUnclassified ? "미분류" : "")}</td>
                  <td>{row.세분류}</td>
                  <td className="cell-name">{row.항목명}{hasOverride && <span className="override-tag">수정됨</span>}</td>
                  <td className={row.sign === 1 ? "cell-sign cell-sign-minus" : "cell-sign cell-sign-plus"}>
                    {row.isUnclassified ? "" : row.sign === 1 ? "−" : "+"}
                  </td>
                  <td className="cell-source">{formatRowSources(row.sources)}</td>
                  <td className="cell-actions">
                    {hasOverride && <button type="button" className="ghost-button button-tiny" onClick={() => revertOverride(row.항목명)} title="원래대로">↺</button>}
                  </td>
                </tr>
              );
            })}
            {pageRows.length === 0 && (
              <tr><td colSpan={9} style={{ textAlign: "center", color: "#9ca3af", padding: 24 }}>표시할 행이 없습니다.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="classification-table-pager">
        <button type="button" className="ghost-button" disabled={safePage === 0} onClick={() => setPage(0)}>« 처음</button>
        <button type="button" className="ghost-button" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>‹ 이전</button>
        <span className="muted" style={{ fontSize: 13 }}>
          {safePage + 1} / {totalPages} 페이지
        </span>
        <button type="button" className="ghost-button" disabled={safePage >= totalPages - 1} onClick={() => setPage(safePage + 1)}>다음 ›</button>
        <button type="button" className="ghost-button" disabled={safePage >= totalPages - 1} onClick={() => setPage(totalPages - 1)}>끝 »</button>
        <select className="select" value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(0); }} style={{ marginLeft: 8 }}>
          <option value={25}>25행</option>
          <option value={50}>50행</option>
          <option value={100}>100행</option>
          <option value={200}>200행</option>
        </select>
      </div>
    </div>
  );
}

// Memoized so the table doesn't re-render when unrelated parent state changes.
export const ClassificationTableView = memo(ClassificationTableViewInner);

/**
 * 결과물DB 표 (4-1 탭). 사용자가 만든 엑셀(재무제표 음양.xlsx)을 그대로 가져온
 * result-classification.ts의 632개 entry를 보여줌. 분류DB와 코드(넘버)로 연결됨.
 * 편집 불가 — 엑셀에서 관리.
 */
function ResultClassificationTableView() {
  const [search, setSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState<string>("");
  const deferredSearch = useDeferredValue(search);

  const groupOptions = useMemo(() => {
    return Array.from(RESULT_BY_GROUP.keys()).sort((a, b) => a.localeCompare(b, "ko"));
  }, []);

  const filtered = useMemo(() => {
    const q = deferredSearch.trim().toLowerCase();
    return RESULT_CLASSIFICATION.filter((e) => {
      if (groupFilter && e.group !== groupFilter) return false;
      if (!q) return true;
      return (
        String(e.code).includes(q)
        || e.대분류.toLowerCase().includes(q)
        || e.중분류.toLowerCase().includes(q)
        || e.소분류.toLowerCase().includes(q)
        || e.세분류.toLowerCase().includes(q)
        || (e.group ?? "").toLowerCase().includes(q)
      );
    });
  }, [deferredSearch, groupFilter]);

  return (
    <section className="config-card">
      <div className="classification-table-toolbar">
        <input
          className="input"
          placeholder="코드/이름/묶음 검색"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ minWidth: 240, flex: "0 1 320px" }}
        />
        <select className="select" value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)} style={{ minWidth: 180 }}>
          <option value="">모든 묶음</option>
          {groupOptions.map((g) => (
            <option key={g} value={g}>{g} ({RESULT_BY_GROUP.get(g)?.length ?? 0})</option>
          ))}
        </select>
        <span className="muted" style={{ marginLeft: "auto", fontSize: 12 }}>
          전체 {RESULT_CLASSIFICATION.length.toLocaleString()} · 묶음 {RESULT_BY_GROUP.size}개 · 필터 후 {filtered.length.toLocaleString()}
        </span>
      </div>
      <div className="classification-table-scroll">
        <table className="table report-table classification-flat-table">
          <thead>
            <tr>
              <th>코드</th>
              <th>대분류</th>
              <th>중분류</th>
              <th>소분류</th>
              <th>세분류</th>
              <th>부호</th>
              <th>묶음</th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, 200).map((e) => (
              <tr key={e.code}>
                <td className="cell-code">{e.code}</td>
                <td>{e.대분류}</td>
                <td>{e.중분류}</td>
                <td>{e.소분류 || ""}</td>
                <td>{e.세분류}</td>
                <td className={e.sign === 1 ? "cell-sign cell-sign-minus" : "cell-sign cell-sign-plus"}>
                  {e.sign === 1 ? "−" : "+"}
                </td>
                <td>{e.group ?? ""}</td>
              </tr>
            ))}
            {filtered.length > 200 && (
              <tr><td colSpan={7} style={{ textAlign: "center", color: "#9ca3af", padding: 12 }}>
                상위 200건만 표시 — 검색·필터로 좁혀주세요 (전체 {filtered.length.toLocaleString()}건)
              </td></tr>
            )}
            {filtered.length === 0 && (
              <tr><td colSpan={7} style={{ textAlign: "center", color: "#9ca3af", padding: 24 }}>표시할 행이 없습니다.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// Top-level tree view with expand-all / collapse-all controls.
export function ClassificationTreeView({
  accountEntries
}: {
  accountEntries: SectionAccountDbEntry[];
}) {
  const tree = useMemo(() => buildClassificationTree(accountEntries), [accountEntries]);
  // Default: top-level (대분류) expanded so user sees structure at a glance
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const init = new Set<string>();
    for (const node of tree) {
      if (node.kind === "branch") init.add(node.nodeId);
    }
    return init;
  });

  function toggle(nodeId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }

  function collectAllIds(nodes: ClassificationTreeNode[], acc: Set<string>) {
    for (const n of nodes) {
      acc.add(n.nodeId);
      if (n.kind === "branch") collectAllIds(n.children, acc);
    }
  }

  function expandAll() {
    const all = new Set<string>();
    collectAllIds(tree, all);
    setExpanded(all);
  }

  function collapseAll() {
    setExpanded(new Set());
  }

  const totalLeaves = tree.reduce((acc, n) => acc + (n.kind === "branch" ? n.leafCount : 1), 0);
  const totalEncountered = tree.reduce((acc, n) => acc + (n.kind === "branch" ? n.encounteredCount : n.encounteredCount), 0);

  return (
    <div className="classification-tree">
      <div className="classification-tree-controls">
        <span className="soft-badge">세분류 {totalLeaves}</span>
        <span className="soft-badge">등장 {totalEncountered}</span>
        <div className="inline-actions" style={{ marginLeft: "auto" }}>
          <button type="button" className="ghost-button" onClick={expandAll}>전체 펼치기</button>
          <button type="button" className="ghost-button" onClick={collapseAll}>전체 접기</button>
        </div>
      </div>
      <ul className="tree-root">
        {tree.map((node) => (
          <ClassificationTreeNodeView
            key={node.nodeId}
            node={node}
            expanded={expanded}
            onToggle={toggle}
            depth={0}
          />
        ))}
      </ul>
    </div>
  );
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

    if (["인건비", "연구개발비", "광고선전비", "접대비", "복리후생비", "지급수수료", "외주용역비", "임차료", "변동비"].includes(inferredKey)) {
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
  const [sheetsSyncState, setSheetsSyncState] = useState<{ status: "idle" | "syncing" | "ok" | "error" | "disabled"; message?: string }>({ status: "idle" });
  const sheetsAutoSyncInitializedRef = useRef(false);
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
  const [parentAliasRows, setParentAliasRows] = useState<Array<{ parent: string; aliases: string }>>(
    () => Object.entries(DEFAULT_LOGIC_CONFIG.parentAliases ?? {}).map(([parent, aliases]) => ({
      parent,
      aliases: aliases.filter((a) => a !== parent).join(", ")
    }))
  );
  const [classificationHistory, setClassificationHistory] = useState<ClassificationCatalogGroup[][]>([]);
  const [configRulesHistory, setConfigRulesHistory] = useState<ConfigRulesSnapshot[]>([]);
  const configRulesSnapshotPendingRef = useRef(false);
  const [classificationSyncMessage, setClassificationSyncMessage] = useState<string | null>(null);
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
  const [statementType, setStatementType] = useState<"별도" | "연결">("별도");
  const [classificationSaveState, setClassificationSaveState] = useState<"idle" | "saved">("idle");
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
        const remotePersisted = parsePersistedState(JSON.stringify(remote.config));
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
      const payload = buildSheetsSyncPayload(savedDatasets, classificationGroups);
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
        classificationCatalog
      }),
    [pastedText, selectedCompany, tolerance, logicConfig, companyConfigs, pasteEdits, nameEdits, sessionSignFixes, classificationCatalog]
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
        classificationCatalog,
        pasteEdits,
        nameEdits,
        sessionSignFixes
      };
      return buildReportingModel(reportArgs);
    },
    [pastedText, selectedCompany, tolerance, logicConfig, companyConfigs, classificationGroups, classificationCatalog, pasteEdits, nameEdits, sessionSignFixes]
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

  // Stable callback so ClassificationTableView memo isn't broken by inline closures.
  const handleClassificationOverrides = useCallback((overrides: Map<string, AliasOverride>) => {
    if (!overrides.size) return;
    const nextCatalog = applyAliasOverridesToCatalog(classificationCatalog, overrides);
    applyClassificationCatalog(nextCatalog, true);
  }, [classificationCatalog]);

  /**
   * One-click "분류DB에 영구 반영" from the validation diagnosis card.
   * Locates the seed pair (same 세분류 with opposite sign) and moves the alias
   * to the correctly-signed entry. Then persists via the standard catalog flow.
   */
  function applySeedFix(_sect: string, acct: string, newSign: SignCode) {
    if (newSign === 2) {
      window.alert("'제외' 부호는 분류DB에 박을 수 없습니다. 회사별 규칙으로 처리하세요.");
      return;
    }
    const current = findEntryByAlias(acct);
    if (!current) {
      window.alert(`'${acct}'은(는) 분류DB에 없는 항목입니다.\n먼저 4. 분류DB 탭에서 추가/분류해주세요.`);
      return;
    }
    if (current.sign === newSign) return;

    // Locate paired code (same 세분류 with opposite sign). Code suffix layout:
    // positive at xxxx000, negative at xxxx100 — toggle by ±100.
    const pairedCode = newSign === 1 ? current.code + 100 : current.code - 100;
    const paired = CLASSIFICATION_ENTRIES.find((e) => e.code === pairedCode && e.sign === newSign);
    if (!paired) {
      window.alert(`'${acct}'은(는) 분류DB에 반대 부호 짝이 없어 자동 반영할 수 없습니다.\n4. 분류DB 탭에서 수동으로 처리해주세요.`);
      return;
    }

    const overrides = new Map<string, AliasOverride>();
    overrides.set(acct, {
      code: paired.code,
      대분류: paired.대분류,
      중분류: paired.중분류,
      소분류: paired.소분류,
      세분류: paired.세분류,
      sign: paired.sign
    });
    const nextCatalog = applyAliasOverridesToCatalog(classificationCatalog, overrides);
    applyClassificationCatalog(nextCatalog, true);
    applySessionFix(_sect, acct, newSign); // also reflect immediately in current validation
  }

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
        classificationGroups,
        classificationCatalog,
        pasteEdits: prev,
        nameEdits,
        sessionSignFixes
      });
      return JSON.stringify(normalized) !== JSON.stringify(prev) ? normalized : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pastedText, selectedCompany, logicConfig, companyConfigs, classificationGroups, classificationCatalog, nameEdits, sessionSignFixes]);

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
      classificationGroups,
      classificationCatalog,
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
      const sheetsPayload = buildSheetsSyncPayload(nextSaved, classificationGroups);
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
      const payload = buildSheetsSyncPayload(savedDatasets, classificationGroups);
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
      classificationGroups,
      classificationCatalog,
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
      classificationGroups,
      classificationCatalog,
      pasteEdits: prev,
      nameEdits,
      sessionSignFixes: nextSessionSignFixes
    }));

    // Also try to persist into the classification DB so the change isn't lost
    // on the next validation. Silent on failure (no seed pair exists for this alias)
    // — the session fix above still keeps the current validation passing.
    if (nextSign === 0 || nextSign === 1) {
      const current = findEntryByAlias(acct, sect);
      if (current && current.sign !== nextSign) {
        const pairedCode = nextSign === 1 ? current.code + 100 : current.code - 100;
        const paired = CLASSIFICATION_ENTRIES.find((e) => e.code === pairedCode && e.sign === nextSign);
        if (paired) {
          const overrides = new Map<string, AliasOverride>();
          overrides.set(acct, {
            code: paired.code,
            대분류: paired.대분류,
            중분류: paired.중분류,
            소분류: paired.소분류,
            세분류: paired.세분류,
            sign: paired.sign
          });
          const nextCatalog = applyAliasOverridesToCatalog(classificationCatalog, overrides);
          applyClassificationCatalog(nextCatalog, false);
        }
      }
    }
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
      // Explicit save → also re-sync stored datasets so their signs follow
      // the new 분류DB without the user having to re-open and re-save each one.
      void syncStoredDatasetsToClassificationDB(clonedCatalog, nextGroups);
    }
  }

  /**
   * Re-build every saved dataset's statement rows against the current 분류DB
   * and push only the ones whose signs actually changed back to Supabase.
   * No-op when nothing changes.
   *
   * Chunked + yielded so a large dataset list doesn't lock the main thread
   * (each buildQuarterSnapshots call re-parses the paste). Progress shows in
   * the hero; the rest of the UI stays interactive in the meantime.
   */
  async function syncStoredDatasetsToClassificationDB(
    catalogOverride?: ClassificationCatalogGroup[],
    groupsOverride?: ClassificationGroups,
    forceAll: boolean = false,
    logicConfigOverride?: LogicConfig,
    companyConfigsOverride?: CompanyConfigs
  ) {
    if (!savedDatasets.length) return;
    const effectiveCatalog = catalogOverride ?? classificationCatalog;
    const effectiveGroups = groupsOverride ?? classificationGroups;
    const effectiveLogicConfig = logicConfigOverride ?? logicConfig;
    const effectiveCompanyConfigs = companyConfigsOverride ?? companyConfigs;
    const total = savedDatasets.length;
    const changedSnapshots: SavedQuarterSnapshot[] = [];
    const yieldToMain = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    const CHUNK = 5;

    setClassificationSyncMessage(`저장 데이터 동기화 중... 0 / ${total}`);

    for (let i = 0; i < total; i += CHUNK) {
      const slice = savedDatasets.slice(i, i + CHUNK);
      for (const dataset of slice) {
        const fresh = buildQuarterSnapshots({
          pastedText: dataset.source.pastedText,
          selectedCompany: dataset.companyName,
          tolerance: dataset.source.tolerance ?? 0,
          logicConfig: effectiveLogicConfig,
          companyConfigs: effectiveCompanyConfigs,
          classificationGroups: effectiveGroups,
          classificationCatalog: effectiveCatalog,
          pasteEdits: dataset.source.pasteEdits ?? {},
          nameEdits: dataset.source.nameEdits ?? {},
          sessionSignFixes: {},
          statementType: dataset.source.statementType
        });
        const matched = fresh.find((s) => s.id === dataset.id);
        if (!matched) continue;
        const changed =
          forceAll
          || matched.adjustedStatementRows.length !== dataset.adjustedStatementRows.length
          || matched.adjustedStatementRows.some((newRow, idx) => {
            const oldRow = dataset.adjustedStatementRows[idx];
            // 부호 변화뿐 아니라 code 변화도 동기화 대상 — 옛 데이터(code 없음)에
            // code를 채우는 1회 마이그레이션이 이 비교로 트리거된다.
            return !oldRow
              || oldRow.signFlag !== newRow.signFlag
              || (oldRow.code ?? null) !== (newRow.code ?? null);
          });
        if (changed) changedSnapshots.push(matched);
      }
      const done = Math.min(i + CHUNK, total);
      setClassificationSyncMessage(`저장 데이터 동기화 중... ${done} / ${total}`);
      // Hand the main thread back so clicks/scroll stay responsive.
      await yieldToMain();
    }

    if (!changedSnapshots.length) {
      setClassificationSyncMessage(null);
      return;
    }

    try {
      // 변경된 스냅샷을 한 번에 PUT하면 payload가 커서 413으로 실패한다.
      // 작은 배치로 나눠 보내 — 각 PUT은 부분 배열만 upsert하고,
      // 응답은 항상 전체 datasets라 마지막 응답을 최종 상태로 쓴다.
      const PUT_CHUNK = 5;
      let latest: ReturnType<typeof parseDatasetApiResponse> | null = null;
      for (let i = 0; i < changedSnapshots.length; i += PUT_CHUNK) {
        const batch = changedSnapshots.slice(i, i + PUT_CHUNK);
        const done = Math.min(i + PUT_CHUNK, changedSnapshots.length);
        setClassificationSyncMessage(`${changedSnapshots.length}개 중 ${done}개 저장 중...`);
        const response = await fetch("/api/datasets", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ snapshots: batch, validatedText: "" })
        });
        if (!response.ok) {
          setClassificationSyncMessage(null);
          return;
        }
        latest = parseDatasetApiResponse(await response.json() as DatasetApiResponse);
      }
      if (latest) {
        setSavedDatasets(latest.datasets);
        setTrashedDatasets(latest.trashedDatasets);
      }
      setClassificationSyncMessage(`분류DB 기준으로 ${changedSnapshots.length}개 저장 데이터를 자동 갱신했습니다.`);
      window.setTimeout(() => setClassificationSyncMessage(null), 5000);
    } catch {
      setClassificationSyncMessage(null);
    }
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
            classificationGroups,
            classificationCatalog,
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
            // pass under the *current* 분류DB?". Historical overrides would
            // hide that.
            sessionSignFixes: {},
            classificationCatalog
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

  // Block the full app until Supabase has handed us the shared catalog +
  // saved datasets — otherwise the user briefly sees an empty/half-built
  // workspace before things pop in.
  if (!mounted || !sharedStateReady) {
    return (
      <main className="workspace-shell" style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "60vh" }}>
        <div style={{ textAlign: "center", maxWidth: 480, padding: 24 }}>
          <span className="hero-eyebrow">KVOCEAN OCR Validator</span>
          <h1 style={{ marginTop: 8, marginBottom: 16 }}>불러오는 중...</h1>
          <p className="muted">
            {sharedStateError
              ? sharedStateError
              : "공용 Supabase 저장소에서 분류DB와 저장 데이터를 가져오고 있습니다. 잠시만 기다려 주세요."}
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
        {classificationSyncMessage ? <p className="save-feedback">{classificationSyncMessage}</p> : null}
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
              <button className={`side-nav-item ${activeTab === "result-db" ? "active" : ""}`} onClick={() => setActiveTab("result-db")}>4-1. 결과물DB</button>
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
                                            {action.fix ? (
                                              <div className="inline-actions" style={{ marginTop: 12 }}>
                                                <button className="button" onClick={() => applySeedFix(action.fix!.sect, action.fix!.acct, action.fix!.newSign)}>분류DB에 영구 반영: {action.label}</button>
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
                    </div>
                    <div className="data-list grouped-data-list">
                      {groupedSavedDatasets.map(([companyName, datasets]) => {
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

          {activeTab === "classify" && (
            <>
              <section className="overview-card report-hero-card">
                <div className="section-title">
                  <div>
                    <span className="section-kicker">분류 기준</span>
                    <h3>5단계 분류 트리 (대 → 중 → 소 → 세 → 항목)</h3>
                    <p className="result-meta">시드 카탈로그(632 세분류) 기준 트리. 노드를 펼쳐 하위 항목을 확인하고, 실제 OCR 등장 항목은 강조됩니다. 미분류 그룹은 맨 밑에 모입니다.</p>
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
                <ClassificationTableView
                  accountEntries={accountDictionaryEntries}
                  catalog={classificationCatalog}
                  onOverridesChange={handleClassificationOverrides}
                />
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
                    <h3>전체 분류 + 미분류 처리</h3>
                    <p className="result-meta">표준 분류 카탈로그를 보고, 새로 들어온 OCR 항목 중 매칭 안 된 것(미분류)을 바로 분류합니다. 상단 `미분류만` 필터로 손볼 항목만 추려서 빠르게 처리 가능. 저장하면 다음 검증부터 자동 적용됩니다.</p>
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
                <ClassificationTableView
                  accountEntries={accountDictionaryEntries}
                  catalog={classificationCatalog}
                  onOverridesChange={handleClassificationOverrides}
                />
              </section>
            </>
          )}

          {activeTab === "result-db" && (
            <>
              <section className="overview-card report-hero-card">
                <div className="section-title">
                  <div>
                    <span className="section-kicker">4-1. 결과물DB</span>
                    <h3>결과물 화면용 분류 트리 + 묶음</h3>
                    <p className="muted" style={{ marginTop: 4 }}>
                      보고서·매트릭스 화면에서 사용하는 분류 트리(영업비용/변동비/고정비 등)와 묶음(인건비, 차입금 등 27개) 정의입니다.
                      OCR 매칭·부호 결정은 4. 분류DB(시드)에서 합니다. 두 DB는 코드(넘버)로 연결됩니다.
                    </p>
                  </div>
                </div>
              </section>
              <ResultClassificationTableView />
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
