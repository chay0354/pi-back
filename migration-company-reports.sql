-- Company profile reports (דווח על חברה) — run in Supabase SQL Editor.
create table if not exists public.company_reports (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  reported_subscription_id uuid not null,
  reported_listing_id uuid,
  company_display_name text,
  subject_type text not null default 'company',
  reason_keys text[] not null default '{}',
  description text,
  reporter_name text,
  reporter_phone text,
  reporter_email text,
  reporter_subscription_id uuid
);

create index if not exists company_reports_created_at_idx
  on public.company_reports (created_at desc);
create index if not exists company_reports_reported_sub_idx
  on public.company_reports (reported_subscription_id);

comment on table public.company_reports is 'User-submitted reports against company profiles from the app';
