create table if not exists public.app_config (
  id text primary key default 'global',
  logic_config jsonb not null default '{}'::jsonb,
  classification_catalog jsonb not null default '[]'::jsonb,
  company_configs jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text
);

create table if not exists public.datasets (
  id text primary key,
  company_name text not null,
  quarter_key text not null,
  quarter_label text not null,
  saved_at timestamptz not null default now(),
  saved_by text,
  raw_statement_rows jsonb not null default '[]'::jsonb,
  adjusted_statement_rows jsonb not null default '[]'::jsonb,
  source jsonb not null default '{}'::jsonb
);

create table if not exists public.change_logs (
  id bigint generated always as identity primary key,
  action text not null,
  target_type text not null,
  target_id text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  created_by text
);

alter table public.app_config enable row level security;
alter table public.datasets enable row level security;
alter table public.change_logs enable row level security;

drop policy if exists "authenticated users can read app_config" on public.app_config;
create policy "authenticated users can read app_config"
on public.app_config
for select
to authenticated
using (true);

drop policy if exists "authenticated users can update app_config" on public.app_config;
create policy "authenticated users can update app_config"
on public.app_config
for all
to authenticated
using (true)
with check (true);

drop policy if exists "authenticated users can read datasets" on public.datasets;
create policy "authenticated users can read datasets"
on public.datasets
for select
to authenticated
using (true);

drop policy if exists "authenticated users can write datasets" on public.datasets;
create policy "authenticated users can write datasets"
on public.datasets
for all
to authenticated
using (true)
with check (true);

drop policy if exists "authenticated users can read change_logs" on public.change_logs;
create policy "authenticated users can read change_logs"
on public.change_logs
for select
to authenticated
using (true);

drop policy if exists "authenticated users can write change_logs" on public.change_logs;
create policy "authenticated users can write change_logs"
on public.change_logs
for insert
to authenticated
with check (true);

insert into public.app_config (id)
values ('global')
on conflict (id) do nothing;
