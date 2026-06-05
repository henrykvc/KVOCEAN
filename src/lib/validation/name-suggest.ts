/**
 * 계정명 오타 추론 — 같은 회사의 과거 분기 계정명 사전과 문자열 편집거리로
 * 비교해 "이건 X의 오타일 수 있다"를 제안한다.
 *
 * 전제: 같은 회사는 분기마다 계정명을 거의 그대로 재사용한다. 그래서 전역
 * 계정트리보다 "그 회사가 과거에 실제로 쓴 계정명"이 훨씬 강한 신호다. OCR이
 * 흘린 한두 글자(매줄액→매출액)를 한글 자모 단위 편집거리로 잡는다.
 *
 * 정책: 제안만 한다. 절대 자동 적용하지 않는다. 멀쩡한 신규 계정을 과거
 * 계정으로 잘못 합쳐버리는 게 가장 위험하므로, 사용자가 칩을 눌러 확정한다.
 */

import { normalizeAccountName } from "./account-tree";

const HANGUL_BASE = 0xac00;
const HANGUL_END = 0xd7a3;
const CHO = [
  "ㄱ", "ㄲ", "ㄴ", "ㄷ", "ㄸ", "ㄹ", "ㅁ", "ㅂ", "ㅃ", "ㅅ",
  "ㅆ", "ㅇ", "ㅈ", "ㅉ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"
];
const JUNG = [
  "ㅏ", "ㅐ", "ㅑ", "ㅒ", "ㅓ", "ㅔ", "ㅕ", "ㅖ", "ㅗ", "ㅘ",
  "ㅙ", "ㅚ", "ㅛ", "ㅜ", "ㅝ", "ㅞ", "ㅟ", "ㅠ", "ㅡ", "ㅢ", "ㅣ"
];
const JONG = [
  "", "ㄱ", "ㄲ", "ㄳ", "ㄴ", "ㄵ", "ㄶ", "ㄷ", "ㄹ", "ㄺ",
  "ㄻ", "ㄼ", "ㄽ", "ㄾ", "ㄿ", "ㅀ", "ㅁ", "ㅂ", "ㅄ", "ㅅ",
  "ㅆ", "ㅇ", "ㅈ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"
];

/** 한글 음절을 초/중/종성 자모열로 분해한다. 비음절 글자는 그대로 통과. */
export function decomposeHangul(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= HANGUL_BASE && code <= HANGUL_END) {
      const s = code - HANGUL_BASE;
      out += CHO[Math.floor(s / 588)];
      out += JUNG[Math.floor((s % 588) / 28)];
      out += JONG[s % 28];
    } else {
      out += ch;
    }
  }
  return out;
}

/** 표준 Levenshtein 편집거리(삽입·삭제·치환 각 1). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/**
 * 한글 자모 단위 유사도(0~1). 정규화(공백·기호 제거 + 소문자) 후 자모로
 * 분해해 편집거리를 잰다. 자모 단위라 "매출액 vs 매출앤"처럼 한 글자 안에서
 * 한 획만 틀린 OCR 오류를 음절 단위보다 정밀하게 잡는다.
 */
export function jamoSimilarity(a: string, b: string): { distance: number; similarity: number } {
  const na = decomposeHangul(normalizeAccountName(a));
  const nb = decomposeHangul(normalizeAccountName(b));
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return { distance: 0, similarity: 1 };
  const distance = levenshtein(na, nb);
  return { distance, similarity: 1 - distance / maxLen };
}

export type VocabEntry = {
  /** 회사가 과거 분기에 실제로 쓴 계정명. */
  name: string;
  /** 이 계정명이 등장한 분기 수(많을수록 진짜 이름일 가능성↑). */
  quarters: number;
  /** 계정트리에 매칭되는(=분류 완료된) 이름인지. */
  inTree: boolean;
};

export type TypoCandidate = {
  name: string;
  distance: number;
  similarity: number;
  quarters: number;
  inTree: boolean;
};

export type SuggestOptions = {
  /** 이 자모거리 이내면 무조건 오타 후보로 인정(짧은 이름의 1글자 오타). */
  nearDistance?: number;
  /** nearDistance를 넘어도 이 유사도 이상이면 인정(긴 이름의 한 음절 오타). */
  highSimilarity?: number;
  /** 이보다 멀면 무조건 다른 계정으로 보고 후보에서 제외. */
  maxDistance?: number;
  /** 반환할 최대 후보 수. */
  maxCandidates?: number;
};

const DEFAULTS: Required<SuggestOptions> = {
  // "매줄액→매출액"(거리1)은 잡고 "매출원가→매출액"(거리3·유사도0.7)은
  // 거른다. 거리≤2 자동인정 + 그 밖엔 유사도≥0.85만, 거리>4는 전부 제외.
  nearDistance: 2,
  highSimilarity: 0.85,
  maxDistance: 4,
  maxCandidates: 2
};

/**
 * 입력 계정명과 회사 사전을 비교해 오타 후보를 랭킹해 돌려준다.
 *
 * - 정규화 후 완전히 같은 사전 항목이 있으면 → 오타가 아니라 "그 회사가 늘
 *   쓰던(아직 미분류) 이름"이므로 후보를 내지 않는다(빈 배열).
 * - 그 외엔 자모 편집거리 임계값을 넘는 항목을 거리↑ → 분기수↓ → 트리매칭
 *   순으로 정렬해 상위 N개 반환.
 */
export function suggestTypoCandidates(
  input: string,
  vocab: VocabEntry[],
  options: SuggestOptions = {}
): TypoCandidate[] {
  const opts = { ...DEFAULTS, ...options };
  const normInput = normalizeAccountName(input);
  if (!normInput) return [];

  // 사전에 같은 이름이 이미 있으면 오타가 아니다.
  if (vocab.some((entry) => normalizeAccountName(entry.name) === normInput)) {
    return [];
  }

  const scored: TypoCandidate[] = [];
  const seen = new Set<string>();
  for (const entry of vocab) {
    const norm = normalizeAccountName(entry.name);
    if (!norm || norm === normInput || seen.has(norm)) continue;
    seen.add(norm);
    const { distance, similarity } = jamoSimilarity(input, entry.name);
    if (distance < 1) continue; // 동일
    if (distance > opts.maxDistance) continue;
    const qualifies = distance <= opts.nearDistance || similarity >= opts.highSimilarity;
    if (!qualifies) continue;
    scored.push({
      name: entry.name,
      distance,
      similarity,
      quarters: entry.quarters,
      inTree: entry.inTree
    });
  }

  scored.sort((a, b) => {
    if (a.distance !== b.distance) return a.distance - b.distance;
    if (a.quarters !== b.quarters) return b.quarters - a.quarters;
    if (a.inTree !== b.inTree) return a.inTree ? -1 : 1;
    return b.similarity - a.similarity;
  });

  return scored.slice(0, opts.maxCandidates);
}
