import type { ReportingModel } from "@/lib/validation/report";

export const SHEETS_KEY_COLUMNS = ["회사명", "분기키", "분기명"] as const;

export type MetricColumn = {
  header: string;
  section: string;
  label: string;
  kind: "amount" | "ratio" | "growthRate";
};

export function buildMetricColumns(report: ReportingModel): MetricColumn[] {
  const cols: MetricColumn[] = [];
  for (const section of report.finalSections) {
    for (const row of section.rows) {
      (["amount", "ratio", "growthRate"] as const).forEach((kind) => {
        cols.push({
          header: `${section.title}::${row.label}::${kindToLabel(kind)}`,
          section: section.title,
          label: row.label,
          kind
        });
      });
    }
  }
  return cols;
}

function kindToLabel(kind: MetricColumn["kind"]) {
  if (kind === "amount") return "금액";
  if (kind === "ratio") return "비율";
  return "증감율";
}

export function buildHeaderRow(metricColumns: MetricColumn[]): string[] {
  return [...SHEETS_KEY_COLUMNS, ...metricColumns.map((c) => c.header)];
}

export type SheetCellValue = string | number | null;

export function buildCompanyDataRows(report: ReportingModel, metricColumns: MetricColumn[]): SheetCellValue[][] {
  const sectionIndex = new Map<string, Map<string, ReportingModel["finalSections"][number]["rows"][number]>>();
  for (const section of report.finalSections) {
    const rowMap = new Map<string, ReportingModel["finalSections"][number]["rows"][number]>();
    for (const row of section.rows) {
      rowMap.set(row.label, row);
    }
    sectionIndex.set(section.title, rowMap);
  }

  return report.periods.map((period) => {
    const row: SheetCellValue[] = [
      report.companyName ?? "",
      period.key,
      period.label
    ];
    for (const col of metricColumns) {
      const metric = sectionIndex.get(col.section)?.get(col.label);
      if (!metric) {
        row.push(null);
        continue;
      }
      const record = col.kind === "amount" ? metric.amounts : col.kind === "ratio" ? metric.ratios : metric.growthRates;
      const value = record[period.key];
      row.push(value ?? null);
    }
    return row;
  });
}

export type ExistingSheetState = {
  headers: string[];
  rows: SheetCellValue[][];
};

export function parseExistingSheet(values: unknown[][] | null | undefined): ExistingSheetState {
  if (!values || !values.length) {
    return { headers: [], rows: [] };
  }
  const rawHeaders = (values[0] ?? []).map((cell) => (typeof cell === "string" ? cell : String(cell ?? "")));
  const rawRows = values.slice(1).map((row) => row.map((cell) => normalizeCell(cell)));
  return { headers: rawHeaders, rows: rawRows };
}

function normalizeCell(cell: unknown): SheetCellValue {
  if (cell === null || cell === undefined || cell === "") return null;
  if (typeof cell === "number") return cell;
  if (typeof cell === "string") {
    const trimmed = cell.trim();
    if (!trimmed) return null;
    const num = Number(trimmed.replace(/,/g, ""));
    if (Number.isFinite(num) && /^-?[\d,.]+$/.test(trimmed)) return num;
    return cell;
  }
  return String(cell);
}

export function mergeSheetState(args: {
  existing: ExistingSheetState;
  companyName: string;
  newMetricColumns: MetricColumn[];
  newDataRows: SheetCellValue[][];
}): { headers: string[]; rows: SheetCellValue[][] } {
  const newHeaders = buildHeaderRow(args.newMetricColumns);
  const existingHeaders = args.existing.headers;

  const headers = existingHeaders.length ? mergeHeaderUnion(existingHeaders, newHeaders) : newHeaders;
  const headerIndex = new Map(headers.map((h, i) => [h, i] as const));

  const filteredExistingRows = args.existing.rows.filter((row) => {
    const companyCol = existingHeaders.indexOf(SHEETS_KEY_COLUMNS[0]);
    if (companyCol < 0) return true;
    return row[companyCol] !== args.companyName;
  });

  const remappedExistingRows = filteredExistingRows.map((row) => {
    const reshaped: SheetCellValue[] = new Array(headers.length).fill(null);
    existingHeaders.forEach((h, oldIdx) => {
      const newIdx = headerIndex.get(h);
      if (newIdx !== undefined) reshaped[newIdx] = row[oldIdx] ?? null;
    });
    return reshaped;
  });

  const newRowsRemapped = args.newDataRows.map((dataRow) => {
    const reshaped: SheetCellValue[] = new Array(headers.length).fill(null);
    newHeaders.forEach((h, oldIdx) => {
      const newIdx = headerIndex.get(h);
      if (newIdx !== undefined) reshaped[newIdx] = dataRow[oldIdx] ?? null;
    });
    return reshaped;
  });

  const rows = [...remappedExistingRows, ...newRowsRemapped];

  const companyIdx = headerIndex.get(SHEETS_KEY_COLUMNS[0]) ?? 0;
  const quarterIdx = headerIndex.get(SHEETS_KEY_COLUMNS[1]) ?? 1;
  rows.sort((a, b) => {
    const ca = String(a[companyIdx] ?? "");
    const cb = String(b[companyIdx] ?? "");
    if (ca !== cb) return ca.localeCompare(cb, "ko");
    const qa = String(a[quarterIdx] ?? "");
    const qb = String(b[quarterIdx] ?? "");
    return qb.localeCompare(qa);
  });

  return { headers, rows };
}

function mergeHeaderUnion(existing: string[], incoming: string[]): string[] {
  const seen = new Set<string>(existing);
  const merged = [...existing];
  for (const h of incoming) {
    if (!seen.has(h)) {
      seen.add(h);
      merged.push(h);
    }
  }
  return merged;
}
