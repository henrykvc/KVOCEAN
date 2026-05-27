create table if not exists public.access_requests (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  display_name text,
  reason text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by text
);

create index if not exists access_requests_status_idx
  on public.access_requests (status, requested_at desc);

create index if not exists access_requests_email_idx
  on public.access_requests (email);

-- 같은 이메일로 동시에 여러 pending 못 만들도록 — 재요청 시 기존 pending을 update.
create unique index if not exists access_requests_unique_pending
  on public.access_requests (email)
  where status = 'pending';

alter table public.access_requests enable row level security;
-- 모든 read/write는 API route + service role을 거치므로 직접 policy 부여하지 않음.
