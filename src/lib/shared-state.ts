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
};

export type SharedStateResponse = {
  config: SharedConfigRecord;
  datasets: SavedQuarterSnapshot[];
};

export function normalizeSharedConfig(input: Partial<PersistedState> | null | undefined): SharedConfigRecord {
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
} | null | undefined): SharedConfigRecord {
  const catalog = Array.isArray(row?.classification_catalog)
    ? mergeDefaultClassificationCatalog(row?.classification_catalog)
    : structuredClone(DEFAULT_CLASSIFICATION_CATALOG);

  return normalizeSharedConfig({
    logicConfig: row?.logic_config ?? structuredClone(DEFAULT_LOGIC_CONFIG),
    companyConfigs: row?.company_configs ?? structuredClone(DEFAULT_COMPANY_CONFIGS),
    classificationCatalog: catalog,
    classificationGroups: classificationCatalogToGroups(catalog)
  });
}
