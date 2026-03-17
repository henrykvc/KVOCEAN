import { ACCOUNT_ALIASES, type CompanyConfigs, type LogicConfig, type SignCode } from "./defaults";
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
  accountName: string;
  values: Record<string, number | null>;
};

export type FinalMetricRow = {
  label: string;
  amounts: Record<string, number | null>;
  ratios: Record<string, number | null>;
  growthRates: Record<string, number | null>;
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
  rawStatementRows: Array<{ signFlag: 0 | 1; section: string; accountName: string; value: number | null }>;
  adjustedStatementRows: Array<{ signFlag: 0 | 1; section: string; accountName: string; value: number | null }>;
  source: {
    pastedText: string;
    tolerance: number;
    pasteEdits: Record<string, number>;
    sessionSignFixes: SessionSignFixes;
    logicConfig: LogicConfig;
    companyConfigs: CompanyConfigs;
  };
};

type RowMeta = {
  accountName: string;
  section: string;
  signFlag: 0 | 1;
  signCode: SignCode;
  sourceCol: number;
};

type MetricContext = {
  periods: ReportPeriod[];
  rawRows: StatementMatrixRow[];
  adjustedRows: StatementMatrixRow[];
  sectionTotals: Map<string, Record<string, number>>;
};

type MetricSpec = {
  label: string;
  amount?: (period: ReportPeriod, context: MetricContext) => number | null;
  ratio?: (period: ReportPeriod, context: MetricContext) => number | null;
};

const DEPRECIATION_ALIASES = ["감가상각비", "무형자산상각비", "사용권자산상각비"];
const COST_STRUCTURE_ITEMS = ["인건비", "광고선전비", "연구개발비", "접대비", "복리후생비", "지급수수료", "외주용역비", "임차료", "총이자비용"];
const ASSET_LIABILITY_ITEMS = ["현금및현금성자산", "매도가능증권", "단기대여금", "개발비(자산)", "선급금", "가수금", "가지급금", "퇴직급여충당부채(자산)"];
const VARIABLE_COST_ALIASES = ["매출원가", "외주용역비", "외주비", "지급수수료", "광고선전비", "배송비", "운반비"];
const BORROWING_ALIASES = ["차입금", "단기차입금", "장기차입금", "유동성장기차입금", "사채"];
const INTEREST_ALIASES = ["총이자비용", "이자비용", "금융비용"];

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
    let signCode = inferSignFromName(accountName, logicConfig) ?? 0;

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
        accountName: meta.accountName,
        values
      } satisfies StatementMatrixRow;
    });
}

function getRowValues(rows: StatementMatrixRow[], periodKey: string, candidates: string[], sectionName?: string) {
  const matches = rows.filter((row) => {
    const byName = candidates.some((candidate) => row.accountName === candidate || row.accountName.includes(candidate));
    const bySection = !sectionName || row.section === sectionName;
    return byName && bySection;
  });

  return matches
    .map((row) => row.values[periodKey])
    .filter((value): value is number => value !== null && value !== undefined);
}

function getSectionTotals(rows: StatementMatrixRow[], periods: ReportPeriod[]) {
  const totals = new Map<string, Record<string, number>>();
  rows.forEach((row) => {
    const current = totals.get(row.section) ?? Object.fromEntries(periods.map((period) => [period.key, 0]));
    periods.forEach((period) => {
      current[period.key] += row.values[period.key] ?? 0;
    });
    totals.set(row.section, current);
  });
  return totals;
}

function firstAvailableValue(rows: StatementMatrixRow[], periodKey: string, candidates: string[], sectionName?: string) {
  const values = getRowValues(rows, periodKey, candidates, sectionName);
  return values[0] ?? null;
}

function sumValues(rows: StatementMatrixRow[], periodKey: string, candidates: string[], sectionName?: string) {
  const values = getRowValues(rows, periodKey, candidates, sectionName);
  if (!values.length) {
    return null;
  }
  return values.reduce((total, value) => total + value, 0);
}

function getMetricValue(context: MetricContext, periodKey: string, names: string[]) {
  return firstAvailableValue(context.adjustedRows, periodKey, names);
}

function getMetricSum(context: MetricContext, periodKey: string, names: string[]) {
  return sumValues(context.adjustedRows, periodKey, names);
}

function getRawMetricValue(context: MetricContext, periodKey: string, names: string[], sectionName?: string) {
  return firstAvailableValue(context.rawRows, periodKey, names, sectionName);
}

function getAdjustedMetricValue(context: MetricContext, periodKey: string, names: string[], sectionName?: string) {
  return firstAvailableValue(context.adjustedRows, periodKey, names, sectionName);
}

function getAdjustedMetricSum(context: MetricContext, periodKey: string, names: string[], sectionName?: string) {
  return sumValues(context.adjustedRows, periodKey, names, sectionName);
}

function safeDivide(numerator: number | null, denominator: number | null, multiplier = 1) {
  if (numerator === null || denominator === null || denominator === 0) {
    return null;
  }
  return (numerator / denominator) * multiplier;
}

function buildMetricRows(context: MetricContext, specs: MetricSpec[]) {
  return specs.map((spec) => {
    const amounts: Record<string, number | null> = {};
    const ratios: Record<string, number | null> = {};
    const growthRates: Record<string, number | null> = {};

    context.periods.forEach((period, index) => {
      const currentAmount = spec.amount ? spec.amount(period, context) : null;
      const currentRatio = spec.ratio ? spec.ratio(period, context) : null;
      amounts[period.key] = currentAmount;
      ratios[period.key] = currentRatio;

      const previous = context.periods[index + 1];
      const previousAmount = previous && spec.amount ? spec.amount(previous, context) : null;
      growthRates[period.key] = currentAmount !== null && previousAmount !== null && previousAmount !== 0
        ? ((currentAmount - previousAmount) / Math.abs(previousAmount)) * 100
        : null;
    });

    return {
      label: spec.label,
      amounts,
      ratios,
      growthRates
    } satisfies FinalMetricRow;
  });
}

function buildFinalSections(context: MetricContext): FinalMetricSection[] {
  const amountMetric = (label: string, names: string[]): MetricSpec => ({
    label,
    amount: (period, current) => getRawMetricValue(current, period.key, names)
  });

  const runwaySpec: MetricSpec = {
    label: "런웨이(E)",
    amount: (period, current) => {
      const cash = getMetricValue(current, period.key, ["현금및현금성자산"]);
      const sales = getMetricValue(current, period.key, ["매출액"]);
      const cogs = getMetricValue(current, period.key, ["매출원가"]);
      const sga = getMetricValue(current, period.key, ["판매비와관리비", "판관비"]);
      const depreciation = getMetricSum(current, period.key, DEPRECIATION_ALIASES);
      if ([cash, sales, cogs, sga].some((value) => value === null)) {
        return null;
      }
      const burnBase = (cogs ?? 0) + (sga ?? 0) - (depreciation ?? 0);
      return burnBase > 0 ? (cash ?? 0) * period.monthsElapsed / burnBase : null;
    }
  };

  const ebitdaSpec: MetricSpec = {
    label: "EBITDA",
    amount: (period, current) => {
      const sales = getMetricValue(current, period.key, ["매출액"]);
      const cogs = getMetricValue(current, period.key, ["매출원가"]);
      const sga = getMetricValue(current, period.key, ["판매비와관리비", "판관비"]);
      const depreciation = getMetricSum(current, period.key, DEPRECIATION_ALIASES);
      if ([sales, cogs, sga].some((value) => value === null)) {
        return null;
      }
      return (sales ?? 0) - (cogs ?? 0) - (sga ?? 0) + (depreciation ?? 0);
    }
  };

  const costStructureSpecs = COST_STRUCTURE_ITEMS.map((label) => ({
    label,
    amount: (period: ReportPeriod, current: MetricContext) => getRawMetricValue(current, period.key, [label]),
    ratio: label === "총이자비용" ? undefined : (period: ReportPeriod, current: MetricContext) => {
      const value = getMetricValue(current, period.key, [label]);
      const expenseTotal = (current.sectionTotals.get("판매비와관리비")?.[period.key] ?? 0) + (current.sectionTotals.get("영업외비용")?.[period.key] ?? 0);
      return safeDivide(value, expenseTotal, 100);
    }
  } satisfies MetricSpec));

  const stabilitySpecs: MetricSpec[] = [
    {
      label: "유동비율",
      ratio: (period, current) => safeDivide(getMetricValue(current, period.key, ["유동자산"]), getMetricValue(current, period.key, ["유동부채"]), 100)
    },
    {
      label: "당좌비율",
      ratio: (period, current) => {
        const currentAssets = getMetricValue(current, period.key, ["유동자산"]);
        const inventories = getMetricValue(current, period.key, ["재고자산"]);
        const currentLiabilities = getMetricValue(current, period.key, ["유동부채"]);
        return safeDivide(currentAssets !== null ? currentAssets - (inventories ?? 0) : null, currentLiabilities, 100);
      }
    },
    {
      label: "부채비율",
      ratio: (period, current) => safeDivide(getMetricValue(current, period.key, ["부채"]), getMetricValue(current, period.key, ["자본"]), 100)
    },
    {
      label: "차입금 의존도",
      ratio: (period, current) => safeDivide(getMetricSum(current, period.key, BORROWING_ALIASES), getMetricValue(current, period.key, ["자산"]), 100)
    },
    {
      label: "이자보상비율",
      ratio: (period, current) => safeDivide(getMetricValue(current, period.key, ["영업이익"]), getMetricSum(current, period.key, INTEREST_ALIASES), 1)
    }
  ];

  const profitabilitySpecs: MetricSpec[] = [
    {
      label: "매출액순이익률",
      ratio: (period, current) => safeDivide(getMetricValue(current, period.key, ["당기순이익"]), getMetricValue(current, period.key, ["매출액"]), 100)
    },
    {
      label: "총자산이익률",
      ratio: (period, current) => safeDivide(getMetricValue(current, period.key, ["당기순이익"]), getMetricValue(current, period.key, ["자산"]), 100)
    },
    {
      label: "자기자본이익률",
      ratio: (period, current) => safeDivide(getMetricValue(current, period.key, ["당기순이익"]), getMetricValue(current, period.key, ["자본"]), 100)
    },
    {
      label: "영업이익률",
      ratio: (period, current) => safeDivide(getMetricValue(current, period.key, ["영업이익"]), getMetricValue(current, period.key, ["매출액"]), 100)
    },
    {
      label: "공헌이익률",
      ratio: (period, current) => {
        const sales = getMetricValue(current, period.key, ["매출액"]);
        const variableCosts = getMetricSum(current, period.key, VARIABLE_COST_ALIASES);
        return safeDivide(sales !== null ? sales - (variableCosts ?? 0) : null, sales, 100);
      }
    }
  ];

  const activitySpecs: MetricSpec[] = [
    {
      label: "총자산회전율",
      ratio: (period, current) => safeDivide(getMetricValue(current, period.key, ["매출액"]), getMetricValue(current, period.key, ["자산"]), 1)
    },
    {
      label: "매출채권회전율",
      ratio: (period, current) => safeDivide(getMetricValue(current, period.key, ["매출액"]), getMetricValue(current, period.key, ["매출채권"]), 1)
    },
    {
      label: "매출채권회전기간",
      amount: (period, current) => {
        const turnover = safeDivide(getMetricValue(current, period.key, ["매출액"]), getMetricValue(current, period.key, ["매출채권"]), 1);
        return turnover ? 365 / turnover : null;
      }
    },
    {
      label: "재고자산회전율",
      ratio: (period, current) => safeDivide(getMetricValue(current, period.key, ["매출원가"]), getMetricValue(current, period.key, ["재고자산"]), 1)
    },
    {
      label: "재고자산회전기간",
      amount: (period, current) => {
        const turnover = safeDivide(getMetricValue(current, period.key, ["매출원가"]), getMetricValue(current, period.key, ["재고자산"]), 1);
        return turnover ? 365 / turnover : null;
      }
    },
    {
      label: "정상영업순환주기",
      amount: (period, current) => {
        const receivableTurnover = safeDivide(getMetricValue(current, period.key, ["매출액"]), getMetricValue(current, period.key, ["매출채권"]), 1);
        const inventoryTurnover = safeDivide(getMetricValue(current, period.key, ["매출원가"]), getMetricValue(current, period.key, ["재고자산"]), 1);
        const receivableDays = receivableTurnover ? 365 / receivableTurnover : null;
        const inventoryDays = inventoryTurnover ? 365 / inventoryTurnover : null;
        return receivableDays !== null && inventoryDays !== null ? receivableDays + inventoryDays : null;
      }
    }
  ];

  const growthSpecs: MetricSpec[] = [
    amountMetric("매출액증가율", ["매출액"]),
    amountMetric("영업이익증가율", ["영업이익"])
  ];

  return [
    { title: "핵심 지표", rows: buildMetricRows(context, [runwaySpec, ebitdaSpec]) },
    { title: "비용 구조 분석", rows: buildMetricRows(context, costStructureSpecs) },
    { title: "자산/부채 분석", rows: buildMetricRows(context, ASSET_LIABILITY_ITEMS.map((label) => amountMetric(label, [label]))) },
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
  const metaRows = resolveRowMeta(parsed.catRow, parsed.nameRow, args.logicConfig, args.companyConfigs, companyName, args.sessionSignFixes);
  const rawStatementRows = buildStatementRows(metaRows, periods, parsed.dataRows, args.pasteEdits, false);
  const adjustedStatementRows = buildStatementRows(metaRows, periods, parsed.dataRows, args.pasteEdits, true);
  const context: MetricContext = {
    periods,
    rawRows: rawStatementRows,
    adjustedRows: adjustedStatementRows,
    sectionTotals: getSectionTotals(adjustedStatementRows, periods)
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
      accountName: row.accountName,
      value: row.values[period.key] ?? null
    })),
    adjustedStatementRows: reporting.adjustedStatementRows.map((row) => ({
      signFlag: row.signFlag,
      section: row.section,
      accountName: row.accountName,
      value: row.values[period.key] ?? null
    })),
    source: {
      pastedText: args.pastedText,
      tolerance: args.tolerance,
      pasteEdits: { ...args.pasteEdits },
      sessionSignFixes: structuredClone(args.sessionSignFixes),
      logicConfig: structuredClone(args.logicConfig),
      companyConfigs: structuredClone(args.companyConfigs)
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
        const key = `${row.section}__${row.accountName}`;
        if (!rowMap.has(key)) {
          rowMap.set(key, {
            signFlag: row.signFlag,
            section: row.section,
            accountName: row.accountName,
            values: Object.fromEntries(periods.map((period) => [period.key, null]))
          });
        }
        rowMap.get(key)!.values[snapshot.quarterKey] = row.value;
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
    sectionTotals: getSectionTotals(adjustedStatementRows, periods)
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

  return formatNumber(value);
}

export function formatMetricRatio(value: number | null) {
  if (value === null || value === undefined) {
    return "-";
  }

  return `${value.toFixed(1)}%`;
}
