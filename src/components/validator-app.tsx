"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import {
  DEFAULT_CLASSIFICATION_GROUPS,
  DEFAULT_COMPANY_CONFIGS,
  DEFAULT_LOGIC_CONFIG,
  LAST_PATCH,
  type ClassificationGroups,
  type CompanyConfigs,
  type LogicConfig,
  type SignCode
} from "@/lib/validation/defaults";
import {
  STORAGE_KEYS,
  buildCopyText,
  diagnoseDiff,
  formatNumber,
  getDefaultPersistedState,
  parsePersistedState,
  pasteEditKey,
  runValidation,
  safeFloat,
  type SessionSignFixes
} from "@/lib/validation/engine";
import {
  buildCompanyReport,
  buildQuarterSnapshots,
  buildReportingModel,
  formatMetricRatio,
  formatMetricValue,
  type FinalMetricRow,
  type MetricCalculationDetail,
  type ReportingModel,
  type SavedQuarterSnapshot,
  type StatementMatrixRow
} from "@/lib/validation/report";

type TabKey = "validate" | "data" | "report" | "config" | "classify" | "formulas";

type OverrideRow = {
  section: string;
  keyword: string;
  sign: SignCode;
};

type ClassificationRow = {
  canonicalKey: string;
  aliases: string;
};

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

function upsertOverrideRow(rows: OverrideRow[], nextRow: OverrideRow) {
  const foundIndex = rows.findIndex((row) => row.section === nextRow.section && row.keyword === nextRow.keyword);
  if (foundIndex === -1) {
    const cleanedRows = rows.filter((row) => row.section.trim() || row.keyword.trim());
    return [...cleanedRows, nextRow];
  }

  return rows.map((row, index) => (index === foundIndex ? nextRow : row));
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

function objectEntriesToRows(record: Record<string, string>): MapRow[] {
  return Object.entries(record).map(([section, parent]) => ({ section, parent }));
}

function overridesToRows(record: Record<string, Record<string, SignCode>>): OverrideRow[] {
  return Object.entries(record).flatMap(([section, items]) =>
    Object.entries(items).map(([keyword, sign]) => ({ section, keyword, sign }))
  );
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

function classificationGroupsToRows(groups: ClassificationGroups): ClassificationRow[] {
  return Object.entries(groups).map(([canonicalKey, aliases]) => ({ canonicalKey, aliases: aliases.join("\n") }));
}

function rowsToClassificationGroups(rows: ClassificationRow[]) {
  return rows.reduce<ClassificationGroups>((acc, row) => {
    const canonicalKey = row.canonicalKey.trim();
    if (!canonicalKey) {
      return acc;
    }
    acc[canonicalKey] = parseKeywordList(row.aliases);
    return acc;
  }, {});
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

function buildFinalSheetRows(reporting: ReportingModel) {
  const rows: Array<Record<string, string | number | null>> = [];
  for (const section of reporting.finalSections) {
    rows.push({ 구분: section.title, 항목: null });
    for (const metric of section.rows) {
      rows.push({
        구분: section.title,
        항목: metric.label,
        ...Object.fromEntries(reporting.periods.flatMap((period) => ([
          [`${period.label} 금액`, metric.amounts[period.key]],
          [`${period.label} 비율`, metric.ratios[period.key]],
          [`${period.label} 증감율`, metric.growthRates[period.key]]
        ])))
      });
    }
    rows.push({ 구분: null, 항목: null });
  }
  return rows;
}

function buildFormulaGuideRows() {
  return [
    { 항목: "런웨이(E)", 계산식: "현금및현금성자산 * 경과월수 / (매출원가 + 판관비 - 감가/상각비)" },
    { 항목: "EBITDA", 계산식: "매출액 - 매출원가 - 판관비 + 감가상각비 + 무형자산상각비 + 사용권자산상각비" },
    { 항목: "유동비율", 계산식: "유동자산 / 유동부채 * 100" },
    { 항목: "당좌비율", 계산식: "(유동자산 - 재고자산) / 유동부채 * 100" },
    { 항목: "부채비율", 계산식: "부채 / 자본 * 100" },
    { 항목: "영업이익률", 계산식: "영업이익 / 매출액 * 100" },
    { 항목: "매출액증가율", 계산식: "(당기 매출액 - 직전 분기 매출액) / |직전 분기 매출액| * 100" }
  ];
}

function buildRequestedFormulaRows() {
  return [
    { 항목: "유동비율", 수식: "(유동자산/유동부채) * 100" },
    { 항목: "당좌비율", 수식: "(당좌자산/유동부채) * 100" },
    { 항목: "부채비율", 수식: "(부채/자본) * 100" },
    { 항목: "차입금 의존도", 수식: "(((차입금_양수) - (차입금_음수))/자산) * 100" },
    { 항목: "이자보상비율", 수식: "영업이익(손실)/이자비용" },
    { 항목: "매출액순이익률", 수식: "(계속사업당기순이익/매출액) * 100" },
    { 항목: "총자산이익률(ROA)", 수식: "(계속사업당기순이익/자산) * 100" },
    { 항목: "자기자본이익률(ROE)", 수식: "(계속사업당기순이익/자본) * 100" },
    { 항목: "영업이익률", 수식: "(영업이익(손실)/매출액) * 100" },
    { 항목: "공헌이익률", 수식: "(매출액 - 변동비)/매출액 * 100" },
    { 항목: "인건비", 수식: "(인건비/(영업비용+영업외비용)) * 100" },
    { 항목: "연구개발비", 수식: "(연구비/(영업비용+영업외비용)) * 100" },
    { 항목: "접대비", 수식: "(접대비/(영업비용+영업외비용)) * 100" },
    { 항목: "복리후생비", 수식: "(복리후생비/(영업비용+영업외비용)) * 100" },
    { 항목: "광고선전비", 수식: "(광고선전비/(영업비용+영업외비용)) * 100" },
    { 항목: "지급수수료", 수식: "(지급수수료/(영업비용+영업외비용)) * 100" },
    { 항목: "외주용역비", 수식: "(외주용역비/(영업비용+영업외비용)) * 100" },
    { 항목: "임차료", 수식: "(임차료/(영업비용+영업외비용)) * 100" },
    { 항목: "이자비용", 수식: "(총이자비용/(영업비용+영업외비용)) * 100" },
    { 항목: "현금및현금성자산", 수식: "(현금및현금성자산/자산) * 100" },
    { 항목: "단기대여금", 수식: "((단기대여금_양수 - 단기대여금_음수)/자산) * 100" },
    { 항목: "개발비(자산)", 수식: "((개발비_양수 - 개발비_음수)/자산) * 100" },
    { 항목: "선급금", 수식: "((선급금_양수 - 선급금_음수)/자산) * 100" },
    { 항목: "가수금", 수식: "(가수금/부채) * 100" },
    { 항목: "가지급금", 수식: "(가지급금/자산) * 100" },
    { 항목: "퇴직급여충당부채", 수식: "((퇴직급여충당부채_양수 + 퇴직급여충당부채_음수)/부채) * 100" },
    { 항목: "총자산회전율", 수식: "매출액 / 평균총자산" },
    { 항목: "매출채권회전율", 수식: "매출액 / 평균매출채권" },
    { 항목: "매출채권회전기간", 수식: "365일 / 매출채권회전율" },
    { 항목: "재고자산회전율", 수식: "매출원가 / 평균재고자산" },
    { 항목: "재고자산회전기간", 수식: "365일 / 재고자산회전율" },
    { 항목: "정상영업순환주기", 수식: "매출채권회전기간 + 재고자산회전기간" },
    { 항목: "매출액 증가율", 수식: "(당기 매출액 - 전기 매출액) / 전기 매출액 * 100" },
    { 항목: "영업이익 증가율", 수식: "(당기 영업이익 - 전기 영업이익) / 전기 영업이익 * 100" },
    { 항목: "매도가능증권", 수식: "(매도가능증권/자산) * 100" },
    { 항목: "런웨이(E)", 수식: "현금및현금성자산 * 2 * 3 / (매출액 - 영업이익(손실) - 감가상각비 - 무형자산상각비 - 사용권자산상각비)" },
    { 항목: "EBITDA", 수식: "영업이익(손실) + 감가상각비 + 무형자산상각비 + 사용권자산상각비" },
    { 항목: "월 평균 지출액", 수식: "(매출액 - 영업이익(손실) + 감가상각비 + 무형자산상각비 + 사용권자산상각비) / 3" }
  ];
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
        logicConfig: cloneLogicConfig((item.source as { logicConfig?: LogicConfig }).logicConfig ?? DEFAULT_LOGIC_CONFIG),
        companyConfigs: cloneCompanyConfigs((item.source as { companyConfigs?: CompanyConfigs }).companyConfigs ?? DEFAULT_COMPANY_CONFIGS),
        classificationGroups: cloneClassificationGroups((item.source as { classificationGroups?: ClassificationGroups }).classificationGroups ?? DEFAULT_CLASSIFICATION_GROUPS),
        sessionSignFixes: cloneSessionSignFixes((item.source as { sessionSignFixes?: SessionSignFixes }).sessionSignFixes ?? {})
      }
    }));
  } catch {
    return [];
  }
}

export function ValidatorApp() {
  const [activeTab, setActiveTab] = useState<TabKey>("validate");
  const [mounted, setMounted] = useState(false);
  const [pastedText, setPastedText] = useState("");
  const [tolerance, setTolerance] = useState(1);
  const [selectedCompany, setSelectedCompany] = useState("");
  const [logicConfig, setLogicConfig] = useState<LogicConfig>(cloneLogicConfig(DEFAULT_LOGIC_CONFIG));
  const [companyConfigs, setCompanyConfigs] = useState<CompanyConfigs>(cloneCompanyConfigs(DEFAULT_COMPANY_CONFIGS));
  const [classificationGroups, setClassificationGroups] = useState<ClassificationGroups>(cloneClassificationGroups(DEFAULT_CLASSIFICATION_GROUPS));
  const [pasteEdits, setPasteEdits] = useState<Record<string, number>>({});
  const [sessionSignFixes, setSessionSignFixes] = useState<SessionSignFixes>({});
  const [globalOverrideRows, setGlobalOverrideRows] = useState<OverrideRow[]>(overridesToRows(DEFAULT_LOGIC_CONFIG.sectionSignOverrides));
  const [companyOverrideRows, setCompanyOverrideRows] = useState<OverrideRow[]>([]);
  const [pasteSectionRows, setPasteSectionRows] = useState<MapRow[]>(objectEntriesToRows(DEFAULT_LOGIC_CONFIG.pasteSectToParent));
  const [classificationRows, setClassificationRows] = useState<ClassificationRow[]>(classificationGroupsToRows(DEFAULT_CLASSIFICATION_GROUPS));
  const [resultOpenState, setResultOpenState] = useState<Record<string, boolean>>({});
  const [savedDatasets, setSavedDatasets] = useState<SavedQuarterSnapshot[]>([]);
  const [selectedDatasetId, setSelectedDatasetId] = useState<string>("");
  const [selectedResultCompany, setSelectedResultCompany] = useState<string>("");
  const [showReportValidation, setShowReportValidation] = useState(false);
  const [expandedReportMetrics, setExpandedReportMetrics] = useState<Record<string, boolean>>({});
  const [classificationSaveState, setClassificationSaveState] = useState<"idle" | "saved">("idle");

  useEffect(() => {
    setMounted(true);
    const persisted = parsePersistedState(window.localStorage.getItem(STORAGE_KEYS.config));
    const saved = parseSavedDatasets(window.localStorage.getItem(STORAGE_KEYS.datasets));
    setLogicConfig(cloneLogicConfig(persisted.logicConfig));
    setCompanyConfigs(cloneCompanyConfigs(persisted.companyConfigs));
    setClassificationGroups(cloneClassificationGroups(persisted.classificationGroups));
    setGlobalOverrideRows(overridesToRows(persisted.logicConfig.sectionSignOverrides));
    setPasteSectionRows(objectEntriesToRows(persisted.logicConfig.pasteSectToParent));
    setClassificationRows(classificationGroupsToRows(persisted.classificationGroups));
    setSavedDatasets(saved);
    if (saved[0]?.id) {
      setSelectedDatasetId(saved[0].id);
      setSelectedResultCompany(saved[0].companyName);
    }
  }, []);

  useEffect(() => {
    if (!mounted) {
      return;
    }
    window.localStorage.setItem(
      STORAGE_KEYS.config,
      JSON.stringify({ logicConfig, companyConfigs, classificationGroups })
    );
  }, [mounted, logicConfig, companyConfigs, classificationGroups]);

  useEffect(() => {
    if (!mounted) {
      return;
    }
    window.localStorage.setItem(STORAGE_KEYS.datasets, JSON.stringify(savedDatasets));
  }, [mounted, savedDatasets]);

  useEffect(() => {
    const autoCompany = runValidation({
      pastedText,
        selectedCompany: selectedCompany || null,
        tolerance,
        logicConfig,
        companyConfigs,
        pasteEdits,
        sessionSignFixes
      }).detectedCompany;

    if (autoCompany && autoCompany !== selectedCompany.trim()) {
      setSelectedCompany(autoCompany);
    }
  }, [pastedText, tolerance, logicConfig, companyConfigs, pasteEdits, sessionSignFixes, selectedCompany]);

  useEffect(() => {
    const company = selectedCompany.trim();
    const rows = overridesToRows(companyConfigs[company]?.sectionSignOverrides ?? {});
    setCompanyOverrideRows(rows.length ? rows : [{ section: "", keyword: "", sign: 0 }]);
  }, [selectedCompany, companyConfigs]);

  const validation = useMemo(
    () =>
      runValidation({
        pastedText,
        selectedCompany: selectedCompany.trim() || null,
        tolerance,
        logicConfig,
        companyConfigs,
        pasteEdits,
        sessionSignFixes
      }),
    [pastedText, selectedCompany, tolerance, logicConfig, companyConfigs, pasteEdits, sessionSignFixes]
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
        sessionSignFixes
      };
      return buildReportingModel(reportArgs);
    },
    [pastedText, selectedCompany, tolerance, logicConfig, companyConfigs, classificationGroups, pasteEdits, sessionSignFixes]
  );

  const companyKnown = selectedCompany.trim() && companyConfigs[selectedCompany.trim()];
  const inputReady = pastedText.trim().length > 0;
  const failedDateCount = Object.values(validation.resultsByDate).filter((items) => items.some((item) => !item.passed)).length;
  const sessionFixCount = countSessionFixes(sessionSignFixes);
  const editedValueCount = Object.keys(pasteEdits).length;
  const previewGroups = useMemo(
    () => buildPreviewGroups(validation.parsed.catRow, validation.parsed.nameRow),
    [validation.parsed.catRow, validation.parsed.nameRow]
  );
  const selectedDataset = useMemo(
    () => savedDatasets.find((item) => item.id === selectedDatasetId) ?? null,
    [savedDatasets, selectedDatasetId]
  );
  const companyDatasetOptions = useMemo(
    () => Array.from(new Set(savedDatasets.map((item) => item.companyName))),
    [savedDatasets]
  );
  const resultSnapshots = useMemo(
    () => savedDatasets.filter((item) => item.companyName === selectedResultCompany),
    [savedDatasets, selectedResultCompany]
  );
  const resultReporting = useMemo(
    () => buildCompanyReport(resultSnapshots, classificationGroups),
    [resultSnapshots, classificationGroups]
  );

  function resetAdjustments() {
    setPasteEdits({});
    setSessionSignFixes({});
  }

  function saveCurrentDataset() {
    if (validation.parsed.error || !reporting.periods.length) {
      return;
    }
    const snapshotArgs = {
      pastedText,
      selectedCompany: selectedCompany.trim() || null,
      tolerance,
      logicConfig,
      companyConfigs,
      classificationGroups,
      pasteEdits,
      sessionSignFixes
    };
    const snapshots = buildQuarterSnapshots(snapshotArgs);

    setSavedDatasets((prev) => {
      const next = [...prev];
      snapshots.forEach((snapshot) => {
        const index = next.findIndex((item) => item.companyName === snapshot.companyName && item.quarterKey === snapshot.quarterKey);
        if (index >= 0) {
          next[index] = snapshot;
        } else {
          next.push(snapshot);
        }
      });
      return sortSavedDatasets(next);
    });
    setSelectedDatasetId(snapshots[0]?.id ?? "");
    setSelectedResultCompany(snapshots[0]?.companyName ?? "");
    setActiveTab("data");
  }

  function loadDatasetIntoValidator(dataset: SavedQuarterSnapshot) {
    setPastedText(dataset.source.pastedText);
    setTolerance(dataset.source.tolerance);
    setSelectedCompany(dataset.companyName);
    setPasteEdits({ ...dataset.source.pasteEdits });
    setSessionSignFixes(cloneSessionSignFixes(dataset.source.sessionSignFixes));
    setLogicConfig(cloneLogicConfig(dataset.source.logicConfig));
    setCompanyConfigs(cloneCompanyConfigs(dataset.source.companyConfigs));
    setClassificationRows(classificationGroupsToRows(classificationGroups));
    setSelectedDatasetId(dataset.id);
    setActiveTab("validate");
  }

  function deleteDataset(datasetId: string) {
    setSavedDatasets((prev) => {
      const next = prev.filter((item) => item.id !== datasetId);
      if (selectedDatasetId === datasetId) {
        setSelectedDatasetId(next[0]?.id ?? "");
      }
      return next;
    });
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

  function applySessionFix(sect: string, acct: string, newSign: SignCode) {
    setSessionSignFixes((prev) => ({
      ...prev,
      [sect]: {
        ...(prev[sect] ?? {}),
        [acct]: newSign
      }
    }));
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
    applySessionFix(sect, acct, nextSign);
  }

  function applyClassificationGroups(nextGroups: ClassificationGroups, showFeedback = false) {
    const clonedGroups = cloneClassificationGroups(nextGroups);
    setClassificationGroups(clonedGroups);
    setClassificationRows(classificationGroupsToRows(clonedGroups));

    if (showFeedback) {
      setClassificationSaveState("saved");
      window.setTimeout(() => setClassificationSaveState("idle"), 1800);
    }
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
      pasteEdits
    );
    navigator.clipboard.writeText(text).catch(() => undefined);
  }

  function exportFinalWorkbook() {
    if (!resultReporting.rawStatementRows.length) {
      return;
    }

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(buildFinalSheetRows(resultReporting)), "최종결과물");
    XLSX.writeFile(workbook, "ocr-validation-final-report.xlsx");
  }

  function toggleReportMetric(metricKey: string) {
    setExpandedReportMetrics((prev) => ({
      ...prev,
      [metricKey]: !prev[metricKey]
    }));
  }

  function resetConfig() {
    const defaults = getDefaultPersistedState();
    setLogicConfig(cloneLogicConfig(defaults.logicConfig));
    setCompanyConfigs(cloneCompanyConfigs(defaults.companyConfigs));
    setClassificationGroups(cloneClassificationGroups(defaults.classificationGroups));
    setGlobalOverrideRows(overridesToRows(defaults.logicConfig.sectionSignOverrides));
    setPasteSectionRows(objectEntriesToRows(defaults.logicConfig.pasteSectToParent));
    setClassificationRows(classificationGroupsToRows(defaults.classificationGroups));
  }

  function saveConfigEditors() {
    setLogicConfig((prev) => ({
      ...prev,
      pasteSectToParent: rowsToMap(pasteSectionRows),
      sectionSignOverrides: rowsToOverrides(globalOverrideRows)
    }));

    const company = selectedCompany.trim();
    if (company) {
      setCompanyConfigs((prev) => ({
        ...prev,
        [company]: {
          ...(prev[company] ?? {}),
          sectionSignOverrides: rowsToOverrides(companyOverrideRows)
        }
      }));
    }

    applyClassificationGroups(rowsToClassificationGroups(classificationRows));
  }

  const configPayload = JSON.stringify({ logicConfig, companyConfigs, classificationGroups }, null, 2);

  function renderMetricCalculationCard(
    label: string,
    kind: "amount" | "ratio" | "growthRate",
    row: FinalMetricRow,
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
            {detail.inputs.map((input) => (
              <div className="metric-detail-input" key={`${kind}-${input.label}`}>
                <span>{input.label}</span>
                <strong>{formatCalculationInputValue(input.value)}</strong>
              </div>
            ))}
          </div>
        )}
        {detail.note ? <p className="metric-detail-note">{detail.note}</p> : null}
      </div>
    );
  }

  return (
    <main className="page-shell">
      <section className="hero">
        <span className="hero-eyebrow">KVOCEAN OCR Validator</span>
        <h1>붙여넣고 바로 확인하는 OCR 검증</h1>
        <div className="hero-meta">
          <span className="pill">1. 텍스트 붙여넣기</span>
          <span className="pill">2. 실패 항목 확인</span>
          <span className="pill">3. 값/부호 바로 수정</span>
        </div>
      </section>

      <section className="summary-strip">
        <article className="summary-card">
          <span className="summary-label">입력 상태</span>
          <strong>{inputReady ? "준비됨" : "대기 중"}</strong>
          <p>{inputReady ? "붙여넣은 데이터를 기준으로 즉시 검증 중" : "왼쪽 입력창에 OCR 3행 텍스트를 넣어 주세요"}</p>
        </article>
        <article className="summary-card">
          <span className="summary-label">실패 묶음</span>
          <strong>{failedDateCount}건</strong>
          <p>날짜별 결과 중 실패 항목이 포함된 묶음 수</p>
        </article>
        <article className="summary-card">
          <span className="summary-label">세션 수정</span>
          <strong>{editedValueCount + sessionFixCount}건</strong>
          <p>값 수정 {editedValueCount}건 / 부호 수정 {sessionFixCount}건</p>
        </article>
        <article className="summary-card">
          <span className="summary-label">최종패치</span>
          <strong>{LAST_PATCH}</strong>
          <p>현재 적용 중인 마지막 패치 시각</p>
        </article>
      </section>

      <section className="layout-grid">
        <aside className="panel sidebar">
          <div className="side-nav-card">
            <span className="section-kicker">메뉴</span>
            <div className="side-nav-list">
              <button className={`side-nav-item ${activeTab === "validate" ? "active" : ""}`} onClick={() => setActiveTab("validate")}>OCR검증</button>
              <button className={`side-nav-item ${activeTab === "config" ? "active" : ""}`} onClick={() => setActiveTab("config")}>검증규칙관리</button>
              <button className={`side-nav-item ${activeTab === "data" ? "active" : ""}`} onClick={() => setActiveTab("data")}>데이터</button>
              <button className={`side-nav-item ${activeTab === "report" ? "active" : ""}`} onClick={() => setActiveTab("report")}>결과물</button>
              <button className={`side-nav-item ${activeTab === "classify" ? "active" : ""}`} onClick={() => setActiveTab("classify")}>분류</button>
              <button className={`side-nav-item ${activeTab === "formulas" ? "active" : ""}`} onClick={() => setActiveTab("formulas")}>수식</button>
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
                  <li>회사명이 자동 감지되면 회사별 부호 규칙을 바로 불러옵니다.</li>
                  <li>값 수정과 부호 수정은 검증 화면에서 바로 반영됩니다.</li>
                </ul>
              </div>
            </>
          ) : (
            <div className="notice input-helper">
              <strong>{activeTab === "data" ? "데이터 안내" : activeTab === "report" ? "결과물 안내" : "보조 기능"}</strong>
              <p className="muted" style={{ marginTop: 8 }}>
                {activeTab === "data"
                  ? `저장된 검증 데이터 ${savedDatasets.length}건이 누적되어 있습니다. 필요한 항목을 선택해 다시 불러오거나 결과물로 보낼 수 있습니다.`
                  : activeTab === "report"
                    ? `${selectedResultCompany ? `${selectedResultCompany} 데이터` : "저장된 데이터"}를 기준으로 결과물을 생성합니다. 먼저 OCR검증에서 저장하기를 누르세요.`
                    : activeTab === "classify"
                      ? "표준 항목별 분류를 카드 형태로 수정할 수 있습니다. 계정명 추가/삭제 후 저장하면 이후 계산에 바로 반영됩니다."
                    : activeTab === "formulas"
                      ? "결과물 계산에 쓰는 기준 수식을 그대로 정리했습니다."
                    : "규칙 관리와 내보내기는 검증 흐름을 지원하는 보조 기능입니다."}
              </p>
            </div>
          )}
        </aside>

        <section className="panel main-panel">
          {activeTab === "validate" && (
            <>
              {!pastedText.trim() && <div className="notice">사이드바에 OCR 3행 텍스트를 붙여넣으면 검증 결과가 나타납니다.</div>}
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
                        <span className="soft-badge">부호 변경 {sessionFixCount}</span>
                        <button className="button" disabled={!reporting.periods.length} onClick={saveCurrentDataset}>저장하기</button>
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
                  </section>

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
                                {name || `열${index}`}
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
                        const isOpen = resultOpenState[cardKey] ?? !result.passed;
                        return (
                          <article className={`result-card ${isOpen ? "" : "collapsed"}`} key={cardKey}>
                            <div className="result-header">
                              <div>
                                <div className={result.passed ? "status-pass" : "status-fail"}>{result.passed ? "통과" : "실패"}</div>
                                <strong>{result.rule}</strong>
                              </div>
                              <div className="result-header-actions">
                                <div className="muted">차이</div>
                                <strong className={result.passed ? "status-pass" : "status-fail"}>{formatNumber(result.diff)}원</strong>
                                <button className="collapse-toggle" onClick={() => toggleResultCard(cardKey, !result.passed)} aria-expanded={isOpen}>
                                  {isOpen ? "접기" : "펼치기"}
                                </button>
                              </div>
                            </div>
                            {isOpen && <div className="result-body">
                              {result.detail.length > 0 ? (
                                <div style={{ overflowX: "auto" }}>
                                  <table className="table">
                                    <thead>
                                      <tr>
                                        <th>계정명</th>
                                        <th>원본값</th>
                                        <th>OCR 수정값</th>
                                        <th>검증 규칙</th>
                                        <th>적용값</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {result.detail.map((detail, index) => {
                                        const currentEditKey = detail._row !== undefined && detail._col !== undefined ? pasteEditKey(detail._row, detail._col) : null;
                                        const currentValue = currentEditKey && pasteEdits[currentEditKey] !== undefined ? pasteEdits[currentEditKey] : detail.원본값;
                                        const currentSign = displayedSignToCode(detail.부호);
                                        return (
                                          <tr key={`${detail.계정명}-${index}`}>
                                            <td>{detail.계정명}</td>
                                            <td>{formatNumber(detail.원본값)}</td>
                                            <td>
                                              {detail._row !== undefined && detail._col !== undefined ? (
                                                <input className="mini-input" type="number" step={1} value={String(currentValue)} onChange={(event) => updateEditableValue(detail._row!, detail._col!, detail.원본값, event.target.value)} />
                                              ) : (
                                                <span className="muted">자동 계산</span>
                                              )}
                                            </td>
                                            <td>
                                              <div className="sign-editor">
                                                <select
                                                  className="mini-select"
                                                  value={String(currentSign)}
                                                  onChange={(event) => updateDetailSign(resultSection, detail.계정명, Number(event.target.value) as SignCode)}
                                                >
                                                  <option value="0">가산(+)</option>
                                                  <option value="1">차감(−)</option>
                                                  <option value="2">제외</option>
                                                </select>
                                                <button
                                                  className="tiny-button"
                                                  disabled={!selectedCompany.trim()}
                                                  onClick={() => saveCompanyFix(resultSection, detail.계정명, currentSign)}
                                                >
                                                  회사별 규칙 저장
                                                </button>
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

                              {result.detail.length > 0 && (
                                <div className="rule-helper muted">
                                  `OCR 수정값`은 복사/내보내기 되는 실제 데이터에 반영됩니다. `검증 규칙`은 이번 검증 해석과 회사별 규칙 저장에만 사용됩니다.
                                </div>
                              )}

                              <div className="two-col">
                                <div className="diagnosis-card">
                                  <strong>합계 비교</strong>
                                  <p className="muted">OCR 합산 {formatNumber(result.computed)}원 / 재무제표 값 {formatNumber(result.parent_val)}원</p>
                                </div>
                                <div className="diagnosis-card">
                                  <strong>누락 계정</strong>
                                  <p className="muted">{result.missing.length ? result.missing.join(", ") : "없음"}</p>
                                </div>
                              </div>

                              {!result.passed && actions.length > 0 && (
                                <div className="diagnosis-card">
                                  <strong>원인 추정과 처리 방향</strong>
                                  <p className="muted diagnosis-note">먼저 `OCR 수정값`을 확인하고, 반복되는 패턴만 `검증 규칙`으로 저장하는 흐름을 권장합니다.</p>
                                  <div className="list-editor" style={{ marginTop: 12 }}>
                                    {actions.map((action, index) => (
                                      <div key={`${action.text}-${index}`} className="notice">
                                        <div className="pre diagnosis-copy">{renderDiagnosisText(action.text)}</div>
                                        {action.fix ? (
                                          <div className="inline-actions" style={{ marginTop: 12 }}>
                                            <button className="secondary-button" onClick={() => applySessionFix(action.fix!.sect, action.fix!.acct, action.fix!.newSign)}>
                                              이번 검증 규칙 적용: {action.label}
                                            </button>
                                            <button className="ghost-button" disabled={!selectedCompany.trim()} onClick={() => saveCompanyFix(action.fix!.sect, action.fix!.acct, action.fix!.newSign)}>
                                              {selectedCompany.trim() ? `[${selectedCompany.trim()}] 회사별 검증 규칙 저장` : "회사명 입력 필요"}
                                            </button>
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
                    <div className="data-list">
                      {savedDatasets.map((dataset) => (
                        <article className={`data-card ${selectedDatasetId === dataset.id ? "selected" : ""}`} key={dataset.id}>
                          <div className="section-title">
                            <div>
                              <strong>{dataset.companyName}</strong>
                              <p className="result-meta">기준 분기 {dataset.quarterLabel} / 저장 시각 {new Date(dataset.savedAt).toLocaleString("ko-KR")}</p>
                            </div>
                            <span className="soft-badge">{dataset.quarterLabel}</span>
                          </div>
                          <div className="inline-actions" style={{ marginTop: 12 }}>
                            <button className="secondary-button" onClick={() => { setSelectedDatasetId(dataset.id); setSelectedResultCompany(dataset.companyName); setActiveTab("report"); }}>결과물 보기</button>
                            <button className="ghost-button" onClick={() => loadDatasetIntoValidator(dataset)}>검증기로 불러오기</button>
                            <button className="danger-button" onClick={() => deleteDataset(dataset.id)}>삭제</button>
                          </div>
                        </article>
                      ))}
                    </div>
                  </section>

                  {selectedDataset && (
                    <section className="report-grid">
                      <article className="config-card">
                        <div className="section-title">
                          <div>
                            <h3>재무제표</h3>
                            <p className="result-meta">선택한 분기의 OCR 수정값 기준 원장</p>
                          </div>
                          <span className="soft-badge">{selectedDataset.quarterLabel}</span>
                        </div>
                        <div className="report-table-wrap">
                          <table className="table report-table">
                            <thead>
                              <tr>
                                <th>양음</th>
                                <th>섹션</th>
                                <th>계정명</th>
                                <th>{selectedDataset.quarterLabel}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {selectedDataset.rawStatementRows.map((row) => (
                                <tr key={`saved-raw-${selectedDataset.id}-${row.section}-${row.accountName}`}>
                                  <td>{row.signFlag}</td>
                                  <td>{row.section}</td>
                                  <td>{row.accountName}</td>
                                  <td>{formatNumber(row.value)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </article>

                      <article className="config-card">
                        <div className="section-title">
                          <div>
                            <h3>재무제표_음양반영</h3>
                            <p className="result-meta">선택한 분기의 검증 규칙 반영 원장</p>
                          </div>
                          <span className="soft-badge">분석 레이어</span>
                        </div>
                        <div className="report-table-wrap">
                          <table className="table report-table">
                            <thead>
                              <tr>
                                <th>양음</th>
                                <th>섹션</th>
                                <th>계정명</th>
                                <th>{selectedDataset.quarterLabel}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {selectedDataset.adjustedStatementRows.map((row) => (
                                <tr key={`saved-adj-${selectedDataset.id}-${row.section}-${row.accountName}`}>
                                  <td>{row.signFlag}</td>
                                  <td>{row.section}</td>
                                  <td>{row.accountName}</td>
                                  <td>{formatNumber(row.value)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </article>
                    </section>
                  )}
                </>
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
                        <button className="button" disabled={!resultReporting?.periods.length} onClick={exportFinalWorkbook}>결과물 Excel 다운로드</button>
                        {companyDatasetOptions.length > 1 && (
                          <select className="select report-company-select" value={selectedResultCompany} onChange={(event) => setSelectedResultCompany(event.target.value)}>
                            {companyDatasetOptions.map((company) => <option key={company} value={company}>{company}</option>)}
                          </select>
                        )}
                        {resultReporting.periods.map((period) => (
                          <span className="soft-badge" key={period.key}>{period.label}</span>
                        ))}
                      </div>
                    </div>
                    <div className="metric-grid compact-metrics">
                      <article className="metric-card"><span className="muted">기간 수</span><strong>{resultReporting.periods.length}</strong></article>
                      <article className="metric-card"><span className="muted">원본 계정</span><strong>{resultReporting.rawStatementRows.length}</strong></article>
                      <article className="metric-card"><span className="muted">지표 섹션</span><strong>{resultReporting.finalSections.length}</strong></article>
                      <article className="metric-card"><span className="muted">저장 데이터</span><strong>{selectedDataset?.companyName ?? "-"}</strong></article>
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
                              {resultReporting.periods.map((period) => (
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
                                  {resultReporting.periods.map((period) => (
                                    <td key={`${row.label}-${period.key}-value`}>
                                      <div className="final-metric-cell">
                                        <strong>{row.label === "런웨이(E)" ? "기간" : "금액"} {formatMetricValue(row, row.amounts[period.key])}</strong>
                                        <span className={`ratio-value ${row.ratios[period.key] === null || row.ratios[period.key] === undefined ? "" : row.ratios[period.key]! < 0 ? "negative" : row.ratios[period.key]! > 0 ? "positive" : ""}`.trim()}>
                                          비율 {formatMetricRatio(row.ratios[period.key])}
                                        </span>
                                        <span className="growth-value">
                                          {row.growthRates[period.key] === null || row.growthRates[period.key] === undefined ? "-" : `전분기 ${row.growthRates[period.key]!.toFixed(1)}%`}
                                        </span>
                                      </div>
                                    </td>
                                  ))}
                                </tr>
                                {showReportValidation && metricExpanded && (
                                  <tr className="final-detail-row">
                                    <td colSpan={resultReporting.periods.length + 1}>
                                      <div className="final-detail-grid">
                                        {resultReporting.periods.map((period) => {
                                          const detail = row.details[period.key] ?? {};
                                          return (
                                            <article className="final-detail-card" key={`${metricKey}-${period.key}`}>
                                              <div className="final-detail-card-head">
                                                <strong>{period.label}</strong>
                                                <span className="soft-badge">계산 근거</span>
                                              </div>
                                              {renderMetricCalculationCard("금액", "amount", row, detail.amount)}
                                              {renderMetricCalculationCard("비율", "ratio", row, detail.ratio)}
                                              {renderMetricCalculationCard("전분기 증감율", "growthRate", row, detail.growthRate)}
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
                  <button className="button" onClick={saveConfigEditors}>편집값 반영</button>
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
                  <h3>회사별 부호 재정의</h3>
                  <p className="muted">회사명을 입력한 뒤 편집하면 브라우저 저장소에 유지됩니다.</p>
                  <div className="list-editor">
                    {companyOverrideRows.map((row, index) => (
                      <div className="override-row" key={`company-override-${index}`}>
                        <input className="input" value={row.section} placeholder="섹션명" onChange={(event) => setCompanyOverrideRows((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, section: event.target.value } : item))} />
                        <input className="input" value={row.keyword} placeholder="계정명 / 키워드" onChange={(event) => setCompanyOverrideRows((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, keyword: event.target.value } : item))} />
                        <select className="select" value={String(row.sign)} onChange={(event) => setCompanyOverrideRows((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, sign: Number(event.target.value) as SignCode } : item))}>
                          <option value="0">가산(+)</option>
                          <option value="1">차감(−)</option>
                          <option value="2">제외</option>
                        </select>
                        <button className="danger-button" onClick={() => setCompanyOverrideRows((prev) => prev.filter((_, itemIndex) => itemIndex !== index))}>삭제</button>
                      </div>
                    ))}
                    <button className="ghost-button" onClick={() => setCompanyOverrideRows((prev) => [...prev, { section: "", keyword: "", sign: 0 }])}>회사 규칙 추가</button>
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
                    <h3>표준 항목 분류</h3>
                    <p className="result-meta">인건비 아래에 급여, 상여, 퇴직급여 같은 하위 계정을 묶어 관리할 수 있게 정리했습니다. 여기서 추가/삭제하면 이후 결과물 계산에 반영됩니다.</p>
                    {classificationSaveState === "saved" && (
                      <p className="save-feedback success">분류를 저장했고, 저장된 결과물도 현재 분류 기준으로 다시 계산했습니다.</p>
                    )}
                  </div>
                  <div className="inline-actions">
                    <button className="ghost-button" onClick={() => setClassificationRows(classificationGroupsToRows(DEFAULT_CLASSIFICATION_GROUPS))}>초안 복원</button>
                    <button className={`button ${classificationSaveState === "saved" ? "is-saved" : ""}`.trim()} onClick={() => applyClassificationGroups(rowsToClassificationGroups(classificationRows), true)}>
                      {classificationSaveState === "saved" ? "분류 저장됨" : "분류 저장"}
                    </button>
                  </div>
                </div>
              </section>

              <section className="classification-grid">
                {classificationRows.map((row, index) => (
                  <article className="config-card classification-card" key={`classification-${index}`}>
                    <div className="section-title">
                      <input
                        className="input"
                        value={row.canonicalKey}
                        placeholder="표준 항목명"
                        onChange={(event) => setClassificationRows((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, canonicalKey: event.target.value } : item))}
                      />
                      <button className="danger-button" onClick={() => setClassificationRows((prev) => prev.filter((_, itemIndex) => itemIndex !== index))}>삭제</button>
                    </div>
                    <label className="field">
                      <span>하위 계정 목록</span>
                      <textarea
                        className="textarea classification-textarea"
                        value={row.aliases}
                        placeholder="급여&#10;상여금&#10;퇴직급여"
                        onChange={(event) => setClassificationRows((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, aliases: event.target.value } : item))}
                      />
                    </label>
                  </article>
                ))}
              </section>

              <div className="inline-actions">
                <button className="ghost-button" onClick={() => setClassificationRows((prev) => [...prev, { canonicalKey: "", aliases: "" }])}>분류 항목 추가</button>
              </div>
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

        </section>
      </section>
    </main>
  );
}
