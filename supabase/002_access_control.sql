create table if not exists public.allowed_users (
  email text primary key,
  display_name text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by text,
  updated_at timestamptz not null default now(),
  updated_by text
);

create table if not exists public.admin_users (
  email text primary key,
  display_name text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by text,
  updated_at timestamptz not null default now(),
  updated_by text
);

alter table public.allowed_users enable row level security;
alter table public.admin_users enable row level security;

drop policy if exists "authenticated users can read allowed_users" on public.allowed_users;
create policy "authenticated users can read allowed_users"
on public.allowed_users
for select
to authenticated
using (true);

drop policy if exists "authenticated users can read admin_users" on public.admin_users;
create policy "authenticated users can read admin_users"
on public.admin_users
for select
to authenticated
using (true);

insert into public.allowed_users (email, display_name, created_by, updated_by)
values ('henry@kakaoventures.co.kr', 'Henry', 'bootstrap', 'bootstrap')
on conflict (email) do update
set is_active = true,
    updated_at = now(),
    updated_by = excluded.updated_by;

insert into public.admin_users (email, display_name, created_by, updated_by)
values ('henry@kakaoventures.co.kr', 'Henry', 'bootstrap', 'bootstrap')
on conflict (email) do update
set is_active = true,
    updated_at = now(),
    updated_by = excluded.updated_by;
