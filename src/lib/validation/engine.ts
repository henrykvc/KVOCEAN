import { ACCOUNT_ALIASES, COMPANY_LABELS, DEFAULT_COMPANY_CONFIGS, DEFAULT_LOGIC_CONFIG, LAST_PATCH, LOSS_ACCOUNTS, RESULT_ORDER, SUMMARY_RULES, type CompanyConfigs, type LogicConfig, type SignCode } from "./defaults";

export type ParsedPaste = {
  catRow: string[];
  nameRow: string[];
  dataRows: Array<Array<string | number | null>>;
  error: string | null;
};

export type DetailRow = {
  계정명: string;
  원본값: number;
  부호: string;
  적용값: number;
  _col?: number;
  _allowedSigns?: SignCode[];
};

export type ValidationResult = {
  분류: string;
  rule: string;
  parent: string;
  sect?: string;
  parent_val: number;
  computed: number;
  diff: number;
  passed: boolean;
  missing: string[];
  detail: DetailRow[];
  _sort_parent: string;
  날짜?: string;
};

export type DiagnosisAction = {
  text: string;
  label?: string;
  fix?: {
    sect: string;
    acct: string;
    newSign: SignCode;
  };
};

export type SessionSignFixes = Record<string, Record<string, SignCode>>;

export type ValidationRun = {
  companyName: string | null;
  parsed: ParsedPaste;
  detectedCompany: string | null;
  previewRow: Array<string | number | null>;
  editableRow: Array<string | number | null>;
  allResults: ValidationResult[];
  resultsByDate: Record<string, ValidationResult[]>;
  stats: {
    total: number;
    passed: number;
    failed: number;
    rate: number;
  };
  copyText: string;
};

export type PersistedState = {
  logicConfig: LogicConfig;
  companyConfigs: CompanyConfigs;
};

export const STORAGE_KEYS = {
  config: "ocr-validation-config-v1"
} as const;

export function getDefaultPersistedState(): PersistedState {
  return {
    logicConfig: structuredClone(DEFAULT_LOGIC_CONFIG),
    companyConfigs: structuredClone(DEFAULT_COMPANY_CONFIGS)
  };
}

export function parsePersistedState(raw: string | null): PersistedState {
  const fallback = getDefaultPersistedState();
  if (!raw) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    return {
      logicConfig: { ...fallback.logicConfig, ...(parsed.logicConfig ?? {}) },
      companyConfigs: { ...fallback.companyConfigs, ...(parsed.companyConfigs ?? {}) }
    };
  } catch {
    return fallback;
  }
}

export function safeFloat(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const trimmed = value.trim();
  if (["", "None", "nan"].includes(trimmed)) {
    return null;
  }

  const cleaned = trimmed.replace(/,/g, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parsePastedText(text: string): ParsedPaste {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim());

  if (lines.length < 3) {
    return {
      catRow: [],
      nameRow: [],
      dataRows: [],
      error: "최소 3행(헤더2줄 + 데이터1줄) 이상 붙여넣어 주세요."
    };
  }

  const splitRow = (line: string) => (line.includes("\t") ? line.split("\t") : line.trim().split(/\s+/));
  const catRow = splitRow(lines[0]).map((cell) => cell.trim());
  const nameRow = splitRow(lines[1]).map((cell) => cell.trim());
  const dataRows = lines.slice(2).map((line) =>
    splitRow(line).map((cell) => {
      const trimmed = cell.trim();
      const numeric = safeFloat(trimmed);
      return numeric ?? (trimmed || null);
    })
  );

  return { catRow, nameRow, dataRows, error: null };
}

export function detectCompanyFromPaste(text: string): string | null {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim());

  if (lines.length < 3 || !lines[1]?.includes("\t") || !lines[2]?.includes("\t")) {
    return null;
  }

  const nameRow = lines[1].split("\t").map((cell) => cell.trim());
  const dataRow = lines[2].split("\t").map((cell) => cell.trim());

  for (const [index, name] of nameRow.entries()) {
    if (COMPANY_LABELS.includes(name) && dataRow[index]) {
      return dataRow[index];
    }
  }

  return null;
}

export function formatNumber(value: string | number | null | undefined): string {
  const numeric = safeFloat(value);
  if (numeric === null) {
    return "";
  }
  return new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 }).format(numeric);
}

export function resultSortKey(parentName: string): number {
  const idx = RESULT_ORDER.indexOf(parentName as (typeof RESULT_ORDER)[number]);
  return idx >= 0 ? idx : RESULT_ORDER.length + 100;
}

function getEffectiveSectionOverrides(logicConfig: LogicConfig, companyConfigs: CompanyConfigs, companyName: string | null) {
  const merged: Record<string, Record<string, SignCode>> = {};

  for (const [sect, overrides] of Object.entries(logicConfig.sectionSignOverrides)) {
    merged[sect] = { ...overrides };
  }

  if (companyName && companyConfigs[companyName]?.sectionSignOverrides) {
    for (const [sect, overrides] of Object.entries(companyConfigs[companyName].sectionSignOverrides ?? {})) {
      merged[sect] = { ...(merged[sect] ?? {}), ...overrides };
    }
  }

  return merged;
}

export function applySign(value: number | null | undefined, signCode: SignCode | 0 | 1): number {
  const numeric = typeof value === "number" ? value : 0;
  return signCode === 1 ? -numeric : numeric;
}

export function inferSignFromName(name: string, logicConfig: LogicConfig): SignCode | null {
  if (logicConfig.plusOverrideKeywords.some((keyword) => name.includes(keyword))) {
    return 0;
  }
  if (logicConfig.minusKeywords.some((keyword) => name.includes(keyword))) {
    return 1;
  }
  if (logicConfig.plusCostKeywords.some((keyword) => name.includes(keyword))) {
    return 0;
  }
  return null;
}

function getAccountValue(nameToValue: Record<string, number | null>, account: string): number | null {
  const matched = getAccountMatch(nameToValue, account);
  return matched?.value ?? null;
}

function getAccountMatch(nameToValue: Record<string, number | null>, account: string): { alias: string; value: number } | null {
  for (const alias of ACCOUNT_ALIASES[account] ?? [account]) {
    const value = nameToValue[alias];
    if (value !== null && value !== undefined) {
      return { alias, value };
    }
  }
  return null;
}

export function validatePasteSections(
  catRow: string[],
  nameRow: string[],
  dataRow: Array<string | number | null>,
  tolerance: number,
  companyName: string | null,
  sessionSignFixes: SessionSignFixes,
  logicConfig: LogicConfig,
  companyConfigs: CompanyConfigs
): ValidationResult[] {
  const results: ValidationResult[] = [];
  const sectionOverrides = getEffectiveSectionOverrides(logicConfig, companyConfigs, companyName);

  const allItems: Array<{ name: string; sect: string; val: number | null; col: number }> = [];
  const nameToValue: Record<string, number | null> = {};
  let prevSect = "";

  for (let i = 0; i < Math.min(catRow.length, nameRow.length); i += 1) {
    const name = nameRow[i];
    if (!name) {
      continue;
    }
    const rawSect = catRow[i]?.trim() ?? "";
    if (rawSect) {
      prevSect = rawSect;
    }
    const sectLabel = prevSect;
    const value = safeFloat(dataRow[i]);
    allItems.push({ name, sect: sectLabel, val: value, col: i });
    if (!(name in nameToValue)) {
      nameToValue[name] = value;
    }
  }

  for (const [sect, parentName] of Object.entries(logicConfig.pasteSectToParent)) {
    const childrenRaw = allItems.filter((item) => item.sect === sect && item.val !== null);
    if (!childrenRaw.length) {
      continue;
    }
    const parentVal = getAccountValue(nameToValue, parentName);
    if (parentVal === null) {
      continue;
    }

    const parentAliases = new Set(ACCOUNT_ALIASES[parentName] ?? [parentName]);
    const used: DetailRow[] = [];
    let computed = 0;

    for (const child of childrenRaw) {
      if (parentAliases.has(child.name)) {
        continue;
      }
      if (parentName === "자본" && logicConfig.capitalMemoAccounts.includes(child.name)) {
        continue;
      }

      let sign = inferSignFromName(child.name, logicConfig);
      const sectOverride = sectionOverrides[sect] ?? {};
      for (const [keyword, override] of Object.entries(sectOverride)) {
        if (child.name.includes(keyword)) {
          sign = override;
          break;
        }
      }
      if (sessionSignFixes[sect]?.[child.name] !== undefined) {
        sign = sessionSignFixes[sect][child.name];
      }
      if (sign === 2) {
        used.push({ 계정명: child.name, 원본값: child.val!, 부호: "제외", 적용값: 0, _col: child.col });
        continue;
      }
      const resolvedSign = (sign ?? 0) as 0 | 1;
      const signedValue = applySign(child.val, resolvedSign);
      computed += signedValue;
      used.push({ 계정명: child.name, 원본값: child.val!, 부호: resolvedSign === 1 ? "−" : "+", 적용값: signedValue, _col: child.col });
    }

    const diff = parentVal - computed;
    results.push({
      분류: "세부항목 합계",
      rule: `${parentName} = Σ 하위항목`,
      parent: parentName,
      sect,
      parent_val: parentVal,
      computed,
      diff,
      passed: Math.abs(diff) <= tolerance,
      missing: [],
      detail: used,
      _sort_parent: parentName
    });
  }

  const capitalVal = getAccountValue(nameToValue, "자본");
  if (capitalVal !== null) {
    const used: DetailRow[] = [];
    let computed = 0;
    const capitalOverrides = sectionOverrides["자본"] ?? {};
    for (const [compName, isPositive] of Object.entries(logicConfig.capitalL1Signs)) {
      const parent = logicConfig.capitalL1Parent[compName];
      const parentVal = parent ? getAccountValue(nameToValue, parent) : null;
      if (parentVal !== null && parentVal !== 0) {
        continue;
      }
      const value = getAccountValue(nameToValue, compName);
      if (value === null) {
        continue;
      }
      let sign: SignCode = isPositive ? 0 : 1;
      for (const [keyword, override] of Object.entries(capitalOverrides)) {
        if (compName.includes(keyword)) {
          sign = override;
          break;
        }
      }
      if (sessionSignFixes["자본"]?.[compName] !== undefined) {
        sign = sessionSignFixes["자본"][compName];
      }
      if (sign === 2) {
        used.push({ 계정명: compName, 원본값: value, 부호: "제외", 적용값: 0, _allowedSigns: isPositive ? [0] : [0, 1] });
        continue;
      }
      const signedValue = applySign(value, sign);
      computed += signedValue;
      used.push({
        계정명: compName,
        원본값: value,
        부호: sign === 1 ? "−" : "+",
        적용값: signedValue,
        _allowedSigns: isPositive ? [0] : [0, 1]
      });
    }
    if (used.length) {
      const diff = capitalVal - computed;
      results.push({
        분류: "상위항목 관계",
        rule: "자본 = Σ 자본구성항목",
        parent: "자본",
        parent_val: capitalVal,
        computed,
        diff,
        passed: Math.abs(diff) <= tolerance,
        missing: [],
        detail: used,
        _sort_parent: "자본"
      });
    }
  }

  for (const [ruleName, parentName, components] of SUMMARY_RULES) {
    const parentMatch = getAccountMatch(nameToValue, parentName);
    if (!parentMatch) {
      continue;
    }
    let parentVal = parentMatch.value;
    if (LOSS_ACCOUNTS.has(parentMatch.alias)) {
      parentVal = -Math.abs(parentVal);
    }

    const used: DetailRow[] = [];
    const missing: string[] = [];
    let computed = 0;

    for (const [compName, defaultSign] of components) {
      const compMatch = getAccountMatch(nameToValue, compName);
      if (!compMatch) {
        missing.push(compName);
        continue;
      }
      const compVal = LOSS_ACCOUNTS.has(compMatch.alias) ? -Math.abs(compMatch.value) : compMatch.value;
      const sign = sessionSignFixes[ruleName]?.[compName] ?? defaultSign;
      const signedValue = applySign(compVal, sign as 0 | 1);
      computed += signedValue;
      used.push({ 계정명: compName, 원본값: compVal, 부호: sign === 1 ? "−" : "+", 적용값: signedValue });
    }

    const diff = parentVal - computed;
    results.push({
      분류: "상위항목 관계",
      rule: ruleName,
      parent: parentName,
      sect: ruleName,
      parent_val: parentVal,
      computed,
      diff,
      passed: Math.abs(diff) <= tolerance,
      missing,
      detail: used,
      _sort_parent: parentName
    });
  }

  return results;
}

export function diagnoseDiff(result: ValidationResult): DiagnosisAction[] {
  const diff = result.diff;
  const absDiff = Math.abs(diff);
  if (absDiff < 1) {
    return [];
  }

  const close = (a: number, b: number) => {
    const max = Math.max(Math.abs(a), Math.abs(b));
    return max > 0 && Math.abs(a - b) / max < 0.02;
  };

  const signFromLabel = (label: string): SignCode => {
    if (label === "−") {
      return 1;
    }
    if (label === "제외") {
      return 2;
    }
    return 0;
  };

  const signName = (sign: SignCode) => {
    if (sign === 1) {
      return "차감(−)";
    }
    if (sign === 2) {
      return "제외";
    }
    return "가산(+)";
  };

  const buildReason = (item: DetailRow, currentSign: SignCode, nextSign: SignCode) => {
    if (item.원본값 < 0 && currentSign === 1 && nextSign === 0) {
      return "원본값이 이미 음수라 현재 차감하면 부호가 두 번 뒤집힙니다.";
    }
    if (item.원본값 < 0 && currentSign === 0 && nextSign === 1) {
      return "원본값이 이미 음수인데 가산 중이라 방향이 반대로 들어갔습니다.";
    }
    if (nextSign === 2) {
      return "이 계정은 이번 합계에서 제외해야 차이가 줄어듭니다.";
    }
    return "이 계정 하나의 부호 해석을 바꾸면 현재 차이가 대부분 해소됩니다.";
  };

  const actions: DiagnosisAction[] = [];
  const sect = result.sect ?? result.parent;

  for (const item of result.detail) {
    const absRaw = Math.abs(item.원본값);
    if (absRaw < 1) {
      continue;
    }

    const currentSign = signFromLabel(item.부호);
    const allowedSigns = item._allowedSigns ?? [0, 1, 2];
    const candidates = allowedSigns
      .filter((candidate) => candidate !== currentSign)
      .map((candidate) => {
        const candidateApplied = candidate === 2 ? 0 : applySign(item.원본값, candidate as 0 | 1);
        const nextComputed = result.computed - item.적용값 + candidateApplied;
        const nextDiff = result.parent_val - nextComputed;
        return {
          candidate,
          candidateApplied,
          nextDiff,
          nextAbsDiff: Math.abs(nextDiff)
        };
      })
      .sort((a, b) => a.nextAbsDiff - b.nextAbsDiff);

    const best = candidates[0];
    if (best && (best.nextAbsDiff <= 1 || (absDiff > 0 && (absDiff - best.nextAbsDiff) / absDiff >= 0.85))) {
      actions.push({
        text: `💡 **${item.계정명}** (${formatNumber(item.원본값)}원): 현재 **${signName(currentSign)}** → **${signName(best.candidate)}**로 바꾸면 차이가 ${formatNumber(result.diff)}원에서 ${formatNumber(best.nextDiff)}원으로 줄어듭니다. ${buildReason(item, currentSign, best.candidate)} 반복되면 회사 규칙 저장으로 고정하세요.`,
        label: `${signName(best.candidate)}으로 수정: ${item.계정명}`,
        fix: { sect, acct: item.계정명, newSign: best.candidate }
      });
      continue;
    }

    if (close(absDiff, absRaw)) {
      if (item.부호 === "−" && diff > 0) {
        actions.push({
          text: `💡 **${item.계정명}** (${formatNumber(item.원본값)}원): 현재 **차감** 중 → **제외**로 바꾸면 차이 해소 가능 (OCR이 이미 NET값 제공)`,
          label: `제외로 수정: ${item.계정명}`,
          fix: { sect, acct: item.계정명, newSign: 2 }
        });
      } else if (item.부호 === "+" && diff < 0) {
        actions.push({
          text: `💡 **${item.계정명}** (${formatNumber(item.원본값)}원): 현재 **가산** 중 → **제외**로 바꾸면 차이 해소 가능 (이중 집계 의심)`,
          label: `제외로 수정: ${item.계정명}`,
          fix: { sect, acct: item.계정명, newSign: 2 }
        });
      } else if (item.부호 === "제외" && diff > 0) {
        actions.push({
          text: `💡 **${item.계정명}** (${formatNumber(item.원본값)}원): 현재 **제외** 중 → **가산(+)**하면 차이 해소 가능`,
          label: `가산(+)으로 수정: ${item.계정명}`,
          fix: { sect, acct: item.계정명, newSign: 0 }
        });
      } else if (item.부호 === "제외" && diff < 0) {
        actions.push({
          text: `💡 **${item.계정명}** (${formatNumber(item.원본값)}원): 현재 **제외** 중 → **차감(−)**하면 차이 해소 가능`,
          label: `차감(−)으로 수정: ${item.계정명}`,
          fix: { sect, acct: item.계정명, newSign: 1 }
        });
      }
    }

    if (close(absDiff, 2 * absRaw)) {
      if (item.부호 === "−" && diff > 0) {
        actions.push({
          text: `💡 **${item.계정명}** (${formatNumber(item.원본값)}원): 현재 **차감** → **가산(+)**으로 바꾸면 차이 해소 가능 (부호 완전 반전)`,
          label: `가산(+)으로 수정: ${item.계정명}`,
          fix: { sect, acct: item.계정명, newSign: 0 }
        });
      } else if (item.부호 === "+" && diff < 0) {
        actions.push({
          text: `💡 **${item.계정명}** (${formatNumber(item.원본값)}원): 현재 **가산** → **차감(−)**으로 바꾸면 차이 해소 가능 (부호 완전 반전)`,
          label: `차감(−)으로 수정: ${item.계정명}`,
          fix: { sect, acct: item.계정명, newSign: 1 }
        });
      }
    }
  }

  if (!actions.length) {
    actions.push({
      text: `⚠️ 차이 ${diff > 0 ? "+" : ""}${formatNumber(diff)}원 — 단일 계정으로 설명되지 않습니다. 복합 오류이거나 OCR 인식 오류일 수 있습니다.`
    });
  }

  return actions;
}

export function buildCopyText(
  catRow: string[],
  nameRow: string[],
  rawFirst: Array<string | number | null>,
  pasteEdits: Record<number, number>
) {
  const values = nameRow.map((_, index) => {
    if (pasteEdits[index] !== undefined) {
      return String(Math.round(pasteEdits[index]));
    }
    const raw = rawFirst[index];
    return raw === null || raw === undefined ? "" : String(raw);
  });

  return [catRow.join("\t"), nameRow.join("\t"), values.join("\t")].join("\n");
}

export function runValidation(args: {
  pastedText: string;
  selectedCompany: string | null;
  tolerance: number;
  logicConfig: LogicConfig;
  companyConfigs: CompanyConfigs;
  pasteEdits: Record<number, number>;
  sessionSignFixes: SessionSignFixes;
}): ValidationRun {
  const parsed = parsePastedText(args.pastedText);
  const detectedCompany = detectCompanyFromPaste(args.pastedText);
  const rawFirst = parsed.dataRows[0] ?? [];
  const editableRow = rawFirst.map((value, index) => (args.pasteEdits[index] !== undefined ? args.pasteEdits[index] : value));

  if (parsed.error) {
    return {
      companyName: args.selectedCompany,
      parsed,
      detectedCompany,
      previewRow: rawFirst,
      editableRow,
      allResults: [],
      resultsByDate: {},
      stats: { total: 0, passed: 0, failed: 0, rate: 0 },
      copyText: ""
    };
  }

  const dateIdx = parsed.nameRow.findIndex((name) => ["날짜", "date", "Date"].includes(name));
  const resultsByDate: Record<string, ValidationResult[]> = {};

  for (const [rowIndex, rawRow] of parsed.dataRows.entries()) {
    const effectiveRow = rawRow.map((value, index) => (args.pasteEdits[index] !== undefined ? args.pasteEdits[index] : value));
    const label = dateIdx >= 0 && effectiveRow[dateIdx] ? String(effectiveRow[dateIdx]) : `데이터${rowIndex + 1}`;
    const results = validatePasteSections(
      parsed.catRow,
      parsed.nameRow,
      effectiveRow,
      args.tolerance,
      args.selectedCompany,
      args.sessionSignFixes,
      args.logicConfig,
      args.companyConfigs
    ).map((result) => ({ ...result, 날짜: label }));
    resultsByDate[label] = results.sort((a, b) => {
      const sortDiff = resultSortKey(a._sort_parent) - resultSortKey(b._sort_parent);
      return sortDiff === 0 ? a.분류.localeCompare(b.분류, "ko") : sortDiff;
    });
  }

  const allResults = Object.values(resultsByDate).flat();
  const passed = allResults.filter((item) => item.passed).length;
  const failed = allResults.length - passed;

  return {
    companyName: args.selectedCompany,
    parsed,
    detectedCompany,
    previewRow: rawFirst,
    editableRow,
    allResults,
    resultsByDate,
    stats: {
      total: allResults.length,
      passed,
      failed,
      rate: allResults.length ? (passed / allResults.length) * 100 : 0
    },
    copyText: buildCopyText(parsed.catRow, parsed.nameRow, rawFirst, args.pasteEdits)
  };
}

export { LAST_PATCH };
