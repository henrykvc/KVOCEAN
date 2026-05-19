import { CLASSIFICATION_SEED, type ClassificationSeedEntry } from "./classification-seed";

export type SignCode = 0 | 1 | 2;

export type ClassificationEntry = ClassificationSeedEntry;
export const CLASSIFICATION_ENTRIES: ClassificationEntry[] = CLASSIFICATION_SEED;

// Treat whitespace and common separators as "absent" — same account name in
// OCR can arrive as "단기대여금_대손충당금", "단기대여금 대손충당금",
// "단기대여금-대손충당금", "대손충당금(단기대여금)" etc. We strip all of these
// so identical glyph sequences collapse to one lookup key.
// Audit confirmed (scripts/audit-seed-collisions.mjs): this introduces zero
// new sign collisions across the 632-entry seed.
export function normalizeLookupKey(value: string): string {
  return (value ?? "").replace(/[\s_\-.\/\\()\[\]·•'"]+/g, "").toLowerCase();
}

// Some aliases appear in multiple seed entries (e.g. "전기오류수정손실" lives in both
// 자본 (3051000, −) and 영업외비용 (5082000, +)). Index every candidate so we can
// disambiguate at lookup time using the OCR section the row belongs to.
const SEED_ALIAS_LOOKUP: Map<string, ClassificationEntry[]> = (() => {
  const map = new Map<string, ClassificationEntry[]>();
  const push = (rawKey: string, entry: ClassificationEntry) => {
    const key = normalizeLookupKey(rawKey);
    if (!key) return;
    const list = map.get(key);
    if (list) {
      if (!list.includes(entry)) list.push(entry);
    } else {
      map.set(key, [entry]);
    }
  };
  for (const entry of CLASSIFICATION_ENTRIES) {
    push(entry.세분류, entry);
    for (const alias of entry.aliases) push(alias, entry);
  }
  return map;
})();

const SEED_CODE_LOOKUP: Map<number, ClassificationEntry> = (() => {
  const map = new Map<number, ClassificationEntry>();
  for (const entry of CLASSIFICATION_ENTRIES) {
    map.set(entry.code, entry);
  }
  return map;
})();

/**
 * Find the seed entry that an OCR row's account name maps into.
 * When sectionHint is provided (the OCR row's parent section, e.g. "영업외비용"),
 * candidates whose 중분류/대분류 match the hint win. This is how we keep ambiguous
 * names like "전기오류수정손실" (자본 vs 영업외비용) from landing on the wrong sign.
 */
export function findEntryByAlias(alias: string, sectionHint?: string): ClassificationEntry | null {
  if (!alias) return null;
  const candidates = SEED_ALIAS_LOOKUP.get(normalizeLookupKey(alias));
  if (!candidates || candidates.length === 0) return null;
  if (candidates.length === 1 || !sectionHint) return candidates[0];

  const hint = normalizeLookupKey(sectionHint);
  if (!hint) return candidates[0];

  // Prefer entries whose 중분류 / 대분류 / 소분류 matches the OCR section.
  const byMiddle = candidates.find((c) => normalizeLookupKey(c.중분류) === hint);
  if (byMiddle) return byMiddle;
  const byMajor = candidates.find((c) => normalizeLookupKey(c.대분류) === hint);
  if (byMajor) return byMajor;
  const bySmall = candidates.find((c) => normalizeLookupKey(c.소분류) === hint);
  if (bySmall) return bySmall;
  return candidates[0];
}

export function findEntryByCode(code: number): ClassificationEntry | null {
  return SEED_CODE_LOOKUP.get(code) ?? null;
}

/**
 * Find all seed entries whose code shares the given prefix.
 * Used for summing groups by level — e.g. all 매출채권 (+/−) share prefix 1001.
 * - prefix 1001 → matches 1001000, 1001100
 * - prefix 100 → matches all 당좌자산 codes (1000000..1004xxx)
 */
export function findEntriesByCodePrefix(codePrefix: number): ClassificationEntry[] {
  const prefixStr = String(codePrefix);
  return CLASSIFICATION_ENTRIES.filter((entry) => String(entry.code).startsWith(prefixStr));
}

/** Find seed entries by their hierarchical name (대/중/소). */
export function findEntriesByLayer(
  layer: "대분류" | "중분류" | "소분류" | "세분류",
  name: string
): ClassificationEntry[] {
  const target = name.trim();
  if (!target) return [];
  return CLASSIFICATION_ENTRIES.filter((entry) => entry[layer]?.trim() === target);
}

export type LogicConfig = {
  plusOverrideKeywords: string[];
  minusKeywords: string[];
  plusCostKeywords: string[];
  capitalL1Signs: Record<string, boolean>;
  capitalL1Parent: Record<string, string>;
  capitalMemoAccounts: string[];
  pasteSectToParent: Record<string, string>;
  sectionSignOverrides: Record<string, Record<string, SignCode>>;
  /**
   * 검증 합산 규칙(SUMMARY_RULES)에서 부모 항목 lookup 시 사용하는 다른 이름들.
   * 예: paste에 "자본총계"라 적혀있어도 "자본" 부모로 인식.
   * 이전엔 LEGACY_PARENT_GROUPS에 자식 alias와 섞여있었는데,
   * 부모 별칭만 떼어 logicConfig로 옮김 — 1-1 검증 규칙 관리 탭에서 편집 가능.
   */
  parentAliases?: Record<string, string[]>;
};

export type CompanyConfig = {
  industry?: string;
  accountingStandard?: string;
  sectionSignOverrides?: Record<string, Record<string, SignCode>>;
};

export type CompanyConfigs = Record<string, CompanyConfig>;
export type ClassificationGroups = Record<string, string[]>;
export type ClassificationCatalogGroup = {
  groupId: string;
  majorCategory: string;
  middleCategory: string;
  smallCategory: string;
  sign: string;
  canonicalKey: string;
  aliases: string[];
};

export const MANAGED_CLASSIFICATION_KEYS = [
  "당좌자산",
  "현금및현금성자산",
  "차입금",
  "매출채권",
  "재고자산",
  "감가상각비계",
  "인건비",
  "연구개발비",
  "접대비",
  "복리후생비",
  "광고선전비",
  "지급수수료",
  "외주용역비",
  "임차료",
  "이자비용",
  "단기대여금",
  "개발비(자산)",
  "선급금",
  "가수금",
  "가지급금",
  "퇴직급여충당부채",
  "변동비"
] as const;

export const MANAGED_CLASSIFICATION_KEY_SET = new Set<string>(MANAGED_CLASSIFICATION_KEYS);

export const SYSTEM_FIXED_CLASSIFICATION_KEYS = [
  "자산",
  "부채",
  "자본",
  "유동자산",
  "비유동자산",
  "유동부채",
  "비유동부채",
  "매출액",
  "매출원가",
  "영업이익",
  "영업외수익",
  "영업외비용"
] as const;

const LEGACY_REMOVED_CLASSIFICATION_ALIASES = new Set<string>([
  "개발비_양수",
  "개발비_음수",
  "선급금_양수",
  "선급금_음수",
  "단기대여금_양수",
  "단기대여금_음수",
  "매출채권_양수",
  "매출채권_음수",
  "미수금_음수",
  "미수수익_음수"
]);

const SYSTEM_FIXED_CLASSIFICATION_KEY_SET = new Set<string>(SYSTEM_FIXED_CLASSIFICATION_KEYS);
const CASH_EQUIVALENT_CANONICAL_KEY = "현금및현금성자산";
const QUICK_ASSET_CANONICAL_KEY = "당좌자산";
const CASH_EQUIVALENT_RAW_ALIASES = new Set([
  "현금",
  "보통예금",
  "당좌예금",
  "정기예적금",
  "정기예금",
  "정기적금",
  "예금",
  "예치금",
  "외화예금"
].map((alias) => alias.trim()));

export const LAST_PATCH = "2026-03-19 17:55";

export const RESULT_ORDER = [
  "자산", "유동자산", "비유동자산",
  "부채", "유동부채", "비유동부채",
  "자본", "자본잉여금", "이익잉여금", "미처분이익잉여금",
  "결손금", "미처리결손금",
  "기타포괄손익누계액", "기타자본", "기타자본요소", "자본조정",
  "매출액", "매출원가", "판매비와관리비",
  "영업이익", "영업이익(손실)",
  "영업외수익", "영업외비용",
  "법인세차감전이익", "법인세차감전손실",
  "계속사업당기순이익", "계속사업당기순손실",
  "당기순이익", "당기순손실"
] as const;


export const LOSS_ACCOUNTS = new Set([
  "영업손실",
  "당기순손실",
  "계속사업당기순손실",
  "계속사업당기순이익(손실)",
  "법인세차감전순손실",
  "법인세비용차감전순손실",
  "연속사업손실",
  "법인세차감전손실"
]);

export const SUMMARY_RULES: Array<[string, string, Array<[string, 0 | 1]>]> = [
  ["자산 = 유동자산 + 비유동자산", "자산", [["유동자산", 0], ["비유동자산", 0]]],
  ["자산 = 부채 + 자본", "자산", [["부채", 0], ["자본", 0]]],
  ["부채 = 유동부채 + 비유동부채", "부채", [["유동부채", 0], ["비유동부채", 0]]],
  ["영업이익 = 매출액 − 매출원가 − 판관비", "영업이익", [["매출액", 0], ["매출원가", 1], ["판매비와관리비", 1]]],
  ["법인세차감전이익 = 영업이익 + 영업외수익 − 영업외비용", "법인세차감전이익", [["영업이익", 0], ["영업외수익", 0], ["영업외비용", 1]]],
  ["당기순이익 = 법인세차감전이익 − 법인세등", "당기순이익", [["법인세차감전이익", 0], ["법인세등", 1]]]
];

export const DEFAULT_LOGIC_CONFIG: LogicConfig = {
  plusOverrideKeywords: ["정부보조금이익", "국고보조금이익", "대손상각비", "대손비용", "대손충당금전입액", "국고보조금반환", "정부보조금반환", "보조금반환", "기타포괄손익누계액"],
  minusKeywords: ["누계액", "충당금", "대손", "정부보조금", "국고보조금", "국가보조금", "현할차", "할인차금", "전환권조정", "신주인수권조정", "매출차감", "손상차손누계", "감가상각누계"],
  plusCostKeywords: ["외주용역비", "외주비", "용역비", "인건비", "급여", "상여금", "퇴직급여", "임차료", "지급임차료", "광고선전비", "판촉비", "여비교통비", "출장비", "통신비", "소모품비", "사무용품비", "보험료", "수선비", "유지보수비", "접대비", "복리후생비", "교육훈련비", "연구비", "지급수수료", "수수료비용", "운반비", "배송비"],
  capitalL1Signs: {
    자본금: true,
    자본잉여금: true,
    자본조정: true,
    기타포괄손익누계액: true,
    기타자본요소: true,
    결손금: false,
    이익잉여금: true,
    이익잉여금결손금: true,
    미처리결손금: false,
    미처분이익잉여금: true
  },
  capitalL1Parent: {
    이익잉여금결손금: "이익잉여금",
    미처리결손금: "결손금",
    미처분이익잉여금: "이익잉여금",
    이익잉여금: "결손금"
  },
  capitalMemoAccounts: ["당기순손실", "당기순이익", "당기순손익", "당기순이익(손실)", "당기순이익(당기순손실)", "연결당기순이익", "연결당기순손실", "미처리결손금"],
  pasteSectToParent: {
    유동자산: "유동자산",
    비유동자산: "비유동자산",
    유동부채: "유동부채",
    비유동부채: "비유동부채",
    매출액: "매출액",
    판매비와관리비: "판매비와관리비",
    판관비: "판매비와관리비",
    영업외수익: "영업외수익",
    영업외비용: "영업외비용"
  },
  parentAliases: {
    자본: ["자본", "자본총계", "총자본"],
    영업이익: ["영업이익", "영업이익(손실)"],
    판매비와관리비: ["판매비와관리비", "판관비", "판매관리비", "판매비및관리비", "판매비와관리비합계"],
    영업외수익: ["영업외수익", "기타수익", "영업외수익합계", "금융수익"],
    이자비용: ["이자비용", "총이자비용", "금융비용"],
    영업비용: ["판매비와관리비", "판관비", "영업비용"],
    당기순이익: ["당기순이익", "당기순이익(손실)", "당기순손익", "연결당기순이익", "당기순이익(당기순손실)", "당기순손실"],
    법인세차감전이익: ["법인세차감전이익", "법인세차감전순이익", "법인세비용차감전순이익", "세전계속사업이익", "법인세차감전이익(손실)", "법인세비용차감전순이익(손실)", "법인세비용차감전계속사업이익", "법인세차감전손실", "법인세차감전순손실", "법인세비용차감전순손실"],
    법인세등: ["법인세등", "법인세 등", "법인세비용", "법인세비용(수익)", "법인세수익", "계속사업법인세비용", "당기법인세비용", "이연법인세비용", "법인세환급"],
    계속사업당기순이익: ["당기순이익", "당기순손실", "당기순이익(손실)", "당기순손익", "계속사업당기순이익", "계속사업당기순손실", "계속사업당기순이익(손실)"],
    결손금: ["결손금", "미처리결손금"],
    이익잉여금: ["이익잉여금", "미처분이익잉여금", "이익잉여금결손금"]
  },
  sectionSignOverrides: {
    비유동부채: { 퇴직연금운용자산: 1, 사외적립자산: 1 },
    유동부채: { 퇴직연금운용자산: 1, 사외적립자산: 1 },
    영업외수익: { 국고보조금: 0, 정부보조금: 0, 국가보조금: 0, 충당금환입: 0 }
  }
};

export const DEFAULT_COMPANY_CONFIGS: CompanyConfigs = {};

/**
 * 합산 자식 목록만 남은 임시 정의. 부모 별칭은 DEFAULT_LOGIC_CONFIG.parentAliases로
 * 이전됨. 보고서 카드(차입금/인건비/매출채권 합산)에서 자식 alias 모음으로 사용 중.
 * 추후 결과물DB(result-classification.ts)의 group 필드로 옮기고 제거 예정.
 */
const LEGACY_PARENT_GROUPS: ClassificationGroups = {
  유동자산: ["유동자산"],
  당좌자산: [
    "당좌자산",
    "현금및현금성자산",
    "매출채권",
    "미수금",
    "미수금_대손충당금",
    "미수금_정부보조금",
    "미수수익",
    "미수수익_대손충당금",
    "매도가능증권"
  ],
  비유동자산: ["비유동자산"],
  자산: ["자산"],
  유동부채: ["유동부채"],
  비유동부채: ["비유동부채"],
  부채: ["부채"],
  자본: ["자본", "자본총계", "총자본"],
  이익잉여금: ["이익잉여금", "미처분이익잉여금", "이익잉여금결손금"],
  결손금: ["결손금", "미처리결손금"],
  매출액: ["매출액"],
  매출원가: ["매출원가"],
  영업비용: ["판매비와관리비", "판관비", "영업비용"],
  영업외비용: ["영업외비용"],
  영업이익: ["영업이익", "영업이익(손실)"],
  계속사업당기순이익: ["당기순이익", "당기순손실", "당기순이익(손실)", "당기순손익", "계속사업당기순이익", "계속사업당기순손실", "계속사업당기순이익(손실)"],
  // Absorbed from legacy ACCOUNT_ALIASES so all matching goes through a single layer.
  당기순이익: ["당기순이익", "당기순이익(손실)", "당기순손익", "연결당기순이익", "당기순이익(당기순손실)", "당기순손실"],
  법인세차감전이익: ["법인세차감전이익", "법인세차감전순이익", "법인세비용차감전순이익", "세전계속사업이익", "법인세차감전이익(손실)", "법인세비용차감전순이익(손실)", "법인세비용차감전계속사업이익", "법인세차감전손실", "법인세차감전순손실", "법인세비용차감전순손실"],
  판매비와관리비: ["판매비와관리비", "판관비", "판매관리비", "판매비및관리비", "판매비와관리비합계"],
  영업외수익: ["영업외수익", "기타수익", "영업외수익합계", "금융수익"],
  법인세등: ["법인세등", "법인세 등", "법인세비용", "법인세비용(수익)", "법인세수익", "계속사업법인세비용", "당기법인세비용", "이연법인세비용", "법인세환급"],
  차입금: [
    "차입금",
    "차입금",
    "단기차입금",
    "단기차입금_주주임원종업원",
    "단기차입금_기타",
    "장기차입금",
    "장기차입금_주주임원종업원",
    "장기차입금_기타",
    "유동성장기차입금",
    "유동성_장기부채",
    "유동성_장기차입금",
    "유동성_일반사채",
    "유동성_전환사채",
    "유동성_신주인수권부사채",
    "유동성_교환사채",
    "일반사채",
    "전환사채",
    "신주인수권부사채",
    "교환사채",
    "사채",
    "유동성_장기차입금_현할차",
    "유동성_일반사채_사채할인발행차금",
    "유동성_일반사채_사채할증발행차금",
    "유동성_전환사채_사채할인발행차금",
    "유동성_전환사채_사채할증발행차금",
    "유동성_전환사채_상환할증금",
    "유동성_전환사채_전환권조정",
    "유동성_신주인수권부사채_사채할인차금",
    "유동성_신주인수권부사채_사채할증차금",
    "유동성_신주인수권부사채_상환할증금",
    "유동성_신주인수권부사채_신주인수권조정",
    "유동성_교환사채_사채할인발행차금",
    "유동성_교환사채_사채할증발행차금",
    "유동성_교환사채_상환할증금",
    "장기차입금_현할차",
    "일반사채_사채할인발행차금",
    "일반사채_사채할증발행차금",
    "전환사채_사채할인발행차금",
    "전환사채_사채할증발행차금",
    "전환사채_상환할증금",
    "전환사채_전환권조정",
    "신주인수권부사채_사채할인발행차금",
    "신주인수권부사채_사채할증발행차금",
    "신주인수권부사채_상환할증금",
    "신주인수권부사채_신주인수권조정",
    "교환사채_사채할인발행차금",
    "교환사채_사채할증발행차금",
    "교환사채_상환할증금"
  ],
  이자비용: ["총이자비용", "이자비용", "금융비용"],
  인건비: ["인건비", "급여", "직원급여", "상여금", "퇴직급여", "잡금", "잡급", "퇴직금"],
  연구개발비: ["연구개발비", "연구비", "사업개발비"],
  접대비: ["접대비", "접대비기업업무추진비"],
  복리후생비: ["복리후생비"],
  광고선전비: ["광고선전비", "광고비", "판매촉진비", "견본비"],
  지급수수료: ["지급수수료", "수수료비용"],
  외주용역비: ["외주용역비", "외주비", "용역비"],
  임차료: ["임차료", "지급임차료"],
  배송비: ["배송비"],
  운반비: ["운반비"],
  수출제비용: ["수출제비용"],
  여비교통비: ["여비교통비", "출장비", "여비", "교통비"],
  통신비: ["통신비"],
  세금과공과금: ["세금과공과금", "세금과공과"],
  도서인쇄비: ["도서인쇄비", "도서인쇄", "인쇄비"],
  소모품비: ["소모품비", "사무용품비"],
  대손상각비: ["대손상각비", "대손충당금전입액", "대손비용"],
  판매촉진비: ["판매촉진비", "판촉비"],
  대외협력비: ["대외협력비", "대외협력"],
  행사비: ["행사비"],
  기술이전료: ["기술이전료", "기술이전"],
  경상기술료: ["경상기술료", "경상기술"],
  전산운영비: ["전산운영비", "전산비", "시스템운영비"],
  반품비용: ["반품비용", "반품손실"],
  기타변동비: ["기타변동비"],
  현금및현금성자산: ["현금및현금성자산", "현금", "보통예금", "당좌예금", "정기예적금", "정기예금", "정기적금", "예금"],
  매도가능증권: ["매도가능증권"],
  단기대여금: ["단기대여금", "단기대여금_주주임원종업원", "단기대여금_기타"],
  "개발비(자산)": ["개발비(자산)", "개발비"],
  선급금: ["선급금"],
  가수금: ["가수금"],
  가지급금: ["가지급금"],
  퇴직급여충당부채: ["퇴직급여충당부채", "퇴직급여충당부채_양수", "확정급여채무", "퇴직급여충당부채_음수", "사외적립자산", "단기종업원부채_퇴직급여", "장기종업원부채_퇴직급여"],
  매출채권: ["매출채권", "외상매출금", "장기매출채권", "매출채권_대손충당금", "장기매출채권_대손충당금", "매출채권_현할차", "장기매출채권_현할차"],
  미수금: ["미수금", "미수금_대손충당금", "미수금_정부보조금"],
  미수수익: ["미수수익", "미수수익_대손충당금"],
  재고자산: [
    "재고자산",
    "상품",
    "상품_재고충당금",
    "상품_평가충당금",
    "제품",
    "제품_재고충당금",
    "제품_평가충당금",
    "원재료",
    "원재료_재고충당금",
    "원재료_평가충당금",
    "원재료_국고보조금",
    "부재료",
    "부재료_재고충당금",
    "반제품",
    "반제품_재고충당금",
    "재공품",
    "재공품_재고충당금",
    "재공품_평가충당금",
    "저장품",
    "저장품_재고충당금",
    "암호화폐(재고자산)"
  ],
  "감가상각비계": ["감가상각비계", "감가상각비", "무형자산상각비", "무형고정자산상각", "무형자산상각", "사용권자산상각비"]
};

/**
 * Build the runtime DEFAULT_CLASSIFICATION_GROUPS from the seed + LEGACY children list.
 *
 * 부모 별칭(자본총계, 판관비 등)은 logicConfig.parentAliases로 분리됐고,
 * 부호 lookup도 더 이상 이 데이터를 거치지 않는다 (시드 우선). 여기 남아있는 LEGACY
 * 머지는 report.ts의 보고서 카드 자식 합산 path에서만 사용 — 다음 푸시에서
 * 결과물DB의 group 필드로 옮기면 LEGACY 자체 제거 가능.
 */
function buildDefaultClassificationGroups(): ClassificationGroups {
  const groups: ClassificationGroups = {};

  for (const entry of CLASSIFICATION_ENTRIES) {
    const key = entry.세분류.trim();
    if (!key) continue;
    const merged = new Set<string>([key, ...entry.aliases.map((a) => a.trim()).filter(Boolean)]);
    if (groups[key]) {
      groups[key].forEach((alias) => merged.add(alias));
    }
    groups[key] = Array.from(merged);
  }

  for (const [key, aliases] of Object.entries(LEGACY_PARENT_GROUPS)) {
    const existing = groups[key] ?? [];
    const merged = new Set<string>([key, ...existing, ...aliases]);
    groups[key] = Array.from(merged);
  }

  return groups;
}

export const DEFAULT_CLASSIFICATION_GROUPS: ClassificationGroups = buildDefaultClassificationGroups();

export function classificationGroupsToCatalog(groups: ClassificationGroups): ClassificationCatalogGroup[] {
  return Object.entries(groups).map(([canonicalKey, aliases], index) => {
    // Prefer the seed whose 세분류 exactly matches canonicalKey — buildDefaultClassificationGroups
    // keys groups by 세분류, so this lands on the right entry even when an alias is shared by
    // multiple seeds (e.g. "전기오류수정손실" is both 자본/3051000 and 영업외비용/5082000).
    let seed: ClassificationEntry | null =
      CLASSIFICATION_ENTRIES.find((e) => e.세분류 === canonicalKey) ?? null;
    if (!seed) seed = findEntryByAlias(canonicalKey);
    if (!seed) {
      for (const alias of aliases) {
        const hit = findEntryByAlias(alias);
        if (hit) { seed = hit; break; }
      }
    }

    const groupId = seed
      ? String(seed.code).padStart(7, "0")
      : `${String(index + 1).padStart(4, "0")}000`;

    return {
      groupId,
      majorCategory: seed?.대분류 ?? "",
      middleCategory: seed?.중분류 ?? "",
      smallCategory: seed?.소분류 ?? "",
      sign: seed ? (seed.sign === 1 ? "−" : "+") : "",
      canonicalKey,
      aliases: Array.from(new Set(aliases.filter((alias) => alias.trim() && alias.trim() !== canonicalKey.trim())))
    };
  });
}

export const DEFAULT_CLASSIFICATION_CATALOG: ClassificationCatalogGroup[] = classificationGroupsToCatalog(DEFAULT_CLASSIFICATION_GROUPS);

export function isSystemFixedClassificationKey(key: string) {
  return SYSTEM_FIXED_CLASSIFICATION_KEY_SET.has(key.trim());
}

export function sanitizeClassificationAliases(aliases: unknown[]) {
  return Array.from(new Set((Array.isArray(aliases) ? aliases : [])
    .map((alias) => typeof alias === "string" ? alias.trim() : "")
    .filter((alias) => alias && !LEGACY_REMOVED_CLASSIFICATION_ALIASES.has(alias))));
}

export function sanitizeClassificationGroups(groups: Record<string, unknown>): ClassificationGroups {
  return Object.fromEntries(Object.entries(groups ?? {}).map(([canonicalKey, aliases]) => [
    canonicalKey.trim(),
    sanitizeClassificationAliases(Array.isArray(aliases) ? aliases : [])
  ]));
}

export function mergeSystemFixedClassificationCatalog(catalog: ClassificationCatalogGroup[]): ClassificationCatalogGroup[] {
  const normalizedCatalog = catalog.map((item) => ({
    ...item,
    canonicalKey: item.canonicalKey.trim(),
    aliases: sanitizeClassificationAliases(item.aliases)
  }));

  const byCanonicalKey = new Map(normalizedCatalog.map((item) => [item.canonicalKey, item]));

  DEFAULT_CLASSIFICATION_CATALOG
    .filter((item) => isSystemFixedClassificationKey(item.canonicalKey))
    .forEach((defaultItem) => {
      const existing = byCanonicalKey.get(defaultItem.canonicalKey);
      if (existing) {
        byCanonicalKey.set(defaultItem.canonicalKey, {
          ...existing,
          aliases: Array.from(new Set([...defaultItem.aliases, ...existing.aliases]))
        });
        return;
      }

      byCanonicalKey.set(defaultItem.canonicalKey, structuredClone(defaultItem));
    });

  return normalizedCatalog.map((item) => byCanonicalKey.get(item.canonicalKey) ?? item)
    .concat(
      Array.from(byCanonicalKey.values()).filter((item) => !normalizedCatalog.some((catalogItem) => catalogItem.canonicalKey === item.canonicalKey))
    );
}

export function mergeDefaultClassificationCatalog(catalog: ClassificationCatalogGroup[]): ClassificationCatalogGroup[] {
  const normalizedCatalog = catalog.map((item) => ({
    ...item,
    canonicalKey: item.canonicalKey.trim(),
    aliases: sanitizeClassificationAliases(item.aliases)
  }));

  const byCanonicalKey = new Map(normalizedCatalog.map((item) => [item.canonicalKey, item]));

  DEFAULT_CLASSIFICATION_CATALOG.forEach((defaultItem) => {
    const existing = byCanonicalKey.get(defaultItem.canonicalKey);
    if (existing) {
      // Group metadata (groupId, 대/중/소분류, sign) is owned by the seed —
      // users only edit alias membership via the 분류DB UI. Letting stored
      // metadata win meant any seed/resolver fix (e.g. 영업외비용 전기오류수정손실
      // sign) would never reach users who already had a saved catalog.
      byCanonicalKey.set(defaultItem.canonicalKey, {
        ...existing,
        ...defaultItem,
        aliases: MANAGED_CLASSIFICATION_KEY_SET.has(defaultItem.canonicalKey)
          ? Array.from(new Set(existing.aliases))
          : Array.from(new Set([...defaultItem.aliases, ...existing.aliases]))
      });
      return;
    }

    byCanonicalKey.set(defaultItem.canonicalKey, MANAGED_CLASSIFICATION_KEY_SET.has(defaultItem.canonicalKey)
      ? {
          ...structuredClone(defaultItem),
          aliases: []
        }
      : structuredClone(defaultItem));
  });

  const mergedCatalog = normalizedCatalog.map((item) => byCanonicalKey.get(item.canonicalKey) ?? item)
    .concat(
      Array.from(byCanonicalKey.values()).filter((item) => !normalizedCatalog.some((catalogItem) => catalogItem.canonicalKey === item.canonicalKey))
    );

  return normalizeCashHierarchyCatalog(mergedCatalog);
}

export function classificationCatalogToGroups(catalog: ClassificationCatalogGroup[]): ClassificationGroups {
  return catalog.reduce<ClassificationGroups>((acc, item) => {
    const canonicalKey = item.canonicalKey.trim();
    if (!canonicalKey) {
      return acc;
    }

    acc[canonicalKey] = Array.from(new Set([
      canonicalKey,
      ...item.aliases.map((alias) => alias.trim()).filter(Boolean)
    ]));
    return acc;
  }, {});
}

function normalizeCashHierarchyCatalog(catalog: ClassificationCatalogGroup[]) {
  const normalizedCatalog = catalog.map((item) => ({
    ...item,
    aliases: sanitizeClassificationAliases(item.aliases)
  }));

  const cashGroup = normalizedCatalog.find((item) => item.canonicalKey === CASH_EQUIVALENT_CANONICAL_KEY);
  const quickAssetGroup = normalizedCatalog.find((item) => item.canonicalKey === QUICK_ASSET_CANONICAL_KEY);

  if (!cashGroup || !quickAssetGroup) {
    return normalizedCatalog;
  }

  const cashAliases = new Set(cashGroup.aliases);
  const quickAssetAliases = new Set<string>();

  quickAssetGroup.aliases.forEach((alias) => {
    const normalizedAlias = alias.trim();
    if (!normalizedAlias) {
      return;
    }

    if (CASH_EQUIVALENT_RAW_ALIASES.has(normalizedAlias)) {
      cashAliases.add(normalizedAlias);
      return;
    }

    quickAssetAliases.add(normalizedAlias);
  });

  quickAssetAliases.add(CASH_EQUIVALENT_CANONICAL_KEY);
  cashGroup.aliases = Array.from(cashAliases);
  quickAssetGroup.aliases = Array.from(quickAssetAliases);

  return normalizedCatalog;
}

export const COMPANY_LABELS = ["회사명", "회사", "법인명", "company", "Company"];

/**
 * Compare a stored snapshot row's sign/canonicalKey against the seed catalog.
 * Returns the discrepancy info if seed says something different.
 */
export type SnapshotSignDiff = {
  accountName: string;
  oldSignFlag: 0 | 1;
  newSignFlag: 0 | 1;
  oldCanonicalKey: string;
  newCanonicalKey: string;
  oldValue: number | null;
  newValue: number | null;
};

export function diffSnapshotRowAgainstSeed(row: {
  signFlag: 0 | 1;
  accountName: string;
  canonicalKey: string;
  value: number | null;
}): SnapshotSignDiff | null {
  const seed = findEntryByAlias(row.accountName);
  if (!seed) return null; // unclassified — leave as-is
  const newSign = seed.sign as 0 | 1;
  const newCanonical = seed.세분류;
  if (newSign === row.signFlag && newCanonical === row.canonicalKey) return null;
  // Reconstruct absolute value: stored value is sign-applied; undo and reapply
  const abs = row.signFlag === 1 ? -(row.value ?? 0) : (row.value ?? 0);
  const newValue = newSign === 1 ? -abs : abs;
  return {
    accountName: row.accountName,
    oldSignFlag: row.signFlag,
    newSignFlag: newSign,
    oldCanonicalKey: row.canonicalKey,
    newCanonicalKey: newCanonical,
    oldValue: row.value,
    newValue: row.value === null ? null : newValue
  };
}

/**
 * Convert a catalog group's display-sign string ("+", "−") into a SignCode.
 */
export function catalogSignToCode(sign: string): SignCode | null {
  const trimmed = (sign ?? "").trim();
  if (trimmed === "+" || trimmed === "0") return 0;
  if (trimmed === "−" || trimmed === "-" || trimmed === "1") return 1;
  if (trimmed === "제외" || trimmed === "2") return 2;
  return null;
}

export type CatalogAliasMatch = {
  sign: SignCode;
  majorCategory: string;
  middleCategory: string;
  smallCategory: string;
  canonicalKey: string;
  groupId: string;
};

/**
 * Build an alias → catalog-entry lookup from the runtime classification catalog.
 * Used so validation reflects user edits made in 4. 분류DB — not just the immutable seed.
 * Multiple matches per alias are kept; callers can disambiguate by section hint.
 */
export function buildCatalogAliasLookup(catalog: ClassificationCatalogGroup[]): Map<string, CatalogAliasMatch[]> {
  const map = new Map<string, CatalogAliasMatch[]>();
  for (const group of catalog) {
    const sign = catalogSignToCode(group.sign);
    if (sign === null) continue;
    const allAliases = [group.canonicalKey, ...group.aliases];
    for (const alias of allAliases) {
      const key = normalizeLookupKey(alias);
      if (!key) continue;
      const list = map.get(key) ?? [];
      const match: CatalogAliasMatch = {
        sign: sign as SignCode,
        majorCategory: group.majorCategory,
        middleCategory: group.middleCategory,
        smallCategory: group.smallCategory,
        canonicalKey: group.canonicalKey,
        groupId: group.groupId
      };
      if (!list.some((m) => m.groupId === match.groupId)) {
        list.push(match);
        map.set(key, list);
      }
    }
  }
  return map;
}

/**
 * Apply per-alias overrides to a classification catalog.
 * For each (alias, targetCode) pair: remove the alias from its current group
 * and add it to the group whose groupId matches the target code.
 * Returns a new catalog (does not mutate input).
 */
export function applyAliasOverridesToCatalog(
  catalog: ClassificationCatalogGroup[],
  overrides: Map<string, { code: number }>
): ClassificationCatalogGroup[] {
  if (!overrides.size) return catalog;

  const next = catalog.map((g) => ({ ...g, aliases: g.aliases.slice() }));

  for (const [aliasName, { code }] of overrides.entries()) {
    const trimmed = aliasName.trim();
    if (!trimmed) continue;
    const norm = (s: string) => s.trim();

    for (const group of next) {
      group.aliases = group.aliases.filter((a) => norm(a) !== trimmed);
    }

    const targetGroupId = String(code).padStart(7, "0");
    const target = next.find((g) => g.groupId === targetGroupId);
    if (target) {
      if (!target.aliases.some((a) => norm(a) === trimmed)) {
        target.aliases.push(trimmed);
      }
    }
  }

  return next;
}
