-- Adds subject type so company_reports also stores professional/broker reports.
-- Run in Supabase SQL Editor after migration-company-reports.sql.

alter table public.company_reports
  add column if not exists subject_type text not null default 'company';

comment on column public.company_reports.subject_type is
  'company | professional | broker — which profile type was reported';
