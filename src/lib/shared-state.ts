import {
  DEFAULT_COMPANY_CONFIGS,
  DEFAULT_LOGIC_CONFIG,
  type CompanyConfigs,
  type LogicConfig
} from "@/lib/validation/defaults";
import { getDefaultPersistedState, parsePersistedState, type PersistedState } from "@/lib/validation/engine";
import type { SavedQuarterSnapshot } from "@/lib/validation/report";

export type SharedConfigRecord = {
  logicConfig: LogicConfig;
  companyConfigs: CompanyConfigs;
  workspaceMemo: string;
  workspaceMemoUpdatedAt?: string | null;
  workspaceMemoUpdatedBy?: string | null;
  // 저장된 datasets가 마지막으로 동기화된 분류DB(계정트리) signature.
  // 부팅 시 현재 트리와 비교해 같으면 동기화를 건너뛴다 (전 사용자 공유).
  lastSyncedCatalogSignature?: string | null;
  // 국내 패밀리사 명단(한 항목 = 회사 하나). null이면 DB 미설정 — 앱 기본 명단 사용.
  familyCompanies?: string[] | null;
  familyCompaniesUpdatedAt?: string | null;
  familyCompaniesUpdatedBy?: string | null;
};

export type SharedStateResponse = {
  config: SharedConfigRecord;
  datasets: SavedQuarterSnapshot[];
};

export function normalizeSharedConfig(input: Partial<PersistedState> | null | undefined): PersistedState {
  return parsePersistedState(JSON.stringify(input ?? getDefaultPersistedState()));
}

export function serializeSharedConfig(config: SharedConfigRecord) {
  return {
    logic_config: config.logicConfig ?? structuredClone(DEFAULT_LOGIC_CONFIG),
    company_configs: config.companyConfigs ?? structuredClone(DEFAULT_COMPANY_CONFIGS)
  };
}

export function deserializeSharedConfig(row: {
  logic_config?: LogicConfig | null;
  company_configs?: CompanyConfigs | null;
  workspace_memo?: string | null;
  workspace_memo_updated_at?: string | null;
  workspace_memo_updated_by?: string | null;
  last_synced_catalog_signature?: string | null;
  family_companies?: unknown;
  family_companies_updated_at?: string | null;
  family_companies_updated_by?: string | null;
} | null | undefined): SharedConfigRecord {
  const persisted = normalizeSharedConfig({
    logicConfig: row?.logic_config ?? structuredClone(DEFAULT_LOGIC_CONFIG),
    companyConfigs: row?.company_configs ?? structuredClone(DEFAULT_COMPANY_CONFIGS)
  });

  const familyCompanies = Array.isArray(row?.family_companies)
    ? (row!.family_companies as unknown[]).filter((v): v is string => typeof v === "string" && !!v.trim())
    : null;

  return {
    ...persisted,
    workspaceMemo: typeof row?.workspace_memo === "string" ? row!.workspace_memo : "",
    workspaceMemoUpdatedAt: row?.workspace_memo_updated_at ?? null,
    workspaceMemoUpdatedBy: row?.workspace_memo_updated_by ?? null,
    lastSyncedCatalogSignature: typeof row?.last_synced_catalog_signature === "string" ? row!.last_synced_catalog_signature : null,
    familyCompanies,
    familyCompaniesUpdatedAt: row?.family_companies_updated_at ?? null,
    familyCompaniesUpdatedBy: row?.family_companies_updated_by ?? null
  };
}
