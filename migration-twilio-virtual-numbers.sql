-- Twilio virtual numbers (call masking / forwarding) — run in Supabase SQL Editor.
-- Each advertiser phone (mobile / office) can be fronted by a Twilio number that
-- forwards inbound calls to the real phone, so the real number is never exposed.

create table if not exists public.virtual_numbers (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  twilio_sid text not null unique,
  phone_e164 text not null unique,
  number_type text not null default 'local'
    check (number_type in ('local', 'mobile', 'toll_free')),
  status text not null default 'available'
    check (status in ('available', 'assigned', 'released')),
  subscription_id uuid null references public.subscriptions(id) on delete set null,
  phone_kind text null check (phone_kind in ('mobile', 'office')),
  target_phone_e164 text null,
  assigned_at timestamptz null,
  released_at timestamptz null
);

-- One active virtual number per advertiser phone kind.
create unique index if not exists virtual_numbers_active_assignment_idx
  on public.virtual_numbers (subscription_id, phone_kind)
  where status = 'assigned';

create index if not exists virtual_numbers_status_idx
  on public.virtual_numbers (status);

create table if not exists public.virtual_number_calls (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  call_sid text not null unique,
  virtual_number_id uuid null references public.virtual_numbers(id) on delete set null,
  subscription_id uuid null references public.subscriptions(id) on delete set null,
  phone_kind text null,
  from_e164 text null,
  to_e164 text null,
  forwarded_to_e164 text null,
  status text null,
  dial_status text null,
  duration_seconds integer null,
  started_at timestamptz null,
  ended_at timestamptz null
);

create index if not exists virtual_number_calls_subscription_idx
  on public.virtual_number_calls (subscription_id, created_at desc);

-- Server-only tables: RLS on with no policies, so only the service role can read/write.
alter table public.virtual_numbers enable row level security;
alter table public.virtual_number_calls enable row level security;

comment on table public.virtual_numbers is 'Twilio numbers pool; assigned rows forward calls to an advertiser phone';
comment on table public.virtual_number_calls is 'Inbound call log for Twilio virtual numbers (from Twilio status callbacks)';
