/**
 * 국내 패밀리사 명단 + 저장 데이터(company_name) 매칭.
 *
 * 명단 한 줄 = 회사 하나. 괄호는 주석이자 별칭이다:
 *   "청연 (구 생활연구소)"  → 표시명 "청연", 별칭 "생활연구소"
 *   "글로벌푸드테크(포잉코퍼레이션)" → 표시명 "글로벌푸드테크", 별칭 "포잉코퍼레이션"
 * 저장 데이터가 옛 이름("생활연구소")으로 남아 있어도 같은 회사로 센다.
 * 비교 키는 괄호·공백·"주식회사" 무시 ("드리모 주식회사" = "드리모").
 *
 * 명단은 app_config.family_companies(마이그레이션 008)에 저장하고 앱에서 편집한다.
 * 컬럼이 없거나 비어 있으면 아래 DEFAULT 명단(2026-06 기준)으로 동작한다.
 */

export type FamilyEntry = {
  /** 화면 표시명 — 괄호 주석 제거본. */
  display: string;
  /** 괄호 안에서 뽑은 별칭(옛 이름 등). */
  aliases: string[];
  /** 명단 원문 줄. */
  raw: string;
};

export type FamilyCoverage = {
  /** 명단 회사 수. */
  total: number;
  /** 해당 분기에 저장된 명단 회사(표시명). */
  saved: string[];
  /** 해당 분기에 저장 안 된 명단 회사(표시명, 가나다순). */
  missing: string[];
  /** 명단에 없는 저장 회사(전체 기간) — 정리된 옛 패밀리 등. */
  extras: string[];
};

/** 회사명 비교 키: 괄호 주석·공백·"주식회사" 무시 + 소문자. */
export function normalizeCompanyKey(name: string): string {
  return (name ?? "")
    .replace(/[(（][^)）]*[)）]/g, " ")
    .replace(/주식회사/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

/** 명단 한 줄 → 표시명 + 별칭. 빈 줄은 null. */
export function parseFamilyLine(line: string): FamilyEntry | null {
  const raw = (line ?? "").trim();
  if (!raw) return null;
  const aliases: string[] = [];
  for (const m of raw.matchAll(/[(（]([^)）]+)[)）]/g)) {
    // "구 생활연구소" / "구, 에듀캐스트" → 앞의 "구" 표기는 떼고 이름만 별칭으로.
    const alias = m[1].replace(/^\s*구[\s,，.]*/, "").trim();
    if (alias) aliases.push(alias);
  }
  const display = raw.replace(/[(（][^)）]*[)）]/g, " ").replace(/\s+/g, " ").trim() || raw;
  return { display, aliases, raw };
}

/** 명단 전체 → (비교 키 → 표시명) 매처. 표시명·원문·별칭 키를 모두 등록한다. */
export function buildFamilyMatcher(lines: string[]) {
  const entries: FamilyEntry[] = [];
  const keyToDisplay = new Map<string, string>();
  for (const line of lines) {
    const entry = parseFamilyLine(line);
    if (!entry) continue;
    entries.push(entry);
    for (const candidate of [entry.display, entry.raw, ...entry.aliases]) {
      const key = normalizeCompanyKey(candidate);
      if (key && !keyToDisplay.has(key)) keyToDisplay.set(key, entry.display);
    }
  }
  return { entries, keyToDisplay };
}

/**
 * 분기 커버리지 계산. quarterLabel이 null이면 모든 분기를 합쳐서 본다.
 * extras(명단 외 저장 회사)는 분기와 무관하게 전체 저장 데이터 기준.
 */
export function computeFamilyCoverage(
  familyLines: string[],
  savedRows: Array<{ companyName: string; quarterLabel: string }>,
  quarterLabel: string | null
): FamilyCoverage {
  const { entries, keyToDisplay } = buildFamilyMatcher(familyLines);

  const savedDisplays = new Set<string>();
  const extraNames = new Set<string>();
  for (const row of savedRows) {
    const key = normalizeCompanyKey(row.companyName);
    const display = keyToDisplay.get(key);
    if (!display) {
      extraNames.add(row.companyName);
      continue;
    }
    if (quarterLabel === null || row.quarterLabel === quarterLabel) savedDisplays.add(display);
  }

  const saved: string[] = [];
  const missing: string[] = [];
  for (const entry of entries) {
    (savedDisplays.has(entry.display) ? saved : missing).push(entry.display);
  }
  missing.sort((a, b) => a.localeCompare(b, "ko"));
  return { total: entries.length, saved, missing, extras: Array.from(extraNames).sort((a, b) => a.localeCompare(b, "ko")) };
}

/** 기본 명단(2026-06 정리본). app_config.family_companies가 비어 있을 때 사용. */
export const DEFAULT_FAMILY_COMPANIES: string[] = [
  "왓챠",
  "두나무",
  "스탠다임",
  "데이블",
  "시프트업",
  "한국신용데이터",
  "당근마켓",
  "청연 (구 생활연구소)",
  "브룩허스트거라지",
  "스켈터랩스",
  "지오인터넷",
  "바움디자인시스템즈",
  "밥게임즈",
  "플랫포스",
  "스와치온",
  "더클로젯컴퍼니",
  "포휠즈",
  "홀릭스팩토리(구, 에듀캐스트)",
  "자란다",
  "엑스트라이버",
  "업라이즈 (구 헤이비트)",
  "레티널",
  "어썸레이",
  "트래블월렛 (구, 모바일퉁)",
  "소셜빈",
  "아이헤이트플라잉버그스",
  "스마트레이더시스템",
  "펜브코퍼레이션",
  "버핏서울",
  "마카롱팩토리",
  "리턴제로",
  "셀렉트스타",
  "웨이브코퍼레이션",
  "콥틱",
  "브이로거",
  "세컨신드롬",
  "온다",
  "홈즈컴퍼니",
  "더기프팅컴퍼니",
  "컨슈머브릿지",
  "문리버",
  "세컨핸즈",
  "스파이더랩",
  "딜리헙",
  "테크타카",
  "모라이",
  "퍼블릭보이드",
  "플랭",
  "에이슬립",
  "레몬베이스",
  "라포랩스",
  "뉴닉",
  "믹서(구, 큐리오스튜디오)",
  "키노라이츠",
  "뉴로티엑스",
  "이모코그",
  "딥메트릭스",
  "비즈니스캔버스",
  "리콘랩스",
  "홉스",
  "티제이랩스",
  "플로틱",
  "외식인",
  "씨드앤",
  "루먼랩",
  "커널로그",
  "고이장례연구소",
  "프릿지크루",
  "알피",
  "아루",
  "제이앤피메디",
  "타임앤코",
  "메이코더스",
  "키보코",
  "프리베노틱스",
  "브이에이게임즈",
  "프로이드",
  "커스토먼트",
  "모요",
  "아티피셜 소사이어티",
  "유머스트알엔디",
  "에이슨",
  "가지랩",
  "메디르",
  "탤런트리",
  "메딜리티",
  "21세기 전파상",
  "위플로",
  "뉴웨이브커머스",
  "원지랩스",
  "노틸러스",
  "코넥티브",
  "액트노바",
  "에이에프아이",
  "벙커키즈",
  "버그홀",
  "뉴로엑스티",
  "보살핌",
  "하이로컬",
  "포트래이",
  "메디띵스",
  "드리모 주식회사",
  "포필러스",
  "폴스타게임즈",
  "오믈렛",
  "트리거스",
  "스퀴즈비츠",
  "비비드헬스",
  "샌디플로어",
  "지피유엔",
  "스트림스튜디오",
  "와들",
  "에이지프리",
  "알버스",
  "파파러웨이",
  "23세기아이들",
  "테이밍랩",
  "바인드",
  "텍트그룹",
  "오큐티",
  "라스트스프링",
  "솔버엑스",
  "홈앤코",
  "브랜드지놈",
  "컨포트랩",
  "플로우닉스",
  "바이버스",
  "예지엑스",
  "디마프",
  "세미에이아이",
  "탭제로",
  "티냅스",
  "엔크레더블",
  "에이투시스",
  "딥그로브",
  "젤라또랩",
  "글로벌푸드테크(포잉코퍼레이션)",
  "로지스팟",
  "리벨리온"
];
