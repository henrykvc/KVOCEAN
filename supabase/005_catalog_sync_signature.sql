-- 저장된 datasets가 마지막으로 동기화된 분류DB catalog의 signature를 보관한다.
-- 부팅 시 현재 catalog의 signature와 비교해 같으면 동기화 작업을 건너뛴다.
-- 브라우저 localStorage 대신 이 컬럼을 쓰면, 한 사용자가 동기화한 결과를
-- 모든 사용자가 공유해 각자 매번 풀 동기화하는 비용을 없앤다.
alter table public.app_config
  add column if not exists last_synced_catalog_signature text;
