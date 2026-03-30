export type SignCode = 0 | 1 | 2;

export type LogicConfig = {
  plusOverrideKeywords: string[];
  minusKeywords: string[];
  plusCostKeywords: string[];
  capitalL1Signs: Record<string, boolean>;
  capitalL1Parent: Record<string, string>;
  capitalMemoAccounts: string[];
  pasteSectToParent: Record<string, string>;
  sectionSignOverrides: Record<string, Record<string, SignCode>>;
};

export type CompanyConfig = {
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

export const ACCOUNT_ALIASES: Record<string, string[]> = {
  영업이익: ["영업이익", "영업이익(손실)", "영업손익", "영업이익(손익)", "영업이익또는손실", "영업이익(영업손실)", "영업손실"],
  법인세차감전이익: [
    "법인세차감전이익",
    "법인세차감전순이익",
    "법인세비용차감전순이익",
    "세전계속사업이익",
    "법인세차감전이익(손실)",
    "법인세비용차감전순이익(손실)",
    "법인세비용차감전계속사업이익",
    "법인세차감전손실",
    "법인세차감전순손실",
    "법인세비용차감전순손실"
  ],
  당기순이익: ["당기순이익", "당기순이익(손실)", "당기순손익", "연결당기순이익", "당기순이익(당기순손실)", "당기순손실"],
  판매비와관리비: ["판매비와관리비", "판관비", "판매관리비", "판매비및관리비", "판매비와관리비합계"],
  영업외수익: ["영업외수익", "기타수익", "영업외수익합계", "금융수익"],
  영업외비용: ["영업외비용", "기타비용", "영업외비용합계", "금융비용"],
  법인세등: ["법인세등", "법인세 등", "법인세비용", "법인세비용(수익)", "법인세수익", "계속사업법인세비용", "당기법인세비용", "이연법인세비용", "법인세환급"]
};

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
  plusOverrideKeywords: ["정부보조금이익", "국고보조금이익", "대손상각비", "대손비용", "대손충당금전입액", "국고보조금반환", "정부보조금반환", "보조금반환"],
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
    미처리결손금: false,
    미처분이익잉여금: true
  },
  capitalL1Parent: {
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
  sectionSignOverrides: {
    비유동부채: { 퇴직연금운용자산: 1, 사외적립자산: 1 },
    유동부채: { 퇴직연금운용자산: 1, 사외적립자산: 1 },
    영업외수익: { 국고보조금: 0, 정부보조금: 0, 국가보조금: 0, 충당금환입: 0 }
  }
};

export const DEFAULT_COMPANY_CONFIGS: CompanyConfigs = {
  알피: { sectionSignOverrides: { 유동자산: { 보통예금보조금: 2 } } },
  소셜빈: { sectionSignOverrides: { 유동자산: { 외상매출금_대손충당금: 2, 임차보증금: 2, 임차보증금현할차: 2 } } },
  에이슬립: { sectionSignOverrides: { 비유동자산: { 기계장치_감가상각: 0, 기계장치: 2, 시설장치_감가상각: 0, 시설장치: 2 } } }
};

export const DEFAULT_CLASSIFICATION_GROUPS: ClassificationGroups = {
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
  매출액: ["매출액"],
  매출원가: ["매출원가"],
  영업비용: ["판매비와관리비", "판관비", "영업비용"],
  영업외비용: ["영업외비용"],
  영업이익: ["영업이익", "영업이익(손실)"],
  계속사업당기순이익: ["당기순이익", "당기순손실", "당기순이익(손실)", "당기순손익", "계속사업당기순이익", "계속사업당기순손실", "계속사업당기순이익(손실)"],
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
  감가상각비: ["감가상각비"],
  무형자산상각비: ["무형자산상각비", "무형고정자산상각", "무형자산상각"],
  사용권자산상각비: ["사용권자산상각비"]
};

export function classificationGroupsToCatalog(groups: ClassificationGroups): ClassificationCatalogGroup[] {
  return Object.entries(groups).map(([canonicalKey, aliases], index) => ({
    groupId: `${String(index + 1).padStart(4, "0")}000`,
    majorCategory: "",
    middleCategory: "",
    smallCategory: "",
    sign: "",
    canonicalKey,
    aliases: Array.from(new Set(aliases.filter((alias) => alias.trim() && alias.trim() !== canonicalKey.trim())))
  }));
}

export const DEFAULT_CLASSIFICATION_CATALOG: ClassificationCatalogGroup[] = classificationGroupsToCatalog(DEFAULT_CLASSIFICATION_GROUPS);

export function isSystemFixedClassificationKey(key: string) {
  return SYSTEM_FIXED_CLASSIFICATION_KEY_SET.has(key.trim());
}

export function sanitizeClassificationAliases(aliases: string[]) {
  return Array.from(new Set(aliases
    .map((alias) => alias.trim())
    .filter((alias) => alias && !LEGACY_REMOVED_CLASSIFICATION_ALIASES.has(alias))));
}

export function sanitizeClassificationGroups(groups: ClassificationGroups): ClassificationGroups {
  return Object.fromEntries(Object.entries(groups).map(([canonicalKey, aliases]) => [
    canonicalKey.trim(),
    sanitizeClassificationAliases(aliases)
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

export const COMPANY_LABELS = ["회사명", "회사", "법인명", "company", "Company"];
