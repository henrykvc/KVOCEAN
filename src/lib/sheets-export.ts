import type { ReportingModel } from "@/lib/validation/report";

/**
 * Exact set of metrics to push to the sheet — amount only (no ratio/growth).
 * `label` matches the row.label in report.ts; `header` is what shows in the sheet column.
 * Order here = column order (after 회사명 in column A).
 */
export const TARGET_METRICS: Array<{ label: string; header: string }> = [
  { label: "런웨이(E)", header: "런웨이" },
  { label: "EBITDA", header: "EBITDA" },
  { label: "월 평균 지출액", header: "월 평균 지출액" }
];

export const SHEETS_KEY_COLUMNS = ["회사명"] as const;

export type SheetCellValue = string | number | null;

export function buildHeaderRow(): string[] {
  return [...SHEETS_KEY_COLUMNS, ...TARGET_METRICS.map((m) => m.header)];
}

/**
 * Build rows for ONE quarter.
 * Each row = one company. Columns = [회사명, 런웨이, EBITDA, 월 평균 지출액].
 * Companies with no data for this quarter are skipped.
 */
export function buildQuarterRows(args: {
  quarterKey: string;
  companyReports: Map<string, ReportingModel>;
}): SheetCellValue[][] {
  const rows: SheetCellValue[][] = [];
  const companyNames = Array.from(args.companyReports.keys()).sort((a, b) => a.localeCompare(b, "ko"));

  for (const companyName of companyNames) {
    const report = args.companyReports.get(companyName)!;
    const period = report.periods.find((p) => p.key === args.quarterKey);
    if (!period) continue;

    // Find the rows in any section (핵심 지표 has these three by label).
    const labelLookup = new Map<string, ReportingModel["finalSections"][number]["rows"][number]>();
    for (const section of report.finalSections) {
      for (const row of section.rows) {
        if (!labelLookup.has(row.label)) {
          labelLookup.set(row.label, row);
        }
      }
    }

    const row: SheetCellValue[] = [companyName];
    for (const metric of TARGET_METRICS) {
      const metricRow = labelLookup.get(metric.label);
      if (!metricRow) {
        row.push(null);
        continue;
      }
      const value = metricRow.amounts[period.key];
      row.push(value ?? null);
    }
    rows.push(row);
  }

  return rows;
}

/**
 * Distinct quarters across all reports. Sorted newest-first (largest key first).
 */
export function collectDistinctQuarters(reports: ReportingModel[]): Array<{ key: string; label: string }> {
  const map = new Map<string, string>();
  for (const report of reports) {
    for (const period of report.periods) {
      if (!map.has(period.key)) {
        map.set(period.key, period.label || period.key);
      }
    }
  }
  return Array.from(map.entries())
    .map(([key, label]) => ({ key, label }))
    .sort((a, b) => b.key.localeCompare(a.key));
}

/**
 * Sanitize a quarter key into a valid Google Sheets tab name.
 * Sheets forbids \ / ? * [ ] : and limits to 100 chars.
 */
export function toSheetTabName(quarterKey: string): string {
  const cleaned = quarterKey.replace(/[\\/?*\[\]:]/g, "_").trim();
  return cleaned.slice(0, 100) || "Sheet";
}
