import {
  DEFAULT_CLASSIFICATION_CATALOG,
  DEFAULT_COMPANY_CONFIGS,
  DEFAULT_LOGIC_CONFIG,
  classificationCatalogToGroups,
  mergeDefaultClassificationCatalog,
  sanitizeClassificationAliases,
  type ClassificationCatalogGroup,
  type ClassificationGroups,
  type CompanyConfigs,
  type LogicConfig
} from "@/lib/validation/defaults";
import { getDefaultPersistedState, parsePersistedState, type PersistedState } from "@/lib/validation/engine";
import type { SavedQuarterSnapshot } from "@/lib/validation/report";

export type SharedConfigRecord = {
  logicConfig: LogicConfig;
  companyConfigs: CompanyConfigs;
  classificationCatalog: ClassificationCatalogGroup[];
  classificationGroups: ClassificationGroups;
  workspaceMemo: string;
  workspaceMemoUpdatedAt?: string | null;
  workspaceMemoUpdatedBy?: string | null;
  // 저장된 datasets가 마지막으로 동기화된 분류DB catalog의 signature.
  // 부팅 시 현재 catalog와 비교해 같으면 동기화를 건너뛴다 (전 사용자 공유).
  lastSyncedCatalogSignature?: string | null;
};

export type SharedStateResponse = {
  config: SharedConfigRecord;
  datasets: SavedQuarterSnapshot[];
};

export function normalizeSharedConfig(input: Partial<PersistedState> | null | undefined): PersistedState {
  return parsePersistedState(JSON.stringify(input ?? getDefaultPersistedState()));
}

export function serializeSharedConfig(config: SharedConfigRecord) {
  const catalog = mergeDefaultClassificationCatalog(config.classificationCatalog.map((item) => ({
    ...item,
    aliases: sanitizeClassificationAliases(item.aliases)
  })));

  return {
    logic_config: config.logicConfig ?? structuredClone(DEFAULT_LOGIC_CONFIG),
    company_configs: config.companyConfigs ?? structuredClone(DEFAULT_COMPANY_CONFIGS),
    classification_catalog: catalog.length ? catalog : structuredClone(DEFAULT_CLASSIFICATION_CATALOG)
  };
}

export function deserializeSharedConfig(row: {
  logic_config?: LogicConfig | null;
  company_configs?: CompanyConfigs | null;
  classification_catalog?: ClassificationCatalogGroup[] | null;
  workspace_memo?: string | null;
  workspace_memo_updated_at?: string | null;
  workspace_memo_updated_by?: string | null;
  last_synced_catalog_signature?: string | null;
} | null | undefined): SharedConfigRecord {
  const catalog = Array.isArray(row?.classification_catalog)
    ? mergeDefaultClassificationCatalog(row?.classification_catalog)
    : structuredClone(DEFAULT_CLASSIFICATION_CATALOG);

  const persisted = normalizeSharedConfig({
    logicConfig: row?.logic_config ?? structuredClone(DEFAULT_LOGIC_CONFIG),
    companyConfigs: row?.company_configs ?? structuredClone(DEFAULT_COMPANY_CONFIGS),
    classificationCatalog: catalog,
    classificationGroups: classificationCatalogToGroups(catalog)
  });

  return {
    ...persisted,
    workspaceMemo: typeof row?.workspace_memo === "string" ? row!.workspace_memo : "",
    workspaceMemoUpdatedAt: row?.workspace_memo_updated_at ?? null,
    workspaceMemoUpdatedBy: row?.workspace_memo_updated_by ?? null,
    lastSyncedCatalogSignature: typeof row?.last_synced_catalog_signature === "string" ? row!.last_synced_catalog_signature : null
  };
}
