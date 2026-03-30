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
  sourceCanonicalKey?: string;
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
  components?: MetricCalculationInput[];
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
  detailAdjustedStatementRows: StatementMatrixRow[];
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
const DERIVED_ACCOUNT_SUFFIXES = [
  "양수",
  "음수",
  "정부보조금",
  "국고보조금",
  "국가보조금",
  "대손충당금",
  "현할차",
  "할인차금",
  "할증차금",
  "전환권조정",
  "신주인수권조정",
  "손상차손누계",
  "감가상각누계",
  "상환할증금",
  "누계액"
] as const;

const NET_NEGATIVE_SUFFIXES = new Set([
  "음수",
  "정부보조금",
  "국고보조금",
  "국가보조금",
  "대손충당금",
  "현할차",
  "할인차금",
  "할증차금",
  "전환권조정",
  "신주인수권조정",
  "손상차손누계",
  "감가상각누계",
  "상환할증금",
  "누계액"
]);

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

function stripDerivedSuffix(accountName: string) {
  const trimmed = accountName.trim();

  for (const suffix of DERIVED_ACCOUNT_SUFFIXES) {
    if (trimmed.endsWith(`_${suffix}`)) {
      return {
        baseName: trimmed.slice(0, -(suffix.length + 1)).trim(),
        suffix
      };
    }

    if (trimmed.endsWith(suffix) && trimmed.length > suffix.length) {
      return {
        baseName: trimmed.slice(0, -suffix.length).trim(),
        suffix
      };
    }
  }

  return null;
}

function resolveBaseCanonicalAccountKey(accountName: string, sectionKey: string, classificationGroups: ClassificationGroups) {
  const normalizedName = normalizeText(accountName);

  for (const canonicalKey of Object.keys(classificationGroups)) {
    if (normalizedName === normalizeText(canonicalKey)) {
      return canonicalKey;
    }
  }

  for (const canonicalKey of Object.keys(ACCOUNT_ALIASES)) {
    if (normalizedName === normalizeText(canonicalKey)) {
      return canonicalKey;
    }
  }

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

function resolveCanonicalAccountKey(accountName: string, sectionKey: string, classificationGroups: ClassificationGroups) {
  const derived = stripDerivedSuffix(accountName);
  if (derived?.baseName) {
    const baseCanonicalKey = resolveBaseCanonicalAccountKey(derived.baseName, sectionKey, classificationGroups);
    return `${baseCanonicalKey}_${derived.suffix}`;
  }

  return resolveBaseCanonicalAccountKey(accountName, sectionKey, classificationGroups);
}

function buildDerivedMetricCandidates(names: string[]) {
  const candidates = new Set<string>();

  names.forEach((name) => {
    candidates.add(name);
    if (DERIVED_ACCOUNT_SUFFIXES.some((suffix) => name.endsWith(`_${suffix}`) || name.endsWith(suffix))) {
      return;
    }
    DERIVED_ACCOUNT_SUFFIXES.forEach((suffix) => {
      candidates.add(`${name}_${suffix}`);
    });
  });

  return Array.from(candidates);
}

function buildMetricCandidateSet(names: string[], classificationGroups: ClassificationGroups) {
  const candidates = new Set<string>();

  buildDerivedMetricCandidates(names).forEach((candidate) => {
    candidates.add(normalizeText(candidate));
    (classificationGroups[candidate] ?? ACCOUNT_ALIASES[candidate] ?? []).forEach((alias) => {
      candidates.add(normalizeText(alias));
    });
  });

  names.forEach((name) => {
    (classificationGroups[name] ?? ACCOUNT_ALIASES[name] ?? []).forEach((alias) => {
      candidates.add(normalizeText(alias));
      const derived = resolveCanonicalAccountKey(alias, "기타", classificationGroups);
      candidates.add(normalizeText(derived));
    });
  });

  return candidates;
}

function getNetMetricRows(context: MetricContext, names: string[]) {
  const candidateSet = buildMetricCandidateSet(names, context.classificationGroups);
  return context.adjustedRows.filter((row) => {
    const rowKey = normalizeText(row.canonicalKey || row.accountName);
    const rowName = normalizeText(row.accountName);
    return candidateSet.has(rowKey) || candidateSet.has(rowName);
  });
}

function isNegativeNetRow(row: StatementMatrixRow) {
  const rowKey = (row.canonicalKey || row.accountName).trim();
  const derived = stripDerivedSuffix(rowKey) ?? stripDerivedSuffix(row.accountName);
  return Boolean(derived?.suffix && NET_NEGATIVE_SUFFIXES.has(derived.suffix as typeof DERIVED_ACCOUNT_SUFFIXES[number]));
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
    let signCode = inferSignFromName(accountName, logicConfig, section) ?? 0;
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
        sourceCanonicalKey: meta.canonicalKey,
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

  return applyCanonicalBucketPrecedence(matches)
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

function applyCanonicalBucketPrecedence(rows: StatementMatrixRow[]) {
  const buckets = new Map<string, StatementMatrixRow[]>();

  rows.forEach((row) => {
    const bucketKey = `${normalizeText(row.sectionKey)}__${normalizeText(row.canonicalKey || row.accountName)}`;
    const bucket = buckets.get(bucketKey) ?? [];
    bucket.push(row);
    buckets.set(bucketKey, bucket);
  });

  return Array.from(buckets.values()).flatMap((bucket) => {
    const exactNameRows = bucket.filter((row) => {
      const activeKey = normalizeText(row.canonicalKey || row.accountName);
      const rowName = normalizeText(row.accountName);
      return activeKey === rowName;
    });

    if (exactNameRows.length) {
      return exactNameRows;
    }

    const nativeRows = bucket.filter((row) => {
      const activeKey = normalizeText(row.canonicalKey || row.accountName);
      const sourceKey = normalizeText(row.sourceCanonicalKey || row.canonicalKey || row.accountName);
      return activeKey === sourceKey;
    });

    return nativeRows.length ? nativeRows : bucket;
  });
}

function pickPreferredRow(rows: StatementMatrixRow[], preferredSections: string[]) {
  const sorted = [...rows].sort((a, b) => {
    const aPreferred = preferredSections.includes(a.sectionKey) ? 1 : 0;
    const bPreferred = preferredSections.includes(b.sectionKey) ? 1 : 0;
    if (aPreferred !== bPreferred) {
      return bPreferred - aPreferred;
    }
    return a.sectionKey.localeCompare(b.sectionKey);
  });
  return sorted[0] ?? null;
}

function applyClassifiedBucketPrecedence(rows: StatementMatrixRow[], preferredSections: string[]) {
  const buckets = new Map<string, StatementMatrixRow[]>();

  rows.forEach((row) => {
    const bucketKey = normalizeText(row.canonicalKey || row.accountName);
    const bucket = buckets.get(bucketKey) ?? [];
    bucket.push(row);
    buckets.set(bucketKey, bucket);
  });

  return Array.from(buckets.values()).flatMap((bucket) => {
    const exactNameRows = bucket.filter((row) => normalizeText(row.accountName) === normalizeText(row.canonicalKey || row.accountName));
    if (exactNameRows.length) {
      const picked = pickPreferredRow(exactNameRows, preferredSections);
      return picked ? [picked] : [];
    }

    const nativeRows = bucket.filter((row) => {
      const activeKey = normalizeText(row.canonicalKey || row.accountName);
      const sourceKey = normalizeText(row.sourceCanonicalKey || row.canonicalKey || row.accountName);
      return activeKey === sourceKey;
    });

    if (nativeRows.length) {
      const picked = pickPreferredRow(nativeRows, preferredSections);
      return picked ? [picked] : [];
    }

    return bucket;
  });
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

function buildClassifiedCandidateSet(candidates: string[], classificationGroups: ClassificationGroups, sectionName?: string) {
  const sectionKey = normalizeSectionKey(sectionName ?? "기타");
  const values = new Set<string>();

  candidates
    .filter((candidate) => Boolean(classificationGroups[candidate]))
    .forEach((candidate) => {
      values.add(normalizeText(candidate));
      for (const alias of classificationGroups[candidate] ?? []) {
        values.add(normalizeText(alias));
        values.add(normalizeText(resolveCanonicalAccountKey(alias, sectionKey, classificationGroups)));
      }
    });

  return values;
}

function sumClassifiedValues(rows: StatementMatrixRow[], periodKey: string, candidates: string[], sectionName: string | undefined, classificationGroups: ClassificationGroups) {
  const canonicalCandidates = buildClassifiedCandidateSet(candidates, classificationGroups, sectionName);
  const canonicalSection = sectionName ? normalizeSectionKey(sectionName) : null;
  const preferredSections = sectionName ? [canonicalSection!].filter(Boolean) : getPreferredSectionKeys(candidates);
  const values = applyClassifiedBucketPrecedence(rows
    .filter((row) => {
      const rowKey = normalizeText(row.canonicalKey || row.accountName);
      const rowName = normalizeText(row.accountName);
      const byName = canonicalCandidates.has(rowKey) || canonicalCandidates.has(rowName);
      const bySection = !canonicalSection || row.sectionKey === canonicalSection || normalizeSectionKey(row.section) === canonicalSection;
      return byName && bySection;
    })
    , preferredSections).sort((a, b) => {
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

function getClassifiedRows(rows: StatementMatrixRow[], candidates: string[], sectionName: string | undefined, classificationGroups: ClassificationGroups) {
  const canonicalCandidates = buildClassifiedCandidateSet(candidates, classificationGroups, sectionName);
  const canonicalSection = sectionName ? normalizeSectionKey(sectionName) : null;

  return applyClassifiedBucketPrecedence(rows.filter((row) => {
    const rowKey = normalizeText(row.canonicalKey || row.accountName);
    const rowName = normalizeText(row.accountName);
    const byName = canonicalCandidates.has(rowKey) || canonicalCandidates.has(rowName);
    const bySection = !canonicalSection || row.sectionKey === canonicalSection || normalizeSectionKey(row.section) === canonicalSection;
    return byName && bySection;
  }), getPreferredSectionKeys(candidates));
}

function getClassifiedMetricBreakdown(context: MetricContext, periodKey: string, names: string[], sectionName?: string) {
  return getClassifiedRows(context.adjustedRows, names, sectionName, context.classificationGroups)
    .map<MetricCalculationInput | null>((row) => {
      const value = row.values[periodKey];
      if (value === null || value === undefined) {
        return null;
      }

      const label = row.accountName === row.canonicalKey
        ? row.accountName
        : `${row.canonicalKey} ← ${row.accountName}`;

      return { label, value } satisfies MetricCalculationInput;
    })
    .filter((item): item is MetricCalculationInput => item !== null);
}

function compactCalculationInputs(inputs: Array<MetricCalculationInput | null>) {
  return inputs.filter((item): item is MetricCalculationInput => item !== null && item.value !== null && item.value !== undefined);
}

function getNetMetricBreakdown(context: MetricContext, periodKey: string, names: string[]) {
  return getNetMetricRows(context, names)
    .map<MetricCalculationInput | null>((row) => {
      const value = row.values[periodKey];
      if (value === null || value === undefined) {
        return null;
      }

      const label = row.accountName === row.canonicalKey
        ? row.accountName
        : `${row.canonicalKey} ← ${row.accountName}`;

      return {
        label,
        value: isNegativeNetRow(row) ? -Math.abs(value) : value
      } satisfies MetricCalculationInput;
    })
    .filter((item): item is MetricCalculationInput => item !== null);
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

function getPreferredQuickAssets(context: MetricContext, periodKey: string) {
  const cash = getAdjustedMetricSum(context, periodKey, ["현금및현금성자산"]);
  const receivables = getNetMetricValue(context, periodKey, ["매출채권"]);
  const accruedReceivables = getNetMetricValue(context, periodKey, ["미수금"]);
  const accruedIncome = getNetMetricValue(context, periodKey, ["미수수익"]);
  const availableSecurities = getAdjustedMetricSum(context, periodKey, ["매도가능증권"]);

  const explicitQuickAssets = [cash, receivables, accruedReceivables, accruedIncome, availableSecurities]
    .filter((value): value is number => value !== null && value !== undefined);

  if (explicitQuickAssets.length) {
    return explicitQuickAssets.reduce((total, value) => total + value, 0);
  }

  const currentAssets = getPreferredCurrentAssets(context, periodKey);
  const inventory = getNetMetricValue(context, periodKey, ["재고자산"]);
  if (currentAssets === null) {
    return null;
  }

  return currentAssets - (inventory ?? 0);
}

function getQuickAssetBreakdown(context: MetricContext, periodKey: string) {
  const explicitBreakdown = compactCalculationInputs([
    {
      label: "현금및현금성자산",
      value: getAdjustedMetricSum(context, periodKey, ["현금및현금성자산"]),
      components: getNetMetricBreakdown(context, periodKey, ["현금및현금성자산"])
    },
    {
      label: "매출채권 순액",
      value: getNetMetricValue(context, periodKey, ["매출채권"]),
      components: getNetMetricBreakdown(context, periodKey, ["매출채권"])
    },
    {
      label: "미수금 순액",
      value: getNetMetricValue(context, periodKey, ["미수금"]),
      components: getNetMetricBreakdown(context, periodKey, ["미수금"])
    },
    {
      label: "미수수익 순액",
      value: getNetMetricValue(context, periodKey, ["미수수익"]),
      components: getNetMetricBreakdown(context, periodKey, ["미수수익"])
    },
    {
      label: "매도가능증권",
      value: getAdjustedMetricSum(context, periodKey, ["매도가능증권"]),
      components: getNetMetricBreakdown(context, periodKey, ["매도가능증권"])
    }
  ]);

  if (explicitBreakdown.length) {
    return explicitBreakdown;
  }

  return [
    {
      label: "유동자산",
      value: getPreferredCurrentAssets(context, periodKey),
      components: getClassifiedMetricBreakdown(context, periodKey, ["유동자산"], "재무상태표")
    },
    {
      label: "차감: 재고자산",
      value: getNetMetricValue(context, periodKey, ["재고자산"]),
      components: getNetMetricBreakdown(context, periodKey, ["재고자산"])
    }
  ];
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

function getPeriodOffset(context: MetricContext, period: ReportPeriod, offset: number) {
  const index = context.periods.findIndex((item) => item.key === period.key);
  return index >= 0 ? context.periods[index + offset] ?? null : null;
}

function getThreeQuarterPriorPeriod(context: MetricContext, period: ReportPeriod) {
  return getPeriodOffset(context, period, 3);
}

function getMonthlySpendBase(current: MetricContext, period: ReportPeriod) {
  const sales = getAdjustedMetricValue(current, period.key, ["매출액"]);
  const operatingIncome = getAdjustedMetricValue(current, period.key, ["영업이익", "영업이익(손실)"]);
  const depreciation = getAdjustedMetricSum(current, period.key, DEPRECIATION_ALIASES);

  if ([sales, operatingIncome].some((value) => value === null)) {
    return {
      sales,
      operatingIncome,
      depreciation,
      totalSpend: null,
      monthlySpend: null
    };
  }

  const totalSpend = (sales ?? 0) - (operatingIncome ?? 0) - (depreciation ?? 0);
  return {
    sales,
    operatingIncome,
    depreciation,
    totalSpend,
    monthlySpend: period.monthsElapsed > 0 ? totalSpend / period.monthsElapsed : null
  };
}

function getNetMetricValue(context: MetricContext, periodKey: string, names: string[]) {
  const rows = getNetMetricRows(context, names);
  if (!rows.length) {
    return null;
  }

  const total = rows.reduce<number | null>((sum, row) => {
    const value = row.values[periodKey];
    if (value === null || value === undefined) {
      return sum;
    }

    const signedValue = isNegativeNetRow(row) ? -Math.abs(value) : value;
    return (sum ?? 0) + signedValue;
  }, null);

  return total;
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
      const previousRatio = previous && spec.ratio ? spec.ratio(previous, context) : null;
      const growthBaseCurrent = currentAmount ?? currentRatio;
      const growthBasePrevious = previousAmount ?? previousRatio;
      const growthLabel = currentAmount !== null || previousAmount !== null ? "금액" : "비율";
      growthRates[period.key] = growthBaseCurrent !== null && growthBasePrevious !== null && growthBasePrevious !== 0
        ? ((growthBaseCurrent - growthBasePrevious) / Math.abs(growthBasePrevious)) * 100
        : null;

      if (spec.amount || spec.ratio) {
        details[period.key].growthRate = createCalculationDetail(
          `(당기 ${growthLabel} - 전분기 ${growthLabel}) / |전분기 ${growthLabel}| * 100`,
          growthRates[period.key],
          [
            { label: `당기 ${growthLabel}`, value: growthBaseCurrent },
            { label: previous ? `전분기 ${growthLabel}` : `비교 전분기 ${growthLabel}`, value: growthBasePrevious }
          ],
          !previous
            ? "이전 분기가 없어 증감율을 계산하지 않았습니다."
            : growthBasePrevious === 0
              ? `전분기 ${growthLabel}이 0이라 증감율을 계산하지 않았습니다.`
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
      const monthlySpendBase = getMonthlySpendBase(current, period);
      if (cash === null || monthlySpendBase.monthlySpend === null || monthlySpendBase.monthlySpend <= 0) {
        return null;
      }
      return cash / monthlySpendBase.monthlySpend;
    },
    amountDetail: (period, current, result) => {
      const cash = getAdjustedMetricSum(current, period.key, ["현금및현금성자산"]);
      const monthlySpendBase = getMonthlySpendBase(current, period);
      return createCalculationDetail(
        "현금및현금성자산 / 월 평균 지출액",
        result,
        [
          { label: "현금및현금성자산", value: cash },
          { label: "월 평균 지출액", value: monthlySpendBase.monthlySpend }
        ],
        monthlySpendBase.monthlySpend !== null && monthlySpendBase.monthlySpend <= 0 ? "월 평균 지출액이 0 이하라 런웨이를 계산하지 않았습니다." : undefined
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
      const monthlySpendBase = getMonthlySpendBase(current, period);
      if (monthlySpendBase.monthlySpend === null || monthlySpendBase.monthlySpend <= 0) {
        return null;
      }
      return monthlySpendBase.monthlySpend;
    },
    amountDetail: (period, current, result) => {
      const monthlySpendBase = getMonthlySpendBase(current, period);
      return createCalculationDetail(
        "(매출액 - 영업이익 - 감가상각계) / 경과월수",
        result,
        [
          { label: "매출액", value: monthlySpendBase.sales },
          { label: "영업이익", value: monthlySpendBase.operatingIncome },
          { label: "감가상각계", value: monthlySpendBase.depreciation },
          { label: "누적 지출 추정", value: monthlySpendBase.totalSpend },
          { label: "경과월수", value: period.monthsElapsed },
          { label: "월 평균 지출액", value: monthlySpendBase.monthlySpend }
        ],
        monthlySpendBase.monthlySpend !== null && monthlySpendBase.monthlySpend <= 0 ? "월 평균 지출액이 0 이하라 오류로 표시했습니다." : undefined
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
      amount: (period, current) => getAdjustedMetricSum(current, period.key, ["단기대여금"]),
      amountDetail: (period, current, result) => {
        const loans = getAdjustedMetricSum(current, period.key, ["단기대여금"]);
        return createCalculationDetail("단기대여금 계정 합계", result, [
          { label: "단기대여금", value: loans, components: getClassifiedMetricBreakdown(current, period.key, ["단기대여금"]) }
        ]);
      },
      ratio: (period, current) => safeDivide(getAdjustedMetricSum(current, period.key, ["단기대여금"]), getPreferredTotalAssets(current, period.key), 100),
      ratioDetail: (period, current, result) => {
        const loans = getAdjustedMetricSum(current, period.key, ["단기대여금"]);
        const assets = getPreferredTotalAssets(current, period.key);
        return createCalculationDetail("단기대여금 / 자산 * 100", result, [
          { label: "단기대여금", value: loans },
          { label: "자산", value: assets }
        ], assets === 0 ? "자산이 0이라 비율을 계산하지 않았습니다." : undefined);
      }
    },
    {
      label: "개발비(자산)",
      amount: (period, current) => getAdjustedMetricSum(current, period.key, ["개발비(자산)", "개발비"]),
      amountDetail: (period, current, result) => {
        const developmentAsset = getAdjustedMetricSum(current, period.key, ["개발비(자산)", "개발비"]);
        return createCalculationDetail("개발비(자산) 계정 합계", result, [
          { label: "개발비(자산)", value: developmentAsset, components: getClassifiedMetricBreakdown(current, period.key, ["개발비(자산)"]) }
        ]);
      },
      ratio: (period, current) => safeDivide(getAdjustedMetricSum(current, period.key, ["개발비(자산)", "개발비"]), getPreferredTotalAssets(current, period.key), 100),
      ratioDetail: (period, current, result) => {
        const developmentAsset = getAdjustedMetricSum(current, period.key, ["개발비(자산)", "개발비"]);
        const assets = getPreferredTotalAssets(current, period.key);
        return createCalculationDetail("개발비(자산) / 자산 * 100", result, [
          { label: "개발비(자산)", value: developmentAsset },
          { label: "자산", value: assets }
        ], assets === 0 ? "자산이 0이라 비율을 계산하지 않았습니다." : undefined);
      }
    },
    {
      label: "선급금",
      amount: (period, current) => getAdjustedMetricSum(current, period.key, ["선급금"]),
      amountDetail: (period, current, result) => {
        const prepaid = getAdjustedMetricSum(current, period.key, ["선급금"]);
        return createCalculationDetail("선급금 계정 합계", result, [
          { label: "선급금", value: prepaid, components: getClassifiedMetricBreakdown(current, period.key, ["선급금"]) }
        ]);
      },
      ratio: (period, current) => safeDivide(getAdjustedMetricSum(current, period.key, ["선급금"]), getPreferredTotalAssets(current, period.key), 100),
      ratioDetail: (period, current, result) => {
        const prepaid = getAdjustedMetricSum(current, period.key, ["선급금"]);
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
        return getAdjustedMetricSum(current, period.key, ["퇴직급여충당부채"]);
      },
      amountDetail: (period, current, result) => {
        const retirementProvision = getAdjustedMetricSum(current, period.key, ["퇴직급여충당부채"]);
        return createCalculationDetail("퇴직급여충당부채 계정 합계", result, [
          { label: "퇴직급여충당부채", value: retirementProvision }
        ]);
      },
      ratio: (period, current) => {
        const value = getAdjustedMetricSum(current, period.key, ["퇴직급여충당부채"]);
        return safeDivide(value, getPreferredTotalLiabilities(current, period.key), 100);
      },
      ratioDetail: (period, current, result) => {
        const value = getAdjustedMetricSum(current, period.key, ["퇴직급여충당부채"]);
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
        const currentAssetBreakdown = getClassifiedMetricBreakdown(current, period.key, ["유동자산"], "재무상태표");
        const currentLiabilityBreakdown = getClassifiedMetricBreakdown(current, period.key, ["유동부채"], "재무상태표");
        return createCalculationDetail("유동자산 / 유동부채 * 100", result, [
          { label: "유동자산", value: currentAssets, components: currentAssetBreakdown },
          { label: "유동부채", value: currentLiabilities, components: currentLiabilityBreakdown }
        ], currentLiabilities === 0 ? "유동부채가 0이라 비율을 계산하지 않았습니다." : undefined);
      }
    },
    {
      label: "당좌비율",
      ratio: (period, current) => {
        const quickAssets = getPreferredQuickAssets(current, period.key);
        const currentLiabilities = getPreferredCurrentLiabilities(current, period.key);
        return safeDivide(quickAssets, currentLiabilities, 100);
      },
      ratioDetail: (period, current, result) => {
        const quickAssets = getPreferredQuickAssets(current, period.key);
        const currentLiabilities = getPreferredCurrentLiabilities(current, period.key);
        const quickAssetBreakdown = getQuickAssetBreakdown(current, period.key);
        const currentLiabilityBreakdown = getClassifiedMetricBreakdown(current, period.key, ["유동부채"], "재무상태표");
        return createCalculationDetail("당좌자산 / 유동부채 * 100", result, [
          { label: "당좌자산", value: quickAssets, components: quickAssetBreakdown },
          { label: "유동부채", value: currentLiabilities, components: currentLiabilityBreakdown }
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
      ratio: (period, current) => safeDivide(getNetMetricValue(current, period.key, ["차입금", ...BORROWING_ALIASES]), getPreferredTotalAssets(current, period.key), 100),
      ratioDetail: (period, current, result) => {
        const borrowings = getNetMetricValue(current, period.key, ["차입금", ...BORROWING_ALIASES]);
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
        const variableCostBreakdown = getClassifiedMetricBreakdown(current, period.key, VARIABLE_COST_ALIASES);
        return createCalculationDetail("(매출액 - 변동비) / 매출액 * 100", result, [
          { label: "매출액", value: sales },
          { label: "변동비 합계", value: variableCosts },
          ...variableCostBreakdown,
          { label: "공헌이익", value: contribution }
        ], sales === 0
          ? "매출액이 0이라 비율을 계산하지 않았습니다."
          : !variableCostBreakdown.length
            ? "현재 분류 기준으로 변동비에 포함된 하위 계정이 없습니다."
            : undefined);
      }
    }
  ];

  const activitySpecs: MetricSpec[] = [
    {
      label: "총자산회전율",
      ratio: (period, current) => {
        const basePeriod = getThreeQuarterPriorPeriod(current, period);
        const averageAssets = basePeriod
          ? averageTwo(getPreferredTotalAssets(current, period.key), getPreferredTotalAssets(current, basePeriod.key))
          : null;
        return safeDivide(getAdjustedMetricSum(current, period.key, ["매출액"]), averageAssets, 1);
      },
      ratioDetail: (period, current, result) => {
        const basePeriod = getThreeQuarterPriorPeriod(current, period);
        const currentAssets = getPreferredTotalAssets(current, period.key);
        const baseAssets = basePeriod ? getPreferredTotalAssets(current, basePeriod.key) : null;
        const averageAssets = basePeriod ? averageTwo(currentAssets, baseAssets) : null;
        const sales = getAdjustedMetricSum(current, period.key, ["매출액"]);
        return createCalculationDetail("매출액 / 기초기말 평균총자산", result, [
          { label: "매출액", value: sales },
          { label: "기초 자산", value: baseAssets },
          { label: "기말 자산", value: currentAssets },
          { label: "기초기말 평균총자산", value: averageAssets }
        ], !basePeriod ? "전 분기 데이터 부족으로 계산하지 않았습니다." : averageAssets === 0 ? "평균총자산이 0이라 회전율을 계산하지 않았습니다." : undefined);
      }
    },
    {
      label: "매출채권회전율",
      ratio: (period, current) => {
        const basePeriod = getThreeQuarterPriorPeriod(current, period);
        const averageReceivables = basePeriod
          ? averageTwo(getNetMetricValue(current, period.key, ["매출채권"]), getNetMetricValue(current, basePeriod.key, ["매출채권"]))
          : null;
        return safeDivide(getAdjustedMetricSum(current, period.key, ["매출액"]), averageReceivables, 1);
      },
      ratioDetail: (period, current, result) => {
        const basePeriod = getThreeQuarterPriorPeriod(current, period);
        const currentReceivables = getNetMetricValue(current, period.key, ["매출채권"]);
        const baseReceivables = basePeriod ? getNetMetricValue(current, basePeriod.key, ["매출채권"]) : null;
        const averageReceivables = basePeriod ? averageTwo(currentReceivables, baseReceivables) : null;
        const sales = getAdjustedMetricSum(current, period.key, ["매출액"]);
        return createCalculationDetail("매출액 / 기초기말 평균매출채권", result, [
          { label: "매출액", value: sales },
          { label: "기초 매출채권", value: baseReceivables },
          { label: "기말 매출채권", value: currentReceivables },
          { label: "기초기말 평균매출채권", value: averageReceivables }
        ], !basePeriod ? "전 분기 데이터 부족으로 계산하지 않았습니다." : averageReceivables === 0 ? "평균매출채권이 0이라 회전율을 계산하지 않았습니다." : undefined);
      }
    },
    {
      label: "매출채권회전기간",
      amount: (period, current) => {
        const basePeriod = getThreeQuarterPriorPeriod(current, period);
        const averageReceivables = basePeriod
          ? averageTwo(getNetMetricValue(current, period.key, ["매출채권"]), getNetMetricValue(current, basePeriod.key, ["매출채권"]))
          : null;
        const turnover = safeDivide(getAdjustedMetricSum(current, period.key, ["매출액"]), averageReceivables, 1);
        return turnover ? 365 / turnover : null;
      },
      amountDetail: (period, current, result) => {
        const basePeriod = getThreeQuarterPriorPeriod(current, period);
        const currentReceivables = getNetMetricValue(current, period.key, ["매출채권"]);
        const baseReceivables = basePeriod ? getNetMetricValue(current, basePeriod.key, ["매출채권"]) : null;
        const averageReceivables = basePeriod ? averageTwo(currentReceivables, baseReceivables) : null;
        const sales = getAdjustedMetricSum(current, period.key, ["매출액"]);
        const turnover = safeDivide(sales, averageReceivables, 1);
        return createCalculationDetail("365 / 매출채권회전율", result, [
          { label: "매출액", value: sales },
          { label: "기초 매출채권", value: baseReceivables },
          { label: "기말 매출채권", value: currentReceivables },
          { label: "기초기말 평균매출채권", value: averageReceivables },
          { label: "매출채권회전율", value: turnover }
        ], !basePeriod ? "전 분기 데이터 부족으로 계산하지 않았습니다." : !turnover ? "회전율이 0 또는 비어 있어 기간을 계산하지 않았습니다." : undefined);
      }
    },
    {
      label: "재고자산회전율",
      ratio: (period, current) => {
        const basePeriod = getThreeQuarterPriorPeriod(current, period);
        const averageInventory = basePeriod
          ? averageTwo(getNetMetricValue(current, period.key, ["재고자산"]), getNetMetricValue(current, basePeriod.key, ["재고자산"]))
          : null;
        return safeDivide(getAdjustedMetricSum(current, period.key, ["매출원가"]), averageInventory, 1);
      },
      ratioDetail: (period, current, result) => {
        const basePeriod = getThreeQuarterPriorPeriod(current, period);
        const currentInventory = getNetMetricValue(current, period.key, ["재고자산"]);
        const baseInventory = basePeriod ? getNetMetricValue(current, basePeriod.key, ["재고자산"]) : null;
        const averageInventory = basePeriod ? averageTwo(currentInventory, baseInventory) : null;
        const costOfSales = getAdjustedMetricSum(current, period.key, ["매출원가"]);
        return createCalculationDetail("매출원가 / 기초기말 평균재고자산", result, [
          { label: "매출원가", value: costOfSales },
          { label: "기초 재고자산", value: baseInventory },
          { label: "기말 재고자산", value: currentInventory },
          { label: "기초기말 평균재고자산", value: averageInventory }
        ], !basePeriod ? "전 분기 데이터 부족으로 계산하지 않았습니다." : averageInventory === 0 ? "평균재고자산이 0이라 회전율을 계산하지 않았습니다." : undefined);
      }
    },
    {
      label: "재고자산회전기간",
      amount: (period, current) => {
        const basePeriod = getThreeQuarterPriorPeriod(current, period);
        const averageInventory = basePeriod
          ? averageTwo(getNetMetricValue(current, period.key, ["재고자산"]), getNetMetricValue(current, basePeriod.key, ["재고자산"]))
          : null;
        const turnover = safeDivide(getAdjustedMetricSum(current, period.key, ["매출원가"]), averageInventory, 1);
        return turnover ? 365 / turnover : null;
      },
      amountDetail: (period, current, result) => {
        const basePeriod = getThreeQuarterPriorPeriod(current, period);
        const currentInventory = getNetMetricValue(current, period.key, ["재고자산"]);
        const baseInventory = basePeriod ? getNetMetricValue(current, basePeriod.key, ["재고자산"]) : null;
        const averageInventory = basePeriod ? averageTwo(currentInventory, baseInventory) : null;
        const costOfSales = getAdjustedMetricSum(current, period.key, ["매출원가"]);
        const turnover = safeDivide(costOfSales, averageInventory, 1);
        return createCalculationDetail("365 / 재고자산회전율", result, [
          { label: "매출원가", value: costOfSales },
          { label: "기초 재고자산", value: baseInventory },
          { label: "기말 재고자산", value: currentInventory },
          { label: "기초기말 평균재고자산", value: averageInventory },
          { label: "재고자산회전율", value: turnover }
        ], !basePeriod ? "전 분기 데이터 부족으로 계산하지 않았습니다." : !turnover ? "회전율이 0 또는 비어 있어 기간을 계산하지 않았습니다." : undefined);
      }
    },
    {
      label: "정상영업순환주기",
      amount: (period, current) => {
        const basePeriod = getThreeQuarterPriorPeriod(current, period);
        const averageReceivables = basePeriod
          ? averageTwo(getNetMetricValue(current, period.key, ["매출채권"]), getNetMetricValue(current, basePeriod.key, ["매출채권"]))
          : null;
        const averageInventory = basePeriod
          ? averageTwo(getNetMetricValue(current, period.key, ["재고자산"]), getNetMetricValue(current, basePeriod.key, ["재고자산"]))
          : null;
        const receivableTurnover = safeDivide(getAdjustedMetricSum(current, period.key, ["매출액"]), averageReceivables, 1);
        const inventoryTurnover = safeDivide(getAdjustedMetricSum(current, period.key, ["매출원가"]), averageInventory, 1);
        const receivableDays = receivableTurnover ? 365 / receivableTurnover : null;
        const inventoryDays = inventoryTurnover ? 365 / inventoryTurnover : null;
        return receivableDays !== null && inventoryDays !== null ? receivableDays + inventoryDays : null;
      },
      amountDetail: (period, current, result) => {
        const basePeriod = getThreeQuarterPriorPeriod(current, period);
        const currentReceivables = getNetMetricValue(current, period.key, ["매출채권"]);
        const baseReceivables = basePeriod ? getNetMetricValue(current, basePeriod.key, ["매출채권"]) : null;
        const averageReceivables = basePeriod ? averageTwo(currentReceivables, baseReceivables) : null;
        const currentInventory = getNetMetricValue(current, period.key, ["재고자산"]);
        const baseInventory = basePeriod ? getNetMetricValue(current, basePeriod.key, ["재고자산"]) : null;
        const averageInventory = basePeriod ? averageTwo(currentInventory, baseInventory) : null;
        const sales = getAdjustedMetricSum(current, period.key, ["매출액"]);
        const costOfSales = getAdjustedMetricSum(current, period.key, ["매출원가"]);
        const receivableTurnover = safeDivide(sales, averageReceivables, 1);
        const inventoryTurnover = safeDivide(costOfSales, averageInventory, 1);
        const receivableDays = receivableTurnover ? 365 / receivableTurnover : null;
        const inventoryDays = inventoryTurnover ? 365 / inventoryTurnover : null;
        return createCalculationDetail("매출채권회전기간 + 재고자산회전기간", result, [
          { label: "매출채권회전기간", value: receivableDays },
          { label: "재고자산회전기간", value: inventoryDays }
        ], !basePeriod ? "전 분기 데이터 부족으로 계산하지 않았습니다." : undefined);
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
      detailAdjustedStatementRows: [],
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
    detailAdjustedStatementRows: adjustedStatementRows,
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

export function buildCompanyReport(snapshots: SavedQuarterSnapshot[], activeClassificationGroups?: ClassificationGroups) {
  if (!snapshots.length) {
    return {
      detectedCompany: null,
      companyName: null,
      periods: [],
      rawStatementRows: [],
      adjustedStatementRows: [],
      detailAdjustedStatementRows: [],
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

  const reportClassificationGroups = activeClassificationGroups
    ?? snapshots[0]?.source?.classificationGroups
    ?? structuredClone(DEFAULT_CLASSIFICATION_GROUPS);

  const buildMatrix = (kind: "rawStatementRows" | "adjustedStatementRows") => {
    const rowMap = new Map<string, StatementMatrixRow>();
    snapshots.forEach((snapshot) => {
      const bucketMap = new Map<string, Array<typeof snapshot[typeof kind][number] & { activeCanonicalKey: string }>>();

      snapshot[kind].forEach((row) => {
        const canonicalKey = resolveCanonicalAccountKey(row.accountName, row.sectionKey, reportClassificationGroups);
        const bucketKey = `${normalizeText(row.sectionKey)}__${normalizeText(canonicalKey)}`;
        const bucket = bucketMap.get(bucketKey) ?? [];
        bucket.push({ ...row, activeCanonicalKey: canonicalKey });
        bucketMap.set(bucketKey, bucket);
      });

      bucketMap.forEach((bucketRows) => {
        const canonicalKey = bucketRows[0].activeCanonicalKey;
        const exactNameRows = bucketRows.filter((row) => normalizeText(row.accountName) === normalizeText(canonicalKey));
        const selectedRows = exactNameRows.length ? exactNameRows : bucketRows;
        const key = buildRowIdentityKey(bucketRows[0].sectionKey, canonicalKey, canonicalKey);

        if (!rowMap.has(key)) {
          rowMap.set(key, {
            signFlag: selectedRows[0].signFlag,
            section: bucketRows[0].section,
            sectionKey: bucketRows[0].sectionKey,
            accountName: canonicalKey,
            canonicalKey,
            sourceCanonicalKey: selectedRows[0].canonicalKey,
            values: Object.fromEntries(periods.map((period) => [period.key, null]))
          });
        }

        const bucketValue = selectedRows.reduce((total, row) => total + (row.value ?? 0), 0);
        const current = rowMap.get(key)!;
        current.values[snapshot.quarterKey] = bucketValue;
      });
    });
    return Array.from(rowMap.values());
  };

  const buildDetailedMatrix = (kind: "rawStatementRows" | "adjustedStatementRows") => {
    const rowMap = new Map<string, StatementMatrixRow>();

    snapshots.forEach((snapshot) => {
      snapshot[kind].forEach((row) => {
        const canonicalKey = resolveCanonicalAccountKey(row.accountName, row.sectionKey, reportClassificationGroups);
        const key = buildRowIdentityKey(row.sectionKey, canonicalKey, row.accountName);

        if (!rowMap.has(key)) {
          rowMap.set(key, {
            signFlag: row.signFlag,
            section: row.section,
            sectionKey: row.sectionKey,
            accountName: row.accountName,
            canonicalKey,
            sourceCanonicalKey: row.canonicalKey,
            values: Object.fromEntries(periods.map((period) => [period.key, null]))
          });
        }

        const current = rowMap.get(key)!;
        current.values[snapshot.quarterKey] = row.value ?? null;
      });
    });

    return Array.from(rowMap.values());
  };

  const rawStatementRows = buildMatrix("rawStatementRows");
  const adjustedStatementRows = buildMatrix("adjustedStatementRows");
  const detailAdjustedStatementRows = buildDetailedMatrix("adjustedStatementRows");
  const context: MetricContext = {
    periods,
    rawRows: rawStatementRows,
    adjustedRows: adjustedStatementRows,
    sectionTotals: getSectionTotals(adjustedStatementRows, periods),
    classificationGroups: reportClassificationGroups
  };

  return {
    detectedCompany: snapshots[0].companyName,
    companyName: snapshots[0].companyName,
    periods,
    rawStatementRows,
    adjustedStatementRows,
    detailAdjustedStatementRows,
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

  if (row.label.includes("기간") || row.label === "정상영업순환주기") {
    return `${value.toFixed(1)}일`;
  }

  return formatNumber(value);
}

export function isTurnoverMetricLabel(label: string) {
  return label.includes("회전율") || label === "총자산회전율";
}

export function formatMetricRatio(value: number | null, label?: string) {
  if (value === null || value === undefined) {
    return "-";
  }

  if (label && isTurnoverMetricLabel(label)) {
    return `${value.toFixed(2)}회`;
  }

  return `${value.toFixed(1)}%`;
}
