-- Expo push tokens per device; chat messages fan out to every token of the recipient email.
create table if not exists public.push_tokens (
  token text primary key,
  user_email text not null,
  subscription_id uuid null,
  platform text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists push_tokens_user_email_idx
  on public.push_tokens (user_email);

-- Server-only: RLS on with no policies, so only the service role can read/write.
alter table public.push_tokens enable row level security;

comment on table public.push_tokens is 'Expo push tokens registered by the mobile app (one row per device)';
