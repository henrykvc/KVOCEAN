alter table public.datasets
add column if not exists is_deleted boolean not null default false;

alter table public.datasets
add column if not exists deleted_at timestamptz;

alter table public.datasets
add column if not exists deleted_by text;

create index if not exists datasets_is_deleted_idx on public.datasets (is_deleted);
