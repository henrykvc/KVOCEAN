-- Add role column to allowed_users
alter table public.allowed_users
  add column if not exists role text not null default 'manager'
  check (role in ('creator', 'admin', 'manager'));

-- Set creator for henry
update public.allowed_users
set role = 'creator'
where email = 'henry@kakaoventures.co.kr';

-- Set admin for anyone already in admin_users (except creator)
update public.allowed_users a
set role = 'admin'
from public.admin_users au
where a.email = au.email
  and a.email != 'henry@kakaoventures.co.kr'
  and a.role = 'manager';
