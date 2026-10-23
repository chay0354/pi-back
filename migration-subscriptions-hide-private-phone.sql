-- Business accounts may hide their מספר פרטי ישיר; the office number and the virtual number stay visible.
alter table public.subscriptions
  add column if not exists hide_private_phone boolean not null default false;

comment on column public.subscriptions.hide_private_phone is 'When true, the private direct phone is not shown on the profile or on ads';
