import { ACCOUNT_ALIASES, DEFAULT_CLASSIFICATION_GROUPS, LOSS_ACCOUNTS, type ClassificationGroups, type CompanyConfigs, type LogicConfig, type SignCode } from "./defaults";
import { applySign, detectCompanyFromPaste, formatNumber, inferSignFromName, parsePastedText, pasteEditKey, safeFloat, type SessionSignFixes } from "./engine";

export type ReportPeriod = {
  key: string;
  label: string;
  rawLabel: string;
  date: Date | null;
  monthsElapsed: number;
  rowIndex: number;
};

export type StatementMatrixRow = {
  signFlag: 0 | 1;
  section: string;
  sectionKey: string;
  accountName: string;
  canonicalKey: string;
  values: Record<string, number | null>;
};

export type FinalMetricRow = {
  label: string;
  amounts: Record<string, number | null>;
  ratios: Record<string, number | null>;
  growthRates: Record<string, number | null>;
  details: Record<string, FinalMetricPeriodDetails>;
};

export type MetricCalculationInput = {
  label: string;
  value: number | null;
};

export type MetricCalculationDetail = {
  formula: string;
  result: number | null;
  inputs: MetricCalculationInput[];
  note?: string;
};

export type FinalMetricPeriodDetails = {
  amount?: MetricCalculationDetail;
  ratio?: MetricCalculationDetail;
  growthRate?: MetricCalculationDetail;
};

export type FinalMetricSection = {
  title: string;
  rows: FinalMetricRow[];
};

export type ReportingModel = {
  detectedCompany: string | null;
  companyName: string | null;
  periods: ReportPeriod[];
  rawStatementRows: StatementMatrixRow[];
  adjustedStatementRows: StatementMatrixRow[];
  finalSections: FinalMetricSection[];
};

export type SavedQuarterSnapshot = {
  id: string;
  companyName: string;
  quarterKey: string;
  quarterLabel: string;
  savedAt: string;
  rawStatementRows: Array<{ signFlag: 0 | 1; section: string; sectionKey: string; accountName: string; canonicalKey: string; value: number | null }>;
  adjustedStatementRows: Array<{ signFlag: 0 | 1; section: string; sectionKey: string; accountName: string; canonicalKey: string; value: number | null }>;
  source: {
    pastedText: string;
    tolerance: number;
    pasteEdits: Record<string, number>;
    sessionSignFixes: SessionSignFixes;
    logicConfig: LogicConfig;
    companyConfigs: CompanyConfigs;
    classificationGroups: ClassificationGroups;
  };
};

type RowMeta = {
  accountName: string;
  section: string;
  sectionKey: string;
  canonicalKey: string;
  signFlag: 0 | 1;
  signCode: SignCode;
  sourceCol: number;
};

type MetricContext = {
  periods: ReportPeriod[];
  rawRows: StatementMatrixRow[];
  adjustedRows: StatementMatrixRow[];
  sectionTotals: Map<string, Record<string, number>>;
  classificationGroups: ClassificationGroups;
};

type MetricSpec = {
  label: string;
  amount?: (period: ReportPeriod, context: MetricContext) => number | null;
  ratio?: (period: ReportPeriod, context: MetricContext) => number | null;
  amountDetail?: (period: ReportPeriod, context: MetricContext, result: number | null) => MetricCalculationDetail | undefined;
  ratioDetail?: (period: ReportPeriod, context: MetricContext, result: number | null) => MetricCalculationDetail | undefined;
};

function createCalculationDetail(
  formula: string,
  result: number | null,
  inputs: MetricCalculationInput[],
  note?: string
): MetricCalculationDetail {
  return { formula, result, inputs, note };
}

const DEPRECIATION_ALIASES = ["감가상각비", "무형자산상각비", "사용권자산상각비"];
const COST_STRUCTURE_ITEMS = ["인건비", "광고선전비", "연구개발비", "접대비", "복리후생비", "지급수수료", "외주용역비", "임차료", "총이자비용"];
const ASSET_LIABILITY_ITEMS = ["현금및현금성자산", "매도가능증권", "단기대여금", "개발비(자산)", "선급금", "가수금", "가지급금", "퇴직급여충당부채(자산)"];
const VARIABLE_COST_ALIASES = ["매출원가", "외주용역비", "외주비", "지급수수료", "광고선전비", "배송비", "운반비", "수출제비용", "인건비", "복리후생비", "접대비", "연구개발비", "여비교통비", "통신비", "세금과공과금", "도서인쇄비", "소모품비", "대손상각비", "판매촉진비", "대외협력비", "행사비", "기술이전료", "경상기술료", "전산운영비", "반품비용", "기타변동비"];
const BORROWING_ALIASES = ["차입금", "단기차입금", "장기차입금", "유동성장기차입금", "사채"];
const INTEREST_ALIASES = ["총이자비용", "이자비용", "금융비용"];
const QUICK_ASSET_ALIASES = [
  "현금및현금성자산",
  "매출채권",
  "매출채권_음수",
  "미수금",
  "미수금_음수",
  "미수수익",
  "미수수익_음수",
  "매도가능증권"
];

const BALANCE_SHEET_METRICS = new Set(["자산", "유동자산", "비유동자산", "부채", "유동부채", "비유동부채", "자본"]);
const INCOME_STATEMENT_METRICS = new Set(["매출액", "매출원가", "판매비와관리비", "영업비용", "영업외수익", "영업외비용", "영업이익", "영업이익(손실)", "계속사업당기순이익", "당기순이익", "당기순손실"]);

function getPreferredSectionKeys(candidates: string[]) {
  if (candidates.some((candidate) => BALANCE_SHEET_METRICS.has(candidate))) {
    return ["재무상태표"];
  }
  if (candidates.some((candidate) => INCOME_STATEMENT_METRICS.has(candidate))) {
    return ["손익계산서"];
  }
  return [];
}

function normalizeText(value: string) {
  return value.replace(/\s+/g, "").trim();
}

function normalizeSectionKey(section: string) {
  const normalized = normalizeText(section);
  if (["판매비와관리비", "판관비", "영업비용"].includes(normalized)) {
    return "영업비용";
  }
  return normalized || "기타";
}

function buildRowIdentityKey(sectionKey: string, canonicalKey: string, accountName: string) {
  return `${normalizeText(sectionKey)}__${normalizeText(canonicalKey)}__${normalizeText(accountName)}`;
}

function resolveCanonicalAccountKey(accountName: string, sectionKey: string, classificationGroups: ClassificationGroups) {
  const normalizedName = normalizeText(accountName);

  for (const [canonicalKey, aliases] of Object.entries(classificationGroups)) {
    if (aliases.some((alias) => normalizedName === normalizeText(alias))) {
      return canonicalKey;
    }
  }

  for (const [canonicalKey, aliases] of Object.entries(classificationGroups)) {
    if (aliases.some((alias) => normalizedName.includes(normalizeText(alias)))) {
      return canonicalKey;
    }
  }

  for (const [canonicalKey, aliases] of Object.entries(ACCOUNT_ALIASES)) {
    if (aliases.some((alias) => normalizedName === normalizeText(alias))) {
      return canonicalKey;
    }
  }

  for (const [canonicalKey, aliases] of Object.entries(ACCOUNT_ALIASES)) {
    if (aliases.some((alias) => normalizedName.includes(normalizeText(alias)))) {
      return canonicalKey;
    }
  }

  if (sectionKey === "영업비용" && normalizedName.includes("광고")) {
    return "광고선전비";
  }
  if (sectionKey === "영업비용" && normalizedName.includes("연구")) {
    return "연구개발비";
  }
  if (sectionKey === "영업비용" && normalizedName.includes("인건비")) {
    return "인건비";
  }

  return normalizedName;
}

function dateLabelFromValue(value: string | number | Date | null | undefined) {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  if (typeof value === "number") {
    return String(value);
  }

  const raw = String(value ?? "").trim();
  return raw;
}

function parseDate(value: string) {
  const direct = new Date(value);
  if (!Number.isNaN(direct.getTime())) {
    return direct;
  }

  const compact = value.replace(/[^0-9]/g, "");
  if (compact.length === 8) {
    const year = Number(compact.slice(0, 4));
    const month = Number(compact.slice(4, 6));
    const day = Number(compact.slice(6, 8));
    const parsed = new Date(year, month - 1, day);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  return null;
}

function buildPeriods(nameRow: string[], dataRows: Array<Array<string | number | null>>) {
  const dateIdx = nameRow.findIndex((name) => ["날짜", "date", "Date"].includes(name));

  const periods = dataRows.map((row, rowIndex) => {
    const rawLabel = dateIdx >= 0 ? dateLabelFromValue(row[dateIdx]) : `데이터${rowIndex + 1}`;
    const date = parseDate(rawLabel);
    const label = date ? date.toISOString().slice(0, 10) : rawLabel;
    return {
      key: label || `data-${rowIndex}`,
      label: label || `데이터${rowIndex + 1}`,
      rawLabel: rawLabel || `데이터${rowIndex + 1}`,
      date,
      monthsElapsed: date ? Math.max(date.getMonth() + 1, 1) : 12,
      rowIndex
    } satisfies ReportPeriod;
  });

  return periods.sort((a, b) => {
    if (a.date && b.date) {
      return b.date.getTime() - a.date.getTime();
    }
    return a.rowIndex - b.rowIndex;
  });
}

function getEffectiveOverrides(logicConfig: LogicConfig, companyConfigs: CompanyConfigs, companyName: string | null) {
  const merged: Record<string, Record<string, SignCode>> = {};
  for (const [section, overrides] of Object.entries(logicConfig.sectionSignOverrides)) {
    merged[section] = { ...overrides };
  }

  if (companyName && companyConfigs[companyName]?.sectionSignOverrides) {
    for (const [section, overrides] of Object.entries(companyConfigs[companyName].sectionSignOverrides ?? {})) {
      merged[section] = { ...(merged[section] ?? {}), ...overrides };
    }
  }
  return merged;
}

function resolveRowMeta(
  catRow: string[],
  nameRow: string[],
  logicConfig: LogicConfig,
  companyConfigs: CompanyConfigs,
  classificationGroups: ClassificationGroups,
  companyName: string | null,
  sessionSignFixes: SessionSignFixes
) {
  const overrides = getEffectiveOverrides(logicConfig, companyConfigs, companyName);
  let prevSect = "";

  return nameRow.map((accountName, index) => {
    const nextSect = catRow[index]?.trim() ?? "";
    if (nextSect) {
      prevSect = nextSect;
    }

    const section = prevSect || "기타";
    const sectionKey = normalizeSectionKey(section);
    let signCode = inferSignFromName(accountName, logicConfig) ?? 0;
    if (LOSS_ACCOUNTS.has(accountName.trim())) {
      signCode = 1;
    }

    for (const [keyword, override] of Object.entries(overrides[section] ?? {})) {
      if (accountName.includes(keyword)) {
        signCode = override;
        break;
      }
    }

    if (sessionSignFixes[section]?.[accountName] !== undefined) {
      signCode = sessionSignFixes[section][accountName];
    }

        return {
          accountName,
          section,
          sectionKey,
          canonicalKey: resolveCanonicalAccountKey(accountName, sectionKey, classificationGroups),
          signFlag: signCode === 1 ? 1 : 0,
          signCode,
          sourceCol: index
        } satisfies RowMeta;
  });
}

function buildStatementRows(
  metaRows: RowMeta[],
  periods: ReportPeriod[],
  dataRows: Array<Array<string | number | null>>,
  pasteEdits: Record<string, number>,
  adjusted: boolean
) {
  return metaRows
    .filter((row) => row.accountName && !["회사명", "회사", "법인명", "날짜", "date", "Date"].includes(row.accountName))
    .map((meta) => {
      const values: Record<string, number | null> = {};
      for (const period of periods) {
        const rawValue = safeFloat(dataRows[period.rowIndex]?.[meta.sourceCol]);
        const edited = pasteEdits[pasteEditKey(period.rowIndex, meta.sourceCol)];
        const editedValue = edited !== undefined ? edited : rawValue;
        if (meta.signCode === 2) {
          values[period.key] = adjusted ? 0 : editedValue;
        } else {
          values[period.key] = adjusted ? applySign(editedValue, meta.signCode as 0 | 1) : editedValue;
        }
      }
      return {
        signFlag: meta.signFlag,
        section: meta.section,
        sectionKey: meta.sectionKey,
        accountName: meta.accountName,
        canonicalKey: meta.canonicalKey,
        values
      } satisfies StatementMatrixRow;
    });
}

function getRowValues(rows: StatementMatrixRow[], periodKey: string, candidates: string[], sectionName: string | undefined, classificationGroups: ClassificationGroups) {
  const canonicalCandidates = candidates.flatMap((candidate) => {
    const base = [candidate];
    const aliases = classificationGroups[candidate] ?? ACCOUNT_ALIASES[candidate] ?? [];
    return [...base, ...aliases].map(normalizeText);
  });
  const canonicalSection = sectionName ? normalizeSectionKey(sectionName) : null;
  const preferredSections = sectionName ? [canonicalSection!].filter(Boolean) : getPreferredSectionKeys(candidates);
  const matches = rows.filter((row) => {
    const rowKey = normalizeText(row.canonicalKey || row.accountName);
    const rowName = normalizeText(row.accountName);
    const byName = canonicalCandidates.some((candidate) => rowKey === candidate || rowName === candidate);
    const bySection = !canonicalSection || row.sectionKey === canonicalSection || normalizeSectionKey(row.section) === canonicalSection;
    return byName && bySection;
  });

  return matches
    .sort((a, b) => {
      const aPreferred = preferredSections.includes(a.sectionKey) ? 1 : 0;
      const bPreferred = preferredSections.includes(b.sectionKey) ? 1 : 0;
      if (aPreferred !== bPreferred) {
        return bPreferred - aPreferred;
      }
      const aExact = canonicalCandidates.includes(normalizeText(a.canonicalKey || a.accountName)) ? 1 : 0;
      const bExact = canonicalCandidates.includes(normalizeText(b.canonicalKey || b.accountName)) ? 1 : 0;
      return bExact - aExact;
    })
    .map((row) => row.values[periodKey])
    .filter((value): value is number => value !== null && value !== undefined);
}

function getSectionTotals(rows: StatementMatrixRow[], periods: ReportPeriod[]) {
  const totals = new Map<string, Record<string, number>>();
  rows.forEach((row) => {
    const current = totals.get(row.sectionKey) ?? Object.fromEntries(periods.map((period) => [period.key, 0]));
    periods.forEach((period) => {
      current[period.key] += row.values[period.key] ?? 0;
    });
    totals.set(row.sectionKey, current);
  });
  return totals;
}

function firstAvailableValue(rows: StatementMatrixRow[], periodKey: string, candidates: string[], sectionName: string | undefined, classificationGroups: ClassificationGroups) {
  const values = getRowValues(rows, periodKey, candidates, sectionName, classificationGroups);
  return values[0] ?? null;
}

function firstExactAccountValue(rows: StatementMatrixRow[], periodKey: string, accountNames: string[], sectionName?: string) {
  const normalizedCandidates = accountNames.map(normalizeText);
  const canonicalSection = sectionName ? normalizeSectionKey(sectionName) : null;
  const match = rows.find((row) => {
    const rowName = normalizeText(row.accountName);
    const rowKey = normalizeText(row.canonicalKey || row.accountName);
    const byName = normalizedCandidates.includes(rowName) || normalizedCandidates.includes(rowKey);
    const bySection = !canonicalSection || row.sectionKey === canonicalSection || normalizeSectionKey(row.section) === canonicalSection;
    return byName && bySection;
  });

  return match?.values[periodKey] ?? null;
}

function sumValues(rows: StatementMatrixRow[], periodKey: string, candidates: string[], sectionName: string | undefined, classificationGroups: ClassificationGroups) {
  const values = getRowValues(rows, periodKey, candidates, sectionName, classificationGroups);
  if (!values.length) {
    return null;
  }
  return values.reduce((total, value) => total + value, 0);
}

function sumClassifiedValues(rows: StatementMatrixRow[], periodKey: string, candidates: string[], sectionName: string | undefined, classificationGroups: ClassificationGroups) {
  const canonicalCandidates = candidates.flatMap((candidate) => {
    const base = [candidate];
    const aliases = classificationGroups[candidate] ?? [];
    return [...base, ...aliases].map(normalizeText);
  });
  const canonicalSection = sectionName ? normalizeSectionKey(sectionName) : null;
  const preferredSections = sectionName ? [canonicalSection!].filter(Boolean) : getPreferredSectionKeys(candidates);
  const values = rows
    .filter((row) => {
      const rowKey = normalizeText(row.canonicalKey || row.accountName);
      const byName = canonicalCandidates.includes(rowKey);
      const bySection = !canonicalSection || row.sectionKey === canonicalSection || normalizeSectionKey(row.section) === canonicalSection;
      return byName && bySection;
    })
    .sort((a, b) => {
      const aPreferred = preferredSections.includes(a.sectionKey) ? 1 : 0;
      const bPreferred = preferredSections.includes(b.sectionKey) ? 1 : 0;
      return bPreferred - aPreferred;
    })
    .map((row) => row.values[periodKey])
    .filter((value): value is number => value !== null && value !== undefined);

  if (!values.length) {
    return null;
  }

  return values.reduce((total, value) => total + value, 0);
}

function getMetricValue(context: MetricContext, periodKey: string, names: string[]) {
  return firstAvailableValue(context.adjustedRows, periodKey, names, undefined, context.classificationGroups);
}

function getMetricSum(context: MetricContext, periodKey: string, names: string[]) {
  return sumValues(context.adjustedRows, periodKey, names, undefined, context.classificationGroups);
}

function getClassifiedMetricSum(context: MetricContext, periodKey: string, names: string[], sectionName?: string) {
  return sumClassifiedValues(context.adjustedRows, periodKey, names, sectionName, context.classificationGroups);
}

function getRawMetricValue(context: MetricContext, periodKey: string, names: string[], sectionName?: string) {
  return firstAvailableValue(context.rawRows, periodKey, names, sectionName, context.classificationGroups);
}

function getRawMetricSum(context: MetricContext, periodKey: string, names: string[], sectionName?: string) {
  return sumValues(context.rawRows, periodKey, names, sectionName, context.classificationGroups);
}

function getAdjustedMetricValue(context: MetricContext, periodKey: string, names: string[], sectionName?: string) {
  return firstAvailableValue(context.adjustedRows, periodKey, names, sectionName, context.classificationGroups);
}

function getAdjustedExactAccountValue(context: MetricContext, periodKey: string, accountNames: string[], sectionName?: string) {
  return firstExactAccountValue(context.adjustedRows, periodKey, accountNames, sectionName);
}

function getAdjustedExactMetricValue(context: MetricContext, periodKey: string, exactNames: string[], fallbackNames: string[], sectionName?: string) {
  const exact = getAdjustedExactAccountValue(context, periodKey, exactNames, sectionName);
  if (exact !== null) {
    return exact;
  }

  return getPreferredAdjustedMetric(context, periodKey, fallbackNames, sectionName);
}

function getAdjustedMetricSum(context: MetricContext, periodKey: string, names: string[], sectionName?: string) {
  return sumValues(context.adjustedRows, periodKey, names, sectionName, context.classificationGroups);
}

function getPreferredAdjustedMetric(context: MetricContext, periodKey: string, names: string[], sectionName?: string) {
  const exact = getAdjustedMetricValue(context, periodKey, names, sectionName);
  if (exact !== null) {
    return exact;
  }
  return getAdjustedMetricSum(context, periodKey, names, sectionName);
}

function getPreferredTotalEquity(context: MetricContext, periodKey: string) {
  return getAdjustedExactMetricValue(context, periodKey, ["자본총계", "총자본"], ["자본"], "재무상태표");
}

function getPreferredTotalAssets(context: MetricContext, periodKey: string) {
  return getAdjustedExactMetricValue(context, periodKey, ["자산총계", "총자산", "자산"], ["자산"], "재무상태표");
}

function getPreferredTotalLiabilities(context: MetricContext, periodKey: string) {
  return getAdjustedExactMetricValue(context, periodKey, ["부채총계", "총부채", "부채"], ["부채"], "재무상태표");
}

function getPreferredCurrentAssets(context: MetricContext, periodKey: string) {
  return getAdjustedExactMetricValue(context, periodKey, ["유동자산"], ["유동자산"], "재무상태표");
}

function getPreferredCurrentLiabilities(context: MetricContext, periodKey: string) {
  return getAdjustedExactMetricValue(context, periodKey, ["유동부채"], ["유동부채"], "재무상태표");
}

function safeDivide(numerator: number | null, denominator: number | null, multiplier = 1) {
  if (numerator === null || denominator === null || denominator === 0) {
    return null;
  }
  return (numerator / denominator) * multiplier;
}

function getSectionTotal(context: MetricContext, periodKey: string, sectionNames: string[]) {
  const values = sectionNames
    .map((name) => context.sectionTotals.get(name)?.[periodKey])
    .filter((value): value is number => value !== null && value !== undefined);

  if (!values.length) {
    return null;
  }

  return values.reduce((total, value) => total + value, 0);
}

function averageTwo(current: number | null, previous: number | null) {
  if (current === null || previous === null) {
    return null;
  }
  return (current + previous) / 2;
}

function getPreviousPeriod(context: MetricContext, period: ReportPeriod) {
  const index = context.periods.findIndex((item) => item.key === period.key);
  return index >= 0 ? context.periods[index + 1] ?? null : null;
}

function getNetMetricValue(context: MetricContext, periodKey: string, positiveNames: string[], negativeNames: string[] = []) {
  const positive = getAdjustedMetricSum(context, periodKey, positiveNames);
  const negative = negativeNames.length ? getAdjustedMetricSum(context, periodKey, negativeNames) : null;
  if (positive === null && negative === null) {
    return null;
  }
  return (positive ?? 0) + (negative ?? 0);
}

function buildMetricRows(context: MetricContext, specs: MetricSpec[]) {
  return specs.map((spec) => {
    const amounts: Record<string, number | null> = {};
    const ratios: Record<string, number | null> = {};
    const growthRates: Record<string, number | null> = {};
    const details: Record<string, FinalMetricPeriodDetails> = {};

    context.periods.forEach((period, index) => {
      const currentAmount = spec.amount ? spec.amount(period, context) : null;
      const currentRatio = spec.ratio ? spec.ratio(period, context) : null;
      amounts[period.key] = currentAmount;
      ratios[period.key] = currentRatio;
      details[period.key] = {};

      if (spec.amountDetail) {
        details[period.key].amount = spec.amountDetail(period, context, currentAmount);
      }

      if (spec.ratioDetail) {
        details[period.key].ratio = spec.ratioDetail(period, context, currentRatio);
      }

      const previous = context.periods[index + 1];
      const previousAmount = previous && spec.amount ? spec.amount(previous, context) : null;
      growthRates[period.key] = currentAmount !== null && previousAmount !== null && previousAmount !== 0
        ? ((currentAmount - previousAmount) / Math.abs(previousAmount)) * 100
        : null;

      if (spec.amount) {
        details[period.key].growthRate = createCalculationDetail(
          "(당기 금액 - 전분기 금액) / |전분기 금액| * 100",
          growthRates[period.key],
          [
            { label: "당기 금액", value: currentAmount },
            { label: previous ? "전분기 금액" : "비교 전분기 금액", value: previousAmount }
          ],
          !previous
            ? "이전 분기가 없어 증감율을 계산하지 않았습니다."
            : previousAmount === 0
              ? "전분기 금액이 0이라 증감율을 계산하지 않았습니다."
              : undefined
        );
      }
    });

    return {
      label: spec.label,
      amounts,
      ratios,
      growthRates,
      details
    } satisfies FinalMetricRow;
  });
}

function buildFinalSections(context: MetricContext): FinalMetricSection[] {
  const runwaySpec: MetricSpec = {
    label: "런웨이(E)",
    amount: (period, current) => {
      const cash = getAdjustedMetricSum(current, period.key, ["현금및현금성자산"]);
      const sales = getMetricValue(current, period.key, ["매출액"]);
      const operatingIncome = getMetricValue(current, period.key, ["영업이익", "영업이익(손실)"]);
      const depreciation = getMetricSum(current, period.key, DEPRECIATION_ALIASES);
      if ([cash, sales, operatingIncome].some((value) => value === null)) {
        return null;
      }
      const burnBase = (sales ?? 0) - (operatingIncome ?? 0) - (depreciation ?? 0);
      return burnBase > 0 ? (cash ?? 0) * 6 / burnBase : null;
    },
    amountDetail: (period, current, result) => {
      const cash = getAdjustedMetricSum(current, period.key, ["현금및현금성자산"]);
      const sales = getMetricValue(current, period.key, ["매출액"]);
      const operatingIncome = getMetricValue(current, period.key, ["영업이익", "영업이익(손실)"]);
      const depreciation = getMetricSum(current, period.key, DEPRECIATION_ALIASES);
      const burnBase = cash === null && sales === null && operatingIncome === null ? null : (sales ?? 0) - (operatingIncome ?? 0) - (depreciation ?? 0);
      return createCalculationDetail(
        "현금및현금성자산 * 6 / (매출액 - 영업이익 - 감가상각계)",
        result,
        [
          { label: "현금및현금성자산", value: cash },
          { label: "매출액", value: sales },
          { label: "영업이익", value: operatingIncome },
          { label: "감가상각계", value: depreciation },
          { label: "월환산 소진기준", value: burnBase }
        ],
        burnBase !== null && burnBase <= 0 ? "소진 기준값이 0 이하라 런웨이를 계산하지 않았습니다." : undefined
      );
    }
  };

  const ebitdaSpec: MetricSpec = {
    label: "EBITDA",
    amount: (period, current) => {
      const operatingIncome = getMetricValue(current, period.key, ["영업이익", "영업이익(손실)"]);
      const depreciation = getMetricSum(current, period.key, DEPRECIATION_ALIASES);
      if (operatingIncome === null) {
        return null;
      }
      return (operatingIncome ?? 0) + (depreciation ?? 0);
    },
    amountDetail: (period, current, result) => {
      const operatingIncome = getMetricValue(current, period.key, ["영업이익", "영업이익(손실)"]);
      const depreciation = getMetricSum(current, period.key, DEPRECIATION_ALIASES);
      return createCalculationDetail(
        "영업이익 + 감가상각계",
        result,
        [
          { label: "영업이익", value: operatingIncome },
          { label: "감가상각계", value: depreciation }
        ]
      );
    }
  };

  const monthlyBurnSpec: MetricSpec = {
    label: "월 평균 지출액",
    amount: (period, current) => {
      const sales = getAdjustedMetricValue(current, period.key, ["매출액"]);
      const operatingIncome = getAdjustedMetricValue(current, period.key, ["영업이익", "영업이익(손실)"]);
      const depreciation = getAdjustedMetricSum(current, period.key, DEPRECIATION_ALIASES);
      if ([sales, operatingIncome].some((value) => value === null)) {
        return null;
      }
      return ((sales ?? 0) - (operatingIncome ?? 0) + (depreciation ?? 0)) / 3;
    },
    amountDetail: (period, current, result) => {
      const sales = getAdjustedMetricValue(current, period.key, ["매출액"]);
      const operatingIncome = getAdjustedMetricValue(current, period.key, ["영업이익", "영업이익(손실)"]);
      const depreciation = getAdjustedMetricSum(current, period.key, DEPRECIATION_ALIASES);
      const quarterlySpend = sales === null && operatingIncome === null ? null : (sales ?? 0) - (operatingIncome ?? 0) + (depreciation ?? 0);
      return createCalculationDetail(
        "(매출액 - 영업이익 + 감가상각계) / 3",
        result,
        [
          { label: "매출액", value: sales },
          { label: "영업이익", value: operatingIncome },
          { label: "감가상각계", value: depreciation },
          { label: "분기 총지출 추정", value: quarterlySpend }
        ]
      );
    }
  };

  const groupedRawValue = (period: ReportPeriod, current: MetricContext, names: string[]) => getRawMetricSum(current, period.key, names);
  const costStructureValue = (period: ReportPeriod, current: MetricContext, label: string) => {
    if (label === "총이자비용") {
      return getAdjustedMetricSum(current, period.key, INTEREST_ALIASES, "영업외비용");
    }
    return getAdjustedMetricSum(current, period.key, [label], "영업비용");
  };

  const costStructureSpecs = COST_STRUCTURE_ITEMS.map((label) => ({
    label,
    amount: (period: ReportPeriod, current: MetricContext) => costStructureValue(period, current, label),
    amountDetail: (period: ReportPeriod, current: MetricContext, result: number | null) => createCalculationDetail(
      label === "총이자비용" ? "영업외비용 섹션 내 이자비용 관련 계정 합계" : `${label} 계정 합계`,
      result,
      [
        { label, value: costStructureValue(period, current, label) }
      ]
    ),
    ratio: (period: ReportPeriod, current: MetricContext) => {
      const value = costStructureValue(period, current, label);
      const expenseTotal = (getPreferredAdjustedMetric(current, period.key, ["매출원가"]) ?? 0)
        + (getPreferredAdjustedMetric(current, period.key, ["판매비와관리비", "영업비용"]) ?? 0)
        + (getPreferredAdjustedMetric(current, period.key, ["영업외비용"]) ?? 0);
      return safeDivide(value, expenseTotal, 100);
    },
    ratioDetail: (period: ReportPeriod, current: MetricContext, result: number | null) => {
      const value = costStructureValue(period, current, label);
      const costOfSales = getPreferredAdjustedMetric(current, period.key, ["매출원가"]);
      const operatingExpense = getPreferredAdjustedMetric(current, period.key, ["판매비와관리비", "영업비용"]);
      const nonOperatingExpense = getPreferredAdjustedMetric(current, period.key, ["영업외비용"]);
      const expenseTotal = (costOfSales ?? 0) + (operatingExpense ?? 0) + (nonOperatingExpense ?? 0);
      return createCalculationDetail(
        `${label} / (매출원가 + 영업비용 + 영업외비용) * 100`,
        result,
        [
          { label, value },
          { label: "매출원가", value: costOfSales },
          { label: "영업비용", value: operatingExpense },
          { label: "영업외비용", value: nonOperatingExpense },
          { label: "총비용", value: expenseTotal }
        ],
        expenseTotal === 0 ? "총비용이 0이라 비율을 계산하지 않았습니다." : undefined
      );
    }
  } satisfies MetricSpec));

  const assetLiabilitySpecs: MetricSpec[] = [
    {
      label: "현금및현금성자산",
      amount: (period, current) => getRawMetricSum(current, period.key, ["현금및현금성자산"]),
      amountDetail: (period, current, result) => createCalculationDetail(
        "현금및현금성자산 계정 합계",
        result,
        [{ label: "현금및현금성자산", value: getRawMetricSum(current, period.key, ["현금및현금성자산"]) }]
      ),
      ratio: (period, current) => safeDivide(getRawMetricSum(current, period.key, ["현금및현금성자산"]), getPreferredTotalAssets(current, period.key), 100),
      ratioDetail: (period, current, result) => {
        const cash = getRawMetricSum(current, period.key, ["현금및현금성자산"]);
        const assets = getPreferredTotalAssets(current, period.key);
        return createCalculationDetail("현금및현금성자산 / 자산 * 100", result, [
          { label: "현금및현금성자산", value: cash },
          { label: "자산", value: assets }
        ], assets === 0 ? "자산이 0이라 비율을 계산하지 않았습니다." : undefined);
      }
    },
    {
      label: "매도가능증권",
      amount: (period, current) => getRawMetricSum(current, period.key, ["매도가능증권"]),
      amountDetail: (period, current, result) => createCalculationDetail(
        "매도가능증권 계정 합계",
        result,
        [{ label: "매도가능증권", value: getRawMetricSum(current, period.key, ["매도가능증권"]) }]
      ),
      ratio: (period, current) => safeDivide(getRawMetricSum(current, period.key, ["매도가능증권"]), getPreferredTotalAssets(current, period.key), 100),
      ratioDetail: (period, current, result) => {
        const availableForSale = getRawMetricSum(current, period.key, ["매도가능증권"]);
        const assets = getPreferredTotalAssets(current, period.key);
        return createCalculationDetail("매도가능증권 / 자산 * 100", result, [
          { label: "매도가능증권", value: availableForSale },
          { label: "자산", value: assets }
        ], assets === 0 ? "자산이 0이라 비율을 계산하지 않았습니다." : undefined);
      }
    },
    {
      label: "단기대여금",
      amount: (period, current) => getNetMetricValue(current, period.key, ["단기대여금_양수", "단기대여금"], ["단기대여금_음수"]),
      amountDetail: (period, current, result) => {
        const positive = getAdjustedMetricSum(current, period.key, ["단기대여금_양수", "단기대여금"]);
        const negative = getAdjustedMetricSum(current, period.key, ["단기대여금_음수"]);
        return createCalculationDetail("단기대여금 관련 양수 합계 + 음수 조정 합계", result, [
          { label: "단기대여금 양수", value: positive },
          { label: "단기대여금 음수 조정", value: negative }
        ]);
      },
      ratio: (period, current) => safeDivide(getNetMetricValue(current, period.key, ["단기대여금_양수", "단기대여금"], ["단기대여금_음수"]), getPreferredTotalAssets(current, period.key), 100),
      ratioDetail: (period, current, result) => {
        const loans = getNetMetricValue(current, period.key, ["단기대여금_양수", "단기대여금"], ["단기대여금_음수"]);
        const assets = getPreferredTotalAssets(current, period.key);
        return createCalculationDetail("단기대여금 / 자산 * 100", result, [
          { label: "단기대여금", value: loans },
          { label: "자산", value: assets }
        ], assets === 0 ? "자산이 0이라 비율을 계산하지 않았습니다." : undefined);
      }
    },
    {
      label: "개발비(자산)",
      amount: (period, current) => getNetMetricValue(current, period.key, ["개발비_양수", "개발비(자산)", "개발비"], ["개발비_음수"]),
      amountDetail: (period, current, result) => {
        const positive = getAdjustedMetricSum(current, period.key, ["개발비_양수", "개발비(자산)", "개발비"]);
        const negative = getAdjustedMetricSum(current, period.key, ["개발비_음수"]);
        return createCalculationDetail("개발비 관련 양수 합계 + 음수 조정 합계", result, [
          { label: "개발비 양수", value: positive },
          { label: "개발비 음수 조정", value: negative }
        ]);
      },
      ratio: (period, current) => safeDivide(getNetMetricValue(current, period.key, ["개발비_양수", "개발비(자산)", "개발비"], ["개발비_음수"]), getPreferredTotalAssets(current, period.key), 100),
      ratioDetail: (period, current, result) => {
        const developmentAsset = getNetMetricValue(current, period.key, ["개발비_양수", "개발비(자산)", "개발비"], ["개발비_음수"]);
        const assets = getPreferredTotalAssets(current, period.key);
        return createCalculationDetail("개발비(자산) / 자산 * 100", result, [
          { label: "개발비(자산)", value: developmentAsset },
          { label: "자산", value: assets }
        ], assets === 0 ? "자산이 0이라 비율을 계산하지 않았습니다." : undefined);
      }
    },
    {
      label: "선급금",
      amount: (period, current) => getNetMetricValue(current, period.key, ["선급금_양수", "선급금"], ["선급금_음수"]),
      amountDetail: (period, current, result) => {
        const positive = getAdjustedMetricSum(current, period.key, ["선급금_양수", "선급금"]);
        const negative = getAdjustedMetricSum(current, period.key, ["선급금_음수"]);
        return createCalculationDetail("선급금 관련 양수 합계 + 음수 조정 합계", result, [
          { label: "선급금 양수", value: positive },
          { label: "선급금 음수 조정", value: negative }
        ]);
      },
      ratio: (period, current) => safeDivide(getNetMetricValue(current, period.key, ["선급금_양수", "선급금"], ["선급금_음수"]), getPreferredTotalAssets(current, period.key), 100),
      ratioDetail: (period, current, result) => {
        const prepaid = getNetMetricValue(current, period.key, ["선급금_양수", "선급금"], ["선급금_음수"]);
        const assets = getPreferredTotalAssets(current, period.key);
        return createCalculationDetail("선급금 / 자산 * 100", result, [
          { label: "선급금", value: prepaid },
          { label: "자산", value: assets }
        ], assets === 0 ? "자산이 0이라 비율을 계산하지 않았습니다." : undefined);
      }
    },
    {
      label: "가수금",
      amount: (period, current) => getRawMetricSum(current, period.key, ["가수금"]),
      amountDetail: (period, current, result) => createCalculationDetail(
        "가수금 계정 합계",
        result,
        [{ label: "가수금", value: getRawMetricSum(current, period.key, ["가수금"]) }]
      ),
      ratio: (period, current) => safeDivide(getRawMetricSum(current, period.key, ["가수금"]), getPreferredTotalLiabilities(current, period.key), 100),
      ratioDetail: (period, current, result) => {
        const suspense = getRawMetricSum(current, period.key, ["가수금"]);
        const liabilities = getPreferredTotalLiabilities(current, period.key);
        return createCalculationDetail("가수금 / 부채 * 100", result, [
          { label: "가수금", value: suspense },
          { label: "부채", value: liabilities }
        ], liabilities === 0 ? "부채가 0이라 비율을 계산하지 않았습니다." : undefined);
      }
    },
    {
      label: "가지급금",
      amount: (period, current) => getRawMetricSum(current, period.key, ["가지급금"]),
      amountDetail: (period, current, result) => createCalculationDetail(
        "가지급금 계정 합계",
        result,
        [{ label: "가지급금", value: getRawMetricSum(current, period.key, ["가지급금"]) }]
      ),
      ratio: (period, current) => safeDivide(getRawMetricSum(current, period.key, ["가지급금"]), getPreferredTotalAssets(current, period.key), 100),
      ratioDetail: (period, current, result) => {
        const advances = getRawMetricSum(current, period.key, ["가지급금"]);
        const assets = getPreferredTotalAssets(current, period.key);
        return createCalculationDetail("가지급금 / 자산 * 100", result, [
          { label: "가지급금", value: advances },
          { label: "자산", value: assets }
        ], assets === 0 ? "자산이 0이라 비율을 계산하지 않았습니다." : undefined);
      }
    },
    {
      label: "퇴직급여충당부채",
      amount: (period, current) => {
        const positive = getAdjustedMetricSum(current, period.key, ["퇴직급여충당부채_양수", "퇴직급여충당부채"]);
        const negative = getAdjustedMetricSum(current, period.key, ["퇴직급여충당부채_음수"]);
        if (positive === null && negative === null) {
          return null;
        }
        return (positive ?? 0) + (negative ?? 0);
      },
      amountDetail: (period, current, result) => {
        const positive = getAdjustedMetricSum(current, period.key, ["퇴직급여충당부채_양수", "퇴직급여충당부채"]);
        const negative = getAdjustedMetricSum(current, period.key, ["퇴직급여충당부채_음수"]);
        return createCalculationDetail("퇴직급여충당부채 양수 합계 + 음수 조정 합계", result, [
          { label: "퇴직급여충당부채 양수", value: positive },
          { label: "퇴직급여충당부채 음수 조정", value: negative }
        ]);
      },
      ratio: (period, current) => {
        const positive = getAdjustedMetricSum(current, period.key, ["퇴직급여충당부채_양수", "퇴직급여충당부채"]);
        const negative = getAdjustedMetricSum(current, period.key, ["퇴직급여충당부채_음수"]);
        const value = (positive ?? 0) + (negative ?? 0);
        return safeDivide(value, getPreferredTotalLiabilities(current, period.key), 100);
      },
      ratioDetail: (period, current, result) => {
        const positive = getAdjustedMetricSum(current, period.key, ["퇴직급여충당부채_양수", "퇴직급여충당부채"]);
        const negative = getAdjustedMetricSum(current, period.key, ["퇴직급여충당부채_음수"]);
        const value = (positive ?? 0) + (negative ?? 0);
        const liabilities = getPreferredTotalLiabilities(current, period.key);
        return createCalculationDetail("퇴직급여충당부채 / 부채 * 100", result, [
          { label: "퇴직급여충당부채", value },
          { label: "부채", value: liabilities }
        ], liabilities === 0 ? "부채가 0이라 비율을 계산하지 않았습니다." : undefined);
      }
    }
  ];

  const stabilitySpecs: MetricSpec[] = [
    {
      label: "유동비율",
      ratio: (period, current) => safeDivide(getPreferredCurrentAssets(current, period.key), getPreferredCurrentLiabilities(current, period.key), 100),
      ratioDetail: (period, current, result) => {
        const currentAssets = getPreferredCurrentAssets(current, period.key);
        const currentLiabilities = getPreferredCurrentLiabilities(current, period.key);
        return createCalculationDetail("유동자산 / 유동부채 * 100", result, [
          { label: "유동자산", value: currentAssets },
          { label: "유동부채", value: currentLiabilities }
        ], currentLiabilities === 0 ? "유동부채가 0이라 비율을 계산하지 않았습니다." : undefined);
      }
    },
    {
      label: "당좌비율",
      ratio: (period, current) => {
        const currentAssetRows = current.adjustedRows.filter((row) => row.sectionKey === "유동자산");
        const quickAssets = sumValues(currentAssetRows, period.key, QUICK_ASSET_ALIASES, undefined, current.classificationGroups);
        const currentLiabilities = getPreferredCurrentLiabilities(current, period.key);
        return safeDivide(quickAssets, currentLiabilities, 100);
      },
      ratioDetail: (period, current, result) => {
        const currentAssetRows = current.adjustedRows.filter((row) => row.sectionKey === "유동자산");
        const quickAssets = sumValues(currentAssetRows, period.key, QUICK_ASSET_ALIASES, undefined, current.classificationGroups);
        const currentLiabilities = getPreferredCurrentLiabilities(current, period.key);
        return createCalculationDetail("당좌자산 / 유동부채 * 100", result, [
          { label: "당좌자산", value: quickAssets },
          { label: "유동부채", value: currentLiabilities }
        ], currentLiabilities === 0 ? "유동부채가 0이라 비율을 계산하지 않았습니다." : undefined);
      }
    },
    {
      label: "부채비율",
      ratio: (period, current) => safeDivide(getPreferredTotalLiabilities(current, period.key), getPreferredTotalEquity(current, period.key), 100),
      ratioDetail: (period, current, result) => {
        const liabilities = getPreferredTotalLiabilities(current, period.key);
        const equity = getPreferredTotalEquity(current, period.key);
        return createCalculationDetail("부채 / 자본 * 100", result, [
          { label: "부채", value: liabilities },
          { label: "자본총계", value: equity }
        ], equity === 0 ? "자본이 0이라 비율을 계산하지 않았습니다." : undefined);
      }
    },
    {
      label: "차입금 의존도",
      ratio: (period, current) => safeDivide(getNetMetricValue(current, period.key, ["차입금_양수", ...BORROWING_ALIASES], ["차입금_음수"]), getPreferredTotalAssets(current, period.key), 100),
      ratioDetail: (period, current, result) => {
        const borrowings = getNetMetricValue(current, period.key, ["차입금_양수", ...BORROWING_ALIASES], ["차입금_음수"]);
        const assets = getPreferredTotalAssets(current, period.key);
        return createCalculationDetail("순차입금 / 자산 * 100", result, [
          { label: "순차입금", value: borrowings },
          { label: "자산", value: assets }
        ], assets === 0 ? "자산이 0이라 비율을 계산하지 않았습니다." : undefined);
      }
    },
    {
      label: "이자보상비율",
      ratio: (period, current) => safeDivide(getAdjustedMetricSum(current, period.key, ["영업이익", "영업이익(손실)"]), getMetricSum(current, period.key, INTEREST_ALIASES), 100),
      ratioDetail: (period, current, result) => {
        const operatingIncome = getAdjustedMetricSum(current, period.key, ["영업이익", "영업이익(손실)"]);
        const interestExpense = getMetricSum(current, period.key, INTEREST_ALIASES);
        return createCalculationDetail("영업이익 / 이자비용 * 100", result, [
          { label: "영업이익", value: operatingIncome },
          { label: "이자비용", value: interestExpense }
        ], interestExpense === 0 ? "이자비용이 0이라 비율을 계산하지 않았습니다." : undefined);
      }
    }
  ];

  const profitabilitySpecs: MetricSpec[] = [
    {
      label: "매출액순이익률",
      ratio: (period, current) => safeDivide(getAdjustedMetricSum(current, period.key, ["계속사업당기순이익"]), getPreferredAdjustedMetric(current, period.key, ["매출액"]), 100),
      ratioDetail: (period, current, result) => {
        const netIncome = getAdjustedMetricSum(current, period.key, ["계속사업당기순이익"]);
        const sales = getPreferredAdjustedMetric(current, period.key, ["매출액"]);
        return createCalculationDetail("계속사업당기순이익 / 매출액 * 100", result, [
          { label: "계속사업당기순이익", value: netIncome },
          { label: "매출액", value: sales }
        ], sales === 0 ? "매출액이 0이라 비율을 계산하지 않았습니다." : undefined);
      }
    },
    {
      label: "총자산이익률(ROA)",
      ratio: (period, current) => safeDivide(getAdjustedMetricSum(current, period.key, ["계속사업당기순이익"]), getPreferredTotalAssets(current, period.key), 100),
      ratioDetail: (period, current, result) => {
        const netIncome = getAdjustedMetricSum(current, period.key, ["계속사업당기순이익"]);
        const assets = getPreferredTotalAssets(current, period.key);
        return createCalculationDetail("계속사업당기순이익 / 자산 * 100", result, [
          { label: "계속사업당기순이익", value: netIncome },
          { label: "자산", value: assets }
        ], assets === 0 ? "자산이 0이라 비율을 계산하지 않았습니다." : undefined);
      }
    },
    {
      label: "자기자본이익률(ROE)",
      ratio: (period, current) => safeDivide(getAdjustedMetricSum(current, period.key, ["계속사업당기순이익"]), getPreferredTotalEquity(current, period.key), 100),
      ratioDetail: (period, current, result) => {
        const netIncome = getAdjustedMetricSum(current, period.key, ["계속사업당기순이익"]);
        const equity = getPreferredTotalEquity(current, period.key);
        return createCalculationDetail("계속사업당기순이익 / 자본 * 100", result, [
          { label: "계속사업당기순이익", value: netIncome },
          { label: "자본", value: equity }
        ], equity === 0 ? "자본이 0이라 비율을 계산하지 않았습니다." : undefined);
      }
    },
    {
      label: "영업이익률",
      ratio: (period, current) => safeDivide(getAdjustedMetricSum(current, period.key, ["영업이익", "영업이익(손실)"]), getPreferredAdjustedMetric(current, period.key, ["매출액"]), 100),
      ratioDetail: (period, current, result) => {
        const operatingIncome = getAdjustedMetricSum(current, period.key, ["영업이익", "영업이익(손실)"]);
        const sales = getPreferredAdjustedMetric(current, period.key, ["매출액"]);
        return createCalculationDetail("영업이익 / 매출액 * 100", result, [
          { label: "영업이익", value: operatingIncome },
          { label: "매출액", value: sales }
        ], sales === 0 ? "매출액이 0이라 비율을 계산하지 않았습니다." : undefined);
      }
    },
    {
      label: "공헌이익률",
      ratio: (period, current) => {
        const sales = getAdjustedMetricSum(current, period.key, ["매출액"]);
        const variableCosts = getClassifiedMetricSum(current, period.key, VARIABLE_COST_ALIASES);
        return safeDivide(sales !== null ? sales - (variableCosts ?? 0) : null, sales, 100);
      },
      ratioDetail: (period, current, result) => {
        const sales = getAdjustedMetricSum(current, period.key, ["매출액"]);
        const variableCosts = getClassifiedMetricSum(current, period.key, VARIABLE_COST_ALIASES);
        const contribution = sales !== null ? sales - (variableCosts ?? 0) : null;
        return createCalculationDetail("(매출액 - 변동비) / 매출액 * 100", result, [
          { label: "매출액", value: sales },
          { label: "변동비", value: variableCosts },
          { label: "공헌이익", value: contribution }
        ], sales === 0 ? "매출액이 0이라 비율을 계산하지 않았습니다." : undefined);
      }
    }
  ];

  const activitySpecs: MetricSpec[] = [
    {
      label: "총자산회전율",
      ratio: (period, current) => {
        const previous = getPreviousPeriod(current, period);
        const averageAssets = previous
          ? averageTwo(getPreferredTotalAssets(current, period.key), getPreferredTotalAssets(current, previous.key))
          : null;
        return safeDivide(getAdjustedMetricSum(current, period.key, ["매출액"]), averageAssets, 1);
      },
      ratioDetail: (period, current, result) => {
        const previous = getPreviousPeriod(current, period);
        const currentAssets = getPreferredTotalAssets(current, period.key);
        const previousAssets = previous ? getPreferredTotalAssets(current, previous.key) : null;
        const averageAssets = previous ? averageTwo(currentAssets, previousAssets) : null;
        const sales = getAdjustedMetricSum(current, period.key, ["매출액"]);
        return createCalculationDetail("매출액 / 평균총자산", result, [
          { label: "매출액", value: sales },
          { label: "당기 자산", value: currentAssets },
          { label: "전기 자산", value: previousAssets },
          { label: "평균총자산", value: averageAssets }
        ], !previous ? "직전 분기가 없어 평균총자산을 계산하지 않았습니다." : averageAssets === 0 ? "평균총자산이 0이라 회전율을 계산하지 않았습니다." : undefined);
      }
    },
    {
      label: "매출채권회전율",
      ratio: (period, current) => {
        const previous = getPreviousPeriod(current, period);
        const averageReceivables = previous
          ? averageTwo(getNetMetricValue(current, period.key, ["매출채권", "매출채권_양수"], ["매출채권_음수"]), getNetMetricValue(current, previous.key, ["매출채권", "매출채권_양수"], ["매출채권_음수"]))
          : null;
        return safeDivide(getAdjustedMetricSum(current, period.key, ["매출액"]), averageReceivables, 1);
      },
      ratioDetail: (period, current, result) => {
        const previous = getPreviousPeriod(current, period);
        const currentReceivables = getNetMetricValue(current, period.key, ["매출채권", "매출채권_양수"], ["매출채권_음수"]);
        const previousReceivables = previous ? getNetMetricValue(current, previous.key, ["매출채권", "매출채권_양수"], ["매출채권_음수"]) : null;
        const averageReceivables = previous ? averageTwo(currentReceivables, previousReceivables) : null;
        const sales = getAdjustedMetricSum(current, period.key, ["매출액"]);
        return createCalculationDetail("매출액 / 평균매출채권", result, [
          { label: "매출액", value: sales },
          { label: "당기 매출채권", value: currentReceivables },
          { label: "전기 매출채권", value: previousReceivables },
          { label: "평균매출채권", value: averageReceivables }
        ], !previous ? "직전 분기가 없어 평균매출채권을 계산하지 않았습니다." : averageReceivables === 0 ? "평균매출채권이 0이라 회전율을 계산하지 않았습니다." : undefined);
      }
    },
    {
      label: "매출채권회전기간",
      amount: (period, current) => {
        const previous = getPreviousPeriod(current, period);
        const averageReceivables = previous
          ? averageTwo(getNetMetricValue(current, period.key, ["매출채권", "매출채권_양수"], ["매출채권_음수"]), getNetMetricValue(current, previous.key, ["매출채권", "매출채권_양수"], ["매출채권_음수"]))
          : null;
        const turnover = safeDivide(getAdjustedMetricSum(current, period.key, ["매출액"]), averageReceivables, 1);
        return turnover ? 365 / turnover : null;
      },
      amountDetail: (period, current, result) => {
        const previous = getPreviousPeriod(current, period);
        const currentReceivables = getNetMetricValue(current, period.key, ["매출채권", "매출채권_양수"], ["매출채권_음수"]);
        const previousReceivables = previous ? getNetMetricValue(current, previous.key, ["매출채권", "매출채권_양수"], ["매출채권_음수"]) : null;
        const averageReceivables = previous ? averageTwo(currentReceivables, previousReceivables) : null;
        const sales = getAdjustedMetricSum(current, period.key, ["매출액"]);
        const turnover = safeDivide(sales, averageReceivables, 1);
        return createCalculationDetail("365 / 매출채권회전율", result, [
          { label: "매출액", value: sales },
          { label: "당기 매출채권", value: currentReceivables },
          { label: "전기 매출채권", value: previousReceivables },
          { label: "평균매출채권", value: averageReceivables },
          { label: "매출채권회전율", value: turnover }
        ], !previous ? "직전 분기가 없어 회전기간을 계산하지 않았습니다." : !turnover ? "회전율이 0 또는 비어 있어 기간을 계산하지 않았습니다." : undefined);
      }
    },
    {
      label: "재고자산회전율",
      ratio: (period, current) => {
        const previous = getPreviousPeriod(current, period);
        const averageInventory = previous
          ? averageTwo(getAdjustedMetricSum(current, period.key, ["재고자산"]), getAdjustedMetricSum(current, previous.key, ["재고자산"]))
          : null;
        return safeDivide(getAdjustedMetricSum(current, period.key, ["매출원가"]), averageInventory, 1);
      },
      ratioDetail: (period, current, result) => {
        const previous = getPreviousPeriod(current, period);
        const currentInventory = getAdjustedMetricSum(current, period.key, ["재고자산"]);
        const previousInventory = previous ? getAdjustedMetricSum(current, previous.key, ["재고자산"]) : null;
        const averageInventory = previous ? averageTwo(currentInventory, previousInventory) : null;
        const costOfSales = getAdjustedMetricSum(current, period.key, ["매출원가"]);
        return createCalculationDetail("매출원가 / 평균재고자산", result, [
          { label: "매출원가", value: costOfSales },
          { label: "당기 재고자산", value: currentInventory },
          { label: "전기 재고자산", value: previousInventory },
          { label: "평균재고자산", value: averageInventory }
        ], !previous ? "직전 분기가 없어 평균재고자산을 계산하지 않았습니다." : averageInventory === 0 ? "평균재고자산이 0이라 회전율을 계산하지 않았습니다." : undefined);
      }
    },
    {
      label: "재고자산회전기간",
      amount: (period, current) => {
        const previous = getPreviousPeriod(current, period);
        const averageInventory = previous
          ? averageTwo(getAdjustedMetricSum(current, period.key, ["재고자산"]), getAdjustedMetricSum(current, previous.key, ["재고자산"]))
          : null;
        const turnover = safeDivide(getAdjustedMetricSum(current, period.key, ["매출원가"]), averageInventory, 1);
        return turnover ? 365 / turnover : null;
      },
      amountDetail: (period, current, result) => {
        const previous = getPreviousPeriod(current, period);
        const currentInventory = getAdjustedMetricSum(current, period.key, ["재고자산"]);
        const previousInventory = previous ? getAdjustedMetricSum(current, previous.key, ["재고자산"]) : null;
        const averageInventory = previous ? averageTwo(currentInventory, previousInventory) : null;
        const costOfSales = getAdjustedMetricSum(current, period.key, ["매출원가"]);
        const turnover = safeDivide(costOfSales, averageInventory, 1);
        return createCalculationDetail("365 / 재고자산회전율", result, [
          { label: "매출원가", value: costOfSales },
          { label: "당기 재고자산", value: currentInventory },
          { label: "전기 재고자산", value: previousInventory },
          { label: "평균재고자산", value: averageInventory },
          { label: "재고자산회전율", value: turnover }
        ], !previous ? "직전 분기가 없어 회전기간을 계산하지 않았습니다." : !turnover ? "회전율이 0 또는 비어 있어 기간을 계산하지 않았습니다." : undefined);
      }
    },
    {
      label: "정상영업순환주기",
      amount: (period, current) => {
        const previous = getPreviousPeriod(current, period);
        const averageReceivables = previous
          ? averageTwo(getNetMetricValue(current, period.key, ["매출채권", "매출채권_양수"], ["매출채권_음수"]), getNetMetricValue(current, previous.key, ["매출채권", "매출채권_양수"], ["매출채권_음수"]))
          : null;
        const averageInventory = previous
          ? averageTwo(getAdjustedMetricSum(current, period.key, ["재고자산"]), getAdjustedMetricSum(current, previous.key, ["재고자산"]))
          : null;
        const receivableTurnover = safeDivide(getAdjustedMetricSum(current, period.key, ["매출액"]), averageReceivables, 1);
        const inventoryTurnover = safeDivide(getAdjustedMetricSum(current, period.key, ["매출원가"]), averageInventory, 1);
        const receivableDays = receivableTurnover ? 365 / receivableTurnover : null;
        const inventoryDays = inventoryTurnover ? 365 / inventoryTurnover : null;
        return receivableDays !== null && inventoryDays !== null ? receivableDays + inventoryDays : null;
      },
      amountDetail: (period, current, result) => {
        const previous = getPreviousPeriod(current, period);
        const currentReceivables = getNetMetricValue(current, period.key, ["매출채권", "매출채권_양수"], ["매출채권_음수"]);
        const previousReceivables = previous ? getNetMetricValue(current, previous.key, ["매출채권", "매출채권_양수"], ["매출채권_음수"]) : null;
        const averageReceivables = previous ? averageTwo(currentReceivables, previousReceivables) : null;
        const currentInventory = getAdjustedMetricSum(current, period.key, ["재고자산"]);
        const previousInventory = previous ? getAdjustedMetricSum(current, previous.key, ["재고자산"]) : null;
        const averageInventory = previous ? averageTwo(currentInventory, previousInventory) : null;
        const sales = getAdjustedMetricSum(current, period.key, ["매출액"]);
        const costOfSales = getAdjustedMetricSum(current, period.key, ["매출원가"]);
        const receivableTurnover = safeDivide(sales, averageReceivables, 1);
        const inventoryTurnover = safeDivide(costOfSales, averageInventory, 1);
        const receivableDays = receivableTurnover ? 365 / receivableTurnover : null;
        const inventoryDays = inventoryTurnover ? 365 / inventoryTurnover : null;
        return createCalculationDetail("매출채권회전기간 + 재고자산회전기간", result, [
          { label: "매출채권회전기간", value: receivableDays },
          { label: "재고자산회전기간", value: inventoryDays }
        ], !previous ? "직전 분기가 없어 영업순환주기를 계산하지 않았습니다." : undefined);
      }
    }
  ];

  const growthSpecs: MetricSpec[] = [
    {
      label: "매출액 증가율",
      ratio: (period, current) => {
        const previous = getPreviousPeriod(current, period);
        if (!previous) {
          return null;
        }
        const currentSales = getAdjustedMetricSum(current, period.key, ["매출액"]);
        const previousSales = getAdjustedMetricSum(current, previous.key, ["매출액"]);
        return currentSales !== null && previousSales !== null && previousSales !== 0
          ? ((currentSales - previousSales) / previousSales) * 100
          : null;
      },
      ratioDetail: (period, current, result) => {
        const previous = getPreviousPeriod(current, period);
        const currentSales = getAdjustedMetricSum(current, period.key, ["매출액"]);
        const previousSales = previous ? getAdjustedMetricSum(current, previous.key, ["매출액"]) : null;
        return createCalculationDetail("(당기 매출액 - 전기 매출액) / 전기 매출액 * 100", result, [
          { label: "당기 매출액", value: currentSales },
          { label: "전기 매출액", value: previousSales }
        ], !previous ? "직전 분기가 없어 증가율을 계산하지 않았습니다." : previousSales === 0 ? "전기 매출액이 0이라 증가율을 계산하지 않았습니다." : undefined);
      }
    },
    {
      label: "영업이익 증가율",
      ratio: (period, current) => {
        const previous = getPreviousPeriod(current, period);
        if (!previous) {
          return null;
        }
        const currentOperating = getAdjustedMetricSum(current, period.key, ["영업이익", "영업이익(손실)"]);
        const previousOperating = getAdjustedMetricSum(current, previous.key, ["영업이익", "영업이익(손실)"]);
        return currentOperating !== null && previousOperating !== null && previousOperating !== 0
          ? ((currentOperating - previousOperating) / previousOperating) * 100
          : null;
      },
      ratioDetail: (period, current, result) => {
        const previous = getPreviousPeriod(current, period);
        const currentOperating = getAdjustedMetricSum(current, period.key, ["영업이익", "영업이익(손실)"]);
        const previousOperating = previous ? getAdjustedMetricSum(current, previous.key, ["영업이익", "영업이익(손실)"]) : null;
        return createCalculationDetail("(당기 영업이익 - 전기 영업이익) / 전기 영업이익 * 100", result, [
          { label: "당기 영업이익", value: currentOperating },
          { label: "전기 영업이익", value: previousOperating }
        ], !previous ? "직전 분기가 없어 증가율을 계산하지 않았습니다." : previousOperating === 0 ? "전기 영업이익이 0이라 증가율을 계산하지 않았습니다." : undefined);
      }
    }
  ];

  return [
    { title: "핵심 지표", rows: buildMetricRows(context, [runwaySpec, ebitdaSpec, monthlyBurnSpec]) },
    { title: "비용 구조 분석", rows: buildMetricRows(context, costStructureSpecs) },
    { title: "자산/부채 분석", rows: buildMetricRows(context, assetLiabilitySpecs) },
    { title: "안정성 비율", rows: buildMetricRows(context, stabilitySpecs) },
    { title: "수익성 비율", rows: buildMetricRows(context, profitabilitySpecs) },
    { title: "활동성 비율", rows: buildMetricRows(context, activitySpecs) },
    { title: "성장성 비율", rows: buildMetricRows(context, growthSpecs) }
  ];
}

export function buildReportingModel(args: {
  pastedText: string;
  selectedCompany: string | null;
  tolerance?: number;
  logicConfig: LogicConfig;
  companyConfigs: CompanyConfigs;
  classificationGroups: ClassificationGroups;
  pasteEdits: Record<string, number>;
  sessionSignFixes: SessionSignFixes;
}) {
  const parsed = parsePastedText(args.pastedText);
  if (parsed.error || !parsed.nameRow.length || !parsed.dataRows.length) {
    return {
      detectedCompany: detectCompanyFromPaste(args.pastedText),
      companyName: args.selectedCompany,
      periods: [],
      rawStatementRows: [],
      adjustedStatementRows: [],
      finalSections: []
    } satisfies ReportingModel;
  }

  const detectedCompany = detectCompanyFromPaste(args.pastedText);
  const companyName = args.selectedCompany?.trim() || detectedCompany || null;
  const periods = buildPeriods(parsed.nameRow, parsed.dataRows);
  const metaRows = resolveRowMeta(parsed.catRow, parsed.nameRow, args.logicConfig, args.companyConfigs, args.classificationGroups, companyName, args.sessionSignFixes);
  const rawStatementRows = buildStatementRows(metaRows, periods, parsed.dataRows, args.pasteEdits, false);
  const adjustedStatementRows = buildStatementRows(metaRows, periods, parsed.dataRows, args.pasteEdits, true);
  const context: MetricContext = {
    periods,
      rawRows: rawStatementRows,
      adjustedRows: adjustedStatementRows,
      sectionTotals: getSectionTotals(adjustedStatementRows, periods),
      classificationGroups: args.classificationGroups
    };

  return {
    detectedCompany,
    companyName,
    periods,
    rawStatementRows,
    adjustedStatementRows,
    finalSections: buildFinalSections(context)
  } satisfies ReportingModel;
}

export function buildQuarterSnapshots(args: {
  pastedText: string;
  selectedCompany: string | null;
  tolerance: number;
  logicConfig: LogicConfig;
  companyConfigs: CompanyConfigs;
  classificationGroups: ClassificationGroups;
  pasteEdits: Record<string, number>;
  sessionSignFixes: SessionSignFixes;
}) {
  const reporting = buildReportingModel(args);
  const companyName = args.selectedCompany?.trim() || reporting.companyName || reporting.detectedCompany || "미지정 회사";

  return reporting.periods.map((period) => ({
    id: `${companyName}__${period.label}`,
    companyName,
    quarterKey: period.key,
    quarterLabel: period.label,
    savedAt: new Date().toISOString(),
    rawStatementRows: reporting.rawStatementRows.map((row) => ({
      signFlag: row.signFlag,
      section: row.section,
      sectionKey: row.sectionKey,
      accountName: row.accountName,
      canonicalKey: row.canonicalKey,
      value: row.values[period.key] ?? null
    })),
    adjustedStatementRows: reporting.adjustedStatementRows.map((row) => ({
      signFlag: row.signFlag,
      section: row.section,
      sectionKey: row.sectionKey,
      accountName: row.accountName,
      canonicalKey: row.canonicalKey,
      value: row.values[period.key] ?? null
    })),
    source: {
      pastedText: args.pastedText,
      tolerance: args.tolerance,
      pasteEdits: { ...args.pasteEdits },
      sessionSignFixes: structuredClone(args.sessionSignFixes),
      logicConfig: structuredClone(args.logicConfig),
      companyConfigs: structuredClone(args.companyConfigs),
      classificationGroups: structuredClone(args.classificationGroups)
    }
  } satisfies SavedQuarterSnapshot));
}

export function buildCompanyReport(snapshots: SavedQuarterSnapshot[]) {
  if (!snapshots.length) {
    return {
      detectedCompany: null,
      companyName: null,
      periods: [],
      rawStatementRows: [],
      adjustedStatementRows: [],
      finalSections: []
    } satisfies ReportingModel;
  }

  const periods = snapshots
    .map((snapshot) => ({
      key: snapshot.quarterKey,
      label: snapshot.quarterLabel,
      rawLabel: snapshot.quarterLabel,
      date: parseDate(snapshot.quarterLabel),
      monthsElapsed: parseDate(snapshot.quarterLabel) ? Math.max(parseDate(snapshot.quarterLabel)!.getMonth() + 1, 1) : 12,
      rowIndex: 0
    }))
    .sort((a, b) => {
      if (a.date && b.date) {
        return b.date.getTime() - a.date.getTime();
      }
      return a.label.localeCompare(b.label);
    });

  const buildMatrix = (kind: "rawStatementRows" | "adjustedStatementRows") => {
    const rowMap = new Map<string, StatementMatrixRow>();
    snapshots.forEach((snapshot) => {
      snapshot[kind].forEach((row) => {
        const key = buildRowIdentityKey(row.sectionKey, row.canonicalKey, row.accountName);
        if (!rowMap.has(key)) {
          rowMap.set(key, {
            signFlag: row.signFlag,
            section: row.section,
            sectionKey: row.sectionKey,
            accountName: row.accountName,
            canonicalKey: row.canonicalKey,
            values: Object.fromEntries(periods.map((period) => [period.key, null]))
          });
        }
        const current = rowMap.get(key)!;
        current.values[snapshot.quarterKey] = (current.values[snapshot.quarterKey] ?? 0) + (row.value ?? 0);
      });
    });
    return Array.from(rowMap.values());
  };

  const rawStatementRows = buildMatrix("rawStatementRows");
  const adjustedStatementRows = buildMatrix("adjustedStatementRows");
  const context: MetricContext = {
    periods,
    rawRows: rawStatementRows,
    adjustedRows: adjustedStatementRows,
    sectionTotals: getSectionTotals(adjustedStatementRows, periods),
      classificationGroups: snapshots[0]?.source?.classificationGroups ?? structuredClone(DEFAULT_CLASSIFICATION_GROUPS)
  };

  return {
    detectedCompany: snapshots[0].companyName,
    companyName: snapshots[0].companyName,
    periods,
    rawStatementRows,
    adjustedStatementRows,
    finalSections: buildFinalSections(context)
  } satisfies ReportingModel;
}

export function formatMetricValue(row: FinalMetricRow, value: number | null) {
  if (value === null || value === undefined) {
    return "-";
  }

  if (row.label === "런웨이(E)") {
    return `${value.toFixed(2)}개월`;
  }

  return formatNumber(value);
}

export function formatMetricRatio(value: number | null) {
  if (value === null || value === undefined) {
    return "-";
  }

  return `${value.toFixed(1)}%`;
}
