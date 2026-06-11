-- 국내 패밀리사 명단 (데이터 탭 "패밀리 N/M" 수집 현황의 분모).
-- 한 줄 = 회사 하나인 text[] 형태의 jsonb. 앱(데이터 탭 패밀리 패널)에서 편집한다.
-- 컬럼이 없거나 값이 비어 있으면 앱은 코드에 내장된 기본 명단으로 동작한다.
-- family_companies = ["왓챠", "두나무", "청연 (구 생활연구소)", ...]
alter table public.app_config
  add column if not exists family_companies jsonb,
  add column if not exists family_companies_updated_at timestamptz,
  add column if not exists family_companies_updated_by text;
