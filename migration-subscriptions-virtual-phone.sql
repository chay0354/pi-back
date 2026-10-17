-- Virtual (Twilio) number shown on profiles; the «חייג» button dials it instead of the direct phones.
alter table public.subscriptions
  add column if not exists virtual_phone varchar null;

comment on column public.subscriptions.virtual_phone is 'Virtual phone number dialled from the profile «חייג» button';
